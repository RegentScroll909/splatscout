// Gaussian splat training with Brush (WebGPU; runs on the RTX 5080 via Vulkan/DX12).
// Input: a COLMAP dataset folder (images/ + sparse/0). Output: .ply splat files.

import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, killTree } from './run.mjs';

/** Measuring quality: every this-many-th photo is held back from training and the splat is scored on them. */
export const HOLD_OUT_EVERY = 12;
// Brush prints nothing when its output isn't a terminal unless asked to log. Its own CLI lines (refines,
// the eval score, "Done training!") are few; everything else stays at errors only.
const BRUSH_LOG = 'error,brush_cli=info';
// A run that has gone quiet: said after this long without a sign of life from Brush, ended after GIVE_UP.
// Both stretch for a slow GPU: they're never under 10 and 30 times the usual gap between Brush's lines.
const STALL_AFTER = 180, STALL_GIVE_UP = 900; // s

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
 * Where a training run is, from what Brush itself says. Brush (0.3) logs
 *   [… INFO  brush_cli] Refine iter 4001, 1073286 splats.
 * every --refine-every steps and writes a snapshot every --export-every: each is a mark (a step, at a time).
 * Between marks the step carries on at the measured speed, but never far past the last line: when the lines
 * stop coming, so does the estimate, and after a while the run counts as stalled. (The estimate used to come
 * from the clock and the snapshots alone: a run whose GPU had stopped still counted up to 99%.)
 */
export class TrainProgress {
  /**
   * @param {object} o
   * @param {number} o.steps total steps
   * @param {number} [o.rate] steps a second to assume until Brush has said enough to measure it
   * @param {number} [o.every] steps between Brush's "Refine" lines (--refine-every)
   * @param {number} o.now start time (ms)
   */
  constructor({ steps, rate = 20, every = 0, now }) {
    this.steps = steps;
    this.rate = rate > 0 ? rate : 20;
    this.every = every;
    this.marks = [{ t: now, iter: 0 }];
    this.lines = 0; // "Refine" lines seen
    this.lastLine = null; // {t, iter} of the last one
    this.gaps = []; // ms between them (the last few)
    this.splats = null;
    this.alive = now; // the last sign of life: a line from Brush, a snapshot growing
  }

  /** A line of Brush's output. */
  line(text, now) {
    this.alive = Math.max(this.alive, now);
    const m = /Refine iter (\d+),\s*(\d+) splats/i.exec(text);
    if (!m) return;
    const iter = +m[1];
    this.splats = +m[2];
    if (this.lastLine) {
      if (now > this.lastLine.t) this.gaps.push(now - this.lastLine.t);
      if (this.gaps.length > 15) this.gaps.shift();
      if (iter > this.lastLine.iter) this.every = iter - this.lastLine.iter;
    }
    this.lastLine = { t: now, iter };
    this.lines++;
    this.mark(iter, now);
  }

  /** The run is known to have reached this step (a "Refine" line, or a finished snapshot). */
  mark(iter, now) {
    this.alive = Math.max(this.alive, now);
    const last = this.marks[this.marks.length - 1];
    if (!(iter > last.iter)) return;
    this.marks.push({ t: now, iter });
    if (this.marks.length > 8) this.marks.shift();
    const from = this.marks[0];
    if (now - from.t >= 500) this.rate = (iter - from.iter) / ((now - from.t) / 1000);
  }

  /** Something else showed the run is alive (a snapshot being written). */
  touch(now) {
    this.alive = Math.max(this.alive, now);
  }

  /** This process stood still for `ms` (the PC slept, or was busy): that time doesn't count against Brush. */
  paused(ms, now) {
    const later = (t) => Math.min(now, t + ms);
    for (const k of this.marks) k.t = later(k.t);
    if (this.lastLine) this.lastLine.t = later(this.lastLine.t);
    this.alive = later(this.alive);
  }

  /** Seconds since the last sign of life. */
  quiet(now) {
    return Math.max(0, now - this.alive) / 1000;
  }

  /** The usual time between Brush's lines in this run (s), or null while it's too early to say. */
  usualGap() {
    if (this.lines < 2 || !this.gaps.length) return null;
    return this.gaps.slice().sort((a, b) => a - b)[this.gaps.length >> 1] / 1000;
  }

  /** @returns {{step: number, fraction: number, eta: number, splats: number|null}} eta in seconds */
  estimate(now) {
    const last = this.marks[this.marks.length - 1];
    let ahead = (this.rate * Math.max(0, now - last.t)) / 1000;
    // With Brush's lines coming, it can't be far past the last one without having said so.
    if (this.lines > 0 && this.every) ahead = Math.min(ahead, this.every * 1.5);
    const step = Math.min(this.steps * 0.995, last.iter + ahead);
    return { step, fraction: step / this.steps, eta: (this.steps - step) / Math.max(this.rate, 0.1), splats: this.splats };
  }
}

/**
 * @param {object} p
 * @param {string} p.brush path to brush_app.exe
 * @param {string} p.dataset dataset folder (images/ + sparse/0)
 * @param {string} p.outDir where .ply exports go
 * @param {{steps:number,maxResolution:number,maxSplats:number}} p.preset
 * @param {(fraction:number, note?:string)=>void} p.progress
 * @param {(file:string, iter:number)=>void} [p.onExport] called when an intermediate/final .ply appears
 * @param {(text:string)=>void} [p.say] for the activity log (a run that stalls, or moves again)
 * @param {number} [p.holdOut] hold every Nth photo back from training and score the finished splat on
 *   them (0 or missing: train on every photo, no score)
 * @param {{after?: number, giveUp?: number, poll?: number}} [p.stall] seconds without a sign of life from Brush
 *   before saying so and before ending the run; ms between looks
 * @returns {Promise<{ply, iter, seconds, stepsPerSec, splats, eval: {psnr, ssim, views, step, every}|null}>}
 */
export async function trainBrush(p) {
  const { brush, dataset, outDir, preset, progress, onExport, log, nImages } = p;
  const token = p.token || { cancelled: false, child: null };
  const say = p.say || (() => {});
  const stall = { after: STALL_AFTER, giveUp: STALL_GIVE_UP, poll: 2000, ...(p.stall || {}) };
  mkdirSync(outDir, { recursive: true });
  const steps = preset.steps;
  const holdOut = p.holdOut > 1 ? Math.round(p.holdOut) : 0;
  const exportEvery = Math.max(1000, Math.round(steps / 5 / 1000) * 1000);
  // Brush suggests refining roughly once per pass over the photos.
  const refineEvery = nImages ? Math.min(400, Math.max(100, nImages)) : 0;
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
  if (refineEvery) args.push('--refine-every', String(refineEvery));

  // Progress comes from Brush's own lines and snapshots (TrainProgress). Only this run's snapshots count: a job
  // processed again still has the last run's in the folder, and they used to be taken for this run's (the bar
  // jumped to 99% at once, and a run with fewer steps handed back the old run's bigger splat as its result).
  const t0 = Date.now(), mine = t0 - 2000;
  const prog = new TrainProgress({ steps, rate: p.stepsPerSec, every: refineEvery || 200, now: t0 });
  const seen = new Set();
  const said = []; // Brush's lines about the eval split and scores
  let lastPoll = t0, stallSaid = false, gaveUp = 0, shown = 0;
  const poll = setInterval(() => {
    const now = Date.now();
    if (now - lastPoll > stall.poll + 8000) prog.paused(now - lastPoll - stall.poll, now);
    lastPoll = now;
    for (const f of listExports(outDir, mine)) {
      if (f.size !== f.prevSize) prog.touch(now);
      if (seen.has(f.file)) continue;
      // Only report files that have finished writing (size stable for one poll).
      if (f.size === f.prevSize || seen.has('pending:' + f.file + ':' + f.size)) {
        seen.add(f.file);
        prog.mark(f.iter, now);
        if (onExport) onExport(f.file, f.iter);
      } else {
        seen.add('pending:' + f.file + ':' + f.size);
      }
    }
    const e = prog.estimate(now);
    shown = Math.max(shown, e.step); // the bar never goes back (a late line can put the run a little behind the estimate)
    const at = `step ~${Math.round(shown).toLocaleString()} / ${steps.toLocaleString()}${e.splats ? ` · ${(e.splats / 1e6).toFixed(2)} M splats` : ''}`;
    // Gone quiet for much longer than this run's lines usually take: say so, and in the end stop waiting.
    const usual = prog.usualGap(), quiet = prog.quiet(now);
    const limit = usual == null ? Infinity : Math.max(stall.giveUp, usual * 30);
    if (usual == null || quiet <= Math.max(stall.after, usual * 10)) {
      if (stallSaid) say('Training is moving again.');
      stallSaid = false;
      return progress(shown / steps, `${at} · ~${fmtMin(e.eta)} left`);
    }
    progress(shown / steps, `${at} · no progress for ${fmtMin(quiet)}`);
    if (!stallSaid) {
      stallSaid = true;
      say(`Training hasn't moved for ${fmtMin(quiet)} (Brush last reported step ${prog.lastLine.iter.toLocaleString()}). If it stays like this, the GPU has probably stopped responding; the run is ended after ${fmtMin(limit)} without progress.`);
    }
    if (!gaveUp && quiet > limit) {
      gaveUp = quiet;
      killTree(token.child);
    }
  }, stall.poll);

  try {
    // Brush keeps a GPU autotune cache in ./target; give it a stable home so tuning is reused.
    if (p.cacheDir) mkdirSync(p.cacheDir, { recursive: true });
    await run(brush, args, {
      log, token, cwd: p.cacheDir, env: { RUST_LOG: BRUSH_LOG },
      onLine: (line) => {
        prog.line(line, Date.now());
        if (/Eval iter|Loaded dataset/.test(line)) said.push(line);
      },
    });
  } catch (e) {
    if (!gaveUp || e.cancelled) throw e;
    throw new Error(`Training stopped at step ${prog.lastLine.iter.toLocaleString()} of ${steps.toLocaleString()}: nothing came from Brush for ${fmtMin(gaveUp)}, so it was ended. ` +
      'The GPU had probably stopped responding (a graphics driver error, or it ran out of memory). Close other programs using the GPU, splat viewers included, and process it again; ' +
      'if it keeps happening, look for "nvlddmkm" errors in Windows\' Event Viewer and update the graphics driver.');
  } finally {
    clearInterval(poll);
  }
  const exportsList = listExports(outDir, mine);
  for (const f of exportsList) if (!seen.has(f.file) && onExport) onExport(f.file, f.iter);
  const final = exportsList.sort((a, b) => b.iter - a.iter)[0];
  if (!final) throw new Error('Brush finished without exporting a .ply. Check the training log.');
  // The finished splat is the one that's used from here on: the snapshots on the way to it (and an earlier
  // run's) only take up room, a few GB for a big scan. (One still open in a viewer stays; that's no failure.)
  for (const name of readdirSync(outDir)) {
    const m = /^(splat_\d+)\.(ply|walk\.json)$/i.exec(name);
    if (!m || join(outDir, `${m[1]}.ply`).toLowerCase() === final.file.toLowerCase()) continue;
    try {
      rmSync(join(outDir, name), { force: true });
    } catch {}
  }
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
/** The snapshots in a folder written since `since` (ms): {file, iter, size, prevSize (at the last look)}. */
function listExports(dir, since = 0) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const m = /^splat_(\d+)\.ply$/i.exec(name);
      if (!m) return null;
      const file = join(dir, name);
      let st;
      try {
        st = statSync(file);
      } catch {
        return null;
      }
      if (st.mtimeMs < since) return null; // left by an earlier run
      const prevSize = sizes.get(file);
      sizes.set(file, st.size);
      return { file, iter: +m[1], size: st.size, prevSize };
    })
    .filter(Boolean);
}

function fmtMin(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  return `${Math.round(sec / 60)} min`;
}
