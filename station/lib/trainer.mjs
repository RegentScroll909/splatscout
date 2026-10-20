// Gaussian splat training with Brush (WebGPU; runs on the RTX 5080 via Vulkan/DX12).
// Input: a COLMAP dataset folder (images/ + sparse/0). Output: .ply splat files.

import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './run.mjs';

/**
 * @param {object} p
 * @param {string} p.brush path to brush_app.exe
 * @param {string} p.dataset dataset folder (images/ + sparse/0)
 * @param {string} p.outDir where .ply exports go
 * @param {{steps:number,maxResolution:number,maxSplats:number}} p.preset
 * @param {(fraction:number, note?:string)=>void} p.progress
 * @param {(file:string, iter:number)=>void} [p.onExport] called when an intermediate/final .ply appears
 */
export async function trainBrush(p) {
  const { brush, dataset, outDir, preset, progress, onExport, token, log, nImages } = p;
  mkdirSync(outDir, { recursive: true });
  const steps = preset.steps;
  const exportEvery = Math.max(1000, Math.round(steps / 5 / 1000) * 1000);
  const args = [
    dataset,
    '--total-steps', String(steps),
    '--max-resolution', String(preset.maxResolution),
    '--max-splats', String(preset.maxSplats),
    '--export-every', String(exportEvery),
    '--export-path', outDir,
    '--export-name', 'splat_{iter}.ply',
    '--eval-every', String(steps + 1),
  ];
  // Brush suggests refining roughly once per pass over the photos.
  if (nImages) args.push('--refine-every', String(Math.min(400, Math.max(100, nImages))));

  // Brush's CLI trains silently and writes splat_<iter>.ply snapshots, so progress is estimated
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

  try {
    // Brush keeps a GPU autotune cache in ./target; give it a stable home so tuning is reused.
    if (p.cacheDir) mkdirSync(p.cacheDir, { recursive: true });
    await run(brush, args, { log, token, cwd: p.cacheDir });
  } finally {
    clearInterval(poll);
  }
  const exportsList = listExports(outDir);
  for (const f of exportsList) if (!seen.has(f.file) && onExport) onExport(f.file, f.iter);
  const final = exportsList.sort((a, b) => b.iter - a.iter)[0];
  if (!final) throw new Error('Brush finished without exporting a .ply. Check the training log.');
  const seconds = (Date.now() - t0) / 1000;
  return { ply: final.file, iter: final.iter, seconds, stepsPerSec: final.iter / seconds, splats: plyVertexCount(final.file) };
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
