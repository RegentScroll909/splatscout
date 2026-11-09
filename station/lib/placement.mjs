// The building view: where on a building's footprint the club's captures were taken. Every finished splat in an
// ASU building brings its COLMAP model (where each photo was taken and which way it looked, and the points it
// reconstructed). The club places each capture on the building's OpenStreetMap outline once, starting from a
// guess (its GPS fix, its walls turned to run with the building's), and the placement is kept in
// <workDir>/campus.json under `placements`. The maths is in station/web/place.js, shared with the pages.
//
// What a capture's model gives is cached beside its splat (scene.cameras.json and scene.points.bin), so camera
// positions survive the job folder being deleted from the dashboard.

import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readModel, isModel, lensOf, thinPoints, planSample, packPoints, unpackPoints } from './colmapmodel.mjs';
import { splatLod } from './splatlod.mjs';
import { upRotation } from './walkmap.mjs';
import { readHeader, insideAreas, CROP_MARGIN } from './crop.mjs';
import { matchNameIn } from '../../app/js/data/campus.js';
import { floorArea } from '../../app/js/core/campusmodel.js';
import * as P from '../web/place.js';

export const MODEL_VERSION = 1;
export const MAX_POINTS = 60000; // per capture, for the 3D view
export const PLAN_POINTS = 2500; // per capture, for floor plans
export const PHONE_HEIGHT = 1.6; // m above the floor a phone is held while scanning (Schwada's AR scans: 1.55–1.71)
const AR = /^(ar-poses|sfm-ar)$/;
export const CAMERAS_FILE = 'scene.cameras.json', POINTS_FILE = 'scene.points.bin';

// ------------------------------------------------------------------------------------ placements in campus.json
const stateFile = (workDir) => join(workDir, 'campus.json');
function readState(workDir) {
  try {
    return JSON.parse(readFileSync(stateFile(workDir), 'utf8')) || {};
  } catch {
    return {};
  }
}

/** Where the club placed its captures: {libraryPath: {s, theta, e, n, floor, at}}. */
export function loadPlacements(workDir) {
  const p = readState(workDir).placements;
  return p && typeof p === 'object' ? p : {};
}

/** Save (or with null, forget) where a capture sits. Everything else in campus.json stays. */
export function savePlacement(workDir, key, placement) {
  const clean = placement == null ? null : P.cleanPlacement(placement);
  if (placement != null && !clean) throw new Error('That isn’t a placement: it needs a scale, a turn, a position and a floor.');
  const st = readState(workDir);
  const all = { ...(st.placements || {}) };
  if (clean) all[key] = { ...clean, at: new Date().toISOString() };
  else delete all[key];
  writeFileSync(stateFile(workDir), JSON.stringify({ ...st, placements: all }, null, 1));
  return all[key] || null;
}

// ------------------------------------------------------------------------------------ one capture's model
const rot3 = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const ID3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};
const fileKey = (f) => {
  try {
    const st = statSync(f);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'none';
  }
};

/** The COLMAP model a job trained from (what training used, else the solve's own folders). */
export function modelDirOf(jobDir) {
  if (!jobDir) return null;
  for (const d of [join(jobDir, 'train', 'sparse', '0'), join(jobDir, 'colmap', 'final_txt'), join(jobDir, 'colmap', 'posed_final'),
    join(jobDir, 'colmap', 'sfm_aligned'), join(jobDir, 'colmap', 'undistorted', 'sparse', '0')]) if (isModel(d)) return d;
  return null;
}

/** Splat centres and colours from a trained .ply (when a capture's COLMAP model is gone). */
async function readSplatCentres(file, { minOpacity = 0.3, maxSize = 0.5, budget = 400000 } = {}) {
  const fd = openSync(file, 'r');
  try {
    const { dataStart, count, stride, off } = readHeader(fd);
    const every = Math.max(1, Math.ceil(count / budget)), C0 = 0.28209479177387814;
    const cap = Math.ceil(count / every), xyz = new Float32Array(cap * 3), rgb = new Uint8Array(cap * 3), weight = new Float32Array(cap);
    const per = Math.max(1, Math.floor((8 << 20) / stride)), chunk = Buffer.alloc(per * stride);
    const col = (o, k) => Math.max(0, Math.min(255, Math.round((0.5 + C0 * chunk.readFloatLE(o + off['f_dc_' + k])) * 255)));
    let n = 0;
    for (let i = 0; i < count; i += per) {
      const m = Math.min(per, count - i);
      readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
      for (let j = (every - (i % every)) % every; j < m; j += every) {
        const o = j * stride;
        const a = 'opacity' in off ? 1 / (1 + Math.exp(-chunk.readFloatLE(o + off.opacity))) : 1;
        if (a < minOpacity) continue;
        if ('scale_0' in off && Math.exp(Math.max(chunk.readFloatLE(o + off.scale_0), chunk.readFloatLE(o + off.scale_1), chunk.readFloatLE(o + off.scale_2))) > maxSize) continue;
        xyz[n * 3] = chunk.readFloatLE(o + off.x);
        xyz[n * 3 + 1] = chunk.readFloatLE(o + off.y);
        xyz[n * 3 + 2] = chunk.readFloatLE(o + off.z);
        if ('f_dc_0' in off) for (let k = 0; k < 3; k++) rgb[n * 3 + k] = col(o, k);
        else rgb.fill(180, n * 3, n * 3 + 3);
        weight[n] = a;
        n++;
      }
      await new Promise((r) => setImmediate(r));
    }
    return { n, xyz: xyz.subarray(0, n * 3), rgb: rgb.subarray(0, n * 3), weight: weight.subarray(0, n), total: count };
  } finally {
    closeSync(fd);
  }
}

/** The floor's height in a levelled model: the scan outline's, else the walk map's, else below the photos. */
function floorOf({ info, folder, metric, camYs, points }) {
  const areas = (info.crop && info.crop.areas) || [];
  const ys = areas.map((a) => a.floorY).filter(Number.isFinite);
  if (metric && ys.length) return { y: median(ys), from: 'outline' };
  if (metric) {
    try {
      const w = JSON.parse(readFileSync(join(folder, 'scene.walk.json'), 'utf8'));
      if (w.metric && Array.isArray(w.rot) && w.rot[4] > 0.999 && Number.isFinite(w.floorY) && !w.floorGuessed) return { y: w.floorY, from: 'walk map' };
    } catch {}
  }
  if (camYs.length && metric) return { y: median(camYs) - PHONE_HEIGHT, from: 'photos' };
  // No scale: the lowest points (2nd percentile) are the floor.
  if (points.n) {
    const s = [];
    for (let i = 0; i < points.n; i += Math.max(1, Math.floor(points.n / 20000))) s.push(points.xyz[i * 3 + 1]);
    s.sort((a, b) => a - b);
    return { y: s[Math.floor(s.length * 0.02)], from: 'points' };
  }
  return { y: (camYs.length ? median(camYs) : 0) - PHONE_HEIGHT, from: 'photos' };
}

/** Which way is up in a model without AR: the photos' average up (a 360 frame's upward view lies on its back). */
function upOf(images, view) {
  const up = [0, 0, 0];
  for (const im of images) if (!im.name.startsWith('up/')) for (let k = 0; k < 3; k++) up[k] += im.up[k];
  if (Math.hypot(...up) > 1e-9) return up;
  return view && view.up ? view.up : [0, 1, 0];
}

const building = new Map(); // folder -> promise, so two pages asking at once read a model once

/**
 * What a finished splat's COLMAP model says, levelled (y up) and cached beside the splat: camera centres with their
 * view and up directions, lenses, the floor's height, a thinned set of points (scene.points.bin) and a floor-plan
 * sample of them. Falls back to the splat's own centres, without cameras, when the job's model is gone.
 * @param {{folder: string, info: object, jobDir: string|null}} o
 */
export async function captureModel({ folder, info, jobDir }) {
  const modelDir = modelDirOf(jobDir);
  const ply = join(folder, 'scene.ply');
  const source = modelDir ? 'colmap' : existsSync(ply) ? 'splat' : null;
  const key = [MODEL_VERSION, source, modelDir ? ['images', 'points3D'].map((n) => fileKey(join(modelDir, `${n}.bin`)) + fileKey(join(modelDir, `${n}.txt`))).join('|') : fileKey(ply)].join('|');
  const cacheFile = join(folder, CAMERAS_FILE);
  try {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
    // A cache made from the COLMAP model outlives the job folder: keep it when the model has gone since.
    if (c.version === MODEL_VERSION && existsSync(join(folder, POINTS_FILE)) && (c.key === key || (c.source === 'colmap' && source !== 'colmap'))) return c;
  } catch {}
  if (!source) return { version: MODEL_VERSION, source: null, error: 'Its splat and COLMAP model are both missing.' };
  if (building.has(folder)) return building.get(folder);
  const p = buildCaptureModel({ folder, info, modelDir, ply, source, key, cacheFile }).finally(() => building.delete(folder));
  building.set(folder, p);
  return p;
}

async function buildCaptureModel({ folder, info, modelDir, ply, source, key, cacheFile }) {
  const mode = (info.colmap && info.colmap.mode) || null, metric = AR.test(mode || '');
  let images = [], cameras = new Map(), raw;
  if (source === 'colmap') {
    const m = await readModel(modelDir);
    images = m.images;
    cameras = m.cameras;
    raw = m.points || { n: 0, xyz: new Float32Array(0), rgb: new Uint8Array(0) };
  } else raw = await readSplatCentres(ply);
  // Level the model: AR models are y-up already (and stay exactly as the splat is); others turn their photos' up to +y.
  const R = metric ? ID3 : upRotation(upOf(images, info.view));
  const lv = (v) => (R === ID3 ? v : rot3(R, v));
  if (R !== ID3) for (let i = 0; i < raw.n; i++) raw.xyz.set(rot3(R, [raw.xyz[i * 3], raw.xyz[i * 3 + 1], raw.xyz[i * 3 + 2]]), i * 3);
  const thin = thinPoints(raw, { max: MAX_POINTS, maxError: 3, voxel: metric ? 0.02 : 0 });
  // Lenses: one entry per COLMAP camera; each photo says which it used when there is more than one.
  const camIds = [...cameras.keys()], lenses = camIds.map((id) => lensOf(cameras.get(id))), lensIdx = new Map(camIds.map((id, i) => [id, i]));
  const cams = images.map((im) => {
    const C = lv(im.C), f = lv(im.fwd), u = lv(im.up);
    const row = [...C, ...f, ...u].map(r3);
    if (camIds.length > 1) row.push(lensIdx.get(im.cameraId) ?? 0);
    return row;
  });
  const camYs = cams.map((c) => c[1]);
  const floor = floorOf({ info, folder, metric, camYs, points: thin });
  // Where a GPS fix taken while setting up stands in the model: the AR session's start (its origin), else the photos' middle.
  const anchor = metric || !cams.length ? [0, 0] : [r3(median(cams.map((c) => c[0]))), r3(median(cams.map((c) => c[2])))];
  // No scale (COLMAP only): guess it from how high the phone was held above the floor.
  const above = cams.length ? median(camYs) - floor.y : 0;
  const sGuess = metric ? 1 : above > 1e-6 ? PHONE_HEIGHT / above : 1;
  // Which way its walls run, from up to 8,000 of its points seen from above.
  const step = Math.max(1, Math.floor(thin.n / 8000)), uv = [];
  for (let i = 0; i < thin.n; i += step) uv.push(thin.xyz[i * 3], -thin.xyz[i * 3 + 2]);
  const wall = P.wallAngle(uv, 0.1 / sGuess);
  let start = null;
  if (info.view && info.view.position && info.view.lookAt) start = { position: lv(info.view.position).map(r3), lookAt: lv(info.view.lookAt).map(r3) };
  const out = {
    version: MODEL_VERSION, key, source, modelDir: modelDir || null, mode, metric, rot: R,
    images: images.length, cams, lenses, floorY: r3(floor.y), floorFrom: floor.from, anchor, sGuess: +sGuess.toFixed(4), wall: +wall.toFixed(4),
    points: thin.n, allPoints: raw.total || raw.n, voxel: +thin.voxel.toFixed(4), start,
    plan: planSample(thin, PLAN_POINTS).map(r2),
    built: new Date().toISOString(),
  };
  try {
    writeFileSync(join(folder, POINTS_FILE), packPoints(thin));
    writeFileSync(cacheFile, JSON.stringify(out));
  } catch (e) {
    out.cacheError = e.message;
  }
  return out;
}

// ------------------------------------------------------------------------------------ a cropped splat's scan area
const readInfo = (folder) => {
  try {
    return JSON.parse(readFileSync(join(folder, 'info.json'), 'utf8')) || {};
  } catch {
    return {};
  }
};

/**
 * What the building view shows of a cropped splat: inside(x, y, z) in its model's coordinates, the crop's own test
 * (its outline plus the margin, from just below the floor to just above the top), or null when it shows everything:
 * no outline, the crop turned off, or not in AR coordinates (where an outline means nothing). AR models aren't turned
 * (captureModel), so the crop's splat coordinates are the model's.
 */
export function cropOf(info) {
  const c = info && info.crop;
  if (!c || c.off || !AR.test((info.colmap && info.colmap.mode) || '')) return null;
  const areas = (c.areas || []).filter((a) => a && Array.isArray(a.poly) && a.poly.length >= 3 && Number.isFinite(a.floorY));
  if (!areas.length) return null;
  try {
    return insideAreas(areas, Number.isFinite(c.margin) ? c.margin : CROP_MARGIN);
  } catch {
    return null;
  }
}
const cropKey = (info) => (cropOf(info) ? JSON.stringify([info.crop.areas, info.crop.margin ?? null]) : '');

/** Which of a capture's points are in its scan area (their indices). */
function insideIdx(pts, inside) {
  const keep = [];
  for (let i = 0; i < pts.n; i++) if (inside(pts.xyz[i * 3], pts.xyz[i * 3 + 1], pts.xyz[i * 3 + 2])) keep.push(i);
  return keep;
}

/**
 * A capture's points for the building view: scene.points.bin as it is (count, x y z floats, r g b bytes), plus a byte
 * a point when its splat is cropped: 1 inside the scan area, 0 outside. The page draws only what's inside, as the
 * crop does, while snapping onto neighbours still gets every point (what's seen through a doorway is where two
 * captures overlap).
 * @returns {Buffer|null} null when its model hasn't been read yet
 */
export function viewPoints(libraryDir, key) {
  const f = pointsFileOf(libraryDir, key);
  if (!f) return null;
  const buf = readFileSync(f), inside = cropOf(readInfo(dirname(f)));
  if (!inside) return buf;
  const pts = unpackPoints(buf), mask = Buffer.alloc(pts.n);
  for (const i of insideIdx(pts, inside)) mask[i] = 1;
  return Buffer.concat([buf.subarray(0, 4 + pts.n * 15), mask]);
}

const plans = new Map(); // folder -> {k, plan}
/** The floor-plan sample a capture is drawn with: of the points inside its scan area when it's cropped. */
function shownPlan(folder, info, model, inside) {
  if (!inside) return model.plan || [];
  const file = join(folder, POINTS_FILE), k = cropKey(info) + '|' + fileKey(file), hit = plans.get(folder);
  if (hit && hit.k === k) return hit.plan;
  let plan = model.plan || [];
  try {
    const pts = unpackPoints(readFileSync(file)), keep = insideIdx(pts, inside), xyz = new Float32Array(keep.length * 3);
    keep.forEach((i, j) => xyz.set(pts.xyz.subarray(i * 3, i * 3 + 3), j * 3));
    plan = planSample({ n: keep.length, xyz }, PLAN_POINTS).map(r2);
  } catch {}
  plans.set(folder, { k, plan });
  return plan;
}

// ------------------------------------------------------------------------------------ one building
function manifestIn(jobDir) {
  for (const f of jobDir ? [join(jobDir, 'dataset', 'splatscout.json'), join(jobDir, 'dataset', 'parts', 'p1', 'splatscout.json')] : []) {
    try {
      if (existsSync(f)) return { m: JSON.parse(readFileSync(f, 'utf8')), merged: f.includes('parts') };
    } catch {}
  }
  return { m: null, merged: false };
}

/** The ASU building a library splat belongs to (as the Campus page files it): its capture's code, else its name. */
export function buildingCodeOf(it, manifest, buildings, list = [...buildings.values()]) {
  const c = manifest && manifest.capture && manifest.capture.buildingCode;
  if (c && buildings.has(c)) return c;
  const b = matchNameIn(list, (it.info && it.info.building) || it.building);
  return b ? b.code : null;
}

/**
 * Everything the floor plans and the 3D view show for one building: its footprint and floors, and each capture
 * filed under it with its cameras, points, scan outline, GPS fix and placement (saved, or a guess).
 * @param {object} o
 * @param {string} o.code ASU building code
 * @param {Map<string, object>} o.buildings ASU buildings by code
 * @param {object[]} o.library finished splats: [{path, building, room, stamp, info}]
 * @param {string} o.libraryDir where they are
 * @param {string} o.jobsDir job folders (their COLMAP models)
 * @param {string} o.workDir SplatStation's folder (campus.json)
 */
export async function buildingView({ code, buildings, library, libraryDir, jobsDir, workDir }) {
  const b = buildings.get(code);
  if (!b) throw new Error('Unknown building');
  const list = [...buildings.values()];
  const fa = floorArea(b, (readState(workDir).floors || {})[code]); // the club's floor count, as the Campus page reads it
  const footprint = P.footprintOf(b), frame = P.localFrame(b.c || b.poly[0]);
  const saved = loadPlacements(workDir);
  const caps = [];
  const mine = [];
  for (const it of library) {
    const info = it.info || {};
    const jobDir = info.jobId && jobsDir && existsSync(join(jobsDir, info.jobId)) ? join(jobsDir, info.jobId) : null;
    const { m, merged } = manifestIn(jobDir);
    if (buildingCodeOf(it, merged ? null : m, buildings, list) === code) mine.push({ it, info, jobDir, m });
  }
  mine.sort((a, c) => (a.it.stamp < c.it.stamp ? -1 : a.it.stamp > c.it.stamp ? 1 : a.it.path < c.it.path ? -1 : 1));
  for (const [slot, { it, info, jobDir, m }] of mine.entries()) {
    const folder = join(libraryDir, ...it.path.split('/'));
    let model;
    try {
      model = await captureModel({ folder, info, jobDir });
    } catch (e) {
      model = { source: null, error: String(e.message || e) };
    }
    const c = (m && m.capture) || {};
    const geo = c.geo && Number.isFinite(c.geo.lat) && Number.isFinite(c.geo.lon) ? { lat: c.geo.lat, lon: c.geo.lon, acc: c.geo.acc ?? null } : null;
    const floorText = c.floor != null ? String(c.floor) : '';
    const outlines = model.metric ? ((info.crop && info.crop.areas) || []).filter((a) => a && Array.isArray(a.poly) && a.poly.length >= 3).map((a) => a.poly.map(([x, z]) => [r3(x), r3(z)])) : [];
    const inside = model.source ? cropOf(info) : null; // a cropped splat: only its scan area is shown
    const pl = saved[it.path] ? P.cleanPlacement(saved[it.path]) : null;
    caps.push({
      key: it.path, slot, room: info.room || it.room, building: info.building || it.building, stamp: it.stamp, created: info.created || null,
      title: `${info.building || it.building} · ${info.room || it.room}`, view: info.view || null,
      grade: (info.capture && info.capture.grade) || null, score: info.capture && info.capture.score != null ? info.capture.score : null,
      author: (info.capture && info.capture.author) || null, eval: (info.training && info.training.eval) || null, splats: (info.training && info.training.splats) || null,
      photos: info.photos || 0, mode: model.mode ?? ((info.colmap && info.colmap.mode) || null), metric: !!model.metric, source: model.source, error: model.error || null,
      images: model.images || 0, cams: model.cams || [], lenses: model.lenses || [], plan: shownPlan(folder, info, model, inside), cropped: !!inside, points: model.points || 0, allPoints: model.allPoints || 0,
      floorY: model.floorY ?? 0, floorFrom: model.floorFrom || null, anchor: model.anchor || [0, 0], sGuess: model.sGuess || 1, wall: model.wall || 0,
      start: model.start || null, outlines, floorText, floorGiven: P.floorNumber(floorText), geo, gps: geo ? frame.toXY([geo.lat, geo.lon]).map(r2) : null,
      placement: pl ? { ...pl, at: saved[it.path].at || null } : null,
    });
  }
  // A first guess for each capture nobody has placed yet. Ones without GPS are spread along the building.
  const unplacedNoGps = caps.filter((x) => !x.placement && !x.gps);
  for (const x of caps) {
    if (x.placement) continue;
    x.guess = P.guessPlacement({
      footprint, gps: x.gps, anchor: x.anchor, wall: x.wall, s: x.sGuess, floor: x.floorGiven ?? 1, floorY: x.floorY,
      index: unplacedNoGps.indexOf(x), count: unplacedNoGps.length,
    });
    for (const k of ['s', 'theta', 'e', 'n']) x.guess[k] = +x.guess[k].toFixed(4);
  }
  return {
    generatedAt: new Date().toISOString(),
    building: {
      code: b.code, name: b.name, ref: b.ref || null, campus: b.campus, c: b.c, poly: b.poly, restricted: b.restricted || null,
      footprint: footprint.map(([e, n]) => [r2(e), r2(n)]), area: fa.footprint, floors: fa.floors, floorsSet: fa.set, floorsGuessed: fa.guessed,
      angle: +P.footprintAngle(footprint).toFixed(4),
    },
    floorHeight: P.FLOOR_HEIGHT,
    captures: caps,
  };
}

/**
 * Read the COLMAP model of every library splat a job made into its cache beside the splat, so its camera positions
 * outlive the job folder (call when a job finishes, and before deleting one).
 * @param {{library: object[], libraryDir: string, jobId: string, jobDir: string}} o
 * @returns {Promise<number>} how many splats were cached
 */
export async function keepCameras({ library, libraryDir, jobId, jobDir }) {
  let n = 0;
  for (const it of library) {
    if (!it.info || it.info.jobId !== jobId) continue;
    const m = await captureModel({ folder: join(libraryDir, ...it.path.split('/')), info: it.info, jobDir });
    if (m.source === 'colmap' && !m.cacheError) n++;
  }
  return n;
}

/** A library splat's folder from its path ("Building/Room/stamp"), or null when that isn't a splat in the library. */
export function libraryFolderOf(libraryDir, key) {
  if (typeof key !== 'string' || !key) return null;
  const root = resolve(libraryDir), f = resolve(root, ...key.split('/'));
  return f.startsWith(root + sep) && existsSync(join(f, 'scene.ply')) ? f : null;
}

// ------------------------------------------------------------------------------------ splats for the building view
/** How many splats the building view's lighter copies keep: the capture being reviewed, and its neighbours. */
export const LOD_SIZES = { near: 800000, far: 250000 };
const LOD_VERSION = 2; // 2: a cropped splat's copies keep only its scan area
const lodBusy = new Map();

/**
 * A lighter copy of a library splat for the building view (scene.lod-near-<tag>.splat or scene.lod-far-<tag>.splat
 * beside it), made when it's missing or older than the splat or its model: its most important splats inside its
 * capture's box (its points, 0.75 m around) and, when it's cropped, inside its scan area (big splats too: the crop
 * keeps those so plain walls look solid from inside, but in the building view they reach into the neighbours),
 * levelled like its model. The tag says what it was made with, so a changed crop makes a new one.
 * @param {{libraryDir: string, jobsDir: string, key: string, detail?: 'near'|'far'}} o
 * @returns {Promise<string>} the .splat file
 */
export async function splatPreview({ libraryDir, jobsDir, key, detail = 'far' }) {
  const folder = libraryFolderOf(libraryDir, key);
  if (!folder) throw new Error('No such splat in the library');
  const info = readInfo(folder), inside = cropOf(info);
  const kind = LOD_SIZES[detail] ? detail : 'far', ply = join(folder, 'scene.ply');
  const tag = createHash('sha1').update(JSON.stringify([LOD_VERSION, cropKey(info)])).digest('hex').slice(0, 8);
  const name = `scene.lod-${kind}-${tag}.splat`, out = join(folder, name);
  const newer = (f, than) => !existsSync(than) || statSync(f).mtimeMs >= statSync(than).mtimeMs;
  if (existsSync(out) && newer(out, ply) && newer(out, join(folder, POINTS_FILE))) return out;
  if (lodBusy.has(out)) return lodBusy.get(out);
  const p = (async () => {
    const jobDir = info.jobId && jobsDir && existsSync(join(jobsDir, info.jobId)) ? join(jobsDir, info.jobId) : null;
    const model = await captureModel({ folder, info, jobDir }); // how it's levelled, and its points for the box
    let box = null;
    if (existsSync(join(folder, POINTS_FILE))) {
      const pts = unpackPoints(readFileSync(join(folder, POINTS_FILE)));
      if (pts.n) {
        box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pts.n; i++) for (let k = 0; k < 3; k++) {
          box[k] = Math.min(box[k], pts.xyz[i * 3 + k]);
          box[k + 3] = Math.max(box[k + 3], pts.xyz[i * 3 + k]);
        }
        const pad = 0.75 / (model.sGuess || 1);
        for (let k = 0; k < 3; k++) [box[k], box[k + 3]] = [box[k] - pad, box[k + 3] + pad];
      }
    }
    await splatLod({ ply, out, max: LOD_SIZES[kind], box, rot: model.rot || null, inside });
    // Copies made before (with another crop, or by an older version) go; one still being read stays till next time.
    const old = new RegExp(`^scene\\.lod-${kind}(-[0-9a-f]+)?\\.splat$`);
    for (const f of readdirSync(folder)) {
      if (f === name || !old.test(f)) continue;
      try {
        rmSync(join(folder, f), { force: true });
      } catch {}
    }
    return out;
  })().finally(() => lodBusy.delete(out));
  lodBusy.set(out, p);
  return p;
}

/** The thinned points of a library splat (scene.points.bin), if its model has been read. */
export function pointsFileOf(libraryDir, key) {
  const folder = libraryFolderOf(libraryDir, key);
  return folder && existsSync(join(folder, POINTS_FILE)) ? join(folder, POINTS_FILE) : null;
}
