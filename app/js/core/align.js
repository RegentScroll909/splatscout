// Re-alignment: put a new or drifted AR coordinate frame back onto the scan.
//
// Every AR session has its own origin and heading, and ARCore can shift its frame after losing
// tracking. All of them share gravity, so two frames differ only by a turn about the vertical axis
// and a shift: 4 numbers. They are found by matching what the depth sensor sees now against the
// surfaces already in the coverage map:
//  1. Floor-plan search: a horizontal slice of the live depth points is turned and slid over a
//     blurred floor plan of the mapped surfaces (every heading and place, or near a guess).
//  2. ICP: the best candidates are refined in 3D (point-to-plane, heading + shift only).
//  3. Visibility check: from the aligned pose, the live depth must not see through mapped surfaces.

import { DEG, clamp, mat4Mul } from './math.js';
import { VoxelMap } from './coverage.js';

// ------------------------------------------------------------------ heading + shift transforms
// xf = {yaw (rad), t: [x, y, z]}: p' = Ry(yaw) p + t, where Ry turns +z towards +x.

export const XF_ID = Object.freeze({ yaw: 0, t: Object.freeze([0, 0, 0]) });

export const xf = (yaw = 0, t = [0, 0, 0]) => ({ yaw, t: [t[0], t[1], t[2]] });

export function xfApply(a, p) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return [c * p[0] + s * p[2] + a.t[0], p[1] + a.t[1], -s * p[0] + c * p[2] + a.t[2]];
}

export function xfApplyDir(a, d) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return [c * d[0] + s * d[2], d[1], -s * d[0] + c * d[2]];
}

/** a after b: p → a(b(p)). */
export function xfCompose(a, b) {
  const r = xfApplyDir(a, b.t);
  return { yaw: wrap(a.yaw + b.yaw), t: [r[0] + a.t[0], r[1] + a.t[1], r[2] + a.t[2]] };
}

export function xfInverse(a) {
  const r = xfApplyDir({ yaw: -a.yaw }, a.t);
  return { yaw: wrap(-a.yaw), t: [-r[0], -r[1], -r[2]] };
}

export function xfIsIdentity(a) {
  return !a || (a.yaw === 0 && a.t[0] === 0 && a.t[1] === 0 && a.t[2] === 0);
}

/** Column-major 4x4. */
export function xfMatrix(a) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  const m = new Float32Array(16);
  m[0] = c; m[2] = -s; m[5] = 1; m[8] = s; m[10] = c;
  m[12] = a.t[0]; m[13] = a.t[1]; m[14] = a.t[2]; m[15] = 1;
  return m;
}

export function xfPose(a, pose, out) {
  return mat4Mul(xfMatrix(a), pose, out);
}

export function xfPoints(a, pts) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], z = pts[i + 2];
    out[i] = c * x + s * z + a.t[0];
    out[i + 1] = pts[i + 1] + a.t[1];
    out[i + 2] = -s * x + c * z + a.t[2];
  }
  return out;
}

/** How far apart two transforms are: {dist (m), yaw (deg)}, measured at point p (default origin). */
export function xfDelta(a, b, p = [0, 0, 0]) {
  const pa = xfApply(a, p), pb = xfApply(b, p);
  return { dist: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]), yaw: Math.abs(wrap(a.yaw - b.yaw)) / DEG };
}

/** Move part of the way from a to b (for small corrections). */
export function xfBlend(a, b, k) {
  return { yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * k), t: a.t.map((v, i) => v + (b.t[i] - v) * k) };
}

/** Heading of a pose (angle of its horizontal view direction; the top edge when looking straight down). */
export function poseHeading(pose) {
  let x = -pose[8], z = -pose[10];
  if (Math.hypot(x, z) < 0.3) [x, z] = [pose[4], pose[6]];
  return Math.atan2(x, z);
}

/** The transform that puts pose `from` onto pose `to` (heading and position). */
export function xfFromPoses(to, from) {
  const yaw = wrap(poseHeading(to) - poseHeading(from));
  const r = xfApplyDir({ yaw }, [from[12], from[13], from[14]]);
  return { yaw, t: [to[12] - r[0], to[13] - r[1], to[14] - r[2]] };
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------ small linear algebra

/** Solve A x = b (n x n, row-major Float64Array) by Gaussian elimination. Returns null if singular. */
export function solve(A, b, n) {
  const M = Float64Array.from(A), x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/** Eigenvalues (ascending) and unit eigenvectors of a symmetric n x n matrix (Jacobi rotations). */
export function eigSym(A, n) {
  const a = Float64Array.from(A);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [...Array(n).keys()].sort((i, j) => a[i * n + i] - a[j * n + j]);
  return { values: idx.map((i) => a[i * n + i]), vectors: idx.map((i) => Array.from({ length: n }, (_, k) => v[k * n + i])) };
}

// ------------------------------------------------------------------ map lookups

/** Surface normal of a voxel from the solid voxels around it (cached), or null where it isn't flat. */
export function voxelNormal(vm, v) {
  if (v._nn === v.n) return v._nrm;
  const pts = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const u = vm.vox.get(vm.key(v.ix + dx, v.iy + dy, v.iz + dz));
        if (u && VoxelMap.isSolid(u)) pts.push([u.sx / u.n, u.sy / u.n, u.sz / u.n]);
      }
    }
  }
  let nrm = null;
  if (pts.length >= 4) {
    const m = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) m[k] += p[k] / pts.length;
    const C = new Float64Array(9);
    for (const p of pts) {
      const d = [p[0] - m[0], p[1] - m[1], p[2] - m[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
    }
    const e = eigSym(C, 3);
    // Flat enough: the thinnest direction is much thinner than the middle one.
    if (e.values[0] < 0.2 * e.values[1]) nrm = e.vectors[0];
  }
  v._nn = v.n;
  v._nrm = nrm;
  return nrm;
}

/** Nearest surface voxel to p within maxDist: {v, p (centroid), d2} or null. */
function nearest(vm, x, y, z, maxDist, accept) {
  const s = vm.size;
  const ix = Math.floor(x / s), iy = Math.floor(y / s), iz = Math.floor(z / s);
  const R = s >= 0.15 ? 1 : Math.min(2, Math.ceil(maxDist / s));
  let best = null, bd = maxDist * maxDist;
  for (let dx = -R; dx <= R; dx++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        const v = vm.vox.get(vm.key(ix + dx, iy + dy, iz + dz));
        if (!v || !VoxelMap.isSolid(v) || (accept && !accept(v))) continue;
        const inv = 1 / v.n;
        const ex = v.sx * inv - x, ey = v.sy * inv - y, ez = v.sz * inv - z;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < bd) {
          bd = d2;
          best = v;
        }
      }
    }
  }
  return best ? { v: best, d2: bd } : null;
}

// ------------------------------------------------------------------ ICP (heading + shift)

/**
 * Refine `x0` (live frame → scan frame) so the live points `pts` (flat xyz, live frame) lie on the
 * map's surfaces.
 * @param {VoxelMap} vm
 * @param {Float32Array} pts
 * @param {{yaw, t}} x0
 * @param {object} [o]
 * @param {number} [o.iters]
 * @param {number} [o.maxDist] correspondence distance at the start (m), shrinking to o.minDist
 * @param {number} [o.minDist]
 * @param {(v) => boolean} [o.accept] which map voxels may be matched
 * @param {number|null} [o.yPrior] keep the vertical shift near this value (floor heights agree)
 * @returns {{xf, n, matched, inliers, overlap, rms, cond, weak}}
 */
export function icp(vm, pts, x0, o = {}) {
  const iters = o.iters || 10, maxDist = o.maxDist || 0.35, minDist = o.minDist || 0.08;
  const n = pts.length / 3;
  let cur = xf(x0.yaw, x0.t);
  let H = null;
  for (let it = 0; it < iters; it++) {
    const md = iters > 1 ? maxDist + ((minDist - maxDist) * it) / (iters - 1) : minDist;
    const q = xfPoints(cur, pts);
    let cx = 0, cz = 0;
    for (let i = 0; i < q.length; i += 3) {
      cx += q[i];
      cz += q[i + 2];
    }
    cx /= n || 1;
    cz /= n || 1;
    const A = new Float64Array(16), g = new Float64Array(4);
    let wsum = 0;
    const add = (J, r, w) => {
      for (let i = 0; i < 4; i++) {
        g[i] += w * J[i] * r;
        for (let j = 0; j < 4; j++) A[i * 4 + j] += w * J[i] * J[j];
      }
      wsum += w;
    };
    for (let i = 0; i < q.length; i += 3) {
      const x = q[i], y = q[i + 1], z = q[i + 2];
      const m = nearest(vm, x, y, z, md, o.accept);
      if (!m) continue;
      const v = m.v, inv = 1 / v.n;
      const mx = v.sx * inv, my = v.sy * inv, mz = v.sz * inv;
      const vx = x - cx, vz = z - cz;
      const nrm = voxelNormal(vm, v);
      if (nrm) {
        const r = nrm[0] * (x - mx) + nrm[1] * (y - my) + nrm[2] * (z - mz);
        add([nrm[0] * vz - nrm[2] * vx, nrm[0], nrm[1], nrm[2]], r, huber(r, 0.04));
      } else {
        // Corners and clutter: plain point-to-point, weighted down.
        add([vz, 1, 0, 0], x - mx, 0.3 * huber(x - mx, 0.06));
        add([0, 0, 1, 0], y - my, 0.3 * huber(y - my, 0.06));
        add([-vx, 0, 0, 1], z - mz, 0.3 * huber(z - mz, 0.06));
      }
    }
    if (wsum < 20) break;
    if (o.yPrior != null) add([0, 0, 1, 0], cur.t[1] - o.yPrior, wsum * 0.02);
    H = A.map((v) => v / wsum);
    for (let i = 0; i < 4; i++) A[i * 4 + i] += 1e-4 * wsum;
    const d = solve(A, g.map((v) => -v), 4);
    if (!d) break;
    const step = clamp(d[0], -0.2, 0.2);
    // Turn about the live points' centre, then shift.
    const rc = xfApplyDir({ yaw: step }, [cur.t[0] - cx, 0, cur.t[2] - cz]);
    cur = { yaw: wrap(cur.yaw + step), t: [rc[0] + cx + d[1], cur.t[1] + d[2], rc[2] + cz + d[3]] };
    if (Math.abs(step) < 1e-4 && Math.hypot(d[1], d[2], d[3]) < 5e-4 && it > 2) break;
  }
  return { xf: cur, ...fitStats(vm, pts, cur, o.accept), ...conditioning(H) };
}

function huber(r, c) {
  const a = Math.abs(r);
  return a <= c ? 1 : c / a;
}

/**
 * How well the live points sit on the map under `x`. "inFree": live surfaces where the map has
 * seen empty space, which happens when only the room's outline matches.
 */
export function fitStats(vm, pts, x, accept) {
  const q = xfPoints(x, pts);
  const n = q.length / 3;
  let matched = 0, inliers = 0, se = 0, inFree = 0;
  for (let i = 0; i < q.length; i += 3) {
    const m = nearest(vm, q[i], q[i + 1], q[i + 2], 0.3, accept);
    if (!m) {
      if (vm.isFreeAt(q[i], q[i + 1], q[i + 2])) inFree++;
      continue;
    }
    matched++;
    const v = m.v, inv = 1 / v.n, nrm = voxelNormal(vm, v);
    const r = nrm
      ? Math.abs(nrm[0] * (q[i] - v.sx * inv) + nrm[1] * (q[i + 1] - v.sy * inv) + nrm[2] * (q[i + 2] - v.sz * inv))
      : Math.sqrt(m.d2);
    if (r < 0.07) inliers++;
    se += Math.min(r, 0.3) ** 2;
  }
  return {
    n, matched, inliers, overlap: n ? matched / n : 0, inlierFrac: matched ? inliers / matched : 0,
    rms: matched ? Math.sqrt(se / matched) : 1, freeFrac: n ? inFree / n : 0,
  };
}

/** Which directions the fit pins down: cond = smallest eigenvalue; weak = 'height' | 'slide' | null. */
function conditioning(H) {
  if (!H) return { cond: 0, weak: 'slide' };
  const e = eigSym(H, 4);
  const cond = e.values[0];
  let weak = null;
  if (cond < 0.03) weak = Math.abs(e.vectors[0][2]) > 0.7 ? 'height' : 'slide';
  return { cond, weak };
}

// ------------------------------------------------------------------ visibility check

/**
 * From the aligned live poses, does the live depth see through mapped surfaces? Counts mapped
 * surfaces that the live depth agrees with (match) and ones it sees past (through).
 * @param frames [{pose (live frame), intr, d, nx, ny}]
 */
export function visibility(vm, frames, x, accept, maxFrames = 10) {
  let match = 0, through = 0;
  const step = Math.max(1, Math.floor(frames.length / maxFrames));
  const M = xfMatrix(x);
  const tol0 = 0.5 * vm.size + 0.05;
  for (let fi = frames.length - 1; fi >= 0; fi -= step) {
    const f = frames[fi];
    if (!f.d) continue;
    const pose = mat4Mul(M, f.pose);
    const { d, nx, ny } = f, intr = f.intr;
    const cx = pose[12], cy = pose[13], cz = pose[14];
    for (const v of vm.vox.values()) {
      if (!VoxelMap.isSolid(v) || (accept && !accept(v))) continue;
      const inv = 1 / v.n;
      const wx = v.sx * inv - cx, wy = v.sy * inv - cy, wz = v.sz * inv - cz;
      const zc = -(pose[8] * wx + pose[9] * wy + pose[10] * wz);
      if (zc < 0.3 || zc > 6) continue;
      const px = pose[0] * wx + pose[1] * wy + pose[2] * wz;
      const py = pose[4] * wx + pose[5] * wy + pose[6] * wz;
      const u = (intr.cx + (intr.fx * px) / zc) / intr.w;
      const w = (intr.cy - (intr.fy * py) / zc) / intr.h;
      if (u < 0.05 || u > 0.95 || w < 0.05 || w > 0.95) continue;
      const i = Math.min(nx - 1, Math.floor(u * nx)), j = Math.min(ny - 1, Math.floor(w * ny));
      const tol = tol0 + 0.03 * zc;
      let near = false, all = true, any = false;
      for (let jj = Math.max(0, j - 1); jj <= Math.min(ny - 1, j + 1); jj++) {
        for (let ii = Math.max(0, i - 1); ii <= Math.min(nx - 1, i + 1); ii++) {
          const m = d[jj * nx + ii];
          if (!(m > 0)) continue;
          any = true;
          if (Math.abs(m - zc) < tol) near = true;
          if (m < zc + 2 * tol) all = false;
        }
      }
      if (!any) continue;
      if (near) match++;
      else if (all) through++;
    }
  }
  return { match, through, ratio: match + through ? through / (match + through) : 0 };
}

// ------------------------------------------------------------------ live data

/**
 * Pool live depth frames into one evenly spaced point set (live frame).
 * @param frames [{pts: Float32Array, pose}]
 * @returns {{pts, n, floorY, camY}}
 */
export function poolLive(frames, cell = 0.08, maxPts = 1500) {
  const cells = new Map();
  let camY = 0;
  for (const f of frames) {
    camY += f.pose[13] / frames.length;
    const p = f.pts;
    for (let i = 0; i < p.length; i += 3) {
      const k = `${Math.floor(p[i] / cell)},${Math.floor(p[i + 1] / cell)},${Math.floor(p[i + 2] / cell)}`;
      let c = cells.get(k);
      if (!c) cells.set(k, (c = [0, 0, 0, 0]));
      c[0] += p[i];
      c[1] += p[i + 1];
      c[2] += p[i + 2];
      c[3]++;
    }
  }
  let list = [...cells.values()].map((c) => [c[0] / c[3], c[1] / c[3], c[2] / c[3]]);
  if (list.length > maxPts) {
    // Deterministic thinning keeps results repeatable.
    const k = list.length / maxPts;
    list = Array.from({ length: maxPts }, (_, i) => list[Math.floor(i * k)]);
  }
  const pts = new Float32Array(list.length * 3);
  list.forEach((p, i) => pts.set(p, i * 3));
  return { pts, n: list.length, floorY: floorOf(list.map((p) => p[1])), camY };
}

/** Floor height from a set of point heights: a dense layer at the bottom, or null. */
export function floorOf(ys) {
  if (ys.length < 40) return null;
  const s = ys.slice().sort((a, b) => a - b);
  const f = s[Math.floor(s.length * 0.04)];
  let near = 0;
  for (const y of s) {
    if (y > f + 0.08) break;
    if (y > f - 0.08) near++;
  }
  return near >= Math.max(15, 0.06 * s.length) ? f : null;
}

// ------------------------------------------------------------------ floor-plan search

/** A blurred floor plan of the mapped surfaces between knee and head height. */
export class FloorPlan {
  constructor(vm, floorY, res = 0.1) {
    if (floorY == null) {
      const ys = [];
      for (const v of vm.vox.values()) if (VoxelMap.isSolid(v)) ys.push(v.sy / v.n);
      floorY = floorOf(ys);
    }
    const pts = [];
    for (const v of vm.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      const y = v.sy / v.n;
      if (floorY != null && (y < floorY + 0.3 || y > floorY + 2.1)) continue;
      pts.push([v.sx / v.n, v.sz / v.n]);
    }
    this.floorY = floorY;
    this.n = pts.length;
    this.res = res;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    if (!pts.length) [x0, z0, x1, z1] = [0, 0, 0, 0];
    this.x0 = x0 - 1;
    this.z0 = z0 - 1;
    this.W = Math.ceil((x1 - x0 + 2) / res) + 1;
    this.H = Math.ceil((z1 - z0 + 2) / res) + 1;
    this.fine = new Float32Array(this.W * this.H);
    const sig = 0.12, R = 3;
    for (const [x, z] of pts) {
      const gx = (x - this.x0) / res, gz = (z - this.z0) / res;
      const ix = Math.floor(gx), iz = Math.floor(gz);
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const cx = ix + dx, cz = iz + dz;
          if (cx < 0 || cz < 0 || cx >= this.W || cz >= this.H) continue;
          const ex = (cx + 0.5 - gx) * res, ez = (cz + 0.5 - gz) * res;
          const val = Math.exp(-(ex * ex + ez * ez) / (2 * sig * sig));
          const k = cz * this.W + cx;
          if (val > this.fine[k]) this.fine[k] = val;
        }
      }
    }
    // Coarser levels (3x and 9x the cell size, max-pooled) for the wide search.
    this.cres = res * 3;
    [this.coarse, this.CW, this.CH] = pool3(this.fine, this.W, this.H);
    this.c2res = res * 9;
    [this.coarse2, this.C2W, this.C2H] = pool3(this.coarse, this.CW, this.CH);
  }

  fineAt(x, z) {
    const ix = Math.floor((x - this.x0) / this.res), iz = Math.floor((z - this.z0) / this.res);
    return ix < 0 || iz < 0 || ix >= this.W || iz >= this.H ? 0 : this.fine[iz * this.W + ix];
  }
}

function pool3(src, W, H) {
  const w = Math.ceil(W / 3), h = Math.ceil(H / 3);
  const out = new Float32Array(w * h);
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      const k = Math.floor(z / 3) * w + Math.floor(x / 3);
      if (src[z * W + x] > out[k]) out[k] = src[z * W + x];
    }
  }
  return [out, w, h];
}

/** Sum of a pooled level over offset points, for the cell (ix, iz). */
function levelSum(field, W, H, ix, iz, off) {
  let sum = 0;
  for (let i = 0; i < off.length; i += 2) {
    const gx = ix + off[i], gz = iz + off[i + 1];
    if (gx >= 0 && gz >= 0 && gx < W && gz < H) sum += field[gz * W + gx];
  }
  return sum;
}

/**
 * Candidate alignments of the live slice (live-frame [x, z] points) on the floor plan.
 * @param {FloorPlan} plan
 * @param {number[][]} live2 live points [x, z]
 * @param {object} [o]
 * @param {Array<{xf, radius, yawRange}>} [o.priors] search near these guesses (yawRange in degrees)
 * @param {boolean} [o.global] also search every heading and place
 * @returns {Array<{yaw, tx, tz, score}>} best first, distinct from each other
 */
export function searchPlan(plan, live2, o = {}) {
  if (!live2.length || !plan.n) return [];
  let mx = 0, mz = 0;
  for (const [x, z] of live2) {
    mx += x / live2.length;
    mz += z / live2.length;
  }
  const rel = live2.map(([x, z]) => [x - mx, z - mz]);
  const found = [];
  const offsets = (yawDeg, res) => {
    const yaw = yawDeg * DEG, c = Math.cos(yaw), sn = Math.sin(yaw);
    const off = new Int16Array(rel.length * 2);
    rel.forEach(([x, z], i) => {
      off[2 * i] = Math.round((c * x + sn * z) / res);
      off[2 * i + 1] = Math.round((-sn * x + c * z) / res);
    });
    return off;
  };
  // Per heading: score the 0.9 m cells, then the 0.3 m cells inside the promising ones.
  const scan = (yawDeg, inWindow) => {
    const off2 = offsets(yawDeg, plan.c2res), off1 = offsets(yawDeg, plan.cres);
    const top = [];
    for (let iz = 0; iz < plan.C2H; iz++) {
      for (let ix = 0; ix < plan.C2W; ix++) {
        if (inWindow && !inWindow(plan.x0 + (ix + 0.5) * plan.c2res, plan.z0 + (iz + 0.5) * plan.c2res, plan.c2res)) continue;
        top.push([levelSum(plan.coarse2, plan.C2W, plan.C2H, ix, iz, off2), ix, iz]);
      }
    }
    top.sort((p, q) => q[0] - p[0]);
    let best = null;
    for (const [ub, ix2, iz2] of top.slice(0, 6)) {
      if (best && ub < best.sum) break;
      for (let dz = 0; dz < 3; dz++) {
        for (let dx = 0; dx < 3; dx++) {
          const ix = ix2 * 3 + dx, iz = iz2 * 3 + dz;
          if (inWindow && !inWindow(plan.x0 + (ix + 0.5) * plan.cres, plan.z0 + (iz + 0.5) * plan.cres, 0)) continue;
          const sum = levelSum(plan.coarse, plan.CW, plan.CH, ix, iz, off1);
          if (!best || sum > best.sum) best = { sum, ix, iz };
        }
      }
    }
    if (best) found.push({ yawDeg, cx: plan.x0 + (best.ix + 0.5) * plan.cres, cz: plan.z0 + (best.iz + 0.5) * plan.cres, score: best.sum / rel.length });
  };
  if (o.global !== false) for (let a = 0; a < 360; a += 3) scan(a, null);
  for (const pr of o.priors || []) {
    const c = xfApply(pr.xf, [mx, 0, mz]);
    const yaw0 = pr.xf.yaw / DEG;
    const win = (x, z, r) => Math.abs(x - c[0]) <= pr.radius + r && Math.abs(z - c[2]) <= pr.radius + r;
    for (let a = -pr.yawRange; a <= pr.yawRange; a += 2) scan(yaw0 + a, win);
  }
  found.sort((a, b) => b.score - a.score);
  // Distinct candidates, refined on the fine plan.
  const picks = [];
  for (const f of found) {
    if (picks.length >= 6) break;
    if (picks.some((p) => Math.hypot(p.cx - f.cx, p.cz - f.cz) < 0.7 && Math.abs(angDiff(p.yawDeg, f.yawDeg)) < 12)) continue;
    picks.push(f);
  }
  return picks.map((p) => refinePlan(plan, rel, p, mx, mz)).sort((a, b) => b.score - a.score);
}

function refinePlan(plan, rel, p, mx, mz) {
  let best = null;
  for (let da = -4; da <= 4; da += 1) {
    const yaw = (p.yawDeg + da) * DEG, c = Math.cos(yaw), s = Math.sin(yaw);
    const r = rel.map(([x, z]) => [c * x + s * z, -s * x + c * z]);
    for (let dz = -0.3; dz <= 0.301; dz += plan.res) {
      for (let dx = -0.3; dx <= 0.301; dx += plan.res) {
        const cx = p.cx + dx, cz = p.cz + dz;
        let sum = 0;
        for (const [x, z] of r) sum += plan.fineAt(cx + x, cz + z);
        if (!best || sum > best.sum) best = { sum, yaw, cx, cz };
      }
    }
  }
  // Live centre (mx, mz) maps to (cx, cz): t = c − R·m.
  const rm = xfApplyDir({ yaw: best.yaw }, [mx, 0, mz]);
  return { yaw: wrap(best.yaw), tx: best.cx - rm[0], tz: best.cz - rm[2], score: best.sum / rel.length };
}

const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

// ------------------------------------------------------------------ the whole solve

/**
 * Find where the live frames sit in the scan.
 * @param {VoxelMap} vm the scan's coverage map
 * @param {Array} frames live depth frames [{pts (live frame), pose (live frame), intr, d, nx, ny}]
 * @param {object} o
 * @param {FloorPlan} [o.plan] cached floor plan of the map
 * @param {number|null} [o.floorY] the scan's floor height
 * @param {Array<{xf, radius, yawRange}>} [o.priors] guesses (e.g. "the frame didn't change")
 * @param {boolean} [o.global] search the whole map too
 * @param {(v) => boolean} [o.accept]
 * @returns {{ok, xf, confidence, status, metrics}}
 *   status: 'more' (need more data) | 'new' (not looking at mapped surfaces) | 'flat' (walls only)
 *   | 'floor' (height unknown) | 'ambiguous' | 'mismatch' (outline fits, contents don't) | 'matching'
 *   | 'locked'
 */
export function solveAlignment(vm, frames, o = {}) {
  const live = poolLive(frames);
  if (live.n < 120) return { ok: false, xf: null, confidence: 0, status: 'more' };
  const plan = o.plan || new FloorPlan(vm, o.floorY);
  // Horizontal slice of the live points, at the same heights as the plan.
  const lo = live.floorY != null ? live.floorY + 0.3 : live.camY - 1.1;
  const hi = live.floorY != null ? live.floorY + 2.1 : live.camY + 0.7;
  const seen = new Set();
  const live2 = [];
  for (let i = 0; i < live.pts.length; i += 3) {
    const y = live.pts[i + 1];
    if (y < lo || y > hi) continue;
    const k = `${Math.floor(live.pts[i] / 0.1)},${Math.floor(live.pts[i + 2] / 0.1)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    live2.push([live.pts[i], live.pts[i + 2]]);
  }
  const thin = live2.length > 260 ? live2.filter((_, i) => i % Math.ceil(live2.length / 260) === 0) : live2;
  if (thin.length < 25) return { ok: false, xf: null, confidence: 0, status: 'more' };

  const cands = searchPlan(plan, thin, { priors: o.priors, global: o.global });
  if (!cands.length) return { ok: false, xf: null, confidence: 0, status: 'new' };
  const yGuess = (fallback) => (o.floorY != null && live.floorY != null ? o.floorY - live.floorY : fallback);
  const yPrior = (ty) => (o.floorY != null && live.floorY != null ? ty : null);
  // Each candidate: quick ICP on a subset, then how much of the map the live depth confirms.
  const sub = thinPoints(live.pts, 600);
  const tried = cands.slice(0, 5).map((c) => {
    const prior = (o.priors || []).find((p) => Math.abs(angDiff(p.xf.yaw / DEG, c.yaw / DEG)) < 30);
    const ty = yGuess(prior ? prior.xf.t[1] : o.priors && o.priors[0] ? o.priors[0].xf.t[1] : 0);
    const fit = icp(vm, sub, xf(c.yaw, [c.tx, ty, c.tz]), { iters: 8, accept: o.accept, yPrior: yPrior(ty) });
    const vis = visibility(vm, frames, fit.xf, o.accept, 6);
    return { fit, vis, ty };
  });
  const maxMatch = Math.max(1, ...tried.map((t) => t.vis.match));
  for (const t of tried) {
    t.score = t.fit.inlierFrac * t.fit.overlap * clamp(1 - 4 * t.vis.ratio, 0, 1) * clamp(1 - 4 * t.fit.freeFrac, 0, 1) + 0.3 * (t.vis.match / maxMatch);
  }
  tried.sort((p, q) => q.score - p.score);
  const top = tried[0];
  // Polish the winner with every point.
  const best = icp(vm, live.pts, top.fit.xf, { iters: 6, maxDist: 0.2, minDist: 0.06, accept: o.accept, yPrior: yPrior(top.ty) });
  const vis = visibility(vm, frames, best.xf, o.accept);
  // Another, clearly different alignment that fits almost as well: the room looks alike there.
  const mid = centreOf(live.pts);
  const rival = tried.find((t) => t !== top && t.score > top.score * 0.88 &&
    (xfDelta(t.fit.xf, top.fit.xf, mid).dist > 0.6 || xfDelta(t.fit.xf, top.fit.xf, mid).yaw > 15));
  const metrics = {
    matched: best.matched, inlierFrac: +best.inlierFrac.toFixed(3), overlap: +best.overlap.toFixed(3), rms: +best.rms.toFixed(3),
    through: +vis.ratio.toFixed(3), visMatch: vis.match, inFree: +best.freeFrac.toFixed(3), cond: +best.cond.toFixed(4), weak: best.weak, n: live.n,
    rival: rival ? +(rival.score / top.score).toFixed(2) : 0,
  };
  const conf =
    clamp((best.inlierFrac - 0.3) / 0.45, 0, 1) *
    clamp(best.overlap / 0.45, 0, 1) *
    clamp(1 - (vis.ratio - 0.05) / 0.25, 0, 1) *
    clamp(1 - (best.freeFrac - 0.02) / 0.1, 0, 1) *
    clamp(best.matched / 300, 0, 1) *
    (best.weak ? 0.5 : 1) *
    (rival ? 0.4 : 1);
  let status = 'matching';
  if (best.overlap < 0.2) status = 'new';
  else if (best.freeFrac > 0.06) status = 'mismatch';
  else if (best.weak === 'height') status = 'floor';
  else if (best.weak) status = 'flat';
  else if (rival) status = 'ambiguous';
  const ok = conf >= 0.55 && best.inlierFrac >= 0.6 && vis.ratio <= 0.12 && best.freeFrac <= 0.06 && best.matched >= 250 && !best.weak && !rival && vis.match >= 60;
  return { ok, xf: best.xf, confidence: conf, status: ok ? 'locked' : status, metrics };
}

/**
 * Quick check that the current alignment still fits (drift and tracking jumps): ICP from `cur`
 * over the latest frames, against older parts of the map.
 * @returns {{xf, delta: {dist, yaw}, matched, inlierFrac, through, through0, weak, enough}}
 */
export function checkAlignment(vm, frames, cur, accept) {
  const live = poolLive(frames, 0.1, 800);
  const before = visibility(vm, frames, cur, accept, 4);
  const visN0 = before.match + before.through;
  if (live.n < 60) return { enough: false, through0: before.ratio, visMatch0: before.match, visN0 };
  const fit = icp(vm, live.pts, cur, { iters: 8, maxDist: 0.3, minDist: 0.08, accept });
  const after = visibility(vm, frames, fit.xf, accept, 4);
  return {
    xf: fit.xf,
    delta: xfDelta(fit.xf, cur, centreOf(live.pts)),
    matched: fit.matched,
    inlierFrac: fit.inlierFrac,
    overlap: fit.overlap,
    weak: fit.weak,
    through0: before.ratio,
    visMatch0: before.match,
    visN0,
    through: after.ratio,
    visMatch: after.match,
    enough: fit.matched >= 120 && after.match + after.through >= 40,
  };
}

function thinPoints(pts, max) {
  const n = pts.length / 3;
  if (n <= max) return pts;
  const out = new Float32Array(max * 3), k = n / max;
  for (let i = 0; i < max; i++) out.set(pts.subarray(Math.floor(i * k) * 3, Math.floor(i * k) * 3 + 3), i * 3);
  return out;
}

function centreOf(pts) {
  const c = [0, 0, 0], n = pts.length / 3 || 1;
  for (let i = 0; i < pts.length; i += 3) {
    c[0] += pts[i] / n;
    c[1] += pts[i + 1] / n;
    c[2] += pts[i + 2] / n;
  }
  return c;
}
