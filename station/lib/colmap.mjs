// Camera reconstruction with COLMAP (GPU SIFT + matching).
//  * Posed:   SplatScout AR poses are used as the starting cameras; COLMAP only triangulates
//             points and refines the poses (bundle adjustment). Robust for plain-walled rooms.
//  * Unposed: full structure-from-motion with COLMAP's global mapper (fast, GPU).
// Produces <out>/sparse/0 with PINHOLE cameras plus an images folder, ready for splat training.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync, statSync } from 'node:fs';
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
 * Pairs to match from AR poses. When only some photos have one (club photos from several outings, where one
 * outing's poses set the coordinates), the others are matched along their own order and against an evenly
 * thinned set of the posed ones, as if they were another capture being merged.
 * @param {Array<{name, pose}>} frames the photos with an AR pose
 * @param {string[]} names every photo
 */
export function posedPairs(frames, names) {
  const posed = new Set(frames.map((f) => f.name));
  const rest = names.filter((n) => !posed.has(n));
  if (rest.length <= names.length * 0.1) return posePairs(frames);
  return mergePairs([{ names: frames.map((f) => f.name), frames }, { names: rest }]);
}

// COLMAP's camera models by the number its database stores, and an undistorted lens (fx, fy, cx, cy) in each.
const CAMERA_MODEL = ['SIMPLE_PINHOLE', 'PINHOLE', 'SIMPLE_RADIAL', 'RADIAL', 'OPENCV'];
const lensAs = (model, [fx, fy, cx, cy]) => {
  const f = (fx + fy) / 2;
  return { SIMPLE_PINHOLE: [f, cx, cy], PINHOLE: [fx, fy, cx, cy], SIMPLE_RADIAL: [f, cx, cy, 0], RADIAL: [f, cx, cy, 0, 0], OPENCV: [fx, fy, cx, cy, 0, 0, 0, 0] }[model] || null;
};

/**
 * The AR pose model under COLMAP's own numbering. point_triangulator needs each image in it under the id the
 * database gave that photo, with the database's camera, rig and frame ids too: any other numbering stops it
 * with "Check failed: existing_frame.DataIds() == frame.DataIds()". The phone numbers its model 1, 2, 3 … over
 * the photos it has poses for, which matches only while every photo has one. Each camera must also be the
 * database's kind of camera ("Check failed: existing_camera.model_id == camera.model_id"): when the photos'
 * lenses differ, the database gives every photo its own SIMPLE_RADIAL camera, so the AR lens is written that
 * way, with no distortion. Photos the database doesn't have, or has at another size, are left out.
 * @param {{cameras: string, images: string}} model the model's cameras.txt and images.txt
 * @param {Array<{image_id: number, name: string, camera_id: number, camera_model?: number, width?: number, height?: number, frame_id?: number, rig_id?: number}>} rows the database's images
 * @returns {{cameras: string, images: string, rigs: string, frames: string, points3D: string, kept: number, dropped: number}}
 */
export function renumberModel(model, rows) {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const camLine = new Map();
  for (const l of model.cameras.split(/\r?\n/)) {
    const p = l.trim().split(/\s+/);
    if (l.startsWith('#') || p.length < 5) continue;
    camLine.set(p[0], p.slice(1)); // MODEL WIDTH HEIGHT PARAMS…
  }
  /** The model's camera as the database's camera of this photo, or null when it can't be. */
  const asDatabase = (c, db) => {
    if (db.camera_model == null) return c.join(' '); // (a database we couldn't read cameras from: as it is)
    const kind = CAMERA_MODEL[db.camera_model];
    if (!kind || +c[1] !== db.width || +c[2] !== db.height) return null;
    if (kind === c[0]) return c.join(' ');
    const params = c[0] === 'PINHOLE' ? lensAs(kind, c.slice(3, 7).map(Number)) : null;
    return params ? [kind, c[1], c[2], ...params.map((v) => +v.toFixed(6))].join(' ') : null;
  };
  const lines = model.images.split(/\r?\n/).filter((l) => !l.startsWith('#'));
  const cams = new Map(), rigs = new Map();
  let images = '', frames = '', kept = 0, dropped = 0;
  for (let i = 0; i < lines.length; i += 2) {
    const p = lines[i].trim().split(/\s+/);
    if (p.length < 10) continue;
    const name = p.slice(9).join(' '), db = byName.get(name), cam = camLine.get(p[8]) && db && asDatabase(camLine.get(p[8]), db);
    if (!db || !cam) {
      dropped++;
      continue;
    }
    const camId = db.camera_id, rigId = db.rig_id ?? camId, frameId = db.frame_id ?? db.image_id, qt = p.slice(1, 8).join(' ');
    if (!cams.has(camId)) cams.set(camId, cam);
    rigs.set(rigId, camId);
    images += `${db.image_id} ${qt} ${camId} ${name}\n\n`;
    frames += `${frameId} ${rigId} ${qt} 1 CAMERA ${camId} ${db.image_id}\n`;
    kept++;
  }
  return {
    cameras: '# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n' + [...cams].map(([id, l]) => `${id} ${l}\n`).join(''),
    images: '# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n' + images,
    rigs: '# Rig calib list with one line of data per calib:\n#   RIG_ID, NUM_SENSORS, REF_SENSOR_TYPE, REF_SENSOR_ID, SENSORS[]\n' + [...rigs].map(([id, cam]) => `${id} 1 CAMERA ${cam}\n`).join(''),
    frames: '# Frame list with one line of data per frame:\n#   FRAME_ID, RIG_ID, RIG_FROM_WORLD[QW, QX, QY, QZ, TX, TY, TZ], NUM_DATA_IDS, DATA_IDS[]\n' + frames,
    points3D: '# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n',
    kept, dropped,
  };
}

/** A COLMAP text model's photos: name, pose (qw qx qy qz tx ty tz) and how many 3-D points each sees. */
export function imagesFromText(text) {
  const lines = text.split(/\r?\n/).filter((l) => !l.startsWith('#')), out = [];
  for (let i = 0; i < lines.length; i += 2) {
    const p = lines[i].trim().split(/\s+/);
    if (p.length < 10) continue;
    const pts = (lines[i + 1] || '').trim().split(/\s+/);
    let seen = 0;
    for (let k = 2; k < pts.length; k += 3) if (pts[k] !== '-1') seen++;
    out.push({ name: p.slice(9).join(' '), qt: p.slice(1, 8).map(Number), seen });
  }
  return out;
}

/** The same from a model folder, binary (what COLMAP writes) or text. */
export function modelImages(dir) {
  const bin = join(dir, 'images.bin');
  if (!existsSync(bin)) return imagesFromText(readFileSync(join(dir, 'images.txt'), 'utf8'));
  const b = readFileSync(bin), out = [];
  let o = 8;
  for (let i = 0, n = Number(b.readBigUInt64LE(0)); i < n && o < b.length; i++) {
    o += 4; // image id
    const qt = [];
    for (let k = 0; k < 7; k++, o += 8) qt.push(b.readDoubleLE(o));
    o += 4; // camera id
    const end = b.indexOf(0, o);
    const name = b.toString('utf8', o, end);
    o = end + 1;
    const np = Number(b.readBigUInt64LE(o));
    o += 8;
    let seen = 0;
    // Each 2-D point: x, y, then its 3-D point's id (all ones when it has none).
    for (let k = 0; k < np; k++, o += 24) if (b.readUInt32LE(o + 16) !== 0xffffffff || b.readUInt32LE(o + 20) !== 0xffffffff) seen++;
    out.push({ name, qt, seen });
  }
  return out;
}

/**
 * AR-posed photos the adjustment couldn't hold where AR tracking had them: moved over `far` metres from their AR
 * position while seeing under `few` points. (Plenty of points and moved: COLMAP correcting the tracking's drift,
 * which is kept. Few points and moved a little: still fine.)
 * @param {Array<{name: string, qt: number[], seen: number}>} images the adjusted model's photos (in the AR frame)
 * @param {Array<{name: string, pose: number[]}>} frames the AR poses
 * @returns {string[]} the photos' names
 */
export function strayedFromAR(images, frames, { far = 1, few = 50 } = {}) {
  const ar = new Map(frames.map((f) => [f.name, [f.pose[12], f.pose[13], f.pose[14]]]));
  const out = [];
  for (const { name, qt, seen } of images) {
    const a = ar.get(name);
    if (!a || seen >= few) continue;
    const [qw, qx, qy, qz, tx, ty, tz] = qt;
    const R = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
      [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
      [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ];
    const C = [0, 1, 2].map((j) => -(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz));
    if (Math.hypot(a[0] - C[0], a[1] - C[1], a[2] - C[2]) > far) out.push(name);
  }
  return out;
}

/** The database's images with their camera, frame and rig ids (Node's built-in SQLite reads it). */
async function databaseImages(db) {
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    try {
      return d.prepare(`select i.image_id, i.name, i.camera_id, c.model as camera_model, c.width, c.height, fd.frame_id, f.rig_id from images i
        join cameras c on c.camera_id = i.camera_id
        left join frame_data fd on fd.data_id = i.image_id and fd.sensor_type = 0 and fd.sensor_id = i.camera_id
        left join frames f on f.frame_id = fd.frame_id`).all();
    } catch {
      return d.prepare('select image_id, name, camera_id from images').all(); // a database from before rigs and frames
    }
  } finally {
    d.close();
  }
}

/**
 * Pairs to match when merging captures from several phones: each capture with itself (photos
 * close in time, plus pairs from its AR poses), and each capture against the others through an
 * evenly thinned set of photos. Their coordinates are unrelated, so poses can't say which overlap.
 * @param {Array<{names: string[], frames?: Array<{name, pose}>}>} parts image names as COLMAP knows them
 */
export function mergePairs(parts, across = parts.length > 2 ? 80 : 120) {
  const set = new Set();
  const add = (a, b) => {
    if (a !== b) set.add(a < b ? `${a} ${b}` : `${b} ${a}`);
  };
  for (const part of parts) {
    const n = part.names;
    for (let i = 0; i < n.length; i++) for (const k of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32]) if (i + k < n.length) add(n[i], n[i + k]);
    if (part.frames && part.frames.length >= 10) for (const l of posePairs(part.frames)) add(...l.split(' '));
  }
  const thin = parts.map((part) => {
    const n = part.names, step = Math.max(1, n.length / across), out = [];
    for (let x = 0; x < n.length; x += step) out.push(n[Math.floor(x)]);
    return out;
  });
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) for (const a of thin[i]) for (const b of thin[j]) add(a, b);
  return [...set];
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
 * @param {Array|null} [p.parts] captures being merged: [{names, camera, frames?}], one folder each
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
  const cameraArgs = (cam) => {
    if (!cam) return ['--ImageReader.camera_model', 'SIMPLE_RADIAL', '--ImageReader.single_camera', '1'];
    const a = ['--ImageReader.camera_model', cam.model, '--ImageReader.single_camera', cam.single ? '1' : '0'];
    return cam.params ? a.concat('--ImageReader.camera_params', cam.params) : a;
  };
  // Merged captures: one run per phone, each with its own lens. Photos of one capture with different lenses
  // (club photos: AR and ordinary ones): one run per lens.
  const groups = p.parts || p.lenses;
  const runs = groups
    ? groups.map((part, i) => {
      const list = join(work, `images_${i + 1}.txt`);
      writeFileSync(list, part.names.join('\n') + '\n');
      return { args: ['--image_list_path', list, ...cameraArgs(part.camera)], n: part.names.length };
    })
    : [{
      args: rig
        ? ['--ImageReader.camera_model', camera.model, '--ImageReader.camera_params', camera.params, '--ImageReader.single_camera_per_folder', '1']
        : cameraArgs(camera),
      n: nImages,
    }];
  let done = 0;
  for (const r of runs) {
    const before = done;
    await run(colmap, ['feature_extractor', '--database_path', db, '--image_path', imagesDir,
      '--FeatureExtraction.use_gpu', '1', '--SiftExtraction.max_num_features', '8192', ...r.args], {
      log, token,
      onLine: (l) => {
        const m = /Processed file \[(\d+)\/(\d+)\]/.exec(l);
        if (m) done = before + (+m[1] / +m[2]) * r.n;
        else if (/Processed file/.test(l)) done++;
        progress('features', Math.min(0.99, done / nImages));
      },
    });
    done = before + r.n;
  }

  if (rig) {
    // Group the views of each 360 frame into one rig frame (same file name in every view folder).
    const cfg = join(work, 'rig.json');
    writeFileSync(cfg, JSON.stringify(rig.config, null, 2));
    await run(colmap, ['rig_configurator', '--database_path', db, '--rig_config_path', cfg], { log, token });
  }

  // ---- 2. Matching
  progress('matching', 0);
  let mode = p.matcher;
  if (p.parts) mode = 'merge';
  else if (mode === 'auto') mode = rig ? 'sequential' : nImages <= 700 ? 'exhaustive' : posed ? 'poses' : 'sequential';
  say(`Matching features (${mode === 'poses' ? 'pairs chosen from AR poses' : mode === 'merge' ? 'within each capture, and across them' : mode})…`);
  const onMatch = (l) => {
    // Exhaustive matching works in blocks: "Processing block [i/n, j/n]".
    const b = /block \[(\d+)\/(\d+),\s*(\d+)\/(\d+)\]/.exec(l);
    if (b) return progress('matching', ((+b[1] - 1) * +b[4] + +b[3]) / (+b[2] * +b[4]));
    const m = /\[(\d+)\/(\d+)\]/.exec(l);
    if (m) progress('matching', +m[1] / +m[2]);
  };
  if (mode === 'exhaustive') {
    await run(colmap, ['exhaustive_matcher', '--database_path', db, '--FeatureMatching.use_gpu', '1'], { log, token, onLine: onMatch });
  } else if (mode === 'poses' || mode === 'merge') {
    const pairsFile = join(work, 'pairs.txt');
    const all = () => readdirSync(imagesDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
    writeFileSync(pairsFile, (mode === 'merge' ? mergePairs(p.parts) : posedPairs(posed.frames, all())).join('\n') + '\n');
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

// Refining AR poses. Above 1,000 photos COLMAP switches Ceres to an iterative solver: on a 1,052-photo
// capture it took 8 min a pass, kept failing to find a step and never settled. The direct sparse solver
// copes with a few thousand photos and did the same pass in 5 min. Ceres also never stops early unless
// told to, so it stops once a step improves the error by less than one part in a million.
const BA_ARGS = ['--BundleAdjustment.refine_principal_point', '0',
  '--BundleAdjustmentCeres.max_num_images_direct_sparse_cpu_solver', '4000', '--BundleAdjustmentCeres.function_tolerance', '1e-6'];

/** The camera setting of each feature extraction run: per capture when merging, per lens, or the one. */
const lensesOf = (p) => (p.parts || p.lenses ? (p.parts || p.lenses).map((x) => x.camera) : [p.camera]);

const fresh = (d) => {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
};

async function posedReconstruction(p, db, nImages) {
  const { colmap, imagesDir, work, posed, progress, say, token, log } = p;
  say(`Triangulating with ${posed.frames.length} AR camera poses…`);
  progress('mapping', 0.05, 'AR poses');
  const tri1 = fresh(join(work, 'posed_tri')), ba1 = fresh(join(work, 'posed_ba')), tri2 = fresh(join(work, 'posed_tri2'));
  // The AR model under the database's numbering (see renumberModel).
  let input = posed.modelDir;
  try {
    const m = renumberModel({ cameras: readFileSync(join(posed.modelDir, 'cameras.txt'), 'utf8'), images: readFileSync(join(posed.modelDir, 'images.txt'), 'utf8') }, await databaseImages(db));
    if (m.kept >= 2) {
      input = join(work, 'posed_in');
      if (existsSync(input)) rmSync(input, { recursive: true, force: true });
      mkdirSync(input, { recursive: true });
      for (const k of ['cameras', 'images', 'rigs', 'frames', 'points3D']) writeFileSync(join(input, `${k}.txt`), m[k]);
      if (m.dropped) say(`${m.dropped} AR poses are for photos COLMAP couldn't read; left out.`);
    }
  } catch (e) {
    say(`Couldn't match the AR poses to COLMAP's numbering (${e.message.split('\n')[0]}); using them as they are.`);
  }
  // Bundle adjustment prints nothing until it's done, which takes minutes on a big capture: keep
  // the stage note ticking so a working step doesn't look stuck.
  const step = async (frac, note, args) => {
    const t0 = Date.now();
    progress('mapping', frac, note);
    const tick = setInterval(() => progress('mapping', frac, `${note} · ${Math.floor((Date.now() - t0) / 60000)} min`), 15000);
    try {
      await run(colmap, args, { log, token });
    } finally {
      clearInterval(tick);
    }
  };
  try {
    await run(colmap, ['point_triangulator', '--database_path', db, '--image_path', imagesDir, '--input_path', input,
      '--output_path', tri1, '--clear_points', '1', '--refine_intrinsics', '0'], { log, token });
    // Club photos (posed.hold): the first adjustment keeps the AR poses where they are and refines only the points
    // and lens. Adjusted freely, one outing's photos alone can let a weakly linked stretch slide: in a club test,
    // 18 of 120 photos moved over a metre (the full 233-photo scan of the same room moved none). The last
    // adjustment, with every photo placed, refines all poses. A scan keeps its free first adjustment.
    say(posed.hold ? 'Fitting the points to the AR poses (bundle adjustment)…' : `Refining the AR poses (bundle adjustment)…${nImages > 600 ? ` ${nImages} photos: this takes a few minutes.` : ''}`);
    await step(0.3, posed.hold ? 'fitting points' : 'refining poses', ['bundle_adjuster', '--input_path', tri1, '--output_path', ba1, ...BA_ARGS,
      ...(posed.hold ? ['--BundleAdjustment.refine_rig_from_world', '0'] : [])]);
    progress('mapping', 0.55, 're-triangulating');
    await run(colmap, ['point_triangulator', '--database_path', db, '--image_path', imagesDir, '--input_path', ba1,
      '--output_path', tri2, '--clear_points', '1', '--refine_intrinsics', '0'], { log, token });
    let model = tri2;
    // Photos without an AR pose here (another AR session, ordinary photos, tracking lost) are placed by COLMAP, in
    // rounds: each round places the photos that see enough of what has been triangulated so far, then
    // triangulates what they add, so the next can place photos of parts the AR poses never saw. (One pass placed
    // 207 of 233 photos of a club test room; three rounds placed all of them.)
    if (posed.frames.length < nImages) {
      say(`Registering ${nImages - posed.frames.length} photos that had no AR pose…`);
      let placed = (await modelStats(colmap, tri2)).images;
      for (let k = 1; k <= 4 && placed < nImages; k++) {
        progress('mapping', 0.6 + 0.05 * k, `adding photos without AR poses (round ${k})`);
        const reg = fresh(join(work, `posed_reg${k}`)), tri = fresh(join(work, `posed_reg${k}_tri`));
        await run(colmap, ['image_registrator', '--database_path', db, '--input_path', model, '--output_path', reg], { log, token });
        await run(colmap, ['point_triangulator', '--database_path', db, '--image_path', imagesDir, '--input_path', reg,
          '--output_path', tri, '--clear_points', '0', '--refine_intrinsics', '0'], { log, token });
        const n = (await modelStats(colmap, tri)).images;
        model = tri;
        if (n <= placed) break;
        placed = n;
      }
    }
    const fin = fresh(join(work, 'posed_final')), kept = fresh(join(work, 'posed_kept')), clean = fresh(join(work, 'posed_clean'));
    await step(0.85, 'final refinement', ['bundle_adjuster', '--input_path', model, '--output_path', fin, ...BA_ARGS]);
    // An AR photo the adjustment dragged far from where AR tracking had it, on only a few points, is one the solve
    // couldn't hold (in a club test, one moved 3 m on 12 points): it goes, rather than teach the splat a wrong view.
    let held = fin;
    try {
      const strays = strayedFromAR(modelImages(fin), posed.frames);
      if (strays.length) {
        const list = join(work, 'strayed.txt');
        writeFileSync(list, strays.join('\n') + '\n');
        await run(colmap, ['image_deleter', '--input_path', fin, '--output_path', fresh(join(work, 'posed_held')), '--image_names_path', list], { log, token });
        held = join(work, 'posed_held');
        say(`Left out ${strays.length} AR photo${strays.length > 1 ? 's' : ''} the solve moved over a metre from where AR tracking had ${strays.length > 1 ? 'them' : 'it'}, on few points (${strays.slice(0, 5).join(', ')}).`);
      }
    } catch (e) {
      if (e.cancelled) throw e;
    }
    // Then out with what the adjustment couldn't make fit: a photo whose lens ran off (placed wrongly), and the
    // odd point flung far off, which would spoil the error figure and the splat's start. Photos with few points
    // stay (by default the filter drops those under 10): a plain wall gives few, and its AR pose is still good.
    let out = held;
    try {
      await run(colmap, ['image_filterer', '--input_path', held, '--output_path', kept, '--max_extra_param', '1', '--min_num_observations', '0'], { log, token });
      await run(colmap, ['point_filtering', '--input_path', kept, '--output_path', clean, '--max_reproj_error', '4'], { log, token });
      out = clean;
    } catch (e) {
      if (e.cancelled) throw e;
    }
    const stats = await modelStats(colmap, out);
    say(`AR-pose model: ${stats.images}/${nImages} photos, ${stats.points} points, ${stats.reprojError.toFixed(2)} px error.`);
    progress('mapping', 1);
    if (stats.images < nImages * 0.6 || stats.points < 2000 || stats.reprojError > 2.5) return null;
    // Any lens with distortion (photos without an exact lens, each refined) means undistorting the photos for
    // training. A scan's single PINHOLE camera, or club photos that are all AR photos, need nothing.
    return { modelDir: out, stats, mode: 'ar-poses', needsUndistort: lensesOf(p).some((c) => !/PINHOLE/.test(c ? c.model : 'SIMPLE_RADIAL')) };
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
  const models = lensesOf(p).map((c) => (c ? c.model : 'SIMPLE_RADIAL'));
  return { modelDir, stats: best.stats, mode, needsUndistort: models.some((m) => !/PINHOLE/.test(m)) };
}
