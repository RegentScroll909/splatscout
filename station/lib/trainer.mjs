// Gaussian splat training with Brush (WebGPU; runs on the RTX 5080 via Vulkan/DX12).
// Input: a COLMAP dataset folder (images/ + sparse/0). Output: .ply splat files.

import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './run.mjs';

/** Measuring quality: every this-many-th photo is held back from training and the splat is scored on them. */
export const HOLD_OUT_EVERY = 12;
// Brush prints nothing when its output isn't a terminal unless asked to log. Its own CLI lines (refines,
// the eval score, "Done training!") are few; everything else stays at errors only.
const BRUSH_LOG = 'error,brush_cli=info';

/**
 * The quality score Brush (0.3) logs when it evaluates on held-back photos:
 *   [… INFO  brush_cli] Loaded dataset with 213 training, 20 eval views
 *   [… INFO  brush_cli] Eval iter 30000: PSNR 24.123456, ssim 0.8123456
 * PSNR is in dB (how closely the splat's render of each held-back view matches the photo, averaged over
 * the views); SSIM runs up to 1 (a perfect match). The last eval in the log counts.
 * @param {string[]} lines
 * @returns {{psnr:number, ssim:number, views:number|null, step:number}|null}
 */
export function brushEval(lines) {
  let views = null, last = null;
  for (const line of lines) {
    let m = /Loaded dataset with (\d+) training, (\d+) eval views?/i.exec(line);
    if (m) views = +m[2];
    else if ((m = /Eval iter (\d+):\s*PSNR\s+([^\s,]+),\s*ssim\s+([^\s,]+)/i.exec(line))) {
      const psnr = Number(m[2]), ssim = Number(m[3]);
      if (Number.isFinite(psnr) && Number.isFinite(ssim)) last = { step: +m[1], psnr, ssim };
    }
  }
  if (!last || views === 0) return null;
  return { psnr: +last.psnr.toFixed(2), ssim: +last.ssim.toFixed(4), views, step: last.step };
}

/**
 * @param {object} p
 * @param {string} p.brush path to brush_app.exe
 * @param {string} p.dataset dataset folder (images/ + sparse/0)
 * @param {string} p.outDir where .ply exports go
 * @param {{steps:number,maxResolution:number,maxSplats:number}} p.preset
 * @param {(fraction:number, note?:string)=>void} p.progress
 * @param {(file:string, iter:number)=>void} [p.onExport] called when an intermediate/final .ply appears
 * @param {number} [p.holdOut] hold every Nth photo back from training and score the finished splat on
 *   them (0 or missing: train on every photo, no score)
 * @returns {Promise<{ply, iter, seconds, stepsPerSec, splats, eval: {psnr, ssim, views, step, every}|null}>}
 */
export async function trainBrush(p) {
  const { brush, dataset, outDir, preset, progress, onExport, token, log, nImages } = p;
  mkdirSync(outDir, { recursive: true });
  const steps = preset.steps;
  const holdOut = p.holdOut > 1 ? Math.round(p.holdOut) : 0;
  const exportEvery = Math.max(1000, Math.round(steps / 5 / 1000) * 1000);
  const args = [
    dataset,
    '--total-steps', String(steps),
    '--max-resolution', String(preset.maxResolution),
    '--max-splats', String(preset.maxSplats),
    '--export-every', String(exportEvery),
    '--export-path', outDir,
    '--export-name', 'splat_{iter}.ply',
    // One evaluation, on the held-back photos at the last step; or none (an eval step past the end).
    ...(holdOut ? ['--eval-split-every', String(holdOut), '--eval-every', String(steps)] : ['--eval-every', String(steps + 1)]),
  ];
  // Brush suggests refining roughly once per pass over the photos.
  if (nImages) args.push('--refine-every', String(Math.min(400, Math.max(100, nImages))));

  // Brush writes splat_<iter>.ply snapshots but says little else, so progress is estimated
  // from elapsed time, re-calibrated at every snapshot (training slows down as splats grow).
  const t0 = Date.now();
  const seen = new Set();
  let rate = p.stepsPerSec || 20; // initial guess, steps per second
  let lastIter = 0, lastT = t0;
  const poll = setInterval(() => {
    for (const f of listExports(outDir)) {
      if (seen.has(f.file)) continue;
      // Only report files that have finished writing (size stable for one poll).
      if (f.size === f.prevSize || seen.has('pending:' + f.file + ':' + f.size)) {
        seen.add(f.file);
        if (f.iter > lastIter) {
          const now = Date.now();
          rate = (f.iter - lastIter) / Math.max(1, (now - lastT) / 1000);
          lastIter = f.iter;
          lastT = now;
        }
        if (onExport) onExport(f.file, f.iter);
      } else {
        seen.add('pending:' + f.file + ':' + f.size);
      }
    }
    const est = Math.min(steps * 0.995, lastIter + rate * ((Date.now() - lastT) / 1000));
    const eta = (steps - est) / Math.max(rate, 0.1);
    progress(est / steps, `step ~${Math.round(est).toLocaleString()} / ${steps.toLocaleString()} · ~${fmtMin(eta)} left`);
  }, 2000);

  const said = []; // Brush's lines about the eval split and scores
  try {
    // Brush keeps a GPU autotune cache in ./target; give it a stable home so tuning is reused.
    if (p.cacheDir) mkdirSync(p.cacheDir, { recursive: true });
    await run(brush, args, {
      log, token, cwd: p.cacheDir, env: { RUST_LOG: BRUSH_LOG },
      onLine: (line) => /Eval iter|Loaded dataset/.test(line) && said.push(line),
    });
  } finally {
    clearInterval(poll);
  }
  const exportsList = listExports(outDir);
  for (const f of exportsList) if (!seen.has(f.file) && onExport) onExport(f.file, f.iter);
  const final = exportsList.sort((a, b) => b.iter - a.iter)[0];
  if (!final) throw new Error('Brush finished without exporting a .ply. Check the training log.');
  const seconds = (Date.now() - t0) / 1000;
  const ev = holdOut ? brushEval(said) : null;
  return { ply: final.file, iter: final.iter, seconds, stepsPerSec: final.iter / seconds, splats: plyVertexCount(final.file), eval: ev ? { ...ev, every: holdOut } : null };
}

/** Number of splats in a .ply (from its header). */
export function plyVertexCount(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const m = /element vertex (\d+)/.exec(buf.toString('latin1'));
    return m ? +m[1] : null;
  } catch {
    return null;
  }
}

const sizes = new Map();
function listExports(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const m = /^splat_(\d+)\.ply$/i.exec(name);
      if (!m) return null;
      const file = join(dir, name);
      const size = statSync(file).size;
      const prevSize = sizes.get(file);
      sizes.set(file, size);
      return { file, iter: +m[1], size, prevSize };
    })
    .filter(Boolean);
}

function fmtMin(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  return `${Math.round(sec / 60)} min`;
}
