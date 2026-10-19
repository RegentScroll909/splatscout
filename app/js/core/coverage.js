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
 * Each voxel stores how often depth hit it ("hits": it is real geometry, not noise) and a small
 * set of distinct observation directions from keyframes ("dirs": how many angles it was captured from).
 */
export class VoxelMap {
  constructor(size = 0.2, maxObsDist = 5) {
    this.size = size;
    this.maxObsDist = maxObsDist;
    this.vox = new Map();
    this.version = 0;
  }

  reset() {
    this.vox.clear();
    this.version++;
  }

  key(ix, iy, iz) {
    return ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);
  }

  /**
   * Integrate depth points (flat [x,y,z,...] world coordinates).
   * @param camPos camera position
   * @param fromKeyframe true when these points belong to a captured keyframe
   */
  observe(points, camPos, fromKeyframe) {
    const s = this.size;
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i], y = points[i + 1], z = points[i + 2];
      const ix = Math.floor(x / s), iy = Math.floor(y / s), iz = Math.floor(z / s);
      const k = this.key(ix, iy, iz);
      let v = this.vox.get(k);
      if (!v) {
        v = { ix, iy, iz, hits: 0, kfs: 0, dirs: [] };
        this.vox.set(k, v);
      }
      v.hits++;
      if (!fromKeyframe) continue;
      const dx = camPos[0] - x, dy = camPos[1] - y, dz = camPos[2] - z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.05 || d > this.maxObsDist) continue; // too far away to resolve detail
      v.kfs++;
      if (v.dirs.length >= MAX_DIRS) continue;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      let dup = false;
      for (const o of v.dirs) {
        if (o[0] * ux + o[1] * uy + o[2] * uz > DIR_SEP_COS) {
          dup = true;
          break;
        }
      }
      if (!dup) v.dirs.push([ux, uy, uz]);
    }
    this.version++;
  }

  /** Voxels hit at least twice are treated as real surfaces (filters depth noise). */
  static isSolid(v) {
    return v.hits >= 2;
  }

  /** 0 = seen but never captured, 1 = one angle, 2 = two angles, 3 = three or more angles. */
  static quality(v) {
    return Math.min(3, v.dirs.length);
  }

  stats() {
    const q = [0, 0, 0, 0];
    let solid = 0;
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      solid++;
      q[VoxelMap.quality(v)]++;
    }
    const coverage = solid ? (q[3] + 0.5 * q[2]) / solid : 0;
    return { solid, q0: q[0], q1: q[1], q2: q[2], q3: q[3], coverage };
  }

  /** Estimated floor height (lowest dense layer of voxels), or null. */
  floorY() {
    const ys = [];
    for (const v of this.vox.values()) if (VoxelMap.isSolid(v)) ys.push(v.iy);
    if (ys.length < 60) return null;
    ys.sort((a, b) => a - b);
    return (ys[Math.floor(ys.length * 0.04)] + 0.5) * this.size;
  }

  /**
   * Find the most useful under-captured area near the camera: clusters weak voxels on a 1 m grid
   * and prefers big clusters roughly in front of the user.
   */
  findGap(camPos, camFwd, maxDist = 5) {
    const cells = new Map();
    const s = this.size;
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v) || VoxelMap.quality(v) >= 2) continue;
      const p = [(v.ix + 0.5) * s, (v.iy + 0.5) * s, (v.iz + 0.5) * s];
      const d = v3.dist(p, camPos);
      if (d < 0.4 || d > maxDist) continue;
      const ck = `${Math.floor(p[0])},${Math.floor(p[1])},${Math.floor(p[2])}`;
      let c = cells.get(ck);
      if (!c) cells.set(ck, (c = { n: 0, sx: 0, sy: 0, sz: 0 }));
      c.n++;
      c.sx += p[0]; c.sy += p[1]; c.sz += p[2];
    }
    let best = null, bestScore = 0;
    for (const c of cells.values()) {
      if (c.n < 4) continue;
      const center = [c.sx / c.n, c.sy / c.n, c.sz / c.n];
      const dir = v3.norm(v3.sub(center, camPos));
      const facing = (v3.dot(dir, camFwd) + 1.5) / 2.5; // 0.2 (behind) .. 1 (ahead)
      const score = c.n * facing;
      if (score > bestScore) {
        bestScore = score;
        best = { center, count: c.n };
      }
    }
    return best;
  }

  /** Flat arrays for rendering: positions (xyz) and quality per solid voxel. */
  renderArrays() {
    const pos = [], qual = [];
    const s = this.size;
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      pos.push((v.ix + 0.5) * s, (v.iy + 0.5) * s, (v.iz + 0.5) * s);
      qual.push(VoxelMap.quality(v));
    }
    return { pos: new Float32Array(pos), qual: new Uint8Array(qual) };
  }

  serialize() {
    const out = [];
    for (const v of this.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      out.push([v.ix, v.iy, v.iz, v.hits, v.kfs, v.dirs.map((d) => d.map((x) => Math.round(x * 100)))]);
    }
    return { size: this.size, voxels: out };
  }

  static deserialize(data, maxObsDist = 5) {
    const m = new VoxelMap(data.size, maxObsDist);
    for (const [ix, iy, iz, hits, kfs, dirs] of data.voxels) {
      m.vox.set(m.key(ix, iy, iz), { ix, iy, iz, hits, kfs, dirs: dirs.map((d) => v3.norm(d)) });
    }
    return m;
  }
}
