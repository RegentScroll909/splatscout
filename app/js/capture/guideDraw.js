// Geometry for the AR guide layers (triangles for Overlay3D.setTris: xyz, rgba, wave per vertex).

import { v3 } from '../core/math.js';

export const COL = {
  path: [0.24, 0.86, 1.0, 0.9],
  stand: [0.24, 0.86, 1.0, 0.75],
  ghost: [0.24, 0.86, 1.0, 0.9],
  bounds: [0.88, 0.96, 1.0, 0.8],
  fence: [0.6, 0.88, 1.0, 0.12],
  cursor: [1.0, 1.0, 1.0, 0.95],
  cursorBad: [1.0, 0.35, 0.35, 0.9],
};

const STATIC = -1, BREATHE = -2;

function vert(out, p, c, w) {
  out.push(p[0], p[1], p[2], c[0], c[1], c[2], c[3], w);
}

/** Quad a-b-c-d (in order around the edge), optional per-corner colours and wave values. */
function quad(out, a, b, c, d, col, w = STATIC, cols = null, ws = null) {
  const C = cols || [col, col, col, col];
  const W = ws || [w, w, w, w];
  vert(out, a, C[0], W[0]); vert(out, b, C[1], W[1]); vert(out, c, C[2], W[2]);
  vert(out, a, C[0], W[0]); vert(out, c, C[2], W[2]); vert(out, d, C[3], W[3]);
}

/** Flat band on the floor from a to b (x, y, z points; y ignored → floor height y). */
function floorBand(out, a, b, y, width, col, w0 = STATIC, w1 = STATIC) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const L = Math.hypot(dx, dz);
  if (L < 1e-4) return;
  const nx = (-dz / L) * (width / 2), nz = (dx / L) * (width / 2);
  quad(out, [a[0] + nx, y, a[2] + nz], [b[0] + nx, y, b[2] + nz], [b[0] - nx, y, b[2] - nz], [a[0] - nx, y, a[2] - nz], col, STATIC, null, [w0, w1, w1, w0]);
}

/** Ring lying on the floor. */
export function floorRing(out, center, r, width, col, wave = STATIC, segs = 36) {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const p = (a, rr) => [center[0] + Math.cos(a) * rr, center[1], center[2] + Math.sin(a) * rr];
    quad(out, p(a0, r - width / 2), p(a1, r - width / 2), p(a1, r + width / 2), p(a0, r + width / 2), col, wave);
  }
}

function disc(out, center, r, col, wave = STATIC, segs = 28) {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    vert(out, center, col, wave);
    vert(out, [center[0] + Math.cos(a0) * r, center[1], center[2] + Math.sin(a0) * r], col, wave);
    vert(out, [center[0] + Math.cos(a1) * r, center[1], center[2] + Math.sin(a1) * r], col, wave);
  }
}

/** Vertical post (two crossed quads, visible from any side). */
function post(out, base, height, width, col) {
  const h = width / 2;
  const top = base[1] + height;
  quad(out, [base[0] - h, base[1], base[2]], [base[0] + h, base[1], base[2]], [base[0] + h, top, base[2]], [base[0] - h, top, base[2]], col);
  quad(out, [base[0], base[1], base[2] - h], [base[0], base[1], base[2] + h], [base[0], top, base[2] + h], [base[0], top, base[2] - h], col);
}

/**
 * Floor chevrons along a polyline of floor points, pointing in the walking direction. The `wave`
 * value is the distance along the path, so a light pulse runs ahead of the user.
 */
export function chevronTrail(points, { start = 0.55, every = 0.45, col = COL.path } = {}) {
  const out = [];
  let s = 0, next = start;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (L < 1e-4) continue;
    const d = [(b[0] - a[0]) / L, 0, (b[2] - a[2]) / L];
    const n = [-d[2], 0, d[0]];
    while (next <= s + L) {
      const u = next - s;
      const p = [a[0] + d[0] * u, a[1] + 0.012, a[2] + d[2] * u];
      chevron(out, p, d, n, col, next);
      next += every;
    }
    s += L;
  }
  // A dotted line under the chevrons so the path reads as one continuous trail.
  s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    for (let u = Math.max(0, start - s); u < L; u += 0.15) {
      const v = Math.min(L, u + 0.06);
      const pa = [a[0] + ((b[0] - a[0]) * u) / L, 0, a[2] + ((b[2] - a[2]) * u) / L];
      const pb = [a[0] + ((b[0] - a[0]) * v) / L, 0, a[2] + ((b[2] - a[2]) * v) / L];
      floorBand(out, pa, pb, a[1] + 0.01, 0.03, [col[0], col[1], col[2], 0.55], s + u, s + v);
    }
    s += L;
  }
  return out;
}

function chevron(out, p, d, n, col, wave) {
  const tip = v3.add(p, v3.scale(d, 0.13));
  for (const side of [1, -1]) {
    const back = v3.add(v3.sub(p, v3.scale(d, 0.08)), v3.scale(n, 0.17 * side));
    const arm = v3.norm(v3.sub(back, tip));
    const perp = v3.scale([-arm[2], 0, arm[0]], 0.025);
    quad(out, v3.add(tip, perp), v3.add(back, perp), v3.sub(back, perp), v3.sub(tip, perp), col, wave);
  }
}

/** "Stand here": pulsing ring and soft disc on the floor. */
export function standMarker(out, p, col = COL.stand) {
  floorRing(out, [p[0], p[1] + 0.015, p[2]], 0.32, 0.05, col, BREATHE);
  disc(out, [p[0], p[1] + 0.01, p[2]], 0.3, [col[0], col[1], col[2], 0.12], STATIC);
}

/**
 * Ghost phone: where to hold the camera and which way to aim (a frame facing along `aim`, with a
 * pointer), plus a thin pole down to the floor so its height reads clearly.
 */
export function ghostPhone(out, pos, aim, floorY, portrait = true, col = COL.ghost) {
  const f = v3.norm(aim);
  let r = v3.cross(f, [0, 1, 0]);
  if (v3.len(r) < 1e-3) r = [1, 0, 0];
  r = v3.norm(r);
  const u = v3.cross(r, f);
  const hw = portrait ? 0.08 : 0.15, hh = portrait ? 0.15 : 0.08, t = 0.012;
  const P = (x, y) => v3.add(pos, v3.add(v3.scale(r, x), v3.scale(u, y)));
  // Frame outline
  quad(out, P(-hw, hh), P(hw, hh), P(hw, hh - t), P(-hw, hh - t), col);
  quad(out, P(-hw, -hh + t), P(hw, -hh + t), P(hw, -hh), P(-hw, -hh), col);
  quad(out, P(-hw, hh), P(-hw + t, hh), P(-hw + t, -hh), P(-hw, -hh), col);
  quad(out, P(hw - t, hh), P(hw, hh), P(hw, -hh), P(hw - t, -hh), col);
  // Glass
  quad(out, P(-hw, hh), P(hw, hh), P(hw, -hh), P(-hw, -hh), [col[0], col[1], col[2], 0.12]);
  // Pointer along the aim
  const tip = v3.add(pos, v3.scale(f, 0.32));
  const b0 = v3.add(pos, v3.scale(f, 0.08));
  for (const side of [r, u]) {
    vert(out, tip, col, BREATHE);
    vert(out, v3.add(b0, v3.scale(side, 0.05)), col, BREATHE);
    vert(out, v3.sub(b0, v3.scale(side, 0.05)), col, BREATHE);
  }
  post(out, [pos[0], floorY, pos[2]], pos[1] - floorY - hh, 0.012, [col[0], col[1], col[2], 0.45]);
}

/**
 * Scan-area outline on the floor with a low translucent fence.
 * @param corners [[x, z], ...]
 * @param {object} o {closed, cursor: [x, y, z] preview point, posts}
 */
export function boundsGeometry(corners, floorY, { closed = true, cursor = null, posts = false } = {}) {
  const out = [];
  const y = floorY + 0.01;
  const pts = corners.map(([x, z]) => [x, y, z]);
  const edges = [];
  for (let i = 0; i + 1 < pts.length; i++) edges.push([pts[i], pts[i + 1], 1]);
  if (closed && pts.length >= 3) edges.push([pts[pts.length - 1], pts[0], 1]);
  if (!closed && cursor && pts.length) {
    edges.push([pts[pts.length - 1], [cursor[0], y, cursor[2]], 0.55]);
    if (pts.length >= 2) edges.push([[cursor[0], y, cursor[2]], pts[0], 0.25]);
  }
  for (const [a, b, alpha] of edges) {
    const c = [COL.bounds[0], COL.bounds[1], COL.bounds[2], COL.bounds[3] * alpha];
    floorBand(out, a, b, y, 0.05, c);
    const f0 = [COL.fence[0], COL.fence[1], COL.fence[2], COL.fence[3] * alpha * 1.6];
    const f1 = [COL.fence[0], COL.fence[1], COL.fence[2], 0];
    const h = 0.45;
    quad(out, a, b, [b[0], y + h, b[2]], [a[0], y + h, a[2]], f0, STATIC, [f0, f0, f1, f1]);
  }
  if (posts) for (const p of pts) post(out, p, 1.1, 0.03, COL.bounds);
  return out;
}

/** Floor cursor while marking corners. */
export function cursorGeometry(p, ok = true) {
  const out = [];
  const c = ok ? COL.cursor : COL.cursorBad;
  floorRing(out, [p[0], p[1] + 0.012, p[2]], 0.12, 0.025, c, STATIC, 28);
  const s = 0.06, y = p[1] + 0.012;
  floorBand(out, [p[0] - s, y, p[2]], [p[0] + s, y, p[2]], y, 0.015, c);
  floorBand(out, [p[0], y, p[2] - s], [p[0], y, p[2] + s], y, 0.015, c);
  return out;
}
