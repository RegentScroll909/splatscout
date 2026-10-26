// Scan area: a floor-plan polygon (x/z, metres) the user marks in AR, plus spots they chose to skip.
// Surfaces outside it don't count toward coverage and get no guidance (e.g. what's seen through a
// window, or the other half of a hallway). Bounds live in one AR session's coordinate frame.

import { v3 } from './math.js';

/** Signed area of a polygon in the x/z plane (positive = counter-clockwise seen from above, +y). */
export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    a += x0 * z1 - x1 * z0;
  }
  // Seen from above (+y looking down), x right and z towards the viewer flips the usual orientation.
  return -a / 2;
}

export function polyCentroid(poly) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i], [x1, z1] = poly[(i + 1) % poly.length];
    const c = x0 * z1 - x1 * z0;
    a += c;
    cx += (x0 + x1) * c;
    cz += (z0 + z1) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to the polygon outline. */
export function distToPoly(x, z, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return best;
}

/** Make the polygon counter-clockwise (seen from above), so "left of an edge" is inside. */
export function ccw(poly) {
  return polyArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

/** Unit normal pointing into a counter-clockwise polygon for the edge a→b. */
export function inwardNormal(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  // Seen from above with x right and z down the page, "left" of (dx, dz) is (dz, -dx).
  return [dz / L, -dx / L];
}

/**
 * Offset a counter-clockwise polygon inwards by d (negative = outwards), mitred corners.
 * Edges that collapse are dropped. Returns null when nothing is left.
 */
export function offsetPoly(poly, d) {
  const P = ccw(poly);
  let lines = P.map((a, i) => {
    const b = P[(i + 1) % P.length];
    const nn = inwardNormal(a, b);
    return { p: [a[0] + nn[0] * d, a[1] + nn[1] * d], dir: [b[0] - a[0], b[1] - a[1]] };
  });
  for (let iter = 0; iter < P.length; iter++) {
    const m = lines.length;
    if (m < 3) return null;
    const verts = lines.map((L1, i) => {
      const L0 = lines[(i - 1 + m) % m];
      return intersectLines(L0.p, L0.dir, L1.p, L1.dir) || L1.p;
    });
    // An edge whose offset copy runs backwards has collapsed: drop it and intersect again.
    const keep = lines.filter((L, i) => {
      const a = verts[i], b = verts[(i + 1) % m];
      return (b[0] - a[0]) * L.dir[0] + (b[1] - a[1]) * L.dir[1] > 1e-9;
    });
    if (keep.length === m) return verts;
    lines = keep;
  }
  return null;
}

function intersectLines(p, r, q, s) {
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den;
  return [p[0] + r[0] * t, p[1] + r[1] * t];
}

/** Long and short axes of a polygon (unit vectors) with its extents along them. */
export function principalAxes(poly) {
  const [cx, cz] = polyCentroid(poly);
  // Edge-length weighted covariance of the outline: robust for rectangles and L-shapes.
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (const t of [0.25, 0.5, 0.75]) {
      const x = a[0] + (b[0] - a[0]) * t - cx, z = a[1] + (b[1] - a[1]) * t - cz;
      sxx += L * x * x;
      szz += L * z * z;
      sxz += L * x * z;
    }
  }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const a = [Math.cos(ang), Math.sin(ang)];
  const b = [-a[1], a[0]];
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [x, z] of poly) {
    const pa = (x - cx) * a[0] + (z - cz) * a[1], pb = (x - cx) * b[0] + (z - cz) * b[1];
    a0 = Math.min(a0, pa); a1 = Math.max(a1, pa);
    b0 = Math.min(b0, pb); b1 = Math.max(b1, pb);
  }
  if (a1 - a0 < b1 - b0) {
    return { center: [cx, cz], long: b, short: [-a[0], -a[1]], long0: b0, long1: b1, short0: -a1, short1: -a0 };
  }
  return { center: [cx, cz], long: a, short: b, long0: a0, long1: a1, short0: b0, short1: b1 };
}

/** Longest stretch of the line p + t*dir that lies inside the polygon, as [t0, t1], or null. */
export function clipLine(p, dir, poly) {
  const ts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const s = [b[0] - a[0], b[1] - a[1]];
    const den = dir[0] * s[1] - dir[1] * s[0];
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den;
    const u = ((a[0] - p[0]) * dir[1] - (a[1] - p[1]) * dir[0]) / den;
    if (u >= 0 && u < 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  let best = null;
  for (let i = 0; i + 1 < ts.length; i += 2) {
    if (!best || ts[i + 1] - ts[i] > best[1] - best[0]) best = [ts[i], ts[i + 1]];
  }
  return best;
}

export class Bounds {
  /**
   * @param {object} o
   * @param {number[][]|null} o.poly floor-plan corners [[x, z], ...], or null for skipped spots only
   * @param {number|null} o.floorY floor height
   * @param {number|null} [o.top] optional height limit
   * @param {number} [o.margin] surfaces this far outside the outline still count (walls sit on it)
   * @param {number[][]} [o.skips] spots to ignore: [[x, y, z, r], ...]
   * @param {number} [o.segment] AR session it was marked in
   * @param {number} [o.space] coordinate space it belongs to (see spaces.js)
   */
  constructor({ poly, floorY, top = null, margin = 0.35, skips = [], segment = null, space = null }) {
    this.poly = poly && poly.length >= 3 ? ccw(poly.map((p) => [p[0], p[1]])) : null;
    this.floorY = floorY;
    this.top = top;
    this.margin = margin;
    this.skips = skips.map((s) => s.slice());
    this.segment = segment;
    this.space = space;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of this.poly || []) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    this.box = [x0 - margin, x1 + margin, z0 - margin, z1 + margin];
    this.version = 1;
  }

  get area() {
    return this.poly ? Math.abs(polyArea(this.poly)) : 0;
  }

  /** Inside the outline (plus margin), above the floor, below the top, and not in a skipped spot. */
  contains(x, y, z) {
    return this.inArea(x, y, z) && !this.skipped(x, y, z);
  }

  inArea(x, y, z) {
    if (!this.poly) return true;
    if (y < this.floorY - 0.3) return false;
    if (this.top != null && y > this.top) return false;
    const b = this.box;
    if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) return false;
    return pointInPoly(x, z, this.poly) || distToPoly(x, z, this.poly) <= this.margin;
  }

  skipped(x, y, z) {
    for (const s of this.skips) {
      const dx = x - s[0], dy = y - s[1], dz = z - s[2];
      if (dx * dx + dy * dy + dz * dz < s[3] * s[3]) return true;
    }
    return false;
  }

  addSkip(p, r = 0.5) {
    this.skips.push([p[0], p[1], p[2], r]);
    this.version++;
  }

  removeLastSkip() {
    this.skips.pop();
    this.version++;
  }

  /** Is a camera standing at (x, z) inside the area, at least `inset` from the outline? */
  standable(x, z, inset = 0.3) {
    if (!this.poly) return true;
    return pointInPoly(x, z, this.poly) && distToPoly(x, z, this.poly) >= inset;
  }

  toJSON() {
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      poly: this.poly ? this.poly.map(([x, z]) => [r(x), r(z)]) : null,
      floorY: this.floorY == null ? null : r(this.floorY),
      top: this.top == null ? null : r(this.top),
      margin: this.margin,
      skips: this.skips.map((s) => s.map(r)),
      segment: this.segment,
      space: this.space,
    };
  }

  static from(o) {
    return o && ((o.poly && o.poly.length >= 3) || (o.skips && o.skips.length)) ? new Bounds(o) : null;
  }
}

/** Distance along a horizontal direction from p to the polygon outline (Infinity if it never leaves). */
export function rayToPoly(p, dir, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const s = [b[0] - a[0], b[1] - a[1]];
    const den = dir[0] * s[1] - dir[1] * s[0];
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den;
    const u = ((a[0] - p[0]) * dir[1] - (a[1] - p[1]) * dir[0]) / den;
    if (t > 1e-6 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

export const horiz = (v) => {
  const l = Math.hypot(v[0], v[2]) || 1;
  return [v[0] / l, 0, v[2] / l];
};

export const dist2D = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export { v3 };
