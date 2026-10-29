// Walk maps: where you can walk in a finished splat (the viewer's first-person mode).
// Reads the Gaussians straight from the .ply, finds the floor (the densest layer below where the
// phone was held) and sorts every 10 cm of floor into floor, blocked (walls and furniture: solid
// splats between knee and head height) or nothing (no floor seen). Plain white walls can be too
// faint to block on their own, but the scanned floor stops at them, so "nothing" keeps you out too.

import { openSync, readSync, closeSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHeader } from './crop.mjs';
import { NOTHING, FLOOR, BLOCK, encodeCells } from '../web/walk.js';

export const WALKMAP_VERSION = 2;

const MIN_OPACITY = 0.15; // fainter splats are haze, not surfaces
const MAX_SIGMA = 1.0; // metres; bigger blobs are background fill
const SOLID = 0.8; // summed opacity that makes a 10 cm voxel solid
const KNEE = 0.3, HEAD = 1.9; // obstacle band above the floor (anything lower is stepped over)
const FLOOR_BAND = 0.15; // splats this close to the floor height count as floor
const FLOOR_MIN = 0.25; // summed opacity in a cell's floor band that counts as seen floor
const PATH_FLOOR = 0.3; // metres around the phone's path that count as floor even if unseen
const LAYER = 0.1; // voxel height
const MAX_CELLS = 600_000;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};

function camFrom(name, qw, qx, qy, qz, tx, ty, tz) {
  const R = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
  return { name, C: [0, 1, 2].map((j) => -(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz)), fwd: R[2] };
}

/** Camera centres and viewing directions from a COLMAP model folder (text or binary), by photo name. */
export function readCameras(modelDir) {
  const out = [];
  const txt = join(modelDir, 'images.txt'), bin = join(modelDir, 'images.bin');
  if (existsSync(txt)) {
    // Two lines per image; the second (its 2-D points) may be empty, so only comments are dropped.
    const lines = readFileSync(txt, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#'));
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const p = lines[i].trim().split(/\s+/);
      if (p.length >= 10) out.push(camFrom(p[9], ...p.slice(1, 8).map(Number)));
    }
  } else if (existsSync(bin)) {
    const b = readFileSync(bin);
    let o = 8;
    const n = Number(b.readBigUInt64LE(0));
    for (let i = 0; i < n && o < b.length; i++) {
      o += 4; // image id
      const q = [];
      for (let k = 0; k < 7; k++, o += 8) q.push(b.readDoubleLE(o));
      o += 4; // camera id
      const end = b.indexOf(0, o);
      const name = b.toString('utf8', o, end);
      o = end + 1;
      o += 8 + Number(b.readBigUInt64LE(o)) * 24; // 2-D points
      out.push(camFrom(name, ...q));
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Row-major rotation taking `up` to +y (the walk frame). */
export function upRotation(up) {
  const n = Math.hypot(...up) || 1;
  const u = up.map((v) => v / n);
  if (u[1] > 0.99999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (u[1] < -0.99999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const al = Math.hypot(u[2], u[0]);
  const a = [-u[2] / al, 0, u[0] / al]; // u × y
  const c = u[1], s = Math.sqrt(1 - c * c), t = 1 - c;
  return [
    c + t * a[0] * a[0], t * a[0] * a[1] - s * a[2], t * a[0] * a[2] + s * a[1],
    t * a[1] * a[0] + s * a[2], c + t * a[1] * a[1], t * a[1] * a[2] - s * a[0],
    t * a[2] * a[0] - s * a[1], t * a[2] * a[1] + s * a[0], c + t * a[2] * a[2],
  ];
}

const mul = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

/** Opaque-enough splats, positions turned into the walk frame. */
async function readSplats(plyFile, R) {
  const fd = openSync(plyFile, 'r');
  try {
    const { dataStart, count, stride, off } = readHeader(fd);
    for (const p of ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
      if (!(p in off)) throw new Error(`The splat has no ${p} values`);
    }
    const P = new Float32Array(count * 3), A = new Float32Array(count), S = new Float32Array(count * 3), Q = new Float32Array(count * 4);
    const L = new Float32Array(count);
    const per = Math.max(1, Math.floor((8 << 20) / stride));
    const chunk = Buffer.alloc(per * stride);
    let n = 0;
    for (let i = 0; i < count; i += per) {
      const m = Math.min(per, count - i);
      readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
      for (let j = 0; j < m; j++) {
        const o = j * stride;
        const a = 1 / (1 + Math.exp(-chunk.readFloatLE(o + off.opacity)));
        if (a < MIN_OPACITY) continue;
        const p = mul(R, [chunk.readFloatLE(o + off.x), chunk.readFloatLE(o + off.y), chunk.readFloatLE(o + off.z)]);
        P[n * 3] = p[0];
        P[n * 3 + 1] = p[1];
        P[n * 3 + 2] = p[2];
        A[n] = a;
        for (let k = 0; k < 3; k++) S[n * 3 + k] = Math.exp(chunk.readFloatLE(o + off['scale_' + k]));
        for (let k = 0; k < 4; k++) Q[n * 4 + k] = chunk.readFloatLE(o + off['rot_' + k]);
        L[n] = levelArea(S, Q, n, R) * a;
        n++;
      }
      await new Promise((r) => setImmediate(r)); // keep the station responsive on big splats
    }
    // A few huge flat splats shouldn't outweigh a whole floor.
    const cap = n ? percentile(L.subarray(0, n), 1, 0, 0.99) : 0;
    for (let i = 0; i < n; i++) L[i] = Math.min(L[i], cap);
    return { n, P, A, S, Q, L, total: count };
  } finally {
    closeSync(fd);
  }
}

/**
 * How much level surface a splat stands for: the area of its flat side, times how level that side
 * is (its thinnest axis pointing up) and how flat the splat is. Counting splats instead would let
 * a band of detailed posters outweigh a plain floor, which training covers with fewer, bigger splats.
 */
function levelArea(S, Q, n, R) {
  const s = [S[n * 3], S[n * 3 + 1], S[n * 3 + 2]];
  const m = s[0] <= s[1] && s[0] <= s[2] ? 0 : s[1] <= s[2] ? 1 : 2; // thinnest axis
  const [lo, mid, hi] = [...s].sort((a, b) => a - b);
  let w = Q[n * 4], x = Q[n * 4 + 1], y = Q[n * 4 + 2], z = Q[n * 4 + 3];
  const qn = Math.hypot(w, x, y, z) || 1;
  [w, x, y, z] = [w / qn, x / qn, y / qn, z / qn];
  const col = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ][m]; // column m of the splat's rotation
  const up = R[3] * col[0] + R[4] * col[1] + R[5] * col[2];
  return up * up * (1 - lo / mid) * mid * hi;
}

/** Height (walk frame) of the layer with the most level surface between lo and hi, near the path. */
function densestLayer(sp, lo, hi, bin, near) {
  const nb = Math.max(3, Math.ceil((hi - lo) / bin));
  const h = new Float64Array(nb);
  let total = 0;
  for (let i = 0; i < sp.n; i++) {
    const y = sp.P[i * 3 + 1];
    if (y < lo || y >= hi || !near(sp.P[i * 3], sp.P[i * 3 + 2])) continue;
    h[Math.floor((y - lo) / bin)] += sp.L[i];
    total += sp.L[i];
  }
  let best = -1, bw = 0;
  for (let b = 0; b < nb; b++) {
    const w = h[b] * 2 + (h[b - 1] || 0) + (h[b + 1] || 0);
    if (w > bw) [best, bw] = [b, w];
  }
  if (best < 0) return null;
  // Refine to the weighted mean height around the peak.
  const c = lo + (best + 0.5) * bin;
  let sw = 0, sy = 0;
  for (let i = 0; i < sp.n; i++) {
    const y = sp.P[i * 3 + 1];
    if (Math.abs(y - c) > bin * 2.5 || !near(sp.P[i * 3], sp.P[i * 3 + 2])) continue;
    sw += sp.L[i];
    sy += sp.L[i] * y;
  }
  return { y: sw ? sy / sw : c, share: total ? bw / 4 / total : 0 };
}

function percentile(arr, stride, k, p) {
  const n = arr.length / stride;
  const step = Math.max(1, Math.floor(n / 20000));
  const s = [];
  for (let i = 0; i < n; i += step) s.push(arr[i * stride + k]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function insidePoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToPoly(poly, x, z) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

/**
 * @param {string} plyFile
 * @param {object} o
 * @param {Array<{name, C, fwd}>} o.cams camera centres/directions in splat coordinates (the phone's path)
 * @param {number[]} [o.up] splat-space up direction
 * @param {boolean} [o.metric] splat is in metres (AR frame); otherwise the scale is estimated
 * @param {number[][]} [o.poly] scan-area outline [[x, z], …] (AR frame only)
 * @param {number} [o.camHeight] when not metric: how high the camera was held, which sets the scale
 */
export async function buildWalkMap(plyFile, { cams = [], up = [0, 1, 0], metric = true, poly = null, camHeight = 1.5 } = {}) {
  if (!cams.length) throw new Error('No camera path to find the floor from');
  const R = upRotation(up);
  const sp = await readSplats(plyFile, R);
  let C = cams.map((c) => ({ C: mul(R, c.C), fwd: mul(R, c.fwd) }));
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const { C: p } of C) {
    bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]);
    bz0 = Math.min(bz0, p[2]); bz1 = Math.max(bz1, p[2]);
  }
  let camY = median(C.map((c) => c.C[1]));

  // Unknown scale (a video): take the densest layer below the camera as the floor and assume the
  // camera was held camHeight above it.
  let k = 1;
  if (!metric) {
    const pad = Math.max(bx1 - bx0, bz1 - bz0) * 0.25;
    const near = (x, z) => x > bx0 - pad && x < bx1 + pad && z > bz0 - pad && z < bz1 + pad;
    const span = camY - percentile(sp.P, 3, 1, 0.01);
    const f = span > 0 && densestLayer(sp, camY - span * 1.15, camY - span * 0.15, span / 300, near);
    if (!f) throw new Error('Could not find a floor below the camera path');
    k = camHeight / (camY - f.y);
    for (let i = 0; i < sp.n * 3; i++) {
      sp.P[i] *= k;
      sp.S[i] *= k;
    }
    C = C.map((c) => ({ C: c.C.map((v) => v * k), fwd: c.fwd }));
    [bx0, bx1, bz0, bz1, camY] = [bx0 * k, bx1 * k, bz0 * k, bz1 * k, camY * k];
  }

  // The floor: densest layer 0.7–2.2 m below the phone, near where it went.
  const nearPath = (x, z) => x > bx0 - 1 && x < bx1 + 1 && z > bz0 - 1 && z < bz1 + 1;
  const fl = densestLayer(sp, camY - 2.2, camY - 0.7, 0.02, nearPath);
  const floorGuessed = !fl || fl.share < 0.02;
  const F = floorGuessed ? camY - 1.5 : fl.y;

  // Map area: around the phone's path and the scan outline, but not beyond the splat itself.
  let gx0 = bx0 - 3, gx1 = bx1 + 3, gz0 = bz0 - 3, gz1 = bz1 + 3;
  if (poly && poly.length >= 3) {
    for (const [x, z] of poly) {
      gx0 = Math.min(gx0, x - 0.6); gx1 = Math.max(gx1, x + 0.6);
      gz0 = Math.min(gz0, z - 0.6); gz1 = Math.max(gz1, z + 0.6);
    }
  }
  gx0 = Math.max(gx0, Math.min(bx0, percentile(sp.P, 3, 0, 0.002)) - 0.3);
  gx1 = Math.min(gx1, Math.max(bx1, percentile(sp.P, 3, 0, 0.998)) + 0.3);
  gz0 = Math.max(gz0, Math.min(bz0, percentile(sp.P, 3, 2, 0.002)) - 0.3);
  gz1 = Math.min(gz1, Math.max(bz1, percentile(sp.P, 3, 2, 0.998)) + 0.3);
  let cell = 0.1;
  while (((gx1 - gx0) * (gz1 - gz0)) / (cell * cell) > MAX_CELLS) cell += 0.05;
  const W = Math.ceil((gx1 - gx0) / cell), H = Math.ceil((gz1 - gz0) / cell);
  const base = F - FLOOR_BAND; // bottom of the lowest layer
  const L = Math.ceil((HEAD + FLOOR_BAND) / LAYER);
  const vox = new Float32Array(W * H * L);

  // Splat each Gaussian's 1-sigma ellipsoid into the voxels: big flat splats on plain walls cover
  // many voxels, so the wall is solid between their centres.
  const seen = new Set();
  const M = new Float64Array(9);
  for (let s = 0; s < sp.n; s++) {
    const x = sp.P[s * 3], y = sp.P[s * 3 + 1], z = sp.P[s * 3 + 2];
    const s0 = sp.S[s * 3], s1 = sp.S[s * 3 + 1], s2 = sp.S[s * 3 + 2];
    const big = Math.max(s0, s1, s2);
    if (big > MAX_SIGMA) continue;
    if (y + big < base || y - big > F + HEAD || x + big < gx0 || x - big > gx1 || z + big < gz0 || z - big > gz1) continue;
    const a = sp.A[s];
    const put = (px, py, pz) => {
      const i = Math.floor((px - gx0) / cell), j = Math.floor((pz - gz0) / cell), l = Math.floor((py - base) / LAYER);
      if (i < 0 || j < 0 || l < 0 || i >= W || j >= H || l >= L) return -1;
      return (l * H + j) * W + i;
    };
    if (big <= LAYER / 2) {
      const v = put(x, y, z);
      if (v >= 0) vox[v] += a;
      continue;
    }
    // Rotation (splat → scene) from the quaternion, then into the walk frame.
    let qw = sp.Q[s * 4], qx = sp.Q[s * 4 + 1], qy = sp.Q[s * 4 + 2], qz = sp.Q[s * 4 + 3];
    const qn = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= qn; qx /= qn; qy /= qn; qz /= qn;
    const Rs = [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = R[r * 3] * Rs[c] + R[r * 3 + 1] * Rs[3 + c] + R[r * 3 + 2] * Rs[6 + c];
    const sig = [s0, s1, s2];
    const cnt = sig.map((g) => Math.min(7, Math.max(1, Math.ceil((2 * g) / cell))));
    seen.clear();
    for (let u = 0; u < cnt[0]; u++) {
      const tu = cnt[0] === 1 ? 0 : -1 + (2 * u + 1) / cnt[0];
      for (let v = 0; v < cnt[1]; v++) {
        const tv = cnt[1] === 1 ? 0 : -1 + (2 * v + 1) / cnt[1];
        for (let w = 0; w < cnt[2]; w++) {
          const tw = cnt[2] === 1 ? 0 : -1 + (2 * w + 1) / cnt[2];
          if (tu * tu + tv * tv + tw * tw > 1) continue;
          const e0 = tu * s0, e1 = tv * s1, e2 = tw * s2;
          const vi = put(x + M[0] * e0 + M[1] * e1 + M[2] * e2, y + M[3] * e0 + M[4] * e1 + M[5] * e2, z + M[6] * e0 + M[7] * e1 + M[8] * e2);
          if (vi >= 0 && !seen.has(vi)) {
            seen.add(vi);
            vox[vi] += a;
          }
        }
      }
    }
  }

  // Sort the cells.
  const cells = new Uint8Array(W * H);
  const fl1 = Math.round((2 * FLOOR_BAND) / LAYER); // layers in the floor band
  const ob0 = Math.ceil((KNEE + FLOOR_BAND) / LAYER - 1e-9); // first layer above the knee
  for (let c = 0; c < W * H; c++) {
    let fw = 0, solid = 0, peak = 0;
    for (let l = 0; l < fl1; l++) fw += vox[l * W * H + c];
    for (let l = ob0; l < L; l++) {
      const w = vox[l * W * H + c];
      if (w >= SOLID) solid++;
      if (w > peak) peak = w;
    }
    // Two solid voxels (a wall, a chair back), or one very solid one (a table top).
    cells[c] = solid >= 2 || peak >= SOLID * 2.5 ? BLOCK : fw >= FLOOR_MIN ? FLOOR : NOTHING;
  }
  // Where the phone went counts as floor even if none was seen (dark or shiny floors).
  const pr = Math.ceil(PATH_FLOOR / cell);
  for (const { C: p } of C) {
    const ci = Math.floor((p[0] - gx0) / cell), cj = Math.floor((p[2] - gz0) / cell);
    for (let j = cj - pr; j <= cj + pr; j++) for (let i = ci - pr; i <= ci + pr; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H || (i - ci) ** 2 + (j - cj) ** 2 > pr * pr) continue;
      if (cells[j * W + i] === NOTHING) cells[j * W + i] = FLOOR;
    }
  }
  // Holes in the floor that don't reach the map edge are floor too (rugs, reflections, glare).
  const outside = new Uint8Array(W * H);
  const stack = [];
  const push = (i, j) => {
    if (i < 0 || j < 0 || i >= W || j >= H) return;
    const c = j * W + i;
    if (outside[c] || cells[c] !== NOTHING) return;
    outside[c] = 1;
    stack.push(c);
  };
  for (let i = 0; i < W; i++) { push(i, 0); push(i, H - 1); }
  for (let j = 0; j < H; j++) { push(0, j); push(W - 1, j); }
  while (stack.length) {
    const c = stack.pop(), i = c % W, j = (c - i) / W;
    push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
  }
  for (let c = 0; c < W * H; c++) if (cells[c] === NOTHING && !outside[c]) cells[c] = FLOOR;
  // Stay inside the scan area marked on the phone.
  if (poly && poly.length >= 3) {
    const P2 = poly.map(([x, z]) => {
      const p = mul(R, [x, 0, z]);
      return [p[0] * k, p[2] * k];
    });
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i;
      if (cells[c] !== FLOOR) continue;
      const x = gx0 + (i + 0.5) * cell, z = gz0 + (j + 0.5) * cell;
      if (!insidePoly(P2, x, z) && distToPoly(P2, x, z) > 0.25) cells[c] = NOTHING;
    }
  }

  let floorCells = 0, blockCells = 0;
  for (const v of cells) v === FLOOR ? floorCells++ : v === BLOCK ? blockCells++ : 0;
  const first = C[0];
  const eye = Math.min(1.8, Math.max(1.2, median(C.map((c) => c.C[1] - F))));
  return {
    version: WALKMAP_VERSION,
    cell, x0: gx0, z0: gz0, W, H,
    floorY: F, eye, floorGuessed, metric,
    rot: R, scale: k,
    start: { x: first.C[0], z: first.C[2], yaw: Math.atan2(first.fwd[0], first.fwd[2]) },
    stats: { splats: sp.total, used: sp.n, floorCells, blockCells },
    cells: encodeCells(cells),
  };
}

/**
 * What a walk map needs for one splat: the phone's path, up direction, scale and scan outline,
 * from the job folder when it still exists (else just the viewer's start view).
 * @param {object} o {jobDir, mode, view, up, pano} — `up` is the viewer's current up (it can be
 *   flipped); `pano` marks 360 video, filmed with the camera on a stick above head height
 */
export function walkInputs({ jobDir = null, mode = null, view = null, up = null, pano = false }) {
  const ar = /^(ar-poses|sfm-ar)$/.test(mode || '');
  let cams = [];
  for (const d of jobDir ? [join(jobDir, 'colmap', 'final_txt'), join(jobDir, 'train', 'sparse', '0')] : []) {
    if (existsSync(d)) cams = readCameras(d);
    if (cams.length) break;
  }
  if (!cams.length && view && view.position && view.lookAt) {
    const f = view.lookAt.map((v, i) => v - view.position[i]);
    const n = Math.hypot(...f) || 1;
    cams = [{ name: 'start', C: view.position, fwd: f.map((v) => v / n) }];
  }
  let poly = null;
  const mf = jobDir && join(jobDir, 'dataset', 'splatscout.json');
  if (ar && mf && existsSync(mf)) {
    try {
      const b = JSON.parse(readFileSync(mf, 'utf8')).bounds;
      if (b && b.poly && b.poly.length >= 3) poly = b.poly;
    } catch {}
  }
  let u = up || (view && view.up) || [0, 1, 0];
  // AR splats are exactly y-up (unless someone flipped the viewer).
  if (ar) u = u[1] < 0 ? [0, -1, 0] : [0, 1, 0];
  return { cams, up: u, metric: ar, poly, camHeight: pano ? 1.9 : 1.5 };
}

const building = new Map();

/** Cached walk map for a splat (kept next to it as <name>.walk.json). */
export async function walkMapFor(plyFile, inputs) {
  const st = statSync(plyFile);
  const cacheFile = plyFile.replace(/\.ply$/i, '') + '.walk.json';
  const key = [WALKMAP_VERSION, st.size, Math.round(st.mtimeMs), inputs.up.map((v) => v.toFixed(3)).join(',')].join('|');
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (c.key === key) return c;
    } catch {}
  }
  if (building.has(cacheFile)) return building.get(cacheFile);
  const p = buildWalkMap(plyFile, inputs)
    .then((map) => {
      const out = { key, ...map };
      try {
        writeFileSync(cacheFile, JSON.stringify(out));
      } catch {}
      return out;
    })
    .finally(() => building.delete(cacheFile));
  building.set(cacheFile, p);
  return p;
}
