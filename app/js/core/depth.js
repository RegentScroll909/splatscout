// Depth grid → world points, without the "flying pixels".
//
// Phone depth (ARCore depth-from-motion) is smoothed, so across object edges it blends near and far
// depth and invents points in mid-air between the two surfaces. Such points form a surface that runs
// along the viewing rays; real surfaces face the camera. So each sample's local surface normal is
// estimated from its neighbours on the same surface, and samples seen at a grazing angle steeper
// than about 78° are dropped. A range limit removes the noisy far end of the sensor.

import { transformPoint } from './math.js';

const MIN_COS = 0.2; // cos(78°)

/**
 * @param {Float32Array} D planar depth per grid cell (metres, 0 = none), row-major from the top-left
 * @param {number} nx grid width
 * @param {number} ny grid height
 * @param {(u:number, v:number, d:number) => number[]} unproject camera-space point (OpenGL axes) for
 *   normalised image coordinates (top-left origin) and planar depth
 * @param pose camera-to-world 4x4
 * @returns {{xyz: Float32Array, uv: Float32Array, d: Float32Array, nx: number, ny: number}}
 *   d is D with rejected cells set to 0
 */
export function depthToPoints(D, nx, ny, unproject, pose) {
  const cam = new Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      cam[k] = D[k] > 0 ? unproject((i + 0.5) / nx, (j + 0.5) / ny, D[k]) : null;
    }
  }
  const xyz = [], uv = [];
  const keep = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const P = cam[k];
      if (!P) continue;
      // The horizontal and vertical neighbour on the same surface (closest in depth).
      const a = closer(D[k], i + 1 < nx ? k + 1 : -1, i > 0 ? k - 1 : -1, D, cam);
      const b = closer(D[k], j + 1 < ny ? k + nx : -1, j > 0 ? k - nx : -1, D, cam);
      if (a && b) {
        const ex = [a[0] - P[0], a[1] - P[1], a[2] - P[2]];
        const ey = [b[0] - P[0], b[1] - P[1], b[2] - P[2]];
        const n = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
        const ln = Math.hypot(n[0], n[1], n[2]), lp = Math.hypot(P[0], P[1], P[2]);
        if (ln > 0 && lp > 0 && Math.abs(n[0] * P[0] + n[1] * P[1] + n[2] * P[2]) / (ln * lp) < MIN_COS) continue;
      }
      keep[k] = D[k];
      const w = transformPoint(pose, P);
      xyz.push(w[0], w[1], w[2]);
      uv.push((i + 0.5) / nx, (j + 0.5) / ny);
    }
  }
  return { xyz: new Float32Array(xyz), uv: new Float32Array(uv), d: keep, nx, ny };
}

function closer(d, k1, k2, D, cam) {
  const c1 = k1 >= 0 ? cam[k1] : null, c2 = k2 >= 0 ? cam[k2] : null;
  if (c1 && c2) return Math.abs(D[k1] - d) <= Math.abs(D[k2] - d) ? c1 : c2;
  return c1 || c2;
}

/** Unprojection for a GL projection matrix (normalised view coordinates, top-left origin). */
export function unprojectGL(P) {
  return (u, v, d) => {
    const xn = 2 * u - 1, yn = 1 - 2 * v;
    return [(d * (xn + P[8])) / P[0], (d * (yn + P[9])) / P[5], -d];
  };
}

/** Unprojection for pinhole intrinsics. */
export function unprojectIntr(intr) {
  return (u, v, d) => [((u * intr.w - intr.cx) / intr.fx) * d, (-(v * intr.h - intr.cy) / intr.fy) * d, -d];
}
