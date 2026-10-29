// Camera reconstruction with COLMAP (GPU SIFT + matching).
//  * Posed:   SplatScout AR poses are used as the starting cameras; COLMAP only triangulates
//             points and refines the poses (bundle adjustment). Robust for plain-walled rooms.
//  * Unposed: full structure-from-motion with COLMAP's global mapper (fast, GPU).
// Produces <out>/sparse/0 with PINHOLE cameras plus an images folder, ready for splat training.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run, capture } from './run.mjs';

/**
 * Where to start a viewer: the first photo's position/direction, plus the average "up" of all
 * cameras (robust world-up for both AR-posed and COLMAP-solved scenes).
 */
export async function viewHint(colmap, modelDir, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  await run(colmap, ['model_converter', '--input_path', modelDir, '--output_path', tmpDir, '--output_type', 'TXT']);
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(join(tmpDir, 'images.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const cams = [];
  for (let i = 0; i < lines.length; i += 2) {
    const p = lines[i].trim().split(/\s+/);
    if (p.length < 10) continue;
    const [qw, qx, qy, qz, tx, ty, tz] = p.slice(1, 8).map(Number);
    const R = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
      [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
      [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ];
    const C = [0, 1, 2].map((j) => -(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz));
    cams.push({ name: p[9], C, fwd: R[2], up: R[1].map((v) => -v) });
  }
  if (!cams.length) return null;
  cams.sort((a, b) => (a.name < b.name ? -1 : 1));
  const up = [0, 0, 0];
  const center = [0, 0, 0];
  for (const c of cams) for (let k = 0; k < 3; k++) {
    if (!c.name.startsWith('up/')) up[k] += c.up[k]; // a 360 frame's upward view is turned on its back
    center[k] += c.C[k] / cams.length;
  }
  const n = Math.hypot(...up) || 1;
  const first = cams[0];
  const r = (v) => v.map((x) => Math.round(x * 1000) / 1000);
  return {
    position: r(first.C),
    lookAt: r(first.C.map((v, k) => v + first.fwd[k] * 1.5)),
    up: r(up.map((v) => v / n)),
    center: r(center),
  };
}

/** Parse `colmap model_analyzer` output into numbers. */
export async function modelStats(colmap, modelDir) {
  try {
    const { stdout, stderr } = await capture(colmap, ['model_analyzer', '--path', modelDir], {
      env: { ...process.env, QT_PLUGIN_PATH: colmap.replace(/\\bin\\colmap\.exe$/i, '\\plugins') },
    });
    const s = stdout + stderr;
    const num = (re) => {
      const m = re.exec(s);
      return m ? parseFloat(m[1]) : 0;
    };
    return {
      images: num(/Registered images:\s*([\d.]+)/),
      points: num(/Points:\s*([\d.]+)/),
      observations: num(/Observations:\s*([\d.]+)/),
      reprojError: num(/Mean reprojection error:\s*([\d.]+)/),
    };
  } catch {
    return { images: 0, points: 0, observations: 0, reprojError: 0 };
  }
}

const isModel = (d) => existsSync(join(d, 'cameras.bin')) || existsSync(join(d, 'cameras.txt'));

/** Photos in a folder, including one level of subfolders (the views cut from 360 video). */
export function countImages(dir) {
  let n = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) n += readdirSync(join(dir, f.name)).filter((x) => /\.(jpe?g|png)$/i.test(x)).length;
    else if (/\.(jpe?g|png)$/i.test(f.name)) n++;
  }
  return n;
}

/** The sub-model with the most registered images in a mapper output folder. */
export async function largestModel(colmap, dir) {
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory() || !isModel(p)) continue;
    const st = await modelStats(colmap, p);
    if (!best || st.images > best.stats.images) best = { path: p, stats: st };
  }
  return best;
}

/**
 * Pairs to match, chosen from AR poses: temporal neighbours plus spatial neighbours that look in
 * a similar direction (catches loop closures between laps). Returns "a.jpg b.jpg" lines.
 */
export function posePairs(frames, { temporal = 10, spatial = 25, maxAngleDeg = 70 } = {}) {
  const n = frames.length;
  const pos = frames.map((f) => [f.pose[12], f.pose[13], f.pose[14]]);
  const fwd = frames.map((f) => [-f.pose[8], -f.pose[9], -f.pose[10]]);
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  const set = new Set();
  const add = (i, j) => {
    if (i === j) return;
    const a = Math.min(i, j), b = Math.max(i, j);
    set.add(a * 100000 + b);
  };
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= temporal && i + k < n; k++) add(i, i + k);
    const cands = [];
    for (let j = 0; j < n; j++) {
      if (Math.abs(i - j) <= temporal) continue;
      const c = fwd[i][0] * fwd[j][0] + fwd[i][1] * fwd[j][1] + fwd[i][2] * fwd[j][2];
      if (c < cosMax) continue;
      const d = Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1], pos[i][2] - pos[j][2]);
      cands.push([d + (1 - c) * 2, j]);
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (const [, j] of cands.slice(0, spatial)) add(i, j);
  }
  return [...set].map((k) => `${frames[Math.floor(k / 100000)].name} ${frames[k % 100000].name}`);
}

/**
 * @param {object} p
 * @param {string} p.colmap path to colmap.exe
 * @param {string} p.imagesDir folder with the photos
 * @param {string} p.work working folder for databases and models
 * @param {object|null} p.camera {model, params, single} camera hint
 * @param {object|null} p.posed {modelDir, frames:[{name, pose}]} AR prior, or null
 * @param {Array|null} [p.align] [{name, pose}] AR poses: an SfM solve is moved into their frame
 * @param {string} p.matcher auto | exhaustive | sequential
 * @param {object|null} [p.rig] views cut from 360 video: {config} COLMAP rig configuration; the
 *   images sit in one folder per view, and p.camera holds the views' exact (PINHOLE) lens
 * @param {(stage:string, fraction:number, note?:string)=>void} p.progress
 * @param {(msg:string)=>void} p.say
 * @param {object} p.token cancellation token
 * @param {string} p.log log file
 * @returns {Promise<{modelDir, stats, mode}>}
 */
export async function reconstruct(p) {
  const { colmap, imagesDir, work, camera, posed, rig, progress, say, token, log } = p;
  mkdirSync(work, { recursive: true });
  const db = join(work, 'database.db');
  if (existsSync(db)) rmSync(db);
  const nImages = countImages(imagesDir);
  if (nImages < 10) throw new Error(`Only ${nImages} images: at least 10 are needed (100+ recommended).`);

  // ---- 1. Features
  progress('features', 0, `${nImages} images`);
  say(`Extracting features from ${nImages} images (GPU)…`);
  const fx = ['feature_extractor', '--database_path', db, '--image_path', imagesDir,
    '--FeatureExtraction.use_gpu', '1', '--SiftExtraction.max_num_features', '8192'];
  if (rig) {
    fx.push('--ImageReader.camera_model', camera.model, '--ImageReader.camera_params', camera.params,
      '--ImageReader.single_camera_per_folder', '1');
  } else if (camera) {
    fx.push('--ImageReader.camera_model', camera.model, '--ImageReader.single_camera', camera.single ? '1' : '0');
    if (camera.params) fx.push('--ImageReader.camera_params', camera.params);
  } else {
    fx.push('--ImageReader.camera_model', 'SIMPLE_RADIAL', '--ImageReader.single_camera', '1');
  }
  let done = 0;
  await run(colmap, fx, {
    log, token,
    onLine: (l) => {
      const m = /Processed file \[(\d+)\/(\d+)\]/.exec(l);
      if (m) progress('features', +m[1] / +m[2]);
      else if (/Processed file/.test(l)) progress('features', Math.min(0.99, ++done / nImages));
    },
  });

  if (rig) {
    // Group the views of each 360 frame into one rig frame (same file name in every view folder).
    const cfg = join(work, 'rig.json');
    writeFileSync(cfg, JSON.stringify(rig.config, null, 2));
    await run(colmap, ['rig_configurator', '--database_path', db, '--rig_config_path', cfg], { log, token });
  }

  // ---- 2. Matching
  progress('matching', 0);
  let mode = p.matcher;
  if (mode === 'auto') mode = rig ? 'sequential' : nImages <= 700 ? 'exhaustive' : posed ? 'poses' : 'sequential';
  say(`Matching features (${mode === 'poses' ? 'pairs chosen from AR poses' : mode})…`);
  const onMatch = (l) => {
    // Exhaustive matching works in blocks: "Processing block [i/n, j/n]".
    const b = /block \[(\d+)\/(\d+),\s*(\d+)\/(\d+)\]/.exec(l);
    if (b) return progress('matching', ((+b[1] - 1) * +b[4] + +b[3]) / (+b[2] * +b[4]));
    const m = /\[(\d+)\/(\d+)\]/.exec(l);
    if (m) progress('matching', +m[1] / +m[2]);
  };
  if (mode === 'exhaustive') {
    await run(colmap, ['exhaustive_matcher', '--database_path', db, '--FeatureMatching.use_gpu', '1'], { log, token, onLine: onMatch });
  } else if (mode === 'poses') {
    const pairsFile = join(work, 'pairs.txt');
    writeFileSync(pairsFile, posePairs(posed.frames).join('\n') + '\n');
    await run(colmap, ['matches_importer', '--database_path', db, '--match_list_path', pairsFile, '--match_type', 'pairs',
      '--FeatureMatching.use_gpu', '1'], { log, token, onLine: onMatch });
  } else {
    // With a rig, each neighbouring frame brings all of its views along (expand_rig_images), so
    // fewer neighbours cover the same ground.
    await run(colmap, ['sequential_matcher', '--database_path', db, '--FeatureMatching.use_gpu', '1',
      '--SequentialMatching.overlap', rig ? '8' : '25', '--SequentialMatching.quadratic_overlap', '1'], { log, token, onLine: onMatch });
  }

  // ---- 3. Cameras + points
  let result = null;
  if (posed) {
    result = await posedReconstruction(p, db, nImages);
    if (!result) say('AR-pose reconstruction was weak; falling back to full structure-from-motion.');
  }
  if (!result) result = await unposedReconstruction(p, db, nImages);

  // ---- 4. Undistort to PINHOLE when the camera model has lens distortion
  const out = join(work, 'final');
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  if (result.needsUndistort) {
    progress('undistort', 0);
    say('Undistorting images for training…');
    const und = join(work, 'undistorted');
    if (existsSync(und)) rmSync(und, { recursive: true, force: true });
    await run(colmap, ['image_undistorter', '--image_path', imagesDir, '--input_path', result.modelDir,
      '--output_path', und, '--output_type', 'COLMAP'], { log, token });
    // image_undistorter writes sparse/ directly; trainers expect sparse/0.
    const s0 = join(und, 'sparse', '0');
    mkdirSync(s0, { recursive: true });
    for (const f of readdirSync(join(und, 'sparse'))) {
      if (f !== '0') renameSync(join(und, 'sparse', f), join(s0, f));
    }
    progress('undistort', 1);
    return { modelDir: s0, imagesDir: join(und, 'images'), stats: result.stats, mode: result.mode, undistorted: true };
  }
  return { modelDir: result.modelDir, imagesDir, stats: result.stats, mode: result.mode, undistorted: false };
}

async function posedReconstruction(p, db, nImages) {
  const { colmap, imagesDir, work, posed, progress, say, token, log } = p;
  say(`Triangulating with ${posed.frames.length} AR camera poses…`);
  progress('mapping', 0.05, 'AR poses');
  const tri1 = join(work, 'posed_tri'), ba1 = join(work, 'posed_ba'), tri2 = join(work, 'posed_tri2'), reg = join(work, 'posed_reg');
  for (const d of [tri1, ba1, tri2, reg]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
  try {
    await run(colmap, ['point_triangulator', '--database_path', db, '--image_path', imagesDir, '--input_path', posed.modelDir,
      '--output_path', tri1, '--clear_points', '1', '--refine_intrinsics', '0'], { log, token });
    progress('mapping', 0.3, 'refining poses');
    say('Refining the AR poses (bundle adjustment)…');
    await run(colmap, ['bundle_adjuster', '--input_path', tri1, '--output_path', ba1,
      '--BundleAdjustment.refine_principal_point', '0'], { log, token });
    progress('mapping', 0.55, 're-triangulating');
    await run(colmap, ['point_triangulator', '--database_path', db, '--image_path', imagesDir, '--input_path', ba1,
      '--output_path', tri2, '--clear_points', '1', '--refine_intrinsics', '0'], { log, token });
    let model = tri2;
    // Photos without an AR pose (other AR sessions, tracking lost) are registered by COLMAP.
    if (posed.frames.length < nImages) {
      progress('mapping', 0.7, 'adding photos without AR poses');
      say(`Registering ${nImages - posed.frames.length} photos that had no AR pose…`);
      await run(colmap, ['image_registrator', '--database_path', db, '--input_path', tri2, '--output_path', reg], { log, token });
      model = reg;
    }
    progress('mapping', 0.85, 'final refinement');
    const fin = join(work, 'posed_final');
    if (existsSync(fin)) rmSync(fin, { recursive: true, force: true });
    mkdirSync(fin, { recursive: true });
    await run(colmap, ['bundle_adjuster', '--input_path', model, '--output_path', fin,
      '--BundleAdjustment.refine_principal_point', '0'], { log, token });
    const stats = await modelStats(colmap, fin);
    say(`AR-pose model: ${stats.images}/${nImages} photos, ${stats.points} points, ${stats.reprojError.toFixed(2)} px error.`);
    progress('mapping', 1);
    if (stats.images < nImages * 0.6 || stats.points < 2000 || stats.reprojError > 2.5) return null;
    return { modelDir: fin, stats, mode: 'ar-poses', needsUndistort: false };
  } catch (e) {
    if (e.cancelled) throw e;
    say('AR-pose reconstruction failed: ' + e.message.split('\n')[0]);
    return null;
  }
}

async function unposedReconstruction(p, db, nImages) {
  const { colmap, imagesDir, work, camera, progress, say, token, log } = p;
  const sfm = join(work, 'sfm');
  if (existsSync(sfm)) rmSync(sfm, { recursive: true, force: true });
  mkdirSync(sfm, { recursive: true });
  say('Solving camera positions (COLMAP global mapper)…');
  progress('mapping', 0.05, 'structure-from-motion');
  // Views cut from 360 frames have an exact lens and a known turn between them: keep both fixed.
  const fixed = p.rig ? ['--GlobalMapper.refine_sensor_from_rig', '0', '--GlobalMapper.ba_refine_focal_length', '0',
    '--GlobalMapper.ba_refine_extra_params', '0'] : [];
  await run(colmap, ['global_mapper', '--database_path', db, '--image_path', imagesDir, '--output_path', sfm, ...fixed], {
    log, token,
    onLine: (l) => {
      if (/rotation averaging/i.test(l)) progress('mapping', 0.25, 'rotation averaging');
      else if (/track/i.test(l) && /establish/i.test(l)) progress('mapping', 0.4, 'building tracks');
      else if (/global positioning/i.test(l)) progress('mapping', 0.55, 'global positioning');
      else if (/bundle adjustment/i.test(l)) progress('mapping', 0.75, 'bundle adjustment');
      else if (/retriangulat/i.test(l)) progress('mapping', 0.9, 'retriangulation');
    },
  });
  const best = await largestModel(colmap, sfm);
  if (!best || best.stats.images < 10) {
    throw new Error('COLMAP could not reconstruct this capture. Check for blur, blank walls, or gaps in overlap.');
  }
  if (best.stats.images < nImages * 0.8) {
    say(`Warning: only ${best.stats.images} of ${nImages} photos were placed. The capture probably has a gap in overlap.`);
  }
  const aligned = join(work, 'sfm_aligned');
  if (existsSync(aligned)) rmSync(aligned, { recursive: true, force: true });
  mkdirSync(aligned, { recursive: true });
  let modelDir = best.path;
  let mode = 'sfm';
  // With phone AR poses: move the model into the AR frame (metric scale, gravity up, same
  // coordinates as the scan area). Otherwise level it (Manhattan world) so viewers start upright.
  if (p.align && p.align.length >= 10) {
    try {
      progress('mapping', 0.95, 'aligning to the phone\'s AR frame');
      const ref = join(work, 'ar_centres.txt');
      writeFileSync(ref, p.align.map((f) => `${f.name} ${f.pose[12]} ${f.pose[13]} ${f.pose[14]}`).join('\n') + '\n');
      await run(colmap, ['model_aligner', '--input_path', best.path, '--output_path', aligned, '--ref_images_path', ref,
        '--ref_is_gps', '0', '--alignment_type', 'custom', '--alignment_max_error', '0.3'], { log, token });
      if (existsSync(join(aligned, 'images.bin')) || existsSync(join(aligned, 'images.txt'))) {
        modelDir = aligned;
        mode = 'sfm-ar';
        say('Aligned the solve to the phone\'s AR coordinates.');
      }
    } catch (e) {
      if (e.cancelled) throw e;
    }
  }
  if (mode === 'sfm') {
    try {
      progress('mapping', 0.95, 'levelling the scene');
      await run(colmap, ['model_orientation_aligner', '--image_path', imagesDir, '--input_path', best.path, '--output_path', aligned,
        '--method', 'MANHATTAN-WORLD'], { log, token });
      modelDir = aligned;
    } catch (e) {
      if (e.cancelled) throw e;
    }
  }
  progress('mapping', 1);
  say(`Model: ${best.stats.images}/${nImages} photos, ${best.stats.points} points, ${best.stats.reprojError.toFixed(2)} px error.`);
  const model = camera ? camera.model : 'SIMPLE_RADIAL';
  return { modelDir, stats: best.stats, mode, needsUndistort: !/PINHOLE/.test(model) };
}
