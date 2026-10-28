// Walk mode for finished splats: the walk map SplatStation builds from a splat (station/lib/walkmap.mjs)
// and a walker that keeps a body-sized circle out of walls and furniture, sliding along them.
// Plain ES module with no DOM use, so the viewer and tools/check.mjs share it.

export const NOTHING = 0; // no floor seen here (usually beyond a wall)
export const FLOOR = 1; // walkable floor
export const BLOCK = 2; // wall or furniture between knee and head height

export function encodeCells(cells) {
  let s = '';
  for (let i = 0; i < cells.length; i += 0x8000) s += String.fromCharCode.apply(null, cells.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Turn the JSON from /api/walkmap into a map with a distance field for the walker. */
export function decodeMap(json) {
  const raw = atob(json.cells);
  const cells = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) cells[i] = raw.charCodeAt(i);
  if (cells.length !== json.W * json.H) throw new Error('Walk map is damaged');
  return { ...json, cells, dist: distanceField(cells, json.W, json.H, json.cell) };
}

const FAR = 1e12; // "no blocked cell yet": far beyond any squared distance on a map, still exact in a double

// Felzenszwalb & Huttenlocher's 1-D squared distance transform, in place over f[start + q*stride].
function edt1d(f, start, stride, n, d, v, z) {
  const at = (q) => f[start + q * stride];
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (at(q) + q * q - (at(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (at(q) + q * q - (at(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + at(v[k]);
  }
  for (let q = 0; q < n; q++) f[start + q * stride] = d[q];
}

/**
 * Distance (metres) from each cell centre to the nearest cell centre you can't stand on. The map
 * edge counts as blocked.
 */
export function distanceField(cells, W, H, cell) {
  const w = W + 2, h = H + 2; // one blocked cell of padding all round
  const f = new Float64Array(w * h).fill(0);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) f[(j + 1) * w + i + 1] = cells[j * W + i] === FLOOR ? FAR : 0;
  const n = Math.max(w, h);
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let j = 0; j < h; j++) edt1d(f, j * w, 1, w, d, v, z);
  for (let i = 0; i < w; i++) edt1d(f, i, w, h, d, v, z);
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) out[j * W + i] = Math.sqrt(f[(j + 1) * w + i + 1]) * cell;
  return out;
}

export const WALK = { radius: 0.25, step: 0.04 };

export class Walker {
  /** @param {object} map decoded walk map ({x0, z0, cell, W, H, cells, dist, ...}) */
  constructor(map, { radius = WALK.radius } = {}) {
    this.map = map;
    this.radius = radius;
    this.x = 0;
    this.z = 0;
  }

  /** Free space around a point: distance to the nearest wall/edge, minus half a cell. */
  clearance(x, z) {
    const m = this.map;
    const u = (x - m.x0) / m.cell - 0.5, v = (z - m.z0) / m.cell - 0.5;
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= m.W - 1 || j >= m.H - 1) return -1;
    const fu = u - i, fv = v - j, D = m.dist, W = m.W;
    const a = D[j * W + i], b = D[j * W + i + 1], c = D[(j + 1) * W + i], d = D[(j + 1) * W + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv - m.cell / 2;
  }

  canStand(x, z) {
    return this.clearance(x, z) >= this.radius;
  }

  cellAt(x, z) {
    const m = this.map;
    const i = Math.floor((x - m.x0) / m.cell), j = Math.floor((z - m.z0) / m.cell);
    return i < 0 || j < 0 || i >= m.W || j >= m.H ? NOTHING : m.cells[j * m.W + i];
  }

  /** Nearest point you can stand on (searching outwards), or null if there is none within `maxDist`. */
  nearestFree(x, z, maxDist = Infinity) {
    const m = this.map;
    const need = this.radius + m.cell / 2 + 0.02;
    let best = null, bestD = maxDist * maxDist;
    for (let j = 0; j < m.H; j++) {
      const cz = m.z0 + (j + 0.5) * m.cell;
      const dz = cz - z;
      if (dz * dz >= bestD) continue;
      for (let i = 0; i < m.W; i++) {
        if (m.dist[j * m.W + i] < need) continue;
        const cx = m.x0 + (i + 0.5) * m.cell;
        const d2 = (cx - x) * (cx - x) + dz * dz;
        if (d2 < bestD) [best, bestD] = [[cx, cz], d2];
      }
    }
    return best;
  }

  /** Put the walker at (x, z), or at the nearest free spot. Returns false if nowhere is free. */
  place(x, z) {
    const p = this.canStand(x, z) ? [x, z] : this.nearestFree(x, z);
    if (!p) return false;
    [this.x, this.z] = p;
    return true;
  }

  _grad(x, z) {
    const h = this.map.cell / 2;
    return [this.clearance(x + h, z) - this.clearance(x - h, z), this.clearance(x, z + h) - this.clearance(x, z - h)];
  }

  /**
   * Try to move by (dx, dz): walls push you out along the distance field, so you slide along them
   * instead of sticking. Returns the distance actually moved.
   */
  move(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (!len) return 0;
    const n = Math.ceil(len / WALK.step);
    const sx = dx / n, sz = dz / n, step = len / n;
    const x0 = this.x, z0 = this.z;
    for (let s = 0; s < n; s++) {
      let nx = this.x + sx, nz = this.z + sz;
      for (let k = 0; k < 4; k++) {
        const c = this.clearance(nx, nz);
        if (c >= this.radius) break;
        const [gx, gz] = this._grad(nx, nz);
        const g = Math.hypot(gx, gz);
        if (g < 1e-6) break;
        nx += (gx / g) * (this.radius - c);
        nz += (gz / g) * (this.radius - c);
      }
      if (this.clearance(nx, nz) < this.radius - 0.005 || Math.hypot(nx - this.x, nz - this.z) > step * 1.5) break;
      this.x = nx;
      this.z = nz;
    }
    return Math.hypot(this.x - x0, this.z - z0);
  }
}

/** Walk-frame point (x, y, z) → splat (scene) coordinates, undoing the map's rotation and scale. */
export function toScene(map, p) {
  const R = map.rot, k = map.scale;
  const x = p[0] / k, y = p[1] / k, z = p[2] / k;
  return [R[0] * x + R[3] * y + R[6] * z, R[1] * x + R[4] * y + R[7] * z, R[2] * x + R[5] * y + R[8] * z];
}

/** Splat (scene) point → walk frame. */
export function toWalk(map, p) {
  const R = map.rot, k = map.scale;
  return [
    (R[0] * p[0] + R[1] * p[1] + R[2] * p[2]) * k,
    (R[3] * p[0] + R[4] * p[1] + R[5] * p[2]) * k,
    (R[6] * p[0] + R[7] * p[1] + R[8] * p[2]) * k,
  ];
}
