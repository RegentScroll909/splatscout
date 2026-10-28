// Photo matching for re-alignment.
//
// Depth shows which wall the phone sees but not always where along it: in a hallway every stretch of
// plain wall has the same shape. The photos taken earlier can tell: doors, signs and posters look
// different all along it. Each photo keeps a "key": a blurred copy of the image at about 1,400
// points, each with its 3D position from the photo's depth image. A guess for the live camera's pose
// is scored by projecting a nearby key's points into the live camera image and correlating the
// brightness there (normalised, so exposure changes don't matter).

import { transformPoint, posePosition, poseForward } from './math.js';
import { unprojectIntr } from './depth.js';
import { rgbaToGray } from './analyzer.js';

const KEY_POINTS = 1400;
const MIN_STD = 4; // grey levels: a key with less contrast than this is a plain wall, useless here

/** Key grid size for an image of aspect w/h. */
function keyGrid(w, h) {
  const kx = Math.max(8, Math.round(Math.sqrt((KEY_POINTS * w) / h)));
  return { kx, ky: Math.max(6, Math.round(KEY_POINTS / kx)) };
}

/** Blur radius (pixels) that matches the key grid spacing, so keys and live images are compared at one scale. */
function blurRadius(w, h) {
  return Math.max(1, Math.round(w / keyGrid(w, h).kx / 3));
}

// Two scales (blur radius multipliers): coarse finds the place (its match peak is wide enough to
// search in steps), fine settles it to a few centimetres.
export const COARSE = 1, FINE = 0;
const LEVELS = [2, 6];

/**
 * Detail at one scale: the image blurred a little minus blurred a lot. The broad layout (bright
 * wall above a darker floor) looks the same all along a hallway and would match anywhere; signs,
 * posters, door frames and their edges don't.
 */
function detail(gray, w, h, level) {
  const r = blurRadius(w, h) * LEVELS[level];
  const a = blurGray(gray, w, h, r), b = blurGray(gray, w, h, 4 * r);
  for (let i = 0; i < a.length; i++) a[i] -= b[i];
  return a;
}

/** Zero mean, unit variance; null when there's too little contrast to match. */
function normalise(raw) {
  const n = raw.length;
  let mean = 0;
  for (const x of raw) mean += x / n;
  let vv = 0;
  for (const x of raw) vv += (x - mean) ** 2 / n;
  const std = Math.sqrt(vv);
  return std < MIN_STD ? null : Float32Array.from(raw, (x) => (x - mean) / std);
}

/** Two passes of a (2r+1) box blur: close to a Gaussian. Returns Float32Array. */
export function blurGray(gray, w, h, r) {
  let a = Float32Array.from(gray);
  let b = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[o + x] = s / (2 * r + 1);
        s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
      }
    }
    // Vertical.
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / (2 * r + 1);
        s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

function bilinear(img, w, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const o = y0 * w + x0;
  return (img[o] * (1 - fx) + img[o + 1] * fx) * (1 - fy) + (img[o + w] * (1 - fx) + img[o + w + 1] * fx) * fy;
}

/**
 * A photo's key.
 * @param {Uint8Array} gray the photo, any size (analysis image or thumbnail)
 * @param pose camera-to-world 4x4 of the photo (scan coordinates)
 * @param intr the photo's camera intrinsics (any resolution: only ratios are used)
 * @param dimg {d: planar depth per cell in metres (0 = none), nx, ny} covering the photo
 * @returns {{pts: Float32Array, vals: Float32Array[], n, pos, fwd}|null} vals per scale (FINE,
 *   COARSE); null when too plain or no depth
 */
export function makeKey(gray, w, h, pose, intr, dimg) {
  const { d, nx: dnx, ny: dny } = dimg;
  const { kx, ky } = keyGrid(w, h);
  const imgs = LEVELS.map((_, l) => detail(gray, w, h, l));
  const un = unprojectIntr(intr);
  // Every grid point's 3D position first (depth between the four nearest depth cells; none across
  // depth edges, where the point would land on the wrong surface).
  const P = new Array(kx * ky).fill(null);
  for (let j = 0; j < ky; j++) {
    for (let i = 0; i < kx; i++) {
      const u = (i + 0.5) / kx, v = (j + 0.5) / ky;
      const gx = Math.min(dnx - 1.001, Math.max(0, u * dnx - 0.5)), gy = Math.min(dny - 1.001, Math.max(0, v * dny - 0.5));
      const i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
      const a = d[j0 * dnx + i0], b = d[j0 * dnx + i0 + 1], c = d[(j0 + 1) * dnx + i0], e = d[(j0 + 1) * dnx + i0 + 1];
      if (!(a > 0 && b > 0 && c > 0 && e > 0)) continue;
      if (Math.max(a, b, c, e) > 1.12 * Math.min(a, b, c, e)) continue;
      const dd = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
      P[j * kx + i] = transformPoint(pose, un(u, v, dd));
    }
  }
  // Walls, doors and signs only. Floors and ceilings are left out: tiles, planks and ceiling grids
  // repeat every few centimetres, so they'd match at many places along a hallway (and backwards).
  const pts = [], raws = LEVELS.map(() => []);
  for (let j = 0; j < ky; j++) {
    for (let i = 0; i < kx; i++) {
      const p = P[j * kx + i];
      if (!p) continue;
      const r = P[j * kx + Math.min(kx - 1, i + 1)] || P[j * kx + Math.max(0, i - 1)];
      const q = P[Math.min(ky - 1, j + 1) * kx + i] || P[Math.max(0, j - 1) * kx + i];
      if (!r || !q || r === p || q === p) continue;
      const ex = [r[0] - p[0], r[1] - p[1], r[2] - p[2]], ey = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const nx = ex[1] * ey[2] - ex[2] * ey[1], ny = ex[2] * ey[0] - ex[0] * ey[2], nz = ex[0] * ey[1] - ex[1] * ey[0];
      if (Math.abs(ny) > 0.6 * Math.hypot(nx, ny, nz)) continue;
      pts.push(p[0], p[1], p[2]);
      const x = Math.min(w - 1.001, ((i + 0.5) / kx) * w - 0.5), y = Math.min(h - 1.001, ((j + 0.5) / ky) * h - 0.5);
      imgs.forEach((im, l) => raws[l].push(bilinear(im, w, x, y)));
    }
  }
  const n = pts.length / 3;
  if (n < 150) return null;
  const vals = raws.map(normalise);
  if (vals.some((v) => !v)) return null;
  return { pts: new Float32Array(pts), vals, n, pos: Array.from(posePosition(pose)), fwd: Array.from(poseForward(pose)) };
}

/** A live camera image (filtered like the keys when first used). `raw` is its pose in the AR session's own coordinates. */
export function liveImage(gray, w, h, intr, raw) {
  return { gray, w, h, intr, raw, b: [] };
}

function filtered(img, level) {
  if (!img.b[level]) img.b[level] = detail(img.gray, img.w, img.h, level);
  return img.b[level];
}

/**
 * How well a key agrees with a live image if the live camera is at `pose` (scan coordinates):
 * normalised correlation over the key points that land in the image.
 * @param stride use every stride-th key point (coarse searches)
 * @param level FINE or COARSE
 * @returns {{ncc, n, frac}} frac: share of the key's points that landed in the image
 */
export function scoreKey(key, img, pose, stride = 1, level = FINE) {
  const b = filtered(img, level), w = img.w, h = img.h, val = key.vals[level];
  const s = w / img.intr.w;
  const fx = img.intr.fx * s, fy = img.intr.fy * s, cx = img.intr.cx * s, cy = img.intr.cy * s;
  const px = pose[12], py = pose[13], pz = pose[14];
  const P = key.pts;
  let n = 0, tried = 0, sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < key.n; i += stride) {
    tried++;
    const dx = P[3 * i] - px, dy = P[3 * i + 1] - py, dz = P[3 * i + 2] - pz;
    const zc = -(pose[8] * dx + pose[9] * dy + pose[10] * dz);
    if (zc < 0.25) continue;
    const x = cx + (fx * (pose[0] * dx + pose[1] * dy + pose[2] * dz)) / zc - 0.5;
    const y = cy - (fy * (pose[4] * dx + pose[5] * dy + pose[6] * dz)) / zc - 0.5;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) continue;
    const va = val[i], vb = bilinear(b, w, x, y);
    n++;
    sa += va;
    sb += vb;
    sab += va * vb;
    saa += va * va;
    sbb += vb * vb;
  }
  const frac = tried ? n / tried : 0;
  if (n < 40) return { ncc: 0, n, frac };
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  // A featureless live view says nothing either way.
  if (vb / n < MIN_STD * MIN_STD * 0.5) return { ncc: 0, n, frac, plain: true };
  return { ncc: cov / Math.sqrt(Math.max(1e-9, va * vb)), n, frac };
}

/** Keys that could see what a camera at `pose` sees: nearby and facing about the same way. */
export function nearKeys(keys, pose, limit = 3, maxDist = 4.5, minCos = 0.45) {
  const x = pose[12], z = pose[14], f = [-pose[8], -pose[9], -pose[10]];
  const out = [];
  for (const k of keys) {
    const d = Math.hypot(k.pos[0] - x, k.pos[2] - z);
    if (d > maxDist) continue;
    const c = k.fwd[0] * f[0] + k.fwd[1] * f[1] + k.fwd[2] * f[2];
    if (c < minCos) continue;
    out.push([d + 3 * (1 - c), k]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.slice(0, limit).map((o) => o[1]);
}

/**
 * Photo agreement for live images at the given poses (scan coordinates): per image, the best key
 * that overlaps it enough, averaged over the images. null when no key overlaps (or the views are plain).
 * @param poses one pose per image
 */
export function photoAgreement(keys, imgs, poses, stride = 1, level = FINE) {
  let sum = 0, m = 0;
  imgs.forEach((img, i) => {
    let best = null;
    for (const k of nearKeys(keys, poses[i])) {
      const r = scoreKey(k, img, poses[i], stride, level);
      if (r.frac < 0.15 || r.n < 40 || r.plain) continue;
      if (best == null || r.ncc > best) best = r.ncc;
    }
    if (best != null) {
      sum += best;
      m++;
    }
  });
  return m ? sum / m : null;
}

/** Decode a stored photo thumbnail to grey (browser only). */
export async function grayFromBlob(blob) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return { gray: rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h };
}
