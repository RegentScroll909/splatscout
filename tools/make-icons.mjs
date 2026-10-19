// Renders the PNG app icons (same design as app/icons/icon.svg) without any dependencies.
// Usage: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];

// Design in 512-unit space.
const BLOBS = [
  { cx: 226, cy: 268, rx: 132, ry: 72, inner: hex('#ffd75a'), outer: hex('#ffc627'), a: 1 },
  { cx: 318, cy: 214, rx: 86, ry: 46, inner: hex('#ff7aa2'), outer: hex('#e0457a'), a: 0.95 },
  { cx: 248, cy: 240, rx: 58, ry: 32, inner: [1, 1, 1], outer: hex('#ffe9b0'), a: 1 },
];
const ROT = (-24 * Math.PI) / 180;
const BG = hex('#8c1d40').map((v) => v * 0.85);

function insideRounded(x, y, r) {
  const cx = Math.min(Math.max(x, r), 512 - r), cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= 0 && y >= 0 && x <= 512 && y <= 512;
}

function bracketDist(x, y) {
  // Distance to the four corner-bracket strokes (straight segments only; rounded joins approximated).
  const segs = [
    [96, 112, 96, 168], [112, 96, 168, 96],
    [344, 96, 400, 96], [416, 112, 416, 168],
    [416, 344, 416, 400], [344, 416, 400, 416],
    [112, 416, 168, 416], [96, 344, 96, 400],
  ];
  let d = Infinity;
  for (const [x0, y0, x1, y1] of segs) {
    const dx = x1 - x0, dy = y1 - y0;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)));
  }
  for (const [cx, cy] of [[112, 112], [400, 112], [400, 400], [112, 400]]) {
    // quarter arcs of radius 16 at each corner
    const r = Math.hypot(x - cx, y - cy);
    const inQuadrant = (cx < 256 ? x <= cx : x >= cx) && (cy < 256 ? y <= cy : y >= cy);
    if (inQuadrant) d = Math.min(d, Math.abs(r - 16));
  }
  return d;
}

function shade(x, y) {
  if (!insideRounded(x, y, 112)) return [0, 0, 0, 0];
  let c = BG.slice();
  // Rotate into blob space around the centre.
  const dx = x - 256, dy = y - 256;
  const bx = 256 + dx * Math.cos(-ROT) - dy * Math.sin(-ROT);
  const by = 256 + dx * Math.sin(-ROT) + dy * Math.cos(-ROT);
  for (const b of BLOBS) {
    const r = Math.hypot((bx - b.cx) / b.rx, (by - b.cy) / b.ry);
    if (r >= 1) continue;
    const g = Math.exp(-4.5 * r * r) * b.a * (1 - r ** 6);
    const col = b.inner.map((v, i) => v + (b.outer[i] - v) * Math.min(1, r * 1.6));
    c = c.map((v, i) => v * (1 - g) + col[i] * g);
  }
  const bd = bracketDist(x, y);
  if (bd < 11) {
    const a = 0.92 * Math.min(1, 11 - bd);
    c = c.map((v) => v * (1 - a) + a);
  }
  return [...c, 1];
}

for (const size of [192, 512]) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 3; // supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = ((x + (sx + 0.5) / S) / size) * 512, py = ((y + (sy + 0.5) / S) / size) * 512;
          const c = shade(px, py);
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const a = acc[3] / (S * S);
      const o = (y * size + x) * 4;
      buf[o] = a ? Math.round((acc[0] / acc[3]) * 255) : 0;
      buf[o + 1] = a ? Math.round((acc[1] / acc[3]) * 255) : 0;
      buf[o + 2] = a ? Math.round((acc[2] / acc[3]) * 255) : 0;
      buf[o + 3] = Math.round(a * 255);
    }
  }
  writeFileSync(join(outDir, `icon-${size}.png`), png(size, size, buf));
  console.log(`icon-${size}.png`);
}
