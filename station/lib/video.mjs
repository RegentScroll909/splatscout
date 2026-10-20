// Video input: pick the sharpest, well-spaced frames from a phone video (the same analysis the
// SplatScout app uses live), then extract them at full quality with ffmpeg.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeImage, downsample2, FlowTracker } from '../../app/js/core/analyzer.js';
import { capture, run } from './run.mjs';

export async function probeVideo(ffprobe, file) {
  const { stdout } = await capture(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,avg_frame_rate,nb_frames,duration,color_transfer,pix_fmt:stream_side_data=rotation:format=duration',
    '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const s = j.streams[0];
  const rot = Math.abs(((s.side_data_list || []).find((d) => d.rotation != null) || {}).rotation || 0);
  const swap = rot === 90 || rot === 270;
  const [n, d] = (s.avg_frame_rate || '30/1').split('/').map(Number);
  return {
    width: swap ? s.height : s.width,
    height: swap ? s.width : s.height,
    fps: d ? n / d : 30,
    duration: parseFloat(s.duration || (j.format && j.format.duration) || '0'),
    hdr: /arib-std-b67|smpte2084/.test(s.color_transfer || ''),
  };
}

const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/**
 * @returns {Promise<{selected:number[], total:number, info:object}>} frame indices to keep
 */
export async function selectFrames({ ffmpeg, ffprobe, file, maxFrames = 400, progress, token, log }) {
  const info = await probeVideo(ffprobe, file);
  const long = 640;
  const s = long / Math.max(info.width, info.height);
  const w = Math.round((info.width * s) / 4) * 4, h = Math.round((info.height * s) / 4) * 4;
  const vf = (info.hdr ? TONEMAP + ',' : '') + `scale=${w}:${h}`;
  const frameBytes = w * h;
  const est = Math.max(1, Math.round(info.duration * info.fps));
  const metrics = [];
  const flow = new FlowTracker();
  let cum = 0;

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true });
    if (token) token.child = child;
    let buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= frameBytes) {
        const gray = new Uint8Array(buf.subarray(0, frameBytes));
        buf = buf.subarray(frameBytes);
        const a = analyzeImage(gray, w, h);
        const q = downsample2(gray, w, h);
        const sm = downsample2(q.data, q.w, q.h);
        const f = flow.update(sm.data, sm.w, sm.h);
        const disp = f ? (Math.hypot(f.tx, f.ty) + Math.abs(f.scale - 1) * (sm.w / 2)) / sm.w : 0;
        cum += disp;
        metrics.push({ sharp: a.sharp, cum, mean: a.mean });
        if (metrics.length % 30 === 0 && progress) progress(Math.min(0.99, metrics.length / est));
      }
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (token) token.child = null;
      if (token && token.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      code === 0 ? resolve() : reject(new Error('ffmpeg could not decode the video: ' + err.slice(-400)));
    });
  });

  // Spacing: one frame per ~10% of a frame width of image motion, widened to respect maxFrames.
  const total = metrics.length;
  let step = 0.1;
  const motion = metrics.length ? metrics[metrics.length - 1].cum : 0;
  if (motion / step > maxFrames) step = motion / maxFrames;
  const selected = [];
  let windowStart = 0;
  let target = step;
  const minGap = Math.max(1, Math.round(info.fps / 6)); // at most ~6 frames per second of video
  for (let i = 0; i < total; i++) {
    if (metrics[i].cum < target && i !== total - 1) continue;
    // Choose the sharpest frame among those since the window started.
    let best = -1, bestS = -1;
    for (let j = windowStart; j <= i; j++) {
      if (selected.length && j - selected[selected.length - 1] < minGap) continue;
      // Relative to local sharpness so plain walls are not discarded.
      if (metrics[j].sharp > bestS && metrics[j].mean > 15) {
        bestS = metrics[j].sharp;
        best = j;
      }
    }
    if (best >= 0) selected.push(best);
    windowStart = i + 1;
    target = metrics[i].cum + step;
  }
  if (log) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(log, `\nAnalysed ${total} frames, motion ${motion.toFixed(1)} frame-widths, selected ${selected.length}\n`);
  }
  return { selected, total, info };
}

/** Extract the chosen frames at full resolution as JPEGs named 0001.jpg … */
export async function extractFrames({ ffmpeg, file, frames, info, outDir, token, log }) {
  mkdirSync(outDir, { recursive: true });
  // ffmpeg's expression parser fails on long a+b+c+… chains (>~120 terms), so the terms are
  // combined as a balanced tree (depth log2 n). Chunks keep the command line under Windows' limit.
  const tree = (t) => (t.length === 1 ? t[0] : `(${tree(t.slice(0, t.length >> 1))}+${tree(t.slice(t.length >> 1))})`);
  const chunks = [];
  for (let i = 0; i < frames.length; i += 1000) chunks.push(frames.slice(i, i + 1000));
  let n = 0;
  for (const [ci, chunk] of chunks.entries()) {
    const expr = tree(chunk.map((f) => `eq(n\\,${f})`));
    const vf = (info.hdr ? TONEMAP + ',' : '') + `select='${expr}'`;
    const tmp = join(outDir, `_part${ci}`);
    mkdirSync(tmp, { recursive: true });
    await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-fps_mode', 'passthrough', '-q:v', '2', join(tmp, '%05d.jpg')], { log, token });
    for (const name of readdirSync(tmp).sort()) {
      n++;
      renameSync(join(tmp, name), join(outDir, `${String(n).padStart(4, '0')}.jpg`));
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  return n;
}
