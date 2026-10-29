// SplatStation: turns SplatScout captures (or phone videos) into Gaussian splats on this PC.
//
//   node station/station.mjs            (or double-click start-station.cmd)
//
// Then open http://localhost:8787. Drop captures in the inbox folder, upload them from the
// dashboard (also from a phone on the same Wi-Fi), or plug the phone in over USB and pick them.
// New captures wait until you press Process (unless automatic processing is switched on).

import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, extname, normalize, basename, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { loadConfig, saveConfig, PRESETS } from './lib/config.mjs';
import { processJob, STAGES, sourceKind, guessNames } from './lib/pipeline.mjs';
import { killTree, capture } from './lib/run.mjs';
import { PhoneImporter } from './lib/adb.mjs';
import { readZipText } from './lib/zipread.mjs';
import { walkInputs, walkMapFor } from './lib/walkmap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, 'web');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const cfg = loadConfig(args.dir ? { workDir: args.dir } : {});
if (args.port) cfg.port = +args.port;

// ------------------------------------------------------------------------------------ jobs
const JOBS_FILE = join(cfg.workDir, 'jobs.json');
let jobs = existsSync(JOBS_FILE) ? JSON.parse(readFileSync(JOBS_FILE, 'utf8')) : [];
for (const j of jobs) if (j.status === 'running') j.status = 'interrupted';
const clients = new Set();
const log = [];
let current = null; // {job, token}
let queuePaused = false; // finish the running job, then start nothing new

function saveJobs() {
  writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 1));
}

function publicJob(j) {
  const { dir, token, ...rest } = j;
  return rest;
}

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let saveTimer = null;
function changed(job) {
  broadcast('job', publicJob(job));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveJobs, 500);
}

function say(text, job) {
  const entry = { t: Date.now(), text, job: job ? job.id : null };
  log.push(entry);
  if (log.length > 300) log.shift();
  if (job) {
    job.messages = job.messages || [];
    job.messages.push({ t: entry.t, text });
    if (job.messages.length > 80) job.messages.shift();
    changed(job);
  }
  broadcast('log', entry);
  console.log(`[${new Date().toLocaleTimeString()}] ${job ? `(${job.room || job.id}) ` : ''}${text}`);
}

/**
 * Register a capture. It waits for "Process" unless asked to start (opts.process) or automatic
 * processing is on.
 */
function newJob(file, opts = {}) {
  const kind = sourceKind(file);
  if (!kind) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = join(cfg.dirs.jobs, id);
  mkdirSync(join(dir, 'source'), { recursive: true });
  const dest = join(dir, 'source', basename(file));
  renameSync(file, dest);
  const names = guessNames(file);
  const start = opts.process != null ? opts.process : !!cfg.autoProcess;
  const job = {
    id, dir, created: Date.now(), status: start ? 'queued' : 'waiting', order: Date.now(), preset: opts.preset || cfg.preset,
    source: { kind, file: dest, name: basename(file), size: statSync(dest).size },
    building: names.building, room: names.room,
    stages: Object.fromEntries(STAGES.map((s) => [s.id, { p: 0, note: '' }])), messages: [],
  };
  jobs.unshift(job);
  changed(job);
  say(start ? `Queued ${basename(file)} (${PRESETS[job.preset].label}).` : `Received ${basename(file)}. It waits until you press Process.`, job);
  inspectSource(job);
  pump();
  return job;
}

/** What's in a SplatScout ZIP (photos, grade, scan area), shown before processing. */
async function inspectSource(job) {
  if (job.source.kind !== 'zip') return;
  try {
    const txt = await readZipText(job.source.file, 'splatscout.json');
    if (!txt) return;
    const m = JSON.parse(txt);
    const c = m.capture || {};
    const frames = m.frames || [];
    job.building = c.building || job.building;
    job.room = c.room || job.room;
    const left = m.selection && m.selection.left ? Object.values(m.selection.left).reduce((a, b) => a + b, 0) : 0;
    job.summary = {
      photos: frames.length,
      posed: frames.filter((f) => f.tracked && f.pose).length,
      sessions: new Set(frames.map((f) => f.segment)).size,
      maps: new Set(frames.filter((f) => f.tracked).map((f) => (f.space != null ? f.space : f.segment))).size,
      grade: m.score ? m.score.grade : null,
      score: m.score ? m.score.score : null,
      area: !!(m.bounds && m.bounds.poly),
      engine: c.engine || null,
      author: c.author || null,
      capturedAt: c.createdAt || null,
      app: m.version || null,
      left,
    };
    changed(job);
  } catch {}
}

async function pump() {
  if (current || queuePaused) return;
  const job = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.order ?? a.created) - (b.order ?? b.created))[0];
  if (!job) return;
  const token = { cancelled: false, child: null };
  current = { job, token };
  job.status = 'running';
  job.started = Date.now();
  job.error = null;
  for (const s of STAGES) job.stages[s.id] = { p: 0, note: '' };
  changed(job);
  const ctx = {
    cfg, token,
    update: (patch) => {
      Object.assign(job, patch);
      changed(job);
    },
    stage: (id, p, note) => {
      job.stage = id;
      job.stages[id] = { p: Math.max(0, Math.min(1, p)), note: note != null ? note : (job.stages[id] && job.stages[id].note) || '' };
      // Earlier stages count as done once a later one starts.
      for (const s of STAGES) {
        if (s.id === id) break;
        if (job.stages[s.id].p < 1) job.stages[s.id].p = 1;
      }
      changed(job);
    },
    say: (text) => say(text, job),
  };
  try {
    const result = await processJob(job, ctx);
    job.status = 'done';
    job.result = result;
    job.finished = Date.now();
    say(`Done in ${fmtDur(result.totalSec)}: ${result.info.training.splats ? result.info.training.splats.toLocaleString() + ' splats, ' : ''}${result.info.sizeMB} MB → ${result.folder}`, job);
  } catch (e) {
    job.finished = Date.now();
    if (e.cancelled) {
      job.status = 'cancelled';
      say('Cancelled.', job);
    } else {
      job.status = 'failed';
      job.error = String(e.message || e);
      say('Failed: ' + job.error.split('\n')[0], job);
      console.error(e);
    }
  } finally {
    changed(job);
    saveJobs();
    current = null;
    setTimeout(pump, 200);
  }
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

// ------------------------------------------------------------------------------------ inbox watcher
const sizes = new Map();
function scanInbox() {
  let names = [];
  try {
    names = readdirSync(cfg.dirs.inbox);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith('.') || !sourceKind(name)) continue;
    const file = join(cfg.dirs.inbox, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // Wait until the file stops growing (still being copied).
    if (sizes.get(file) !== st.size) {
      sizes.set(file, st.size);
      continue;
    }
    sizes.delete(file);
    try {
      newJob(file);
    } catch (e) {
      say(`Could not queue ${name}: ${e.message}`);
    }
  }
}
setInterval(scanInbox, 2500);

const phone = new PhoneImporter(cfg, () => scanInbox(), (t) => say(t), () => broadcast('phone', phone.status));
phone.start();

// ------------------------------------------------------------------------------------ GPU monitor
let gpu = { name: null };
async function pollGpu() {
  const smi = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\nvidia-smi.exe`;
  if (!existsSync(smi)) return;
  try {
    const { stdout } = await capture(smi, ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
    const [name, util, used, total, temp] = stdout.trim().split(',').map((s) => s.trim());
    gpu = { name, util: +util, memUsed: +used, memTotal: +total, temp: +temp };
    broadcast('gpu', gpu);
  } catch {}
}
pollGpu();
setInterval(pollGpu, 3000);

// ------------------------------------------------------------------------------------ HTTP
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ply': 'application/octet-stream', '.ico': 'image/x-icon',
};

function lanUrls() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${cfg.port}`);
  }
  return out;
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(res, file, req) {
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!st.isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = +range[1], end = range[2] ? +range[2] : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
    createReadStream(file).pipe(res);
  }
}

/** Resolve a URL path under a root folder, refusing anything that escapes it. */
function under(root, rel) {
  const p = normalize(join(root, decodeURIComponent(rel)));
  return p === root || p.startsWith(root + sep) ? p : null;
}

function library() {
  const out = [];
  const root = cfg.dirs.library;
  for (const b of safeDirs(root)) {
    for (const r of safeDirs(join(root, b))) {
      for (const s of safeDirs(join(root, b, r))) {
        const folder = join(root, b, r, s);
        if (!existsSync(join(folder, 'scene.ply'))) continue;
        let info = {};
        try {
          info = JSON.parse(readFileSync(join(folder, 'info.json'), 'utf8'));
        } catch {}
        out.push({ building: b, room: r, stamp: s, path: `${b}/${r}/${s}`, info, hasThumb: existsSync(join(folder, 'thumb.jpg')) });
      }
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

function safeDirs(d) {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name);
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    // ---------- API
    if (path === '/api/status') {
      return sendJson(res, {
        tools: Object.fromEntries(Object.entries(cfg.tools).map(([k, v]) => [k, v ? basename(v) : null])),
        workDir: cfg.workDir, inbox: cfg.dirs.inbox, library: cfg.dirs.library,
        preset: cfg.preset, presets: PRESETS, usePoses: cfg.usePoses, cropToBounds: cfg.cropToBounds !== false, adbAutoImport: cfg.adbAutoImport,
        phoneAutoImport: !!cfg.phoneAutoImport, autoProcess: !!cfg.autoProcess, queuePaused,
        lan: lanUrls(), gpu, phone: phone.status, running: current ? current.job.id : null,
      });
    }
    if (path === '/api/jobs') return sendJson(res, jobs.map(publicJob));
    if (path === '/api/library') return sendJson(res, library());
    if (path === '/api/walkmap') {
      // Where you can walk in a splat (viewer's walk mode). ?ply=<the viewer's /files/… URL>&up=x,y,z
      const ply = url.searchParams.get('ply') || '';
      const up = (url.searchParams.get('up') || '').split(',').map(Number);
      let file = null, job = null, info = null, jm;
      if ((jm = /^\/files\/jobs\/(\w+)\/(.+)$/.exec(ply))) {
        job = jobs.find((j) => j.id === jm[1]);
        file = job && under(job.dir, jm[2]);
      } else if (ply.startsWith('/files/library/')) {
        file = under(cfg.dirs.library, ply.slice('/files/library/'.length));
        try {
          info = JSON.parse(readFileSync(join(dirname(file), 'info.json'), 'utf8'));
        } catch {}
        job = info && jobs.find((j) => j.id === info.jobId);
      }
      if (!file || !/\.ply$/i.test(file) || !existsSync(file)) return sendJson(res, { error: 'Splat not found' }, 404);
      const mode = (info && info.colmap && info.colmap.mode) || (job && job.colmap && job.colmap.mode) || null;
      const pano = !!((info && info.pano) || (job && job.pano));
      const inputs = walkInputs({ jobDir: job && job.dir, mode, view: info && info.view, up: up.length === 3 && up.every(Number.isFinite) ? up : null, pano });
      try {
        return sendJson(res, await walkMapFor(file, inputs));
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 422);
      }
    }
    if (path === '/api/log') return sendJson(res, log.slice(-100));
    if (path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.preset && PRESETS[b.preset]) cfg.preset = b.preset;
      if (typeof b.usePoses === 'boolean') cfg.usePoses = b.usePoses;
      if (typeof b.cropToBounds === 'boolean') cfg.cropToBounds = b.cropToBounds;
      if (typeof b.adbAutoImport === 'boolean') cfg.adbAutoImport = b.adbAutoImport;
      if (typeof b.phoneAutoImport === 'boolean') cfg.phoneAutoImport = b.phoneAutoImport;
      if (typeof b.autoProcess === 'boolean') cfg.autoProcess = b.autoProcess;
      saveConfig(cfg);
      if (b.adbAutoImport || b.phoneAutoImport) phone.check().catch(() => {});
      return sendJson(res, { ok: true });
    }
    if (path === '/api/phone') return sendJson(res, phone.status);
    if (path === '/api/phone/refresh' && req.method === 'POST') {
      await phone.check().catch(() => {});
      return sendJson(res, phone.status);
    }
    if (path === '/api/phone/import' && req.method === 'POST') {
      const b = await readBody(req);
      const names = Array.isArray(b.names) ? b.names.filter((n) => typeof n === 'string') : [];
      try {
        const n = await phone.importFiles(names);
        return sendJson(res, { ok: true, imported: n });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 409);
      }
    }
    if (path === '/api/queue' && req.method === 'POST') {
      const b = await readBody(req);
      if (typeof b.paused === 'boolean') queuePaused = b.paused;
      broadcast('queue', { paused: queuePaused });
      pump();
      return sendJson(res, { ok: true, paused: queuePaused });
    }
    if (path === '/api/process-all' && req.method === 'POST') {
      let n = 0;
      for (const j of jobs.slice().reverse()) {
        if (j.status !== 'waiting') continue;
        j.status = 'queued';
        j.order = Date.now() + n++;
        changed(j);
      }
      pump();
      return sendJson(res, { ok: true, queued: n });
    }
    if (path === '/api/upload' && req.method === 'POST') {
      const name = basename(url.searchParams.get('name') || 'upload.zip').replace(/[^\w.\- ()]/g, '_');
      if (!sourceKind(name)) return sendJson(res, { error: 'Send a SplatScout .zip or a video file.' }, 400);
      const tmp = join(cfg.dirs.inbox, '.upload-' + Date.now() + '-' + name);
      const out = createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => {
        const final = join(cfg.dirs.inbox, '.ready-' + name);
        renameSync(tmp, final);
        const dest = join(cfg.dirs.inbox, name);
        const p = url.searchParams.get('process');
        const job = newJob(renameAndReturn(final, dest), { preset: url.searchParams.get('preset') || undefined, process: p == null ? undefined : p === '1' });
        sendJson(res, { ok: true, job: job && job.id });
      });
      out.on('error', (e) => sendJson(res, { error: String(e) }, 500));
      return;
    }
    let m;
    if ((m = /^\/api\/jobs\/(\w+)\/(cancel|retry|delete|preset|process|hold|next)$/.exec(path)) && req.method === 'POST') {
      const job = jobs.find((j) => j.id === m[1]);
      if (!job) return sendJson(res, { error: 'no such job' }, 404);
      if (m[2] === 'cancel') {
        if (current && current.job === job) {
          current.token.cancelled = true;
          killTree(current.token.child);
        } else if (job.status === 'queued') {
          job.status = 'waiting';
          changed(job);
        }
      } else if (m[2] === 'process') {
        // Start (or redo) with the options chosen on the card.
        if (job.status !== 'running' && job.status !== 'queued') {
          const b = await readBody(req);
          if (b.preset && PRESETS[b.preset]) job.preset = b.preset;
          if (typeof b.usePoses === 'boolean') job.usePoses = b.usePoses;
          if (typeof b.crop === 'boolean') job.crop = b.crop;
          job.status = 'queued';
          job.order = Date.now();
          job.error = null;
          changed(job);
          say(`Queued (${PRESETS[job.preset].label}).`, job);
          pump();
        }
      } else if (m[2] === 'hold') {
        if (job.status === 'queued') {
          job.status = 'waiting';
          changed(job);
        }
      } else if (m[2] === 'next') {
        if (job.status === 'queued') {
          job.order = Math.min(...jobs.filter((j) => j.status === 'queued').map((j) => j.order ?? j.created)) - 1;
          changed(job);
        }
      } else if (m[2] === 'retry') {
        if (job.status !== 'running') {
          const b = await readBody(req);
          if (b.preset && PRESETS[b.preset]) job.preset = b.preset;
          job.status = 'queued';
          job.error = null;
          changed(job);
          pump();
        }
      } else if (m[2] === 'delete') {
        if (job.status === 'running') return sendJson(res, { error: 'Cancel it first' }, 409);
        jobs = jobs.filter((j) => j !== job);
        rmSync(job.dir, { recursive: true, force: true });
        broadcast('removed', { id: job.id });
        saveJobs();
      }
      return sendJson(res, { ok: true });
    }
    // ---------- files
    if ((m = /^\/files\/jobs\/(\w+)\/(.+)$/.exec(path))) {
      const job = jobs.find((j) => j.id === m[1]);
      const f = job && under(job.dir, m[2]);
      return f ? sendFile(res, f, req) : res.writeHead(404).end();
    }
    if (path.startsWith('/files/library/')) {
      const f = under(cfg.dirs.library, path.slice('/files/library/'.length));
      return f ? sendFile(res, f, req) : res.writeHead(404).end();
    }
    if (path === '/api/open' && req.method === 'POST') {
      // Open a library folder in Explorer (only from this PC).
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const b = await readBody(req);
      const f = b.path && under(cfg.dirs.library, b.path);
      if (local && f && existsSync(f)) {
        const { spawn } = await import('node:child_process');
        spawn('explorer.exe', [f], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, { ok: true });
      }
      return sendJson(res, { error: 'not allowed' }, 403);
    }
    // ---------- web UI
    const file = under(WEB, path === '/' ? 'index.html' : path.slice(1));
    if (file && existsSync(file) && statSync(file).isFile()) return sendFile(res, file, req);
    res.writeHead(404).end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, { error: String(e.message || e) }, 500);
  }
});

function renameAndReturn(from, to) {
  let dest = to;
  for (let i = 2; existsSync(dest); i++) dest = to.replace(/(\.\w+)$/, `_${i}$1`);
  renameSync(from, dest);
  return dest;
}

server.listen(cfg.port, () => {
  console.log('\n  SplatStation is running');
  console.log(`  Dashboard:  http://localhost:${cfg.port}`);
  for (const u of lanUrls()) console.log(`  From phone: ${u}   (same Wi-Fi)`);
  console.log(`  Inbox:      ${cfg.dirs.inbox}`);
  console.log(`  Library:    ${cfg.dirs.library}`);
  console.log(`  COLMAP:     ${cfg.tools.colmap || 'NOT FOUND'}`);
  console.log(`  Brush:      ${cfg.tools.brush || 'NOT FOUND'}`);
  console.log(`  adb:        ${cfg.tools.adb || 'not found (USB auto-import off)'}\n`);
  scanInbox();
  pump();
});
