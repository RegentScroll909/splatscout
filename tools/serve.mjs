// Minimal static server for local testing: node tools/serve.mjs [port]
// The camera and AR need a secure context: http://localhost works on this PC, and on an
// Android phone connected by USB you can forward the port:  adb reverse tcp:8080 tcp:8080
// then open http://localhost:8080 in Chrome on the phone.

import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const port = Number(process.argv[2]) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Optional for testing exports: `--save-uploads DIR` accepts PUT /__upload?name=x.zip from this machine.
const saveIdx = process.argv.indexOf('--save-uploads');
const uploadDir = saveIdx > 0 ? process.argv[saveIdx + 1] : null;

createServer(async (req, res) => {
  if (uploadDir && req.method === 'PUT' && req.url.startsWith('/__upload') && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    const name = basename(new URL(req.url, 'http://x').searchParams.get('name') || 'upload.bin');
    await mkdir(uploadDir, { recursive: true });
    const out = createWriteStream(join(uploadDir, name));
    req.pipe(out);
    out.on('finish', () => res.writeHead(200).end('saved ' + name));
    out.on('error', (e) => res.writeHead(500).end(String(e)));
    return;
  }
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`SplatScout dev server: http://localhost:${port}`));
