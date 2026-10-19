// Shared helpers for capture sources.

import { projectionFromIntrinsics, projectPoint, projectDir, mat4InvertRigid } from '../core/math.js';

export const ANALYSIS_LONG_SIDE = 640;

/** Size of the analysis image (long side 640, even dimensions). */
export function analysisSize(w, h, long = ANALYSIS_LONG_SIDE) {
  const s = long / Math.max(w, h);
  return { w: Math.max(2, Math.round((w * s) / 2) * 2), h: Math.max(2, Math.round((h * s) / 2) * 2) };
}

/**
 * Display mapping for an image of intrinsics `intr` shown with CSS object-fit: cover in a box
 * of dispW x dispH CSS pixels. Returns the GL projection for overlays and a screen projector.
 */
export function coverMapping(intr, dispW, dispH) {
  const s = Math.max(dispW / intr.w, dispH / intr.h);
  const ox = (dispW - intr.w * s) / 2, oy = (dispH - intr.h * s) / 2;
  const di = { fx: intr.fx * s, fy: intr.fy * s, cx: intr.cx * s + ox, cy: intr.cy * s + oy, w: dispW, h: dispH };
  return {
    displayIntr: di,
    proj: projectionFromIntrinsics(di),
    toScreen(pose, p, isDir) {
      return screenProject(pose, di, p, isDir);
    },
  };
}

/** Project to CSS pixels. Returns {x, y, front} — for points behind the camera, x/y are mirrored. */
export function screenProject(pose, di, p, isDir) {
  const r = isDir ? projectDir(pose, di, p) : projectPoint(pose, di, p);
  if (r) return { x: r[0], y: r[1], front: true };
  // Behind the camera: project the point mirrored through the camera, then mirror the result
  // through the image centre, so edge arrows still point the right way.
  const q = isDir
    ? projectDir(pose, di, [-p[0], -p[1], -p[2]])
    : projectPoint(pose, di, [2 * pose[12] - p[0], 2 * pose[13] - p[1], 2 * pose[14] - p[2]]);
  if (!q) return null;
  return { x: 2 * di.cx - q[0], y: 2 * di.cy - q[1], front: false };
}

export function viewMatrixOf(pose) {
  return mat4InvertRigid(pose);
}
