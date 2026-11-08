// One job = one capture → one splat. Stages: import → features → matching → mapping →
// (undistort) → train → finish. Progress and messages go through `ctx.update`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, symlinkSync, linkSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { extractZip } from './zipread.mjs';
import { reconstruct, viewHint, countImages } from './colmap.mjs';
import { trainBrush, HOLD_OUT_EVERY } from './trainer.mjs';
import { selectFrames, extractFrames, probeVideo, isEquirect, extract360, viewSize, rigConfig, VIEWS_360 } from './video.mjs';
import { run } from './run.mjs';
import { cropPly, CROP_MARGIN } from './crop.mjs';
import { walkInputs, walkMapFor, readCameras } from './walkmap.mjs';
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
const MAX_360_FRAMES = 160; // × 9 views each

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
  const t0 = Date.now();

  if (!T.colmap) throw new Error('COLMAP was not found. Set tools.colmap in station.config.json.');
  if (!T.brush) throw new Error('Brush was not found. Set tools.brush in station.config.json.');

  // ---------------------------------------------------------------- import
  ctx.stage('import', 0);
  if (existsSync(dataset)) rmSync(dataset, { recursive: true, force: true });
  let src;
  if (job.source.kind === 'merge') {
    src = await prepareMerge(job, dataset, ctx, log);
  } else {
    src = await prepareSource(job.source, dataset, ctx, { log, usePoses: cfg.usePoses && job.usePoses !== false, progress: (f) => ctx.stage('import', f) });
    ctx.update({ pano: src.pano });
  }
  const { photos, nImages, manifest, camera, rig, posed, arFrames } = src;
  if (manifest) {
    const c = manifest.capture || {};
    ctx.update({
      building: c.building || job.building,
      room: c.room || job.room,
      floor: c.floor || job.floor || '',
      capture: { grade: manifest.score && manifest.score.grade, score: manifest.score && manifest.score.score, engine: c.engine, tracking: c.tracking, author: c.author },
      // A member's scan from the club database: its row, so the club's review can approve the splat built from it.
      club: manifest.club && manifest.club.id ? { id: manifest.club.id, buildingCode: manifest.club.buildingCode || null, contributor: manifest.club.contributor || null, grade: manifest.club.grade || null } : null,
    });
  }
  ctx.update({ nImages });
  ctx.stage('import', 1, `${nImages} photos`);
  if (posed) ctx.say(`Using AR poses for ${posed.frames.length} of ${nImages} photos as a starting point.`);

  // ---------------------------------------------------------------- reconstruction
  const rec = await reconstruct({
    colmap: T.colmap,
    imagesDir: photos,
    work: join(dir, 'colmap'),
    camera,
    posed,
    rig,
    parts: src.parts || null,
    lenses: src.lenses || null,
    segments: src.segments || null,
    align: arFrames,
    matcher: cfg.matcher || 'auto',
    progress: (stage, f, note) => ctx.stage(stage, f, note),
    say: ctx.say,
    token,
    log,
  });
  ctx.stage('mapping', 1, `${rec.stats.images}/${nImages} photos placed · ${(rec.stats.reprojError || 0).toFixed(2)} px`);
  ctx.update({ colmap: { ...rec.stats, mode: rec.mode } });
  // A scan in parts: how much of each part made it into the one model.
  let partsPlaced = null;
  if (src.segments) {
    const inModel = new Set(readCameras(rec.modelDir).map((c) => c.name));
    partsPlaced = src.segments.map((s) => ({ part: s.part, main: s.main, photos: s.names.length, placed: s.names.filter((n) => inModel.has(n)).length }));
    ctx.say(`Scan in ${partsPlaced.length} parts, solved as one: ${partsPlaced.map((s) => `part ${s.part}${s.main ? ' (main)' : ''} ${s.placed} of ${s.photos} photos`).join(', ')}.`);
  }
  if (!rec.undistorted) ctx.stage('undistort', 1, 'not needed');

  // ---------------------------------------------------------------- training dataset
  const train = join(dir, 'train');
  if (existsSync(train)) rmSync(train, { recursive: true, force: true });
  mkdirSync(join(train, 'sparse', '0'), { recursive: true });
  try {
    symlinkSync(rec.imagesDir, join(train, 'images'), 'junction');
  } catch {
    cpSync(rec.imagesDir, join(train, 'images'), { recursive: true });
  }
  for (const f of readdirSync(rec.modelDir)) {
    if (/\.(bin|txt)$/.test(f)) copyFileSync(join(rec.modelDir, f), join(train, 'sparse', '0', f));
  }

  // ---------------------------------------------------------------- training
  const preset = PRESETS[job.preset] || PRESETS[cfg.preset] || PRESETS.standard;
  // Measuring quality holds every 12th photo back from training and scores the splat on them.
  const measure = job.measure != null ? !!job.measure : !!cfg.measureQuality;
  ctx.stage('train', 0, preset.label);
  ctx.say(`Training the splat on the GPU (${preset.steps.toLocaleString()} steps)${measure ? `, holding back every ${HOLD_OUT_EVERY}th photo to measure its quality` : ''}…`);
  const out = join(dir, 'splats');
  const presetKey = PRESETS[job.preset] ? job.preset : cfg.preset;
  const tr = await trainBrush({
    brush: T.brush,
    dataset: train,
    outDir: out,
    preset,
    nImages: rec.stats.images,
    holdOut: measure ? HOLD_OUT_EVERY : 0,
    stepsPerSec: cfg.rates && cfg.rates[presetKey],
    cacheDir: join(cfg.workDir, 'brush-cache'),
    progress: (f, note) => ctx.stage('train', f, note),
    onExport: (file, iter) => ctx.update({ preview: { file, iter, at: Date.now() } }),
    token,
    log,
  });
  if (measure) {
    ctx.say(tr.eval
      ? `Measured on ${tr.eval.views} photos held back from training: PSNR ${tr.eval.psnr.toFixed(1)} dB, SSIM ${tr.eval.ssim.toFixed(3)}.`
      : 'Brush didn’t report a quality score, so this splat has no measurement (see job.log).');
  }

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
  // Scan areas in the splat's coordinates: the capture's own, or every merged phone's, moved into
  // the main phone's AR frame.
  let areas = [];
  if (/^(ar-poses|sfm-ar)$/.test(rec.mode)) {
    if (src.parts) areas = partAreas(src.parts, readCameras(rec.modelDir));
    else if (manifest && manifest.bounds && manifest.bounds.poly && manifest.bounds.poly.length >= 3) areas = [manifest.bounds];
    // A scan in parts: the splat is in the main part's coordinates, like its outline; an outline marked in another
    // part is moved in by where that part's photos ended up.
    if (src.segments) areas.push(...partAreas(src.segments.filter((s) => !s.main), readCameras(rec.modelDir)));
  }
  if (src.parts) writeFileSync(join(dataset, 'merge.json'), JSON.stringify({ areas }, null, 1));
  const cropOn = job.crop != null ? job.crop : cfg.cropToBounds !== false;
  if (cropOn && areas.length) {
    try {
      crop = cropPly(tr.ply, finalPly, areas, CROP_MARGIN, { outside: join(lib, 'scene.outside.ply') });
      ctx.say(`Cropped to the scan area: removed ${crop.removed.toLocaleString()} of ${(crop.kept + crop.removed).toLocaleString()} small splats outside it (kept beside it, so the crop can be changed in the viewer).`);
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
    training: {
      preset: job.preset || cfg.preset, steps: tr.iter, seconds: Math.round(tr.seconds), splats: crop ? crop.kept : tr.splats,
      // Measured quality on the held-back photos: {psnr (dB), ssim (0–1), views, step, every}.
      ...(tr.eval ? { eval: tr.eval } : {}),
    },
    // The outline the crop used (in splat coordinates), so the viewer can show and change it.
    crop: crop ? { removed: crop.removed, margin: CROP_MARGIN, areas: areas.map((a) => ({ poly: a.poly, floorY: a.floorY, top: a.top ?? null })), uncropped: tr.ply } : areas.length ? { off: true, margin: CROP_MARGIN, areas: areas.map((a) => ({ poly: a.poly, floorY: a.floorY, top: a.top ?? null })) } : null,
    capture: job.capture || null, pano: !!job.pano,
    level: job.floor || '', // the building floor it was tagged with ('2'); `floor` below is the walk map's measured floor
    club: job.club || null, // a member's scan: the club reviews the splat before it goes on the campus map
    source: job.source.kind === 'merge' ? job.source.name : basename(job.source.file),
    merged: src.parts ? src.parts.map((p) => ({ name: p.name, photos: p.names.length, ar: !!(p.frames && p.frames.length) })) : undefined,
    scanParts: partsPlaced || undefined, // a scan in parts (tracking was lost): each part's photos and how many were placed
    sizeMB: +(statSync(finalPly).size / 1048576).toFixed(1),
  };
  writeFileSync(join(lib, 'info.json'), JSON.stringify(info, null, 2));
  // Map of where you can walk, so the viewer's walk mode opens straight away.
  try {
    const walk = await walkMapFor(finalPly, walkInputs({ jobDir: dir, mode: rec.mode, view, pano: !!job.pano, areas: info.crop && info.crop.areas }));
    // In metres (lined up with the phone's AR tracking), the map also measures the space's floor: what the
    // Campus page counts when there's no scan outline (club photos taken with Track position, for one).
    if (walk && walk.metric && walk.stats && walk.stats.floorArea >= 1) {
      info.floor = { area: Math.round(walk.stats.floorArea), from: 'walk map' };
      writeFileSync(join(lib, 'info.json'), JSON.stringify(info, null, 2));
      if (!areas.length) ctx.say(`Measured on the splat: about ${info.floor.area} m² of floor where the photos were taken.`);
    }
  } catch (e) {
    ctx.say('No walk map: ' + e.message);
  }
  ctx.stage('finish', 1);
  return { ply: finalPly, folder: lib, thumb: existsSync(thumb) ? thumb : null, info, totalSec: Math.round((Date.now() - t0) / 1000) };
}

/**
 * Unpack one capture (SplatScout ZIP, ZIP of photos, phone or 360° video) into `outDir` and work
 * out what's known about it: lens, AR poses, scan area.
 * @returns {Promise<{photos, nImages, manifest, camera, rig, pano, posed, arFrames}>}
 */
async function prepareSource(source, outDir, ctx, { log, usePoses = true, progress = () => {} }) {
  const T = ctx.cfg.tools, token = ctx.token;
  const imagesDir = join(outDir, 'images');
  let manifest = null, camera = null, rig = null, pano = false, photos = imagesDir;
  if (source.kind === 'zip') {
    ctx.say('Unpacking capture…');
    await extractZip(source.file, outDir, { onProgress: (f) => progress(f * 0.9) });
    const mf = join(outDir, 'splatscout.json');
    if (existsSync(mf)) manifest = JSON.parse(readFileSync(mf, 'utf8'));
    if (!existsSync(imagesDir)) {
      // A plain zip of photos: find the folder that holds the images.
      photos = findImageFolder(outDir);
      if (!photos) throw new Error('No photos found in the ZIP.');
    }
  } else if (source.kind === 'video') {
    if (!T.ffmpeg || !T.ffprobe) throw new Error('ffmpeg/ffprobe are needed for video input.');
    pano = isEquirect(await probeVideo(T.ffprobe, source.file));
    ctx.say(pano ? 'Analysing 360° video for sharp frames…' : 'Analysing video for sharp, well-spaced frames…');
    const sel = await selectFrames({ ffmpeg: T.ffmpeg, ffprobe: T.ffprobe, file: source.file, maxFrames: pano ? MAX_360_FRAMES : 450,
      every: pano ? 0.5 : 0, progress: (f) => progress(f * 0.6), token, log });
    const hdr = sel.info.hdr ? ' (HDR video tone-mapped)' : '';
    if (pano) {
      const size = viewSize(sel.info);
      ctx.say(`360° video: selected ${sel.selected.length} of ${sel.total} frames${hdr}. Cutting each into ${VIEWS_360.length} views of ${size}×${size} px…`);
      await extract360({ ffmpeg: T.ffmpeg, file: source.file, frames: sel.selected, info: sel.info, outDir: imagesDir, size, token, log });
      const f = (size / 2).toFixed(4); // 90° view: focal length is half the width
      camera = { model: 'PINHOLE', params: [f, f, f, f].join(','), single: false };
      rig = { config: rigConfig(VIEWS_360) };
    } else {
      ctx.say(`Selected ${sel.selected.length} of ${sel.total} frames${hdr}. Extracting…`);
      await extractFrames({ ffmpeg: T.ffmpeg, file: source.file, frames: sel.selected, info: sel.info, outDir: imagesDir, token, log });
    }
  }
  const nImages = countImages(photos);

  // Camera hint & AR poses
  let posed = null, lenses = null, segments = null;
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
      // Club photos say which lens each has: one camera per lens (see lensGroups).
      if (manifest.frames.some((f) => f.lens)) lenses = lensGroups(manifest.frames);
    }
    const sparseIn = join(outDir, 'poses', 'colmap', 'sparse', '0');
    if (tracking === '6dof' && existsSync(join(sparseIn, 'images.txt'))) {
      const names = new Set(
        readFileSync(join(sparseIn, 'images.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 10).map((p) => p[9]),
      );
      const frames = manifest.frames.filter((f) => f.pose && names.has(basename(f.file))).map((f) => ({ name: basename(f.file), pose: f.pose }));
      if (frames.length >= 10) arFrames = frames;
      // Club photos: one outing's AR poses, with other photos placed around them (see posedReconstruction's `hold`).
      if (usePoses && frames.length >= 20) posed = { modelDir: sparseIn, frames, hold: (manifest.capture && manifest.capture.engine) === 'club-photos' };
    }
    // A scan in parts (tracking was lost, and it carried on as a new part): the main part's poses are the ones
    // above; the others are joined to it (colmap.mjs segmentPairs, fitPart).
    if (tracking === '6dof') segments = scanParts(manifest, arFrames);
  }
  return { photos, nImages, manifest, camera, rig, pano, posed, arFrames, lenses, segments };
}

/**
 * A scan's parts from its manifest: its photos by AR coordinates (`space`; SplatScout 2.7 also lists `parts`),
 * the main part first (the one whose poses are in poses/colmap/sparse/0, else the biggest), each with its photos'
 * AR poses in its own coordinates and its own scan outline. Null for a scan in one part.
 * @param {object} manifest splatscout.json
 * @param {Array<{name}>|null} mainFrames the photos with poses in poses/colmap/sparse/0
 * @returns {Array<{part, space, names: string[], frames: Array<{name, pose}>, main: boolean, bounds}>|null}
 */
export function scanParts(manifest, mainFrames) {
  const frames = (manifest.frames || []).filter((f) => f.file);
  const spaceOf = (f) => (f.space != null ? f.space : f.segment != null ? f.segment * 100 : null);
  const groups = new Map();
  for (const f of frames) {
    const s = spaceOf(f);
    if (s == null) return null;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(f);
  }
  if (groups.size < 2) return null;
  const listed = new Map(((manifest.parts || [])).map((p) => [p.space, p]));
  const mainNames = new Set((mainFrames || []).map((f) => f.name));
  let main = [...groups].find(([, fs]) => fs.some((f) => mainNames.has(basename(f.file))));
  if (!main) main = [...groups].sort((a, b) => b[1].filter((f) => f.tracked).length - a[1].filter((f) => f.tracked).length)[0];
  const ok = (b) => (b && b.poly && b.poly.length >= 3 ? b : null);
  const parts = [...groups].map(([space, fs], i) => ({
    part: (listed.get(space) && listed.get(space).part) || i + 1,
    space,
    names: fs.map((f) => basename(f.file)),
    frames: fs.filter((f) => f.tracked && f.pose).map((f) => ({ name: basename(f.file), pose: f.pose })),
    main: space === main[0],
    bounds: ok(listed.get(space) && listed.get(space).bounds) || (space === main[0] ? ok(manifest.bounds) : null),
  }));
  return parts.sort((a, b) => b.main - a.main || a.part - b.part);
}

/**
 * A capture's photos grouped by lens, for COLMAP: an exact lens (an AR camera's, from club photos taken with
 * Track position) is a PINHOLE camera kept as it is; a guess (ordinary photos from one phone) is a SIMPLE_RADIAL
 * camera COLMAP refines; photos with neither each get their own. Sharing the exact lens matters: a photo from
 * another AR session then only needs a position, where on its own camera COLMAP starts its lens from a default
 * 1.2 × the image size (2,304 px for the Pixel's 1,374) and can settle somewhere wrong.
 * @returns {Array<{names: string[], camera: {model: string, params: string|null, single: boolean}}>}
 */
export function lensGroups(frames) {
  const groups = new Map();
  for (const f of frames) {
    const i = f.intrinsics, kind = i && (f.lens === 'exact' || f.lens === 'guess') ? f.lens : 'own';
    const key = kind === 'own' ? 'own' : `${kind}|${[i.w, i.h, i.fx, i.fy, i.cx, i.cy].map((v) => (+v).toFixed(1)).join('|')}`;
    if (!groups.has(key)) {
      const p = (vals) => vals.map((v) => (+v).toFixed(4)).join(',');
      groups.set(key, {
        names: [],
        camera: kind === 'exact' ? { model: 'PINHOLE', params: p([i.fx, i.fy, i.cx, i.cy]), single: true }
          : kind === 'guess' ? { model: 'SIMPLE_RADIAL', params: p([(i.fx + i.fy) / 2, i.cx, i.cy, 0]), single: true }
          : { model: 'SIMPLE_RADIAL', params: null, single: false },
      });
    }
    groups.get(key).names.push(basename(f.file));
  }
  return [...groups.values()];
}

/**
 * Captures of the same place from several phones, merged into one splat. Each is unpacked on its
 * own, then its photos go into images/p1/, images/p2/ … (hard links, no copying). COLMAP solves
 * them all together; the result is put into the AR frame of the capture with the most AR poses
 * (real size, level floor), so captures without AR (an iPhone in camera mode, a video) gain both.
 */
async function prepareMerge(job, dataset, ctx, log) {
  const parts = [];
  const all = job.source.parts;
  const imagesDir = join(dataset, 'images');
  for (const [i, part] of all.entries()) {
    const tag = `p${i + 1}`;
    ctx.say(`Capture ${i + 1} of ${all.length}: ${part.name}`);
    const s = await prepareSource(part, join(dataset, 'parts', tag), ctx, {
      log, usePoses: false, progress: (f) => ctx.stage('import', ((i + f) / all.length) * 0.95),
    });
    if (s.rig) throw new Error(`${part.name} is a 360° video: those can't be merged with other captures yet.`);
    // Photo names as COLMAP will know them: images/<tag>/<name>, no spaces (they'd break pair lists).
    const rename = new Map();
    mkdirSync(join(imagesDir, tag), { recursive: true });
    for (const f of readdirSync(s.photos).filter((x) => /\.(jpe?g|png)$/i.test(x)).sort()) {
      const name = `${tag}/${f.replace(/\s+/g, '_')}`;
      rename.set(f, name);
      try {
        linkSync(join(s.photos, f), join(dataset, 'images', name));
      } catch {
        copyFileSync(join(s.photos, f), join(dataset, 'images', name));
      }
    }
    const frames = s.arFrames ? s.arFrames.filter((f) => rename.has(f.name)).map((f) => ({ name: rename.get(f.name), pose: f.pose })) : null;
    parts.push({
      tag, name: part.name, names: [...rename.values()], camera: s.camera, frames,
      bounds: s.manifest && s.manifest.bounds && s.manifest.bounds.poly && s.manifest.bounds.poly.length >= 3 ? s.manifest.bounds : null,
    });
    if (i === 0 && s.manifest && s.manifest.capture) ctx.update({ building: s.manifest.capture.building || job.building });
  }
  // The capture with the most AR poses sets the coordinates.
  const ref = parts.filter((p) => p.frames && p.frames.length >= 10).sort((a, b) => b.frames.length - a.frames.length)[0];
  ctx.say(ref
    ? `Merging ${parts.length} captures in the AR coordinates of ${ref.name} (${ref.frames.length} AR poses).`
    : `Merging ${parts.length} captures. None has AR poses, so the splat's size and level will be estimated.`);
  const nImages = parts.reduce((a, p) => a + p.names.length, 0);
  return { photos: imagesDir, nImages, manifest: null, camera: null, rig: null, pano: false, posed: null, arFrames: ref ? ref.frames : null, parts };
}

/**
 * Each merged capture's scan area, moved into the splat's coordinates: its AR camera positions
 * against where the solve put the same photos give a level turn, a scale and a shift (both frames
 * are AR frames, so gravity already agrees).
 */
export function partAreas(parts, cams) {
  const byName = new Map(cams.map((c) => [c.name, c.C]));
  const out = [];
  for (const part of parts) {
    if (!part.bounds || !part.frames) continue;
    const pairs = part.frames.filter((f) => byName.has(f.name)).map((f) => [[f.pose[12], f.pose[13], f.pose[14]], byName.get(f.name)]);
    if (pairs.length < 5) continue;
    const xf = levelSimilarity(pairs);
    const b = part.bounds;
    out.push({ ...b, poly: b.poly.map(([x, z]) => xf.apply2(x, z)), floorY: xf.y(b.floorY), top: b.top == null ? null : xf.y(b.top), skips: [] });
  }
  return out;
}

/** Best turn about the vertical, scale and shift taking points a to points b ([[a, b], …]). */
export function levelSimilarity(pairs) {
  const n = pairs.length;
  let ax = 0, az = 0, bx = 0, bz = 0, ay = 0, by = 0;
  for (const [a, b] of pairs) {
    ax += a[0] / n; az += a[2] / n; ay += a[1] / n;
    bx += b[0] / n; bz += b[2] / n; by += b[1] / n;
  }
  // Complex least squares on the floor plane: (b - b̄) ≈ k (a - ā), k = s·e^{iθ}.
  let re = 0, im = 0, aa = 0;
  for (const [a, b] of pairs) {
    const px = a[0] - ax, pz = a[2] - az, qx = b[0] - bx, qz = b[2] - bz;
    re += px * qx + pz * qz;
    im += px * qz - pz * qx;
    aa += px * px + pz * pz;
  }
  const kr = aa ? re / aa : 1, ki = aa ? im / aa : 0;
  const s = Math.hypot(kr, ki) || 1;
  return {
    s, theta: Math.atan2(ki, kr),
    apply2: (x, z) => [bx + kr * (x - ax) - ki * (z - az), bz + ki * (x - ax) + kr * (z - az)],
    y: (y) => by + s * (y - ay),
  };
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
  if (files.length) return join(dir, files[Math.floor(files.length / 2)]);
  // Views cut from 360 video: the forward-looking folder.
  const sub = readdirSync(dir, { withFileTypes: true }).filter((f) => f.isDirectory()).map((f) => f.name).sort()[0];
  return sub ? pickThumb(join(dir, sub)) : null;
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
