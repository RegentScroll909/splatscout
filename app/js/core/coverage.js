// Coverage tracking.
//  * DirectionSphere: which view directions have been captured, and from how many distinct viewpoints.
//    Works with orientation-only tracking (camera mode) and full 6DoF (AR mode).
//  * VoxelMap: AR mode with depth. Which real surfaces have been seen, and from how many
//    different angles they were captured — the core "what has been scanned" signal for splats.

import { DEG, azElToDir, dirToAzEl, projectDir, v3, angleBetween } from './math.js';

export const BANDS = [
  { id: 'floor', min: -90, max: -55, n: 6, label: 'Floor' },
  { id: 'low', min: -55, max: -20, n: 12, label: 'Looking down' },
  { id: 'mid', min: -20, max: 20, n: 18, label: 'Eye level' },
  { id: 'high', min: 20, max: 55, n: 12, label: 'Looking up' },
  { id: 'ceil', min: 55, max: 90, n: 6, label: 'Ceiling' },
];

const MAX_REPS_PER_BIN = 8;

export class DirectionSphere {
  constructor() {
    this.bins = [];
    for (const band of BANDS) {
      const step = 360 / band.n;
      for (let i = 0; i < band.n; i++) {
        const az = (i + 0.5) * step;
        const el = (band.min + band.max) / 2;
        this.bins.push({
          band: band.id,
          az0: i * step,
          az1: (i + 1) * step,
          el0: band.min,
          el1: band.max,
          az,
          el,
          dir: azElToDir(az, el),
          views: 0, // photos that saw this direction
          reps: [], // representative viewpoints, each far enough from the others
          distinct: 0, // = reps.length
        });
      }
    }
  }

  reset() {
    for (const b of this.bins) {
      b.views = 0;
      b.reps = [];
      b.distinct = 0;
    }
  }

  binIndexOf(dir) {
    const [az, el] = dirToAzEl(dir);
    let base = 0;
    for (const band of BANDS) {
      if (el <= band.max || band === BANDS[BANDS.length - 1]) {
        return base + Math.min(band.n - 1, Math.floor(az / (360 / band.n)));
      }
      base += band.n;
    }
    return 0;
  }

  /**
   * Register a captured keyframe. Every bin whose centre falls in the central part of the
   * frame counts as viewed. A view is "distinct" when it was taken from a viewpoint that moved
   * enough since earlier views of that bin (parallax is what makes splats work).
   * @param pose camera-to-world 4x4
   * @param intr intrinsics of the image
   * @param vp {pos:[x,y,z]|null, odo:number} viewpoint (position in AR mode, parallax odometer otherwise)
   */
  addView(pose, intr, vp, kfIndex) {
    const mx = intr.w * 0.12, my = intr.h * 0.12;
    const hit = [];
    for (let i = 0; i < this.bins.length; i++) {
      const b = this.bins[i];
      const p = projectDir(pose, intr, b.dir);
      if (!p || p[0] < mx || p[0] > intr.w - mx || p[1] < my || p[1] > intr.h - my) continue;
      hit.push(i);
      b.views++;
      // Greedy clustering: a viewpoint far from every representative becomes a new one, so a
      // continuous walk past a wall adds a representative every ~threshold of movement.
      if (b.reps.length < MAX_REPS_PER_BIN && b.reps.every((v) => viewpointsDiffer(v, vp))) {
        b.reps.push({ pos: vp.pos, odo: vp.odo, kf: kfIndex });
        b.distinct = b.reps.length;
      }
    }
    return hit;
  }

  counts() {
    return this.bins.map((b) => b.distinct);
  }

  /** Fraction of bins in the given bands that have at least `need` distinct views. */
  bandCoverage(bandIds, need = 2) {
    let tot = 0, ok = 0, partial = 0;
    for (const b of this.bins) {
      if (bandIds && !bandIds.includes(b.band)) continue;
      tot++;
      if (b.distinct >= need) ok++;
      else if (b.distinct > 0) partial++;
    }
    return { total: tot, covered: ok, partial, fraction: tot ? ok / tot : 0 };
  }

  /** Nearest under-covered bin (by angle from the current view direction) within the given bands. */
  nextTarget(forward, bandIds, need = 2) {
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < this.bins.length; i++) {
      const b = this.bins[i];
      if (bandIds && !bandIds.includes(b.band)) continue;
      if (b.distinct >= need) continue;
      // Prefer close targets; slight preference for bins with zero views.
      const score = angleBetween(forward, b.dir) / DEG - (b.distinct === 0 ? 8 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best >= 0 ? { index: best, bin: this.bins[best] } : null;
  }

  serialize() {
    return this.bins.map((b) => b.distinct);
  }
}

function viewpointsDiffer(a, b) {
  if (a.pos && b.pos) return v3.dist(a.pos, b.pos) > 0.3;
  return Math.abs((a.odo || 0) - (b.odo || 0)) > 0.15;
}

// ---------------------------------------------------------------------------------------------

const MAX_DIRS = 6;
const DIR_SEP_COS = Math.cos(15 * DEG); // observation directions closer than 15° count as the same angle

/**
 * Sparse voxel grid of observed surfaces.
 *  * Depth frames add "hits" where they land and "misses" along the rays in front of them, so depth
 *    noise floating in the air is carved away again (only voxels confirmed by several frames and
 *    not seen through count as surfaces).
 *  * Each photo adds its viewing direction to every surface voxel visible in it ("dirs": how many
 *    clearly different angles the surface was photographed from).
 *  * Optional bounds: only surfaces inside the scan area count.
 *  * Empty space the depth rays passed through is remembered too ("free"), which lets re-alignment
 *    tell a real match from a room that merely has the same shape.
 */
export class VoxelMap {
  constructor(size = 0.2, maxObsDist = 5) {
    this.size = size;
    this.maxObsDist = maxObsDist;
    this.vox = new Map();
    this.free = new Map(); // key -> times seen through * 4096 + last frame id
    this.version = 0;
    this.frameId = 0;
    this.bounds = null;
    this.bver = 0;
  }

  reset() {
    this.vox.clear();
    this.free.clear();
    this.version++;
  }

  key(ix, iy, iz) {
    return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);
  }

  setBounds(b) {
    this.bounds = b || null;
    this.boundsChanged();
  }

  /** Call after the bounds (or their skipped spots) changed. */
  boundsChanged() {
    this.bver++;
    this.version++;
  }

  /**
   * Integrate one depth frame (flat [x,y,z,...] world points seen from camPos).
   * @param {boolean} [carve] also mark the space in front of each point as empty
   */
  integrate(points, camPos, carve = true) {
    const id = ++this.frameId;
    const s = this.size;
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i], y = points[i + 1], z = points[i + 2];
      const ix = Math.floor(x / s), iy = Math.floor(y / s), iz = Math.floor(z / s);
      const k = this.key(ix, iy, iz);
      let v = this.vox.get(k);
      if (!v) {
        v = { ix, iy, iz, n: 0, sx: 0, sy: 0, sz: 0, hit: 0, miss: 0, f: 0, m: 0, kfs: 0, dirs: [], bv: -1, ib: true, c: id };
        this.vox.set(k, v);
      }
      v.n++;
      v.sx += x; v.sy += y; v.sz += z;
      if (v.f !== id) {
        v.f = id;
        v.hit++;
      }
    }
    if (carve) {
      const stopBefore = 1.5 * s; // leave the surface itself (and depth noise around it) alone
      const visit = (v) => {
        if (v.f !== id && v.m !== id) {
          v.m = id;
          v.miss++;
        }
        return false;
      };
      const free = this.free, tag = id % 4096;
      const cell = (k) => {
        const f = free.get(k) || 0;
        if (f % 4096 !== tag) free.set(k, (Math.floor(f / 4096) + 1) * 4096 + tag);
      };
      for (let i = 0; i < points.length; i += 3) {
        const dx = points[i] - camPos[0], dy = points[i + 1] - camPos[1], dz = points[i + 2] - camPos[2];
        const len = Math.hypot(dx, dy, dz);
        if (len - stopBefore <= s) continue;
        this.march(camPos, [dx / len, dy / len, dz / len], len - stopBefore, visit, cell);
      }
    }
    this.version++;
  }

  /**
   * Walk the voxels along a ray (3D DDA). `visit(voxel, t)` is called for existing voxels;
   * return true to stop. `cell(key)` (optional) sees every cell. Returns the stopping voxel or null.
   */
  march(o, dir, maxLen, visit, cell) {
    const s = this.size;
    let ix = Math.floor(o[0] / s), iy = Math.floor(o[1] / s), iz = Math.floor(o[2] / s);
    const sx = dir[0] > 0 ? 1 : -1, sy = dir[1] > 0 ? 1 : -1, sz = dir[2] > 0 ? 1 : -1;
    const ax = Math.abs(dir[0]), ay = Math.abs(dir[1]), az = Math.abs(dir[2]);
    const dX = ax > 1e-9 ? s / ax : Infinity, dY = ay > 1e-9 ? s / ay : Infinity, dZ = az > 1e-9 ? s / az : Infinity;
    let tX = ax > 1e-9 ? (sx > 0 ? (ix + 1) * s - o[0] : o[0] - ix * s) / ax : Infinity;
    let tY = ay > 1e-9 ? (sy > 0 ? (iy + 1) * s - o[1] : o[1] - iy * s) / ay : Infinity;
    let tZ = az > 1e-9 ? (sz > 0 ? (iz + 1) * s - o[2] : o[2] - iz * s) / az : Infinity;
    let t = 0;
    for (let guard = 0; t < maxLen && guard < 4096; guard++) {
      const k = this.key(ix, iy, iz);
      if (cell) cell(k);
      const v = this.vox.get(k);
      if (v && visit(v, t)) return v;
      if (tX < tY && tX < tZ) { t = tX; tX += dX; ix += sx; }
      else if (tY < tZ) { t = tY; tY += dY; iy += sy; }
      else { t = tZ; tZ += dZ; iz += sz; }
    }
    return null;
  }

  /** First surface hit along a ray: {point, voxel, t} or null. */
  raycast(o, dir, maxLen = 10, skipNear = 0.15) {
    let hitT = 0;
    const v = this.march(o, dir, maxLen, (vx, t) => {
      if (t < skipNear || !VoxelMap.isSolid(vx)) return false;
      hitT = t;
      return true;
    });
    return v ? { point: VoxelMap.centroid(v), voxel: v, t: hitT } : null;
  }

  /**
   * A photo was taken: every surface voxel visible in it gains this viewing direction.
   * Visibility = the voxel projects into the photo and the photo's depth there matches its distance.
   * @param pose camera-to-world 4x4
   * @param intr intrinsics of the photo
   * @param dimg {d: planar depth per grid cell (0 = unknown), nx, ny} covering the photo
   */
  observeView(pose, intr, dimg) {
    const cx = pose[12], cy = pose[13], cz = pose[14];
    const maxD2 = this.maxObsDist * this.maxObsDist;
    const { d, nx, ny } = dimg;
    const tol0 = 0.5 * this.size;
    let seen = 0;
    for (const v of this.vox.values()) {
      const inv = 1 / v.n;
      const wx = v.sx * inv - cx, wy = v.sy * inv - cy, wz = v.sz * inv - cz;
      const d2 = wx * wx + wy * wy + wz * wz;
      if (d2 > maxD2 || d2 < 0.0025) continue;
      const zc = -(pose[8] * wx + pose[9] * wy + pose[10] * wz);
      if (zc < 0.15) continue;
      const x = pose[0] * wx + pose[1] * wy + pose[2] * wz;
      const y = pose[4] * wx + pose[5] * wy + pose[6] * wz;
      const u = (intr.cx + (intr.fx * x) / zc) / intr.w;
      const w = (intr.cy - (intr.fy * y) / zc) / intr.h;
      if (u < 0.03 || u > 0.97 || w < 0.03 || w > 0.97) continue;
      const i = Math.min(nx - 1, Math.floor(u * nx)), j = Math.min(ny - 1, Math.floor(w * ny));
      const tol = tol0 + 0.03 * zc;
      let vis = false;
      for (let jj = Math.max(0, j - 1); jj <= Math.min(ny - 1, j + 1) && !vis; jj++) {
        for (let ii = Math.max(0, i - 1); ii <= Math.min(nx - 1, i + 1); ii++) {
          const m = d[jj * nx + ii];
          if (m > 0 && Math.abs(m - zc) < tol) {
            vis = true;
            break;
          }
        }
      }
      if (!vis) continue;
      v.kfs++;
      addDir(v, -wx, -wy, -wz);
      seen++;
    }
    this.version++;
    return seen;
  }

  /** Older captures without per-photo depth images: the voxels the photo's depth points landed in. */
  observePoints(points, camPos) {
    const s = this.size;
    for (let i = 0; i < points.length; i += 3) {
      const v = this.vox.get(this.key(Math.floor(points[i] / s), Math.floor(points[i + 1] / s), Math.floor(points[i + 2] / s)));
      if (!v) continue;
      const dx = camPos[0] - points[i], dy = camPos[1] - points[i + 1], dz = camPos[2] - points[i + 2];
      if (dx * dx + dy * dy + dz * dz > this.maxObsDist * this.maxObsDist) continue;
      v.kfs++;
      addDir(v, dx, dy, dz);
    }
    this.version++;
  }

  /** Surfaces: confirmed by at least two depth frames and not seen through more often than seen. */
  static isSolid(v) {
    return v.hit >= 2 && v.miss <= 2 * v.hit;
  }

  /** 0 = seen but never photographed, 1 = one angle, 2 = two angles, 3 = three or more angles. */
  static quality(v) {
    return Math.min(3, v.dirs.length);
  }

  /** Mean position of the depth points in a voxel: where the surface actually is. */
  static centroid(v) {
    return [v.sx / v.n, v.sy / v.n, v.sz / v.n];
  }

  inBounds(v) {
    if (!this.bounds) return true;
    if (v.bv !== this.bver) {
      v.bv = this.bver;
      v.ib = this.bounds.contains(v.sx / v.n, v.sy / v.n, v.sz / v.n);
    }
    return v.ib;
  }

  /** Space that depth rays have passed through several times, with no surface in it. */
  isFreeAt(x, y, z) {
    const s = this.size;
    const k = this.key(Math.floor(x / s), Math.floor(y / s), Math.floor(z / s));
    const f = this.free.get(k);
    if (!f || f < 3 * 4096) return false;
    const v = this.vox.get(k);
    return !v || !VoxelMap.isSolid(v);
  }

  isSolidAt(x, y, z) {
    const s = this.size;
    const v = this.vox.get(this.key(Math.floor(x / s), Math.floor(y / s), Math.floor(z / s)));
    return !!v && VoxelMap.isSolid(v);
  }

  /** Coverage of the surfaces inside the scan area. */
  stats() {
    if (this._statsVer === this.version) return this._stats;
    const q = [0, 0, 0, 0];
    let solid = 0, outside = 0;
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      if (!this.inBounds(v)) {
        outside++;
        continue;
      }
      solid++;
      q[VoxelMap.quality(v)]++;
    }
    const coverage = solid ? (q[3] + 0.5 * q[2]) / solid : 0;
    this._statsVer = this.version;
    this._stats = { solid, outside, q0: q[0], q1: q[1], q2: q[2], q3: q[3], coverage };
    return this._stats;
  }

  /** Estimated floor height (the scan area's floor, else the lowest dense layer of voxels), or null. */
  floorY() {
    if (this.bounds && this.bounds.poly) return this.bounds.floorY;
    const ys = [];
    for (const v of this.vox.values()) if (VoxelMap.isSolid(v)) ys.push(v.sy / v.n);
    if (ys.length < 60) return null;
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length * 0.04)];
  }

  /**
   * Under-captured surfaces grouped on a coarse grid (scan area only):
   * [{key, center, count, deficit, dirs: [unit vectors already used]}]
   */
  weakClusters(cell = 0.8, minCount = 3) {
    const cells = new Map();
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v) || !this.inBounds(v)) continue;
      const q = VoxelMap.quality(v);
      if (q >= 3) continue;
      const p = VoxelMap.centroid(v);
      const ck = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
      let c = cells.get(ck);
      if (!c) cells.set(ck, (c = { key: ck, count: 0, deficit: 0, sx: 0, sy: 0, sz: 0, dirs: [] }));
      c.count++;
      c.deficit += 3 - q;
      c.sx += p[0]; c.sy += p[1]; c.sz += p[2];
      for (const d of v.dirs) if (c.dirs.length < 24) c.dirs.push(d);
    }
    const out = [];
    for (const c of cells.values()) {
      if (c.count < minCount) continue;
      c.center = [c.sx / c.count, c.sy / c.count, c.sz / c.count];
      out.push(c);
    }
    return out;
  }

  /** Simple nearest weak area (used when no guide is available). */
  findGap(camPos, camFwd, maxDist = 5) {
    let best = null, bestScore = 0;
    for (const c of this.weakClusters(1, 4)) {
      const dist = v3.dist(c.center, camPos);
      if (dist < 0.4 || dist > maxDist) continue;
      const dir = v3.norm(v3.sub(c.center, camPos));
      const facing = (v3.dot(dir, camFwd) + 1.5) / 2.5; // 0.2 (behind) .. 1 (ahead)
      const score = c.deficit * facing;
      if (score > bestScore) {
        bestScore = score;
        best = { center: c.center, count: c.count };
      }
    }
    return best;
  }

  /** Flat arrays for rendering: surface positions (xyz) and quality per solid voxel (4 = outside the scan area). */
  renderArrays() {
    const pos = [], qual = [];
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      pos.push(v.sx / v.n, v.sy / v.n, v.sz / v.n);
      qual.push(this.inBounds(v) ? VoxelMap.quality(v) : 4);
    }
    return { pos: new Float32Array(pos), qual: new Uint8Array(qual) };
  }
}

function addDir(v, dx, dy, dz) {
  if (v.dirs.length >= MAX_DIRS) return;
  const l = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / l, uy = dy / l, uz = dz / l;
  for (const o of v.dirs) if (o[0] * ux + o[1] * uy + o[2] * uz > DIR_SEP_COS) return;
  v.dirs.push([ux, uy, uz]);
}
