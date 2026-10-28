// Crop a trained splat (.ply) to the scan area marked in SplatScout: removes everything outside the
// floor outline (plus a margin) and below the floor — e.g. floaters "seen" through windows.
// Works when the splat is in the AR coordinate frame (AR-pose solve, or SfM aligned to the AR poses).

import { openSync, readSync, writeSync, closeSync } from 'node:fs';
import { Bounds } from '../../app/js/core/bounds.js';

const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

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

/**
 * @param {string} src input .ply
 * @param {string} dst output .ply
 * @param {object} boundsData SplatScout manifest "bounds" ({poly, floorY, top, ...})
 * @param {number} [margin] metres kept outside the outline (walls sit on it, splats have size)
 * @returns {{kept:number, removed:number}}
 */
export function cropPly(src, dst, boundsData, margin = 0.5) {
  const b = new Bounds({ ...boundsData, margin, skips: [] });
  if (!b.poly) throw new Error('No scan-area outline');
  const fd = openSync(src, 'r');
  try {
    const { header, dataStart, count, stride, off } = readHeader(fd);
    const per = Math.max(1, Math.floor((8 << 20) / stride));
    const chunk = Buffer.alloc(per * stride);
    const keep = new Uint8Array(count);
    let kept = 0;
    const floor = b.floorY - 0.4, top = b.top == null ? Infinity : b.top + 0.4;
    for (let i = 0; i < count; i += per) {
      const m = Math.min(per, count - i);
      readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
      for (let j = 0; j < m; j++) {
        const o = j * stride;
        const x = chunk.readFloatLE(o + off.x), y = chunk.readFloatLE(o + off.y), z = chunk.readFloatLE(o + off.z);
        if (y >= floor && y <= top && b.inArea(x, b.floorY, z)) {
          keep[i + j] = 1;
          kept++;
        }
      }
    }
    const out = openSync(dst, 'w');
    try {
      writeSync(out, Buffer.from(header.replace(/element vertex \d+/, `element vertex ${kept}`), 'latin1'));
      const outBuf = Buffer.alloc(per * stride);
      for (let i = 0; i < count; i += per) {
        const m = Math.min(per, count - i);
        readSync(fd, chunk, 0, m * stride, dataStart + i * stride);
        let w = 0;
        for (let j = 0; j < m; j++) {
          if (!keep[i + j]) continue;
          chunk.copy(outBuf, w * stride, j * stride, (j + 1) * stride);
          w++;
        }
        if (w) writeSync(out, outBuf, 0, w * stride);
      }
    } finally {
      closeSync(out);
    }
    return { kept, removed: count - kept };
  } finally {
    closeSync(fd);
  }
}
