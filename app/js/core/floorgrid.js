// What's walkable, from the coverage map: a floor plan of walls (surfaces up to head height) and
// obstacles (anything between knee and head height), and which parts of it can be reached from where
// the user stands. The guide uses it to keep its path off the walls the depth sensor has found, so a
// scan area drawn generously (a rectangle around a hallway's door recesses, say) doesn't send anyone
// into a wall or to a spot behind one.

import { VoxelMap } from './coverage.js';

const BODY = 0.3; // m: closer than this to an obstacle, nobody stands there
const SEARCH = 1.6; // m: how far a spot may move to get clear of walls

export class FloorGrid {
  /**
   * @param {VoxelMap} vm coverage map
   * @param {number} floorY floor height
   * @param {number[]} box [x0, x1, z0, z1]: the part of the floor to look at
   */
  constructor(vm, floorY, box) {
    const s = (this.s = vm.size);
    this.ix0 = Math.floor(box[0] / s) - 1;
    this.iz0 = Math.floor(box[2] / s) - 1;
    this.W = Math.max(1, Math.floor(box[1] / s) + 2 - this.ix0);
    this.H = Math.max(1, Math.floor(box[3] / s) + 2 - this.iz0);
    const N = this.W * this.H;
    this.wall = new Uint8Array(N); // something solid at chest/head height (walls, tall furniture)
    this.block = new Uint8Array(N); // anything solid between knee and head height
    const tall = new Uint8Array(N);
    this.wx = new Float32Array(N); // where the wall's surface is in the cell (mean of its voxels)
    this.wz = new Float32Array(N);
    for (const v of vm.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      const k = this.key(v.ix, v.iz);
      if (k < 0) continue;
      const y = v.sy / v.n - floorY;
      if (y < 0.25 || y > 2.0) continue;
      this.block[k] = 1;
      if (y > 0.9) {
        tall[k]++;
        this.wx[k] += v.sx / v.n;
        this.wz[k] += v.sz / v.n;
      }
    }
    // Two or more surfaces stacked up: a wall, not a stray depth speck.
    this.walls = 0;
    for (let k = 0; k < N; k++) {
      if (tall[k] >= 2) {
        this.wall[k] = 1;
        this.wx[k] /= tall[k];
        this.wz[k] /= tall[k];
        this.walls++;
      }
    }
    this.reach = null;
  }

  key(ix, iz) {
    const x = ix - this.ix0, z = iz - this.iz0;
    return x < 0 || z < 0 || x >= this.W || z >= this.H ? -1 : z * this.W + x;
  }

  cellOf(x, z) {
    return this.key(Math.floor(x / this.s), Math.floor(z / this.s));
  }

  /** Too close to an obstacle to stand (unknown space counts as free). */
  tight(x, z) {
    const s = this.s, r = Math.ceil(BODY / s);
    const ix = Math.floor(x / s), iz = Math.floor(z / s);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const k = this.key(ix + dx, iz + dz);
        if (k < 0 || !this.block[k]) continue;
        const cx = (ix + dx + 0.5) * s, cz = (iz + dz + 0.5) * s;
        if (Math.hypot(Math.max(0, Math.abs(cx - x) - s / 2), Math.max(0, Math.abs(cz - z) - s / 2)) < BODY) return true;
      }
    }
    return false;
  }

  /** Flood the floor from where the user stands, around obstacles: what can be walked to. */
  reachFrom(x, z) {
    const N = this.W * this.H;
    const open = new Uint8Array(N);
    for (let iz = 0; iz < this.H; iz++) {
      for (let ix = 0; ix < this.W; ix++) {
        const cx = (ix + this.ix0 + 0.5) * this.s, cz = (iz + this.iz0 + 0.5) * this.s;
        open[iz * this.W + ix] = this.tight(cx, cz) ? 0 : 1;
      }
    }
    const reach = new Uint8Array(N);
    // Standing close to a wall is fine: start from the nearest open cell.
    let start = this.cellOf(x, z);
    if (start < 0 || !open[start]) start = this._nearest(x, z, 1.0, (k) => open[k]);
    if (start >= 0) {
      const queue = [start];
      reach[start] = 1;
      while (queue.length) {
        const k = queue.pop();
        const ix = k % this.W, iz = (k - ix) / this.W;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = ix + dx, nz = iz + dz;
          if (nx < 0 || nz < 0 || nx >= this.W || nz >= this.H) continue;
          const n = nz * this.W + nx;
          if (!reach[n] && open[n]) {
            reach[n] = 1;
            queue.push(n);
          }
        }
      }
    }
    this.reach = reach;
    return this;
  }

  reachable(x, z) {
    const k = this.cellOf(x, z);
    return k >= 0 && !!this.reach && !!this.reach[k];
  }

  /** Can someone stand at (x, z) and get there from where they are? */
  standable(x, z) {
    return this.reachable(x, z) && !this.tight(x, z);
  }

  /** Nearest wall surface within `r` metres: {d, p: [x, z]}, or d = Infinity. */
  nearestWall(x, z, r = SEARCH + 0.5) {
    const s = this.s, n = Math.ceil(r / s);
    const ix = Math.floor(x / s), iz = Math.floor(z / s);
    let best = { d: Infinity, p: null };
    for (let dz = -n; dz <= n; dz++) {
      for (let dx = -n; dx <= n; dx++) {
        const k = this.key(ix + dx, iz + dz);
        if (k < 0 || !this.wall[k]) continue;
        const d = Math.hypot(this.wx[k] - x, this.wz[k] - z);
        if (d < best.d) best = { d, p: [this.wx[k], this.wz[k]] };
      }
    }
    return best;
  }

  _nearest(x, z, r, ok) {
    const s = this.s, n = Math.ceil(r / s);
    const ix = Math.floor(x / s), iz = Math.floor(z / s);
    let best = -1, bd = Infinity;
    for (let dz = -n; dz <= n; dz++) {
      for (let dx = -n; dx <= n; dx++) {
        const k = this.key(ix + dx, iz + dz);
        if (k < 0 || !ok(k)) continue;
        const d = Math.hypot((ix + dx + 0.5) * s - x, (iz + dz + 0.5) * s - z);
        if (d < bd && d <= r) [bd, best] = [d, k];
      }
    }
    return best;
  }

  /**
   * Where to stand instead of (x, z): the same spot when it's reachable and at least `want` from
   * the walls, otherwise moved away from them (or out from behind one) by as little as possible.
   * @returns {number[]|null} [x, z], or null when no reachable spot is close enough
   */
  fit(x, z, want) {
    let p = [x, z];
    if (!this.standable(x, z)) {
      // Inside furniture or behind a wall: the nearest open spot that can be walked to.
      const k = this._nearest(x, z, SEARCH, (c) => {
        const cx = (c % this.W + this.ix0 + 0.5) * this.s, cz = (Math.floor(c / this.W) + this.iz0 + 0.5) * this.s;
        return !!this.reach && !!this.reach[c] && !this.tight(cx, cz);
      });
      if (k < 0) return null;
      p = [(k % this.W + this.ix0 + 0.5) * this.s, (Math.floor(k / this.W) + this.iz0 + 0.5) * this.s];
    }
    // Step straight away from the nearest wall until `want` from it (twice, for corners). In a
    // narrow place it stops where it would get too close to something else.
    for (let i = 0; i < 2; i++) {
      const w = this.nearestWall(p[0], p[1]);
      if (!(w.d < want - 0.03)) break;
      const dx = p[0] - w.p[0], dz = p[1] - w.p[1], L = Math.hypot(dx, dz);
      if (L < 1e-3) break;
      let q = null;
      for (const f of [1, 0.75, 0.5]) {
        const c = [w.p[0] + (dx / L) * (w.d + (want - w.d) * f), w.p[1] + (dz / L) * (w.d + (want - w.d) * f)];
        if (this.standable(c[0], c[1])) {
          q = c;
          break;
        }
      }
      if (!q) break;
      p = q;
    }
    return Math.hypot(p[0] - x, p[1] - z) <= SEARCH ? p : null;
  }
}
