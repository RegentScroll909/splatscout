// Video input: pick the sharpest, well-spaced frames from a phone video (the same analysis the
// SplatScout app uses live), then extract them at full quality with ffmpeg.
//
// 360° video: a 360 camera records every direction at once, so one slow walk covers what takes many
// minutes of phone photos. Each chosen (equirectangular) frame is cut into ordinary 90° views with
// ffmpeg's v360 filter, one folder per view direction; COLMAP then solves the views of a frame as a
// rig (same position, fixed turn between them) and the splat trains on them like normal photos.

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeImage, downsample2, FlowTracker } from '../../app/js/core/analyzer.js';
import { capture, run } from './run.mjs';

export async function probeVideo(ffprobe, file) {
  const { stdout } = await capture(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,avg_frame_rate,nb_frames,duration,color_transfer,pix_fmt:stream_side_data:format=duration',
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
    spherical: (s.side_data_list || []).some((d) => /equirect/i.test(d.projection || '')),
  };
}

/** An equirectangular 360° video: tagged as one, or a 2:1 frame (what 360 cameras export). */
export function isEquirect(info) {
  return info.spherical || (Math.abs(info.width / info.height - 2) < 0.02 && info.width >= 1280);
}

/** Views cut from each 360 frame: eight around the horizon and one straight up. None looks down,
 *  where the person holding the camera is. The first is the rig's reference. */
export const VIEWS_360 = [0, 45, 90, 135, 180, 225, 270, 315]
  .map((yaw) => ({ name: 'h' + String(yaw).padStart(3, '0'), yaw, pitch: 0 }))
  .concat([{ name: 'up', yaw: 0, pitch: 90 }]);

/** Side of a square 90° view that keeps the 360 frame's detail (a quarter of its width). */
export const viewSize = (info) => Math.max(512, Math.min(1920, Math.round(info.width / 4 / 16) * 16));

function quaternion(m) {
  // row-major rotation matrix → [w, x, y, z]
  const t = m[0] + m[4] + m[8];
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4];
  }
  return q.map((v) => +v.toFixed(9));
}

/**
 * COLMAP rig configuration for the views: each is the reference view turned by its yaw (right) and
 * pitch (up), at the same position. COLMAP cameras look along +z with y down.
 */
export function rigConfig(views = VIEWS_360) {
  const cameras = views.map((v, i) => {
    if (i === 0) return { image_prefix: v.name + '/', ref_sensor: true };
    const a = (v.yaw * Math.PI) / 180, b = (v.pitch * Math.PI) / 180;
    // The view's right, down and forward axes in reference-view coordinates are the rows of cam_from_rig.
    const right = [Math.cos(a), 0, -Math.sin(a)];
    const down = [Math.sin(b) * Math.sin(a), Math.cos(b), Math.sin(b) * Math.cos(a)];
    const fwd = [Math.sin(a) * Math.cos(b), -Math.sin(b), Math.cos(a) * Math.cos(b)];
    return { image_prefix: v.name + '/', cam_from_rig_rotation: quaternion([...right, ...down, ...fwd]), cam_from_rig_translation: [0, 0, 0] };
  });
  return [{ cameras }];
}

const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/**
 * @returns {Promise<{selected:number[], total:number, info:object}>} frame indices to keep
 */
export async function selectFrames({ ffmpeg, ffprobe, file, maxFrames = 400, every = 0, progress, token, log }) {
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

  const total = metrics.length;
  if (every) {
    // 360 video: image motion means little on an equirectangular frame (ahead grows while behind
    // shrinks), so take the sharpest frame from every `every` seconds instead.
    const win = Math.max(1, Math.round(info.fps * every), Math.ceil(total / maxFrames));
    const selected = [];
    for (let s = 0; s < total; s += win) {
      let best = -1;
      for (let j = s; j < Math.min(total, s + win); j++) {
        if (metrics[j].mean > 15 && (best < 0 || metrics[j].sharp > metrics[best].sharp)) best = j;
      }
      if (best >= 0) selected.push(best);
    }
    if (log) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(log, `\nAnalysed ${total} frames of 360 video, one per ${win}, selected ${selected.length}\n`);
    }
    return { selected, total, info };
  }
  // Spacing: one frame per ~10% of a frame width of image motion, widened to respect maxFrames.
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

// ffmpeg's expression parser fails on long a+b+c+… chains (>~120 terms), so the terms are
// combined as a balanced tree (depth log2 n). Chunks keep the command line under Windows' limit.
const tree = (t) => (t.length === 1 ? t[0] : `(${tree(t.slice(0, t.length >> 1))}+${tree(t.slice(t.length >> 1))})`);
const selectOnly = (frames) => `select='${tree(frames.map((f) => `eq(n\\,${f})`))}'`;
function chunked(frames, size) {
  const chunks = [];
  for (let i = 0; i < frames.length; i += size) chunks.push(frames.slice(i, i + size));
  return chunks;
}

// Brush 0.3 reads the first 16,387 bytes of every image in one go to find its size, and fails
// ("early eof") on smaller files, which a plain view cut from 360 video can be. Zero bytes after the
// end-of-image marker are ignored by JPEG readers.
const BRUSH_MIN_BYTES = 16448;
function padForBrush(file) {
  const size = statSync(file).size;
  if (size < BRUSH_MIN_BYTES) appendFileSync(file, Buffer.alloc(BRUSH_MIN_BYTES - size));
}

/** Extract the chosen frames at full resolution as JPEGs named 0001.jpg … */
export async function extractFrames({ ffmpeg, file, frames, info, outDir, token, log }) {
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const [ci, chunk] of chunked(frames, 1000).entries()) {
    const vf = (info.hdr ? TONEMAP + ',' : '') + selectOnly(chunk);
    const tmp = join(outDir, `_part${ci}`);
    mkdirSync(tmp, { recursive: true });
    await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-fps_mode', 'passthrough', '-q:v', '2', join(tmp, '%05d.jpg')], { log, token });
    for (const name of readdirSync(tmp).sort()) {
      n++;
      const out = join(outDir, `${String(n).padStart(4, '0')}.jpg`);
      renameSync(join(tmp, name), out);
      padForBrush(out);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  return n;
}

/**
 * Cut the chosen 360 frames into views: <outDir>/<view name>/0001.jpg … The same number is the same
 * frame in every view folder, which is how COLMAP groups the views into rig frames.
 */
export async function extract360({ ffmpeg, file, frames, info, outDir, size, views = VIEWS_360, token, log }) {
  for (const v of views) mkdirSync(join(outDir, v.name), { recursive: true });
  let n = 0;
  for (const [ci, chunk] of chunked(frames, 600).entries()) {
    const split = `[0:v]${info.hdr ? TONEMAP + ',' : ''}${selectOnly(chunk)},split=${views.length}${views.map((_, i) => `[s${i}]`).join('')}`;
    const cuts = views.map((v, i) => `[s${i}]v360=input=e:output=flat:yaw=${v.yaw > 180 ? v.yaw - 360 : v.yaw}:pitch=${v.pitch}:h_fov=90:v_fov=90:w=${size}:h=${size}:interp=lanczos[o${i}]`);
    const tmp = join(outDir, `_part${ci}`);
    const args = ['-v', 'error', '-i', file, '-filter_complex', [split, ...cuts].join(';')];
    views.forEach((v, i) => {
      mkdirSync(join(tmp, v.name), { recursive: true });
      args.push('-map', `[o${i}]`, '-fps_mode', 'passthrough', '-q:v', '2', join(tmp, v.name, '%05d.jpg'));
    });
    await run(ffmpeg, args, { log, token });
    const names = readdirSync(join(tmp, views[0].name)).sort();
    names.forEach((name, k) => {
      const out = `${String(n + k + 1).padStart(4, '0')}.jpg`;
      for (const v of views) {
        renameSync(join(tmp, v.name, name), join(outDir, v.name, out));
        padForBrush(join(outDir, v.name, out));
      }
    });
    n += names.length;
    rmSync(tmp, { recursive: true, force: true });
  }
  return n;
}
