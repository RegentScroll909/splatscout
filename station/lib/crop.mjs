// Crop a trained splat (.ply) to the scan area marked in SplatScout: removes small splats outside the
// floor outline (plus a margin) and below the floor — e.g. floaters "seen" through windows.
// Works when the splat is in the AR coordinate frame (AR-pose solve, or SfM aligned to the AR poses).
//
// Big splats stay wherever they are. Seen only from inside a room, a plain wall can be painted by
// large faint blobs metres behind it (they look the same from every photo), and in one capture
// those outweighed all the splats inside the room 300 to 1: cropping them away left the walls dark
// and see-through. What's removed is kept beside the splat (<name>.outside.ply), so a crop can be
// changed or undone later without training again.

import { openSync, readSync, writeSync, closeSync, renameSync, rmSync, existsSync } from 'node:fs';
import { Bounds } from '../../app/js/core/bounds.js';

const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

export const CROP_MARGIN = 0.5; // m kept outside the outline (walls sit on it, splats have size)
export const KEEP_BIG = 0.25; // m: splats at least this big (largest axis) stay outside the area too

export function readHeader(fd) {
  const buf = Buffer.alloc(65536);
  const n = readSync(fd, buf, 0, buf.length, 0);
  const txt = buf.subarray(0, n).toString('latin1');
  const endIdx = txt.indexOf('end_header');
  if (!txt.startsWith('ply') || endIdx < 0) throw new Error('Not a PLY file');
  const dataStart = txt.indexOf('\n', endIdx) + 1;
  const lines = txt.slice(0, dataStart).split(/\r?\n/);
  if (!lines.some((l) => l.startsWith('format binary_little_endian'))) throw new Error('Only binary little-endian PLY is supported');
  let count = 0, stride = 0, inVertex = false, elements = 0;
  const off = {};
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'element') {
      elements++;
      inVertex = p[1] === 'vertex';
      if (inVertex) count = +p[2];
    } else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') throw new Error('List properties are not supported');
      off[p[2]] = stride;
      stride += SIZES[p[1]] || 4;
    }
  }
  if (elements !== 1 || !('x' in off)) throw new Error('Expected a single vertex element with x, y, z');
  return { header: txt.slice(0, dataStart), dataStart, count, stride, off };
}

/** Visit every splat of one or more PLY files with the same layout: fn(chunk, offset, fileIndex, index). */
function eachSplat(files, fn) {
  const { stride } = files[0];
  const per = Math.max(1, Math.floor((8 << 20) / stride));
  const chunk = Buffer.alloc(per * stride);
  files.forEach((f, fi) => {
    for (let i = 0; i < f.count; i += per) {
      const m = Math.min(per, f.count - i);
      readSync(f.fd, chunk, 0, m * stride, f.dataStart + i * stride);
      for (let j = 0; j < m; j++) fn(chunk, j * stride, fi, i + j);
    }
  });
}

function openAll(srcs) {
  const files = srcs.map((f) => {
    const fd = openSync(f, 'r');
    return { fd, ...readHeader(fd) };
  });
  if (files.some((f) => f.stride !== files[0].stride || Object.keys(f.off).join() !== Object.keys(files[0].off).join())) {
    for (const f of files) closeSync(f.fd);
    throw new Error('The splat files have different layouts');
  }
  return files;
}

/** Replace `dst` with `tmp`, retrying while a viewer may still be reading it (Windows locks open files). */
function replace(tmp, dst) {
  for (let k = 0; ; k++) {
    try {
      renameSync(tmp, dst);
      return;
    } catch (e) {
      if (k >= 20) throw e;
      const until = Date.now() + 250;
      while (Date.now() < until);
    }
  }
}

/**
 * Whether a point (splat coordinates) is in the scan area, as the crop judges it: inside an outline plus the
 * margin, and from just below its floor to just above its top.
 * @param {object|object[]} boundsData SplatScout "bounds" ({poly, floorY, top, ...}), or several: inside any of them
 * @param {number} [margin] metres kept outside the outline
 * @returns {(x: number, y: number, z: number) => boolean}
 */
export function insideAreas(boundsData, margin = CROP_MARGIN) {
  const areas = (Array.isArray(boundsData) ? boundsData : [boundsData]).map((d) => {
    const b = new Bounds({ ...d, margin, skips: [] });
    return { b, floor: b.floorY - 0.4, top: b.top == null ? Infinity : b.top + 0.4 };
  });
  if (!areas.length || areas.some((a) => !a.b.poly)) throw new Error('No scan-area outline');
  return (x, y, z) => areas.some(({ b, floor, top }) => y >= floor && y <= top && b.inArea(x, b.floorY, z));
}

/**
 * @param {string|string[]} src input .ply (several: e.g. a cropped splat plus what an earlier crop removed)
 * @param {string} dst output .ply (may be one of the inputs)
 * @param {object|object[]|null} boundsData SplatScout manifest "bounds" ({poly, floorY, top, ...}), or
 *   several (merged captures): a splat stays if it's inside any of them. null: keep everything.
 * @param {number} [margin] metres kept outside the outline
 * @param {object} [o]
 * @param {string|null} [o.outside] where to write what's removed (null: drop it)
 * @param {number} [o.keepBig] splats this big stay wherever they are (0: crop them too)
 * @returns {{kept:number, removed:number}}
 */
export function cropPly(src, dst, boundsData, margin = CROP_MARGIN, { outside = null, keepBig = KEEP_BIG } = {}) {
  const inside = boundsData ? insideAreas(boundsData, margin) : () => true;
  const files = openAll(Array.isArray(src) ? src : [src]);
  const { header, stride, off } = files[0];
  // Scales are stored as logs; without them (plain point clouds) size can't be judged.
  const bigLog = keepBig > 0 && ['scale_0', 'scale_1', 'scale_2'].every((k) => k in off) ? Math.log(keepBig) : null;
  let kept = 0, total = 0;
  try {
    for (const f of files) f.keep = new Uint8Array(f.count);
    eachSplat(files, (c, o, fi, i) => {
      total++;
      let k = inside(c.readFloatLE(o + off.x), c.readFloatLE(o + off.y), c.readFloatLE(o + off.z));
      if (!k && bigLog != null) k = Math.max(c.readFloatLE(o + off.scale_0), c.readFloatLE(o + off.scale_1), c.readFloatLE(o + off.scale_2)) >= bigLog;
      if (k) {
        files[fi].keep[i] = 1;
        kept++;
      }
    });
    // Written next to the destination first: dst may be one of the inputs.
    const write = (path, want, n) => {
      const out = openSync(path, 'w');
      try {
        writeSync(out, Buffer.from(header.replace(/element vertex \d+/, `element vertex ${n}`), 'latin1'));
        const per = Math.max(1, Math.floor((8 << 20) / stride));
        const buf = Buffer.alloc(per * stride);
        let w = 0;
        eachSplat(files, (c, o, fi, i) => {
          if (files[fi].keep[i] !== want) return;
          c.copy(buf, w * stride, o, o + stride);
          if (++w === per) {
            writeSync(out, buf, 0, w * stride);
            w = 0;
          }
        });
        if (w) writeSync(out, buf, 0, w * stride);
      } finally {
        closeSync(out);
      }
    };
    write(dst + '.tmp', 1, kept);
    if (outside && total > kept) write(outside + '.tmp', 0, total - kept);
  } finally {
    for (const f of files) closeSync(f.fd);
  }
  replace(dst + '.tmp', dst);
  if (outside) {
    if (total > kept) replace(outside + '.tmp', outside);
    else if (existsSync(outside)) rmSync(outside);
  }
  return { kept, removed: total - kept };
}

/**
 * Top-down picture of a splat for drawing a crop on: how much solid surface is at wall height in
 * each cell (the big faint background left out). Returns {x0, z0, cell, W, H, data} with data one
 * byte per cell (0–255), row by row.
 * @param {string[]} srcs .ply files (same layout)
 * @param {number} floorY floor height
 * @param {number[]} box [x0, x1, z0, z1] area to cover
 */
export function topDown(srcs, floorY, box, maxCells = 360) {
  const files = openAll(srcs);
  const { off } = files[0];
  const cell = Math.max(0.03, Math.max(box[1] - box[0], box[3] - box[2]) / maxCells);
  const W = Math.ceil((box[1] - box[0]) / cell), H = Math.ceil((box[3] - box[2]) / cell);
  const sum = new Float32Array(W * H);
  const bigLog = 'scale_0' in off ? Math.log(KEEP_BIG) : Infinity;
  try {
    eachSplat(files, (c, o) => {
      const y = c.readFloatLE(o + off.y);
      if (y < floorY + 0.3 || y > floorY + 2.2) return;
      if ('scale_0' in off && Math.max(c.readFloatLE(o + off.scale_0), c.readFloatLE(o + off.scale_1), c.readFloatLE(o + off.scale_2)) >= bigLog) return;
      const i = Math.floor((c.readFloatLE(o + off.x) - box[0]) / cell), j = Math.floor((c.readFloatLE(o + off.z) - box[2]) / cell);
      if (i < 0 || j < 0 || i >= W || j >= H) return;
      sum[j * W + i] += 'opacity' in off ? 1 / (1 + Math.exp(-c.readFloatLE(o + off.opacity))) : 1;
    });
  } finally {
    for (const f of files) closeSync(f.fd);
  }
  // Brightness on a square-root scale, with the busiest tenth of the cells saturating.
  const sorted = Float32Array.from(sum).filter((v) => v > 0).sort();
  const ref = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 1;
  const data = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) data[k] = Math.min(255, Math.round(255 * Math.sqrt(sum[k] / ref)));
  return { x0: box[0], z0: box[2], cell, W, H, data };
}
