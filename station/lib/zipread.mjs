// Minimal streaming ZIP reader (STORE and DEFLATE), enough for SplatScout exports and
// typical phone/OS zips. Reads the central directory, then extracts entries one at a time
// without loading the archive into memory.

import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export async function listZip(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    // End of central directory: search the last 64 KB.
    const tail = Math.min(size, 65557);
    const buf = Buffer.alloc(tail);
    await fh.read(buf, 0, tail, size - tail);
    let eocd = -1;
    for (let i = tail - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');
    let count = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);
    // ZIP64
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const locIdx = eocd - 20;
      if (locIdx >= 0 && buf.readUInt32LE(locIdx) === 0x07064b50) {
        const z64Off = Number(buf.readBigUInt64LE(locIdx + 8));
        const z = Buffer.alloc(56);
        await fh.read(z, 0, 56, z64Off);
        count = Number(z.readBigUInt64LE(32));
        cdSize = Number(z.readBigUInt64LE(40));
        cdOffset = Number(z.readBigUInt64LE(48));
      }
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      // ZIP64 extra field
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (local === 0xffffffff) { local = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + sz;
      }
      entries.push({ name, method, csize, usize, local, dir: name.endsWith('/') });
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

async function dataOffset(fh, entry) {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, entry.local);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt ZIP local header for ' + entry.name);
  return entry.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

/**
 * Extract all entries into `dest`. `strip` removes a common top-level folder (SplatScout zips
 * contain one folder named after the capture). Refuses paths that escape `dest`.
 */
export async function extractZip(file, dest, { strip = true, onProgress } = {}) {
  const entries = await listZip(file);
  let prefix = '';
  if (strip) {
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    if (tops.size === 1 && entries.some((e) => e.name.includes('/'))) prefix = [...tops][0] + '/';
  }
  const fh = await open(file, 'r');
  const root = normalize(dest);
  let done = 0;
  try {
    for (const e of entries) {
      done++;
      if (e.dir) continue;
      const rel = e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name;
      if (!rel) continue;
      const out = normalize(join(root, rel));
      if (!out.startsWith(root + sep)) throw new Error('Unsafe path in ZIP: ' + e.name);
      await mkdir(dirname(out), { recursive: true });
      const start = await dataOffset(fh, e);
      if (e.csize === 0) {
        await (await open(out, 'w')).close();
      } else {
        const rs = createReadStream(file, { start, end: start + e.csize - 1 });
        if (e.method === 0) await pipeline(rs, createWriteStream(out));
        else if (e.method === 8) await pipeline(rs, createInflateRaw(), createWriteStream(out));
        else throw new Error(`Unsupported ZIP compression (method ${e.method}) for ${e.name}`);
      }
      if (onProgress && done % 25 === 0) onProgress(done / entries.length);
    }
  } finally {
    await fh.close();
  }
  return { entries: entries.length, prefix };
}

/** Read one small entry as text, or null. */
export async function readZipText(file, name) {
  const entries = await listZip(file);
  const e = entries.find((x) => x.name === name || x.name.endsWith('/' + name));
  if (!e) return null;
  const fh = await open(file, 'r');
  try {
    const start = await dataOffset(fh, e);
    const buf = Buffer.alloc(e.csize);
    await fh.read(buf, 0, e.csize, start);
    if (e.method === 0) return buf.toString('utf8');
    const { inflateRawSync } = await import('node:zlib');
    return inflateRawSync(buf).toString('utf8');
  } finally {
    await fh.close();
  }
}
