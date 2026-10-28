// One job = one capture → one splat. Stages: import → features → matching → mapping →
// (undistort) → train → finish. Progress and messages go through `ctx.update`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { extractZip } from './zipread.mjs';
import { reconstruct, viewHint } from './colmap.mjs';
import { trainBrush } from './trainer.mjs';
import { selectFrames, extractFrames } from './video.mjs';
import { run } from './run.mjs';
import { cropPly } from './crop.mjs';
import { walkInputs, walkMapFor } from './walkmap.mjs';
import { PRESETS, saveConfig } from './config.mjs';

export const STAGES = [
  { id: 'import', label: 'Import', weight: 4 },
  { id: 'features', label: 'Features', weight: 6 },
  { id: 'matching', label: 'Matching', weight: 10 },
  { id: 'mapping', label: 'Camera solve', weight: 10 },
  { id: 'undistort', label: 'Undistort', weight: 2 },
  { id: 'train', label: 'Train splat', weight: 66 },
  { id: 'finish', label: 'Finish', weight: 2 },
];

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

export function sourceKind(file) {
  if (/\.zip$/i.test(file)) return 'zip';
  if (VIDEO.test(file)) return 'video';
  return null;
}

/**
 * @param {object} job job record (mutated through ctx.update)
 * @param {object} ctx {cfg, update(patch), stage(id, fraction, note), say(text), token}
 */
export async function processJob(job, ctx) {
  const { cfg, token } = ctx;
  const T = cfg.tools;
  const dir = job.dir;
  const log = join(dir, 'job.log');
  const dataset = join(dir, 'dataset');
  const imagesDir = join(dataset, 'images');
  const t0 = Date.now();

  if (!T.colmap) throw new Error('COLMAP was not found. Set tools.colmap in station.config.json.');
  if (!T.brush) throw new Error('Brush was not found. Set tools.brush in station.config.json.');

  // ---------------------------------------------------------------- import
  ctx.stage('import', 0);
  let manifest = null;
  if (job.source.kind === 'zip') {
    ctx.say('Unpacking capture…');
    if (existsSync(dataset)) rmSync(dataset, { recursive: true, force: true });
    await extractZip(job.source.file, dataset, { onProgress: (f) => ctx.stage('import', f * 0.9) });
    const mf = join(dataset, 'splatscout.json');
    if (existsSync(mf)) manifest = JSON.parse(readFileSync(mf, 'utf8'));
    if (!existsSync(imagesDir)) {
      // A plain zip of photos: find the folder that holds the images.
      const found = findImageFolder(dataset);
      if (!found) throw new Error('No photos found in the ZIP.');
      if (found !== imagesDir) ctx.update({ imagesDirOverride: found });
    }
  } else if (job.source.kind === 'video') {
    if (!T.ffmpeg || !T.ffprobe) throw new Error('ffmpeg/ffprobe are needed for video input.');
    ctx.say('Analysing video for sharp, well-spaced frames…');
    const sel = await selectFrames({ ffmpeg: T.ffmpeg, ffprobe: T.ffprobe, file: job.source.file, maxFrames: 450,
      progress: (f) => ctx.stage('import', f * 0.6), token, log });
    ctx.say(`Selected ${sel.selected.length} of ${sel.total} frames${sel.info.hdr ? ' (HDR video tone-mapped)' : ''}. Extracting…`);
    if (existsSync(dataset)) rmSync(dataset, { recursive: true, force: true });
    await extractFrames({ ffmpeg: T.ffmpeg, file: job.source.file, frames: sel.selected, info: sel.info, outDir: imagesDir, token, log });
  }
  const photos = job.imagesDirOverride || imagesDir;
  const nImages = readdirSync(photos).filter((f) => /\.(jpe?g|png)$/i.test(f)).length;
  if (manifest) {
    const c = manifest.capture || {};
    ctx.update({
      building: c.building || job.building,
      room: c.room || job.room,
      capture: { grade: manifest.score && manifest.score.grade, score: manifest.score && manifest.score.score, engine: c.engine, tracking: c.tracking, author: c.author },
    });
  }
  ctx.update({ nImages });
  ctx.stage('import', 1, `${nImages} photos`);

  // ---------------------------------------------------------------- camera hint & AR poses
  let camera = null;
  let posed = null;
  let arFrames = null; // AR camera poses, also used to put an SfM solve into the AR frame
  if (manifest && manifest.frames && manifest.frames.length) {
    const intrs = manifest.frames.map((f) => f.intrinsics).filter(Boolean);
    const key = (i) => [i.w, i.h, i.fx.toFixed(1), i.fy.toFixed(1), i.cx.toFixed(1), i.cy.toFixed(1)].join('|');
    const uniform = intrs.length === manifest.frames.length && intrs.every((i) => key(i) === key(intrs[0]));
    const tracking = manifest.capture && manifest.capture.tracking;
    if (uniform && tracking === '6dof') {
      const i = intrs[0];
      camera = { model: 'PINHOLE', params: [i.fx, i.fy, i.cx, i.cy].map((v) => v.toFixed(4)).join(','), single: true };
    } else if (uniform) {
      // Camera mode: focal length is only an estimate, so let COLMAP refine it (and lens distortion).
      const i = intrs[0];
      camera = { model: 'SIMPLE_RADIAL', params: [i.fx, i.cx, i.cy, 0].map((v) => v.toFixed(4)).join(','), single: true };
    } else {
      camera = { model: 'SIMPLE_RADIAL', params: null, single: false };
    }
    const sparseIn = join(dataset, 'poses', 'colmap', 'sparse', '0');
    if (tracking === '6dof' && existsSync(join(sparseIn, 'images.txt'))) {
      const names = new Set(
        readFileSync(join(sparseIn, 'images.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 10).map((p) => p[9]),
      );
      const frames = manifest.frames.filter((f) => f.pose && names.has(basename(f.file))).map((f) => ({ name: basename(f.file), pose: f.pose }));
      if (frames.length >= 10) arFrames = frames;
      if (cfg.usePoses && job.usePoses !== false && frames.length >= 20) posed = { modelDir: sparseIn, frames };
    }
  }
  if (posed) ctx.say(`Using AR poses for ${posed.frames.length} of ${nImages} photos as a starting point.`);

  // ---------------------------------------------------------------- reconstruction
  const rec = await reconstruct({
    colmap: T.colmap,
    imagesDir: photos,
    work: join(dir, 'colmap'),
    camera,
    posed,
    align: arFrames,
    matcher: cfg.matcher || 'auto',
    progress: (stage, f, note) => ctx.stage(stage, f, note),
    say: ctx.say,
    token,
    log,
  });
  ctx.stage('mapping', 1, `${rec.stats.images}/${nImages} photos placed · ${(rec.stats.reprojError || 0).toFixed(2)} px`);
  ctx.update({ colmap: { ...rec.stats, mode: rec.mode } });
  if (!rec.undistorted) ctx.stage('undistort', 1, 'not needed');

  // ---------------------------------------------------------------- training dataset
  const train = join(dir, 'train');
  if (existsSync(train)) rmSync(train, { recursive: true, force: true });
  mkdirSync(join(train, 'sparse', '0'), { recursive: true });
  try {
    symlinkSync(rec.imagesDir, join(train, 'images'), 'junction');
  } catch {
    mkdirSync(join(train, 'images'), { recursive: true });
    for (const f of readdirSync(rec.imagesDir)) copyFileSync(join(rec.imagesDir, f), join(train, 'images', f));
  }
  for (const f of readdirSync(rec.modelDir)) {
    if (/\.(bin|txt)$/.test(f)) copyFileSync(join(rec.modelDir, f), join(train, 'sparse', '0', f));
  }

  // ---------------------------------------------------------------- training
  const preset = PRESETS[job.preset] || PRESETS[cfg.preset] || PRESETS.standard;
  ctx.stage('train', 0, preset.label);
  ctx.say(`Training the splat on the GPU (${preset.steps.toLocaleString()} steps)…`);
  const out = join(dir, 'splats');
  const presetKey = PRESETS[job.preset] ? job.preset : cfg.preset;
  const tr = await trainBrush({
    brush: T.brush,
    dataset: train,
    outDir: out,
    preset,
    nImages: rec.stats.images,
    stepsPerSec: cfg.rates && cfg.rates[presetKey],
    cacheDir: join(cfg.workDir, 'brush-cache'),
    progress: (f, note) => ctx.stage('train', f, note),
    onExport: (file, iter) => ctx.update({ preview: { file, iter, at: Date.now() } }),
    token,
    log,
  });

  // Remember the training speed so the next progress estimate starts out accurate.
  cfg.rates = { ...(cfg.rates || {}), [presetKey]: +tr.stepsPerSec.toFixed(2) };
  saveConfig(cfg);

  // ---------------------------------------------------------------- finish
  ctx.stage('finish', 0);
  const lib = libraryFolder(cfg, job);
  mkdirSync(lib, { recursive: true });
  const finalPly = join(lib, 'scene.ply');
  // Crop to the scan area marked on the phone (only possible when the splat is in the AR frame).
  let crop = null;
  const bounds = manifest && manifest.bounds;
  const cropOn = job.crop != null ? job.crop : cfg.cropToBounds !== false;
  if (cropOn && bounds && bounds.poly && bounds.poly.length >= 3 && /^(ar-poses|sfm-ar)$/.test(rec.mode)) {
    try {
      crop = cropPly(tr.ply, finalPly, bounds);
      ctx.say(`Cropped to the scan area: removed ${crop.removed.toLocaleString()} of ${(crop.kept + crop.removed).toLocaleString()} splats outside it.`);
    } catch (e) {
      ctx.say('Could not crop to the scan area: ' + e.message);
      crop = null;
    }
  }
  if (!crop) copyFileSync(tr.ply, finalPly);
  const thumbSrc = pickThumb(rec.imagesDir);
  const thumb = join(lib, 'thumb.jpg');
  if (thumbSrc) {
    if (cfg.tools.ffmpeg) {
      try {
        await run(cfg.tools.ffmpeg, ['-v', 'error', '-y', '-i', thumbSrc, '-vf', 'scale=480:-2', thumb], { token });
      } catch {
        copyFileSync(thumbSrc, thumb);
      }
    } else copyFileSync(thumbSrc, thumb);
  }
  let view = null;
  try {
    view = await viewHint(T.colmap, rec.modelDir, join(dir, 'colmap', 'final_txt'));
  } catch {}
  const info = {
    building: job.building, room: job.room, created: new Date().toISOString(), jobId: job.id, view,
    photos: nImages, placed: rec.stats.images, colmap: { ...rec.stats, mode: rec.mode },
    training: { preset: job.preset || cfg.preset, steps: tr.iter, seconds: Math.round(tr.seconds), splats: crop ? crop.kept : tr.splats },
    crop: crop ? { removed: crop.removed, uncropped: tr.ply } : null,
    capture: job.capture || null, source: basename(job.source.file),
    sizeMB: +(statSync(finalPly).size / 1048576).toFixed(1),
  };
  writeFileSync(join(lib, 'info.json'), JSON.stringify(info, null, 2));
  // Map of where you can walk, so the viewer's walk mode opens straight away.
  try {
    await walkMapFor(finalPly, walkInputs({ jobDir: dir, mode: rec.mode, view }));
  } catch (e) {
    ctx.say('No walk map: ' + e.message);
  }
  ctx.stage('finish', 1);
  return { ply: finalPly, folder: lib, thumb: existsSync(thumb) ? thumb : null, info, totalSec: Math.round((Date.now() - t0) / 1000) };
}

function findImageFolder(root) {
  let best = null, bestN = 0;
  const walk = (d, depth) => {
    if (depth > 3) return;
    let n = 0;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(join(d, f.name), depth + 1);
      else if (/\.(jpe?g|png)$/i.test(f.name)) n++;
    }
    if (n > bestN) [best, bestN] = [d, n];
  };
  walk(root, 0);
  return best;
}

function pickThumb(dir) {
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  return files.length ? join(dir, files[Math.floor(files.length / 2)]) : null;
}

const safe = (s) => (s || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim().slice(0, 60) || 'Unknown';

export function libraryFolder(cfg, job) {
  const d = new Date(job.created);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return join(cfg.dirs.library, safe(job.building), safe(job.room), stamp);
}

export function guessNames(file) {
  // SplatScout export names: Building_Room_YYYYMMDD.zip
  const base = basename(file, extname(file));
  const m = /^(.*)_(\d{8})$/.exec(base);
  const core = m ? m[1] : base;
  const parts = core.split('_');
  if (parts.length >= 2) return { building: parts[0].replace(/-/g, ' '), room: parts.slice(1).join(' ') };
  return { building: 'Unsorted', room: core.replace(/_/g, ' ') };
}
