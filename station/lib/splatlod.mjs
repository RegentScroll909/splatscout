// Lighter copies of finished splats for the building view, where several are shown at once: the splats that count
// most (opaque and big), at most `max` of them, inside the capture's own box, in the .splat format the viewer's
// renderer reads (32 bytes a splat: centre and size as floats, colour with opacity, then the turn as bytes). Turned
// like the capture's levelled model (y up), so the building view moves them exactly as it moves the capture's points.
// A cropped splat's copies keep only its scan area (placement.mjs cropOf).

import { openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { readHeader } from './crop.mjs';

const C0 = 0.28209479177387814; // spherical harmonics, degree 0: the colour seen from every side
export const ROW = 32;
const tick = () => new Promise((r) => setImmediate(r));

const isIdentity = (R) => !R || R.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-9);
const rot3 = (R, [x, y, z]) => [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];

/** The quaternion [w, x, y, z] of a row-major rotation matrix. */
export function quatOf(R) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R, tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
}
const qmul = ([aw, ax, ay, az], [bw, bx, by, bz]) => [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];

/** The importance above which at most `max` splats are (importances of 0 never count). */
function cutFor(imp, max) {
  let lo = Infinity, hi = -Infinity;
  for (const v of imp) if (v > 0) {
    const l = Math.log(v);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const B = 4096, h = new Uint32Array(B), w = (hi - lo) / B || 1;
  for (const v of imp) if (v > 0) h[Math.min(B - 1, Math.floor((Math.log(v) - lo) / w))]++;
  let n = 0;
  for (let b = B - 1; b >= 0; b--) {
    if (n + h[b] > max) return Math.exp(lo + (b + 1) * w);
    n += h[b];
  }
  return 0;
}

/**
 * Write a lighter copy of a trained splat (.ply, 3DGS layout) as a .splat file.
 * @param {object} o
 * @param {string} o.ply the splat
 * @param {string} o.out the .splat file to write
 * @param {number} o.max at most this many splats
 * @param {number[]|null} [o.box] [x0, y0, z0, x1, y1, z1]: leave out what's outside (levelled coordinates)
 * @param {number[]|null} [o.rot] row-major 3×3 that levels the model (the capture's), or null
 * @param {((x: number, y: number, z: number) => boolean)|null} [o.inside] leave out what this says no to (levelled
 *   coordinates): a cropped splat's scan area, big splats included
 * @returns {Promise<{count: number, kept: number}>} splats in the .ply, and written
 */
export async function splatLod({ ply, out, max, box = null, rot = null, inside = null, minOpacity = 0.03 }) {
  const fd = openSync(ply, 'r');
  try {
    const { dataStart, count, stride, off } = readHeader(fd);
    for (const p of ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) if (!(p in off)) throw new Error(`The splat has no ${p} values`);
    const R = isIdentity(rot) ? null : rot, qR = R ? quatOf(R) : null, color = 'f_dc_0' in off;
    const per = Math.max(1, Math.floor((8 << 20) / stride)), chunk = Buffer.alloc(per * stride);
    const f = (o, k) => chunk.readFloatLE(o + off[k]);
    const centre = (o) => (R ? rot3(R, [f(o, 'x'), f(o, 'y'), f(o, 'z')]) : [f(o, 'x'), f(o, 'y'), f(o, 'z')]);
    // First pass: how much each splat counts (its opacity times the area of its broad side), 0 when left out.
    const imp = new Float32Array(count);
    let kept = 0;
    for (let i = 0; i < count; i += per) {
      const m = Math.min(per, count - i);
      readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
      for (let j = 0; j < m; j++) {
        const o = j * stride, a = 1 / (1 + Math.exp(-f(o, 'opacity')));
        if (a < minOpacity) continue;
        const [x, y, z] = centre(o);
        if (box && (x < box[0] || y < box[1] || z < box[2] || x > box[3] || y > box[4] || z > box[5])) continue;
        if (inside && !inside(x, y, z)) continue;
        const s = [f(o, 'scale_0'), f(o, 'scale_1'), f(o, 'scale_2')].map(Math.exp).sort((p, q) => q - p);
        imp[i + j] = Math.max(1e-30, a * s[0] * s[1]);
        kept++;
      }
      await tick();
    }
    const cut = kept > max ? cutFor(imp, max) : 0;
    // Second pass: write the ones above the cut.
    const buf = Buffer.alloc(Math.min(kept, max) * ROW);
    let w = 0;
    const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
    for (let i = 0; i < count && w * ROW < buf.length; i += per) {
      const m = Math.min(per, count - i);
      readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
      for (let j = 0; j < m && w * ROW < buf.length; j++) {
        if (!(imp[i + j] > cut)) continue;
        const o = j * stride, b = w * ROW, [x, y, z] = centre(o);
        buf.writeFloatLE(x, b);
        buf.writeFloatLE(y, b + 4);
        buf.writeFloatLE(z, b + 8);
        for (let k = 0; k < 3; k++) buf.writeFloatLE(Math.exp(f(o, 'scale_' + k)), b + 12 + 4 * k);
        for (let k = 0; k < 3; k++) buf[b + 24 + k] = color ? byte((0.5 + C0 * f(o, 'f_dc_' + k)) * 255) : 200;
        buf[b + 27] = byte(255 / (1 + Math.exp(-f(o, 'opacity'))));
        let q = [f(o, 'rot_0'), f(o, 'rot_1'), f(o, 'rot_2'), f(o, 'rot_3')];
        const qn = Math.hypot(...q) || 1;
        q = q.map((v) => v / qn);
        if (qR) q = qmul(qR, q);
        for (let k = 0; k < 4; k++) buf[b + 28 + k] = byte(q[k] * 128 + 128);
        w++;
      }
      await tick();
    }
    writeFileSync(out + '.tmp', buf.subarray(0, w * ROW));
    renameSync(out + '.tmp', out);
    return { count, kept: w };
  } finally {
    closeSync(fd);
  }
}

/** Read a .splat file back: [{x, y, z, scale: [3], rgba: [4], rot: [w, x, y, z]}] (for the self-checks). */
export function readSplat(buf) {
  const out = [];
  for (let b = 0; b + ROW <= buf.length; b += ROW) {
    out.push({
      x: buf.readFloatLE(b), y: buf.readFloatLE(b + 4), z: buf.readFloatLE(b + 8),
      scale: [0, 1, 2].map((k) => buf.readFloatLE(b + 12 + 4 * k)),
      rgba: [...buf.subarray(b + 24, b + 28)], rot: [...buf.subarray(b + 28, b + 32)].map((v) => (v - 128) / 128),
    });
  }
  return out;
}
