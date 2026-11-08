// Reading a COLMAP model as COLMAP writes it, text or binary (4.x included: its rigs and frames files aren't
// needed): the lenses, where each photo was taken and which way it looked, and the reconstructed points. Then
// thinning the points out for a browser. Used by the building view (station/lib/placement.mjs).

import { openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';

/** COLMAP's camera models by id, with how many parameters each has. */
export const CAMERA_MODELS = [
  ['SIMPLE_PINHOLE', 3], ['PINHOLE', 4], ['SIMPLE_RADIAL', 4], ['RADIAL', 5], ['OPENCV', 8], ['OPENCV_FISHEYE', 8],
  ['FULL_OPENCV', 12], ['FOV', 5], ['SIMPLE_RADIAL_FISHEYE', 4], ['RADIAL_FISHEYE', 5], ['THIN_PRISM_FISHEYE', 12],
  ['RAD_TAN_THIN_PRISM_FISHEYE', 16],
].map(([name, params], id) => ({ id, name, params }));
const MODEL_BY_NAME = new Map(CAMERA_MODELS.map((m) => [m.name, m]));

const tick = () => new Promise((r) => setImmediate(r)); // keep the station answering while a big model loads

/** Reads a big binary file front to back through a small window, skipping what isn't needed. */
class Reader {
  constructor(file, window = 1 << 22) {
    this.fd = openSync(file, 'r');
    this.size = fstatSync(this.fd).size;
    this.buf = Buffer.alloc(window);
    this.base = 0; // file offset of buf[0]
    this.len = 0; // bytes of the file in buf
    this.i = 0; // read position in buf
  }
  get pos() {
    return this.base + this.i;
  }
  need(n) {
    if (this.i + n <= this.len) return;
    const start = this.base + this.i;
    if (n > this.buf.length) this.buf = Buffer.alloc(Math.max(n, this.buf.length * 2));
    this.base = start;
    this.i = 0;
    this.len = readSync(this.fd, this.buf, 0, this.buf.length, start);
    if (this.len < n) throw new Error('The model file ends too soon');
  }
  skip(n) {
    if (this.i + n <= this.len) this.i += n;
    else {
      this.base += this.i + n;
      this.i = this.len = 0;
    }
  }
  u8() {
    this.need(1);
    return this.buf[this.i++];
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.i);
    this.i += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.buf.readInt32LE(this.i);
    this.i += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = Number(this.buf.readBigUInt64LE(this.i));
    this.i += 8;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.buf.readDoubleLE(this.i);
    this.i += 8;
    return v;
  }
  /** A NUL-terminated string. */
  str() {
    for (;;) {
      const end = this.buf.indexOf(0, this.i);
      if (end >= 0 && end < this.len) {
        const s = this.buf.toString('utf8', this.i, end);
        this.i = end + 1;
        return s;
      }
      const have = this.len - this.i;
      if (this.pos + have >= this.size) throw new Error('A photo name in the model never ends');
      this.need(Math.min(have + 4096, this.size - this.pos));
    }
  }
  close() {
    closeSync(this.fd);
  }
}

/** Every line of a text file, read in chunks (COLMAP's images.txt runs to hundreds of MB). */
function eachLine(file, fn) {
  const fd = openSync(file, 'r'), buf = Buffer.alloc(1 << 22), dec = new StringDecoder('utf8');
  let rest = '', pos = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const lines = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = lines.pop();
      for (const l of lines) fn(l);
    }
    rest += dec.end();
    if (rest) fn(rest);
  } finally {
    closeSync(fd);
  }
}

/**
 * A photo's pose from COLMAP's world-to-camera rotation (quaternion w, x, y, z) and translation: its centre in the
 * model, the way it looks (+z), and its up (−y: COLMAP's camera y points down the image).
 */
export function imagePose(id, q, t, cameraId, name, points2D = 0) {
  const nq = Math.hypot(...q) || 1;
  const [qw, qx, qy, qz] = q.map((v) => v / nq);
  const R = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
  const C = [0, 1, 2].map((j) => -(R[0][j] * t[0] + R[1][j] * t[1] + R[2][j] * t[2]));
  return { id, name, cameraId, q, t, C, fwd: R[2], up: R[1].map((v) => -v), right: R[0], points2D };
}

// ------------------------------------------------------------------------------------ binary
function readCamerasBin(file) {
  const r = new Reader(file, 1 << 16), out = new Map();
  try {
    const n = r.u64();
    for (let k = 0; k < n; k++) {
      const id = r.u32(), modelId = r.i32(), width = r.u64(), height = r.u64();
      const m = CAMERA_MODELS[modelId];
      if (!m) throw new Error(`Unknown COLMAP camera model ${modelId}`);
      const params = [];
      for (let j = 0; j < m.params; j++) params.push(r.f64());
      out.set(id, { id, model: m.name, width, height, params });
    }
  } finally {
    r.close();
  }
  return out;
}

async function readImagesBin(file) {
  // A small window: each photo's 2-D points (most of the file) are skipped, so most reads are of one header.
  const r = new Reader(file, 1 << 14), out = [];
  try {
    const n = r.u64();
    for (let k = 0; k < n; k++) {
      const id = r.u32();
      const q = [r.f64(), r.f64(), r.f64(), r.f64()], t = [r.f64(), r.f64(), r.f64()];
      const cameraId = r.u32(), name = r.str(), n2 = r.u64();
      r.skip(n2 * 24); // x, y (doubles) and the 3-D point's id (uint64) of each
      out.push(imagePose(id, q, t, cameraId, name, n2));
      if (k % 2000 === 1999) await tick();
    }
  } finally {
    r.close();
  }
  return out;
}

async function readPointsBin(file) {
  const r = new Reader(file);
  try {
    const n = r.u64();
    const xyz = new Float32Array(n * 3), rgb = new Uint8Array(n * 3), err = new Float32Array(n), track = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      r.skip(8); // its id
      xyz[k * 3] = r.f64();
      xyz[k * 3 + 1] = r.f64();
      xyz[k * 3 + 2] = r.f64();
      rgb[k * 3] = r.u8();
      rgb[k * 3 + 1] = r.u8();
      rgb[k * 3 + 2] = r.u8();
      err[k] = r.f64();
      const L = r.u64();
      track[k] = L;
      r.skip(L * 8); // which photos saw it: image id and 2-D point index (uint32 each)
      if (k % 100000 === 99999) await tick();
    }
    return { n, xyz, rgb, err, track };
  } finally {
    r.close();
  }
}

// ------------------------------------------------------------------------------------ text
function readCamerasTxt(file) {
  const out = new Map();
  eachLine(file, (l) => {
    if (l.startsWith('#')) return;
    const p = l.trim().split(/\s+/);
    if (p.length < 5) return;
    const m = MODEL_BY_NAME.get(p[1]);
    out.set(+p[0], { id: +p[0], model: p[1], width: +p[2], height: +p[3], params: p.slice(4, 4 + (m ? m.params : p.length)).map(Number) });
  });
  return out;
}

function readImagesTxt(file) {
  // Two lines a photo: its pose, then its 2-D points (that line can be empty).
  const out = [];
  let header = true;
  eachLine(file, (l) => {
    if (l.startsWith('#')) return;
    if (!header) {
      header = true;
      return;
    }
    const p = l.trim().split(/\s+/);
    if (p.length < 10) return;
    out.push(imagePose(+p[0], p.slice(1, 5).map(Number), p.slice(5, 8).map(Number), +p[8], p.slice(9).join(' ')));
    header = false;
  });
  return out;
}

function readPointsTxt(file) {
  const X = [], C = [], E = [], T = [];
  eachLine(file, (l) => {
    if (l.startsWith('#')) return;
    const p = l.trim().split(/\s+/);
    if (p.length < 8) return;
    X.push(+p[1], +p[2], +p[3]);
    C.push(+p[4], +p[5], +p[6]);
    E.push(+p[7]);
    T.push((p.length - 8) >> 1);
  });
  return { n: E.length, xyz: Float32Array.from(X), rgb: Uint8Array.from(C), err: Float32Array.from(E), track: Uint32Array.from(T) };
}

// ------------------------------------------------------------------------------------ a whole model
export const isModel = (dir) => !!dir && ['images.bin', 'images.txt'].some((f) => existsSync(join(dir, f)));

/**
 * Read a COLMAP model folder (binary when it has images.bin, else text).
 * @param {string} dir
 * @param {{points?: boolean}} [o] points: false skips points3D (only the photos are wanted)
 * @returns {Promise<{dir, format, cameras: Map, images: object[], points: object|null}>} images sorted by name
 */
export async function readModel(dir, { points = true } = {}) {
  const bin = existsSync(join(dir, 'images.bin'));
  const f = (name) => join(dir, `${name}.${bin ? 'bin' : 'txt'}`);
  if (!existsSync(f('images'))) throw new Error(`No COLMAP model in ${dir}`);
  const cameras = existsSync(f('cameras')) ? (bin ? readCamerasBin(f('cameras')) : readCamerasTxt(f('cameras'))) : new Map();
  const images = bin ? await readImagesBin(f('images')) : readImagesTxt(f('images'));
  images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let pts = null;
  if (points && existsSync(f('points3D'))) pts = bin ? await readPointsBin(f('points3D')) : readPointsTxt(f('points3D'));
  return { dir, format: bin ? 'bin' : 'txt', cameras, images, points: pts };
}

/** How wide a lens sees: tan of half its view across and down the image, from a COLMAP camera. */
export function lensOf(cam) {
  if (!cam || !cam.width || !cam.params || !cam.params.length) return null;
  const p = cam.params;
  const two = cam.model === 'PINHOLE' || cam.model === 'OPENCV' || cam.model === 'FULL_OPENCV' || cam.model === 'OPENCV_FISHEYE' || cam.model === 'FOV' || cam.model === 'THIN_PRISM_FISHEYE' || cam.model === 'RAD_TAN_THIN_PRISM_FISHEYE';
  const fx = p[0], fy = two ? p[1] : p[0];
  if (!(fx > 0 && fy > 0)) return null;
  return { tanX: cam.width / 2 / fx, tanY: cam.height / 2 / fy, w: cam.width, h: cam.height };
}

// ------------------------------------------------------------------------------------ thinning
function percentiles(xyz, n, k, ps) {
  const step = Math.max(1, Math.floor(n / 20000)), s = [];
  for (let i = 0; i < n; i += step) s.push(xyz[i * 3 + k]);
  s.sort((a, b) => a - b);
  return ps.map((p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]);
}

/**
 * Points for a browser: leave out ones seen badly (reprojection error over `maxError` px) and far-off strays
 * (outside the middle 98% of points along any axis, padded by 30%), then keep the best-seen point of each voxel,
 * growing the voxel until at most `max` points are left.
 * @param {{n, xyz: Float32Array, rgb: Uint8Array, err?: Float32Array, track?: ArrayLike<number>, weight?: ArrayLike<number>}} pts
 *   weight (or track length) says which point of a voxel to keep: the highest
 * @param {{max?: number, maxError?: number, voxel?: number}} [o] voxel: the smallest voxel to try (model units)
 * @returns {{n, xyz: Float32Array, rgb: Uint8Array, voxel: number, kept: number}} kept: points left before voxels
 */
export function thinPoints(pts, { max = 60000, maxError = 3, voxel = 0.02 } = {}) {
  const { n, xyz, rgb } = pts, w = pts.weight || pts.track || null;
  if (!n) return { n: 0, xyz: new Float32Array(0), rgb: new Uint8Array(0), voxel, kept: 0 };
  // Strays only count as strays among enough points to tell (a handful of points keeps all of them).
  const lo = [], hi = [];
  for (let k = 0; k < 3; k++) {
    const [a, b] = percentiles(xyz, n, k, n >= 200 ? [0.01, 0.99] : [0, 1]), pad = (b - a) * (n >= 200 ? 0.3 : 0) + 1e-6;
    lo.push(a - pad);
    hi.push(b + pad);
  }
  const ok = [];
  for (let i = 0; i < n; i++) {
    if (pts.err && pts.err[i] > maxError) continue;
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2] || !Number.isFinite(x + y + z)) continue;
    ok.push(i);
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let v = Math.max(voxel, span / 100000); // voxel indices stay under 2^17 along each axis
  const bucket = (size) => {
    const best = new Map(), G = 131072;
    for (const i of ok) {
      const key = (Math.floor((xyz[i * 3] - lo[0]) / size) * G + Math.floor((xyz[i * 3 + 1] - lo[1]) / size)) * G + Math.floor((xyz[i * 3 + 2] - lo[2]) / size);
      const j = best.get(key);
      if (j === undefined || (w && w[i] > w[j])) best.set(key, i);
    }
    return best;
  };
  let keep = ok.length > max ? bucket(v) : null;
  // Points lie on surfaces, so their count falls with the square of the voxel size.
  for (let tries = 0; keep && keep.size > max && tries < 12; tries++) {
    v *= Math.max(1.08, Math.sqrt(keep.size / max) * 1.03);
    keep = bucket(v);
  }
  const idx = keep ? [...keep.values()] : ok;
  const out = { n: idx.length, xyz: new Float32Array(idx.length * 3), rgb: new Uint8Array(idx.length * 3), voxel: keep ? v : 0, kept: ok.length };
  idx.forEach((i, k) => {
    for (let c = 0; c < 3; c++) {
      out.xyz[k * 3 + c] = xyz[i * 3 + c];
      out.rgb[k * 3 + c] = rgb[i * 3 + c];
    }
  });
  return out;
}

/** One point per cell of a floor grid (x, z), growing the cell until at most `max` remain: [x0, z0, x1, z1, …]. */
export function planSample(pts, max = 2500) {
  if (!pts.n) return [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.n; i++) {
    const x = pts.xyz[i * 3], z = pts.xyz[i * 3 + 2];
    [x0, z0, x1, z1] = [Math.min(x0, x), Math.min(z0, z), Math.max(x1, x), Math.max(z1, z)];
  }
  let cell = Math.max(x1 - x0, z1 - z0, 1e-6) / 400;
  for (;;) {
    const seen = new Map();
    for (let i = 0; i < pts.n; i++) {
      const key = Math.floor((pts.xyz[i * 3] - x0) / cell) * 1e6 + Math.floor((pts.xyz[i * 3 + 2] - z0) / cell);
      if (!seen.has(key)) seen.set(key, i);
    }
    if (seen.size <= max) return [...seen.values()].flatMap((i) => [pts.xyz[i * 3], pts.xyz[i * 3 + 2]]);
    cell *= Math.max(1.1, Math.sqrt(seen.size / max));
  }
}

/** Points as one binary blob for the browser: uint32 count, then float32 x, y, z of each, then uint8 r, g, b of each. */
export function packPoints(pts) {
  const buf = Buffer.alloc(4 + pts.n * 15);
  buf.writeUInt32LE(pts.n, 0);
  Buffer.from(pts.xyz.buffer, pts.xyz.byteOffset, pts.n * 12).copy(buf, 4);
  Buffer.from(pts.rgb.buffer, pts.rgb.byteOffset, pts.n * 3).copy(buf, 4 + pts.n * 12);
  return buf;
}

export function unpackPoints(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = b.readUInt32LE(0);
  const xyz = new Float32Array(n * 3), rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n * 3; i++) xyz[i] = b.readFloatLE(4 + i * 4);
  b.copy(Buffer.from(rgb.buffer), 0, 4 + n * 12, 4 + n * 15);
  return { n, xyz, rgb };
}
