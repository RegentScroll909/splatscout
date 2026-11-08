// Placing captures on a building's footprint: the maths shared by SplatStation (station/lib/placement.mjs), its
// building view (building.html), the floor plans on the Campus page (plan.js) and tools/check.mjs. Plain ES
// module with no DOM use.
//
// Three frames:
//  * model: a capture's COLMAP model, turned so y is up (placement.mjs levels it). Models lined up with the
//    phone's AR tracking (ar-poses, sfm-ar) are in metres; a COLMAP-only solve has no scale of its own.
//  * plan: a model's floor seen from above, (u, v) = (x, −z). Turning a plan never mirrors it.
//  * building: metres east (e) and north (n) of the building's centre, and height (h) above its ground floor.
//
// A placement {s, theta, e, n, floor, floorY, dh} takes a model point (x, y, z) into the building:
//   [e, n] = s · rot(theta) · [x, −z] + [pl.e, pl.n]
//   h      = s · (y − floorY) + (floor − 1) · FLOOR_HEIGHT + dh
// floorY is the height of the capture's floor in its model; floor 1 is the ground floor; dh (usually 0) is a small
// correction snapping to neighbours can make when two captures disagree about where the floor is.

export const FLOOR_HEIGHT = 4; // m from one floor to the next (about right for ASU's classroom buildings)
const M_PER_DEG_LAT = 110540;
const QUARTER = Math.PI / 2;

// ------------------------------------------------------------------------------------ the building's frame
/** A flat frame in metres around a point [lat, lon] (fine at the scale of a building). */
export function localFrame([lat0, lon0]) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    origin: [lat0, lon0],
    toXY: ([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLatLon: ([e, n]) => [lat0 + n / M_PER_DEG_LAT, lon0 + e / kx],
  };
}

/** A building's outline in metres east and north of its centre (b.c), counter-clockwise. */
export function footprintOf(b) {
  const f = localFrame(b.c || b.poly[0]);
  const pts = b.poly.map(f.toXY);
  return signedArea(pts) < 0 ? pts.reverse() : pts;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}
export const polygonArea = (pts) => Math.abs(signedArea(pts));

export function centroid(pts) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const c = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    a += c;
    x += (pts[j][0] + pts[i][0]) * c;
    y += (pts[j][1] + pts[i][1]) * c;
  }
  if (Math.abs(a) < 1e-9) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return [x / (3 * a), y / (3 * a)];
}

export function inside(pts, x, y) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

/** The closest point on a polygon's edge to (x, y), with the edge it's on. */
export function closestOnEdge(pts, x, y) {
  let best = null;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { p: [px, py], d, edge: [pts[j], pts[i]] };
  }
  return best;
}

/** A point inside a polygon near (x, y): the point itself when it is inside, else the nearest edge point moved `inset` metres in. */
export function nearestInside(pts, x, y, inset = 2) {
  if (inside(pts, x, y)) return [x, y];
  const { p, edge } = closestOnEdge(pts, x, y);
  const dx = edge[1][0] - edge[0][0], dy = edge[1][1] - edge[0][1], L = Math.hypot(dx, dy) || 1;
  const left = signedArea(pts) >= 0; // counter-clockwise: the inside is on the left of each edge
  for (const k of [1, 0.5, 0.25]) {
    const q = [p[0] + ((left ? -dy : dy) / L) * inset * k, p[1] + ((left ? dx : -dx) / L) * inset * k];
    if (inside(pts, q[0], q[1])) return q;
  }
  const c = centroid(pts);
  return inside(pts, c[0], c[1]) ? c : p;
}

// ------------------------------------------------------------------------------------ which way walls run
/** Turn an angle into (−45°, 45°]: walls that differ by quarter turns run the same way. */
export const wrap90 = (a) => a - QUARTER * Math.round(a / QUARTER);

/** The direction a building's walls run, mod 90° (radians): its outline's edges, longer ones counting more. */
export function footprintAngle(pts) {
  let c = 0, s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], L = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    c += L * Math.cos(4 * a);
    s += L * Math.sin(4 * a);
  }
  return Math.atan2(s, c) / 4;
}

/**
 * The direction a capture's walls run in its plan, mod 90° (radians): the turn that lines its points up best
 * with the axes (their histograms along both axes are sharpest when walls run along them).
 * @param {ArrayLike<number>} plan flat [u0, v0, u1, v1, …]
 * @param {number} cell histogram bin (plan units)
 */
export function wallAngle(plan, cell = 0.1) {
  const n = plan.length >> 1;
  if (n < 20) return 0;
  // soft: each point shared between its two nearest bins, so a wall sitting on a bin edge doesn't score low.
  const score = (a, size, soft) => {
    const c = Math.cos(-a), s = Math.sin(-a), hu = new Map(), hv = new Map();
    const put = (m, x) => {
      const p = x / size, i = Math.floor(p), f = soft ? p - i : 0;
      m.set(i, (m.get(i) || 0) + 1 - f);
      if (f) m.set(i + 1, (m.get(i + 1) || 0) + f);
    };
    for (let i = 0; i < n; i++) {
      const u = plan[2 * i], v = plan[2 * i + 1];
      put(hu, c * u - s * v);
      put(hv, s * u + c * v);
    }
    let t = 0;
    for (const m of [hu, hv]) for (const k of m.values()) t += k * k;
    return t;
  };
  // Whole degrees with coarse bins first (a 10 cm bin along a 5 m wall can't tell 1° apart), then tenths with fine ones.
  let best = 0, bs = -1;
  for (let d = -45; d < 45; d++) {
    const v = score((d * Math.PI) / 180, cell, false);
    if (v > bs) [best, bs] = [d, v];
  }
  let fine = best;
  bs = -1;
  for (let k = -15; k <= 15; k++) {
    const d = best + k / 10, v = score((d * Math.PI) / 180, cell / 4, true);
    if (v > bs) [fine, bs] = [d, v];
  }
  return wrap90((fine * Math.PI) / 180);
}

/** Where a building's main axis runs (unit vector) and how far its outline reaches along it from the centre. */
export function mainAxis(pts) {
  const a = footprintAngle(pts), d = [Math.cos(a), Math.sin(a)], c = centroid(pts);
  let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
  for (const [x, y] of pts) {
    const t = (x - c[0]) * d[0] + (y - c[1]) * d[1], w = -(x - c[0]) * d[1] + (y - c[1]) * d[0];
    lo = Math.min(lo, t); hi = Math.max(hi, t);
    lo2 = Math.min(lo2, w); hi2 = Math.max(hi2, w);
  }
  // The longer of the two quarter-turned axes is the main one.
  return hi - lo >= hi2 - lo2 ? { dir: d, centre: c, lo, hi } : { dir: [-d[1], d[0]], centre: c, lo: lo2, hi: hi2 };
}

// ------------------------------------------------------------------------------------ applying a placement
/** A model's floor point (x, z) in the building: [e, n]. */
export function planOf(pl, x, z) {
  const c = Math.cos(pl.theta) * pl.s, s = Math.sin(pl.theta) * pl.s, u = x, v = -z;
  return [c * u - s * v + pl.e, s * u + c * v + pl.n];
}

/** Back from the building's floor to the model: [x, z]. */
export function modelOf(pl, e, n) {
  const c = Math.cos(-pl.theta) / pl.s, s = Math.sin(-pl.theta) / pl.s, de = e - pl.e, dn = n - pl.n;
  return [c * de - s * dn, -(s * de + c * dn)];
}

/** Height above the building's ground floor of a model height y. */
export const heightOf = (pl, y) => pl.s * (y - (pl.floorY || 0)) + ((pl.floor ?? 1) - 1) * FLOOR_HEIGHT + (pl.dh || 0);

/** A model point in the building: [e, n, h]. */
export function toBuilding(pl, [x, y, z]) {
  const [e, n] = planOf(pl, x, z);
  return [e, n, heightOf(pl, y)];
}

/** A model direction in the building (unit length): [e, n, h]. Scale doesn't turn directions. */
export function dirOf(pl, [x, y, z]) {
  const c = Math.cos(pl.theta), s = Math.sin(pl.theta), u = x, v = -z;
  const d = [c * u - s * v, s * u + c * v, y], L = Math.hypot(...d) || 1;
  return d.map((k) => k / L);
}

// ------------------------------------------------------------------------------------ fitting a placement
/**
 * The placement taking model floor points onto building points, from pairs [[[x, z], [e, n]], …]: a turn and a
 * shift, and a scale unless `scale` is given (models in metres). Least squares; two pairs fit exactly.
 * @returns {{s, theta, e, n, rms}|null} null when the model points don't span anything
 */
export function fitPoints(pairs, { scale = null } = {}) {
  const m = pairs.length;
  if (m < 2) return null;
  const P = pairs.map(([[x, z]]) => [x, -z]), Q = pairs.map(([, q]) => q);
  const pm = [0, 1].map((k) => P.reduce((t, p) => t + p[k], 0) / m), qm = [0, 1].map((k) => Q.reduce((t, q) => t + q[k], 0) / m);
  let re = 0, im = 0, pp = 0;
  for (let i = 0; i < m; i++) {
    const pu = P[i][0] - pm[0], pv = P[i][1] - pm[1], qu = Q[i][0] - qm[0], qv = Q[i][1] - qm[1];
    re += pu * qu + pv * qv;
    im += pu * qv - pv * qu;
    pp += pu * pu + pv * pv;
  }
  if (pp < 1e-12 || Math.hypot(re, im) < 1e-12) return null;
  const theta = Math.atan2(im, re), s = scale != null ? scale : Math.hypot(re, im) / pp;
  const c = Math.cos(theta) * s, sn = Math.sin(theta) * s;
  const pl = { s, theta, e: qm[0] - (c * pm[0] - sn * pm[1]), n: qm[1] - (sn * pm[0] + c * pm[1]) };
  let sq = 0;
  for (const [[x, z], [e, n]] of pairs) {
    const [pe, pn] = planOf(pl, x, z);
    sq += (pe - e) ** 2 + (pn - n) ** 2;
  }
  return { ...pl, rms: Math.sqrt(sq / m) };
}

/** Move a placement so model floor point `from` ([x, z]) lands on building point `to` ([e, n]), keeping its turn and scale. */
export function moveTo(pl, from, to) {
  const [e, n] = planOf({ ...pl, e: 0, n: 0 }, from[0], from[1]);
  return { ...pl, e: to[0] - e, n: to[1] - n };
}

/** Turn a placement by `da` radians about the building point `about` ([e, n]). */
export function turnAbout(pl, da, about) {
  const c = Math.cos(da), s = Math.sin(da), de = pl.e - about[0], dn = pl.n - about[1];
  return { ...pl, theta: pl.theta + da, e: about[0] + c * de - s * dn, n: about[1] + s * de + c * dn };
}

/** Scale a placement by `k` about the building point `about`. */
export function scaleAbout(pl, k, about) {
  return { ...pl, s: pl.s * k, e: about[0] + (pl.e - about[0]) * k, n: about[1] + (pl.n - about[1]) * k };
}

/**
 * A first guess at where a capture sits, before anyone has placed it: at its GPS fix, moved inside the footprint
 * (indoors GPS is often 10–50 m out), else spread along the building's main axis; turned so its walls run with
 * the building's (up to a quarter turn, which only a person can tell).
 * @param {object} o
 * @param {number[][]} o.footprint the building's outline [[e, n], …] (footprintOf)
 * @param {number[]|null} o.gps [e, n] of the capture's GPS fix, or null
 * @param {number[]} o.anchor the model floor point [x, z] the GPS fix stands for (where the AR session began)
 * @param {number} [o.wall] wallAngle of the capture's plan
 * @param {number} [o.s] its scale (1 for models in metres)
 * @param {number} [o.index] which of `count` captures without GPS this is, to spread them out
 */
export function guessPlacement({ footprint, gps = null, anchor = [0, 0], wall = 0, s = 1, floor = 1, floorY = 0, index = 0, count = 1 }) {
  const theta = wrap90(footprintAngle(footprint) - wall);
  let at, from;
  if (gps) {
    at = nearestInside(footprint, gps[0], gps[1], 3);
    from = 'gps';
  } else {
    const ax = mainAxis(footprint), step = Math.min(14, (ax.hi - ax.lo) / (count + 1));
    const t = (index - (count - 1) / 2) * step;
    at = nearestInside(footprint, ax.centre[0] + ax.dir[0] * t, ax.centre[1] + ax.dir[1] * t, 3);
    from = 'none';
  }
  return { ...moveTo({ s, theta, e: 0, n: 0, floor, floorY }, anchor, at), from };
}

// ------------------------------------------------------------------------------------ floors
/** A floor as members write it ("1", "2nd", "Floor 3", "G", "Ground", "B1", "Basement") as a number (1 = ground floor), or null. */
export function floorNumber(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^(g|gf|ground|ground floor|main|main floor|lobby|street)$/.test(t)) return 1;
  if (/^(b|basement|lower level|ll)$/.test(t)) return 0;
  const b = /^(?:b|basement|level b|lower level)\s*-?\s*(\d+)$/.exec(t);
  if (b) return 1 - +b[1];
  const m = /-?\d+/.exec(t);
  return m ? +m[0] : null;
}

// ------------------------------------------------------------------------------------ how much of a floor
/**
 * How much of a floor the club has been over: 0.5 m cells of the footprint inside a placed capture's scan outline
 * or within `reach` metres of where one of its photos was taken.
 * @param {number[][]} footprint [[e, n], …]
 * @param {{cams: number[][], outlines?: number[][][]}[]} sets camera positions [[e, n], …] and scan outlines in building metres
 * @returns {{area: number, share: number, footprint: number}}
 */
export function floorCoverage(footprint, sets, { cell = 0.5, reach = 1.5 } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of footprint) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const W = Math.max(1, Math.ceil((x1 - x0) / cell)), H = Math.max(1, Math.ceil((y1 - y0) / cell));
  const inFoot = new Uint8Array(W * H), hit = new Uint8Array(W * H);
  let total = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (inside(footprint, x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell)) {
      inFoot[j * W + i] = 1;
      total++;
    }
  }
  const r = Math.ceil(reach / cell);
  for (const set of sets) {
    for (const [e, n] of set.cams || []) {
      const ci = Math.floor((e - x0) / cell), cj = Math.floor((n - y0) / cell);
      for (let j = Math.max(0, cj - r); j <= Math.min(H - 1, cj + r); j++) for (let i = Math.max(0, ci - r); i <= Math.min(W - 1, ci + r); i++) {
        if (Math.hypot(x0 + (i + 0.5) * cell - e, y0 + (j + 0.5) * cell - n) <= reach) hit[j * W + i] = 1;
      }
    }
    for (const poly of set.outlines || []) {
      if (!poly || poly.length < 3) continue;
      let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
      for (const [x, y] of poly) [a0, b0, a1, b1] = [Math.min(a0, x), Math.min(b0, y), Math.max(a1, x), Math.max(b1, y)];
      for (let j = Math.max(0, Math.floor((b0 - y0) / cell)); j <= Math.min(H - 1, Math.floor((b1 - y0) / cell)); j++) {
        for (let i = Math.max(0, Math.floor((a0 - x0) / cell)); i <= Math.min(W - 1, Math.floor((a1 - x0) / cell)); i++) {
          if (inside(poly, x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell)) hit[j * W + i] = 1;
        }
      }
    }
  }
  let n = 0;
  for (let k = 0; k < W * H; k++) if (hit[k] && inFoot[k]) n++;
  const area = n * cell * cell, foot = total * cell * cell;
  return { area, share: foot ? area / foot : 0, footprint: foot };
}

// ------------------------------------------------------------------------------------ a placement as saved
/** A placement from the club (campus.json or a POST), checked: {s, theta, e, n, floor, dh}, or null if it isn't one. */
export function cleanPlacement(p) {
  if (!p || typeof p !== 'object') return null;
  const s = +p.s, theta = +p.theta, e = +p.e, n = +p.n, floor = Math.round(+p.floor), dh = p.dh == null ? 0 : +p.dh;
  if (!(s > 1e-6 && s < 1e6) || ![theta, e, n, dh].every(Number.isFinite) || Math.abs(e) > 1e5 || Math.abs(n) > 1e5) return null;
  if (!Number.isFinite(floor) || floor < -10 || floor > 100) return null;
  return { s, theta: Math.atan2(Math.sin(theta), Math.cos(theta)), e, n, floor, dh: Math.max(-MAX_RISE, Math.min(MAX_RISE, dh)) };
}

// ------------------------------------------------------------------------------------ snapping to neighbours
// Like fitting a jigsaw piece: a capture that overlaps captures already placed (a shared doorway, the same wall seen
// from both rooms) is moved until its points sit on theirs. ICP limited to a turn about the vertical, a shift and a
// small rise: AR captures already agree on which way is up, and a model in metres keeps its size.
export const MAX_RISE = 0.5; // m: the most snapping may raise or lower a capture (floors are found to a few cm)
const OFF = 32768;
const cellKey = (i, j, k) => ((i + OFF) * 65536 + (j + OFF)) * 65536 + (k + OFF);

/** Points [x, y, z, …] filed by cube of `cell` metres (at most `cap` a cube), to find each one's nearest within a cell. */
export function pointGrid(pts, cell, cap = 32) {
  const m = new Map(), n = Math.floor(pts.length / 3);
  for (let i = 0; i < n; i++) {
    const k = cellKey(Math.floor(pts[3 * i] / cell), Math.floor(pts[3 * i + 1] / cell), Math.floor(pts[3 * i + 2] / cell));
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    if (a.length < cap) a.push(i);
  }
  return { m, cell, pts };
}

/** The nearest point of a grid within `reach` (no more than its cell) of (x, y, z): {i, d2}, or null. */
export function nearestIn(g, x, y, z, reach = g.cell) {
  const c = g.cell, i0 = Math.floor(x / c), j0 = Math.floor(y / c), k0 = Math.floor(z / c), P = g.pts;
  let best = -1, bd = reach * reach;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
    const a = g.m.get(cellKey(i0 + di, j0 + dj, k0 + dk));
    if (!a) continue;
    for (const j of a) {
      const dx = P[3 * j] - x, dy = P[3 * j + 1] - y, dz = P[3 * j + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) [bd, best] = [d2, j];
    }
  }
  return best < 0 ? null : { i: best, d2: bd };
}

/** Solve the 4×4 system A·x = b (A row-major), lightly damped so a direction nothing pins down stays put. */
export function solve4(A, b) {
  const M = [0, 1, 2, 3].map((i) => [...A.slice(i * 4, i * 4 + 4), b[i]]);
  const top = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(M[i][i])));
  for (let i = 0; i < 4; i++) M[i][i] += top * 1e-6 + 1e-12;
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < 4; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let v = M[r][4];
    for (let k = r + 1; k < 4; k++) v -= M[r][k] * x[k];
    x[r] = v / M[r][r];
  }
  return x;
}

/** The smallest eigenvalue of a symmetric 3×3 matrix [a00, a01, a02, a11, a12, a22], the middle one, and the smallest's unit vector. */
export function smallestEigen([a00, a01, a02, a11, a12, a22]) {
  const p1 = a01 * a01 + a02 * a02 + a12 * a12, q = (a00 + a11 + a22) / 3;
  let l0, l1;
  if (p1 < 1e-30) {
    const d = [a00, a11, a22].map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const v = [0, 0, 0];
    v[d[0][1]] = 1;
    return { value: d[0][0], mid: d[1][0], vector: v };
  }
  const p2 = (a00 - q) ** 2 + (a11 - q) ** 2 + (a22 - q) ** 2 + 2 * p1, p = Math.sqrt(p2 / 6);
  const b = [(a00 - q) / p, a01 / p, a02 / p, (a11 - q) / p, a12 / p, (a22 - q) / p];
  const det = b[0] * (b[3] * b[5] - b[4] * b[4]) - b[1] * (b[1] * b[5] - b[4] * b[2]) + b[2] * (b[1] * b[4] - b[3] * b[2]);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const top = q + 2 * p * Math.cos(phi);
  l0 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  l1 = 3 * q - top - l0;
  // Its vector: the longest cross product of two rows of (A − l0·I).
  const r = [[a00 - l0, a01, a02], [a01, a11 - l0, a12], [a02, a12, a22 - l0]];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let v = null, best = -1;
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    const c = cr(r[i], r[j]), L = Math.hypot(...c);
    if (L > best) [best, v] = [L, c];
  }
  return { value: l0, mid: l1, vector: best > 1e-30 ? v.map((x) => x / best) : [0, 0, 1] };
}

/**
 * Snap a capture onto its placed neighbours. Both sets of points are in the building: [e, n, h, …] (the capture's as it
 * is placed now). Each round pairs every point of the capture with the nearest neighbour point within reach and finds
 * the turn and shift (and rise) that bring them together, measuring each pair across the surface the neighbour's point
 * lies on (its floor, its wall) where there is one: sliding along a wall costs nothing, so the end of a neighbour's scan
 * doesn't drag it, and a doorway, a corner or a pillar decides where it goes along a corridor. Pairs further apart count
 * less (a Cauchy weight). The reach shrinks from 1 m to 12 cm over the rounds.
 * @returns {{ok: boolean, reason?: string, turn: number, shift: number[], about: number[], rms: number, overlap: number,
 *   pairs: number, before: {rms: number, overlap: number}, rounds: number}} the move is a turn by `turn` about `about`
 *   ([e, n]) followed by `shift` ([de, dn, dh]); rms (m) and overlap (share of its points within the last reach of a
 *   neighbour's) say how well it fits, before and after (fitOf).
 */
export function snapPoints(src, dst, { stages = [1, 0.6, 0.35, 0.2, 0.12], rounds = 15, minPairs = 40, maxShift = 3, maxTurn = 0.35, normalRadius = 0.15 } = {}) {
  const n = Math.floor(src.length / 3), last = stages[stages.length - 1];
  const out = { ok: false, turn: 0, shift: [0, 0, 0], about: [0, 0], rms: 0, overlap: 0, pairs: 0, before: { rms: 0, overlap: 0 }, rounds: 0 };
  if (!n || dst.length < 3) return { ...out, reason: 'There’s nothing placed near it to snap to.' };
  let a0 = 0, a1 = 0;
  for (let i = 0; i < n; i++) {
    a0 += src[3 * i] / n;
    a1 += src[3 * i + 1] / n;
  }
  out.about = [a0, a1];
  let th = 0, t0 = 0, t1 = 0, dh = 0;
  const cur = new Float64Array(n * 3);
  const apply = () => {
    const c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < n; i++) {
      const x = src[3 * i] - a0, y = src[3 * i + 1] - a1;
      cur[3 * i] = c * x - s * y + a0 + t0;
      cur[3 * i + 1] = s * x + c * y + a1 + t1;
      cur[3 * i + 2] = src[3 * i + 2] + dh;
    }
  };
  // Which way the surface around each neighbour point faces, from its neighbours within normalRadius, worked out when
  // first needed; null where the points around it don't lie on one surface (an edge, clutter, too few).
  const gN = pointGrid(dst, normalRadius, 40), normals = new Map(), rN = normalRadius * normalRadius;
  const normalOf = (j) => {
    if (normals.has(j)) return normals.get(j);
    const x = dst[3 * j], y = dst[3 * j + 1], z = dst[3 * j + 2], c = gN.cell;
    const i0 = Math.floor(x / c), j0 = Math.floor(y / c), k0 = Math.floor(z / c);
    let m = 0, sx = 0, sy = 0, sz = 0, xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      for (const k of gN.m.get(cellKey(i0 + di, j0 + dj, k0 + dk)) || []) {
        const dx = dst[3 * k] - x, dy = dst[3 * k + 1] - y, dz = dst[3 * k + 2] - z;
        if (dx * dx + dy * dy + dz * dz > rN) continue;
        m++;
        sx += dx; sy += dy; sz += dz;
        xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
      }
    }
    let v = null;
    if (m >= 6) {
      const mx = sx / m, my = sy / m, mz = sz / m;
      const e = smallestEigen([xx / m - mx * mx, xy / m - mx * my, xz / m - mx * mz, yy / m - my * my, yz / m - my * mz, zz / m - mz * mz]);
      if (e.value < 0.2 * e.mid) v = e.vector;
    }
    normals.set(j, v);
    return v;
  };
  const fitNow = () => {
    apply();
    return fitOf(cur, dst, { reach: last });
  };
  out.before = fitNow();
  const A = new Float64Array(16), B = new Float64Array(4);
  const add = (r0, r1, r2, r3, res, w) => {
    const row = [r0, r1, r2, r3];
    for (let a = 0; a < 4; a++) {
      B[a] += w * row[a] * res;
      for (let b = 0; b < 4; b++) A[a * 4 + b] += w * row[a] * row[b];
    }
  };
  for (const reach of stages) {
    // The early, wide rounds only need a rough pull: a few points a cell keeps them quick.
    const g = pointGrid(dst, reach, reach > 0.3 ? 8 : 24), s2 = (reach / 2) ** 2;
    for (let r = 0; r < rounds; r++) {
      apply();
      let ce = 0, cn = 0;
      for (let i = 0; i < n; i++) {
        ce += cur[3 * i] / n;
        cn += cur[3 * i + 1] / n;
      }
      A.fill(0);
      B.fill(0);
      let m = 0;
      // Small moves: a turn d about (ce, cn) moves a point by d·(−py, px); unknowns [d, de, dn, dh].
      for (let i = 0; i < n; i++) {
        const hit = nearestIn(g, cur[3 * i], cur[3 * i + 1], cur[3 * i + 2], reach);
        if (!hit) continue;
        m++;
        const j = hit.i, px = cur[3 * i] - ce, py = cur[3 * i + 1] - cn;
        const de = dst[3 * j] - cur[3 * i], dn = dst[3 * j + 1] - cur[3 * i + 1], dz = dst[3 * j + 2] - cur[3 * i + 2];
        const v = normalOf(j);
        if (v) {
          const res = de * v[0] + dn * v[1] + dz * v[2];
          add(-py * v[0] + px * v[1], v[0], v[1], v[2], res, 1 / (1 + (res * res) / s2));
        } else {
          const w = 1 / (1 + (de * de + dn * dn + dz * dz) / s2);
          add(-py, 1, 0, 0, de, w);
          add(px, 0, 1, 0, dn, w);
          add(0, 0, 0, 1, dz, w);
        }
      }
      if (m < minPairs) {
        if (reach === stages[0]) return { ...out, reason: 'It doesn’t overlap anything placed yet: move it next to its neighbour first (a shared doorway or wall).' };
        break;
      }
      const [d, se, sn, sh] = solve4(A, B);
      const c = Math.cos(d), s = Math.sin(d);
      // Compose: p → rot(d)·(p − c) + c + (se, sn), after p → rot(th)·(p − a) + a + t.
      const ex = a0 + t0 - ce, ey = a1 + t1 - cn;
      th += d;
      t0 = c * ex - s * ey + ce + se - a0;
      t1 = s * ex + c * ey + cn + sn - a1;
      dh += sh;
      out.rounds++;
      if (Math.abs(d) < 2e-5 && Math.hypot(se, sn) < 2e-4 && Math.abs(sh) < 2e-4) break; // settled (to a fraction of a mm)
    }
  }
  const after = fitNow();
  Object.assign(out, { turn: Math.atan2(Math.sin(th), Math.cos(th)), shift: [t0, t1, dh], rms: after.rms, overlap: after.overlap, pairs: after.pairs });
  if (after.pairs < minPairs) return { ...out, reason: 'Too little of it overlaps its neighbours to tell where it fits.' };
  if (Math.abs(out.turn) > maxTurn || Math.hypot(t0, t1) > maxShift || Math.abs(dh) > MAX_RISE) {
    return { ...out, reason: 'It would have to move further than a nudge: put it closer by hand first, then snap.' };
  }
  return { ...out, ok: true };
}

/**
 * How well a capture fits its neighbours where it is now (no moving): how far its points are from the nearest of
 * theirs within `reach` (rms of the closest `keep` share, m), and what share of its points have one that close.
 */
export function fitOf(src, dst, { reach = 0.12, keep = 0.8 } = {}) {
  const n = Math.floor(src.length / 3);
  if (!n || dst.length < 3) return { rms: 0, overlap: 0, pairs: 0 };
  const g = pointGrid(dst, reach), d = [];
  for (let i = 0; i < n; i++) {
    const hit = nearestIn(g, src[3 * i], src[3 * i + 1], src[3 * i + 2], reach);
    if (hit) d.push(hit.d2);
  }
  d.sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(d.length * keep));
  return { rms: d.length ? Math.sqrt(d.slice(0, k).reduce((t, v) => t + v, 0) / k) : 0, overlap: d.length / n, pairs: d.length };
}

/** A placement moved by a snap (snapPoints' turn about its point, then its shift and rise). */
export function applySnap(pl, snap) {
  const t = turnAbout(pl, snap.turn, snap.about);
  return { ...t, e: t.e + snap.shift[0], n: t.n + snap.shift[1], dh: Math.max(-MAX_RISE, Math.min(MAX_RISE, (pl.dh || 0) + snap.shift[2])) };
}
