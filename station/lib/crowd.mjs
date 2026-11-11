// Club uploads: captures phones sent to the club's Supabase project (see crowd/supabase-setup.sql).
// SplatStation lists them by building, and imports one by downloading its files into an ordinary
// SplatScout ZIP in the inbox, where it waits to be processed like any other capture.
//
// Reading everyone's uploads needs the project's secret key. It stays on this PC, in
// <workDir>/crowd.json: {"url": "https://<project>.supabase.co", "secretKey": "sb_secret_..."}.
//
// A scan's files stay in the cloud after it is imported. The club frees them by hand once the scan is
// reviewed (freeUpload: the files go, the row stays, so the member keeps the points); cloudUsage says how
// full the storage is. Nothing here deletes by itself.

import { existsSync, readFileSync, createWriteStream, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipWriter } from '../../app/js/core/zip.js';

const BUCKET = 'captures';
const COLUMNS = 'id,created_at,building_code,building_name,floor,room,photo_count,grade,mode,contributor,status,gps_accuracy_m,storage_prefix';
/** File storage on Supabase's free plan: about 1 GB for the whole project. */
export const CLOUD_LIMIT = 1024 * 1048576;

/** {url, key} from crowd.json, or {error} saying what's missing. */
export function crowdConfig(workDir) {
  const file = join(workDir, 'crowd.json');
  if (!existsSync(file)) return { error: `To see club uploads, create ${file} with the project URL and secret key.`, file };
  let c;
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `${file} isn't valid JSON: ${e.message}`, file };
  }
  const url = (c.url || '').replace(/\/+$/, ''), key = (c.secretKey || '').trim();
  // https only, except a server on this PC (tools/fake-supabase-server.mjs, for trying things out).
  if (!/^(https:\/\/[\w.-]+|http:\/\/(localhost|127\.0\.0\.1):\d+)$/.test(url)) return { error: `Put the project URL ("url") in ${file}.`, file };
  if (!key) return { error: `Paste the project's secret key ("secretKey", from Supabase → Project Settings → API Keys) into ${file}.`, file };
  if (key.startsWith('sb_publishable_')) return { error: `${file} has the publishable key; SplatStation needs the secret key (sb_secret_…).`, file };
  return { url, key };
}

export async function call(c, path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  // New secret keys go in the apikey header only; an old service_role key (a JWT) also as the bearer.
  const auth = c.key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${c.key}` };
  const r = await fetch(c.url + path, {
    method,
    headers: { apikey: c.key, ...auth, ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (raw && r.ok) return r;
  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) throw Object.assign(new Error((j && (j.message || j.error || j.msg)) || text || `error ${r.status}`), { status: r.status });
  return j;
}

/** Every row of a REST query (the server returns at most 1000 at a time). */
export async function listAll(c, path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await call(c, `${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** Uploads, newest first (not the ones rejected). */
export async function listUploads(c) {
  return call(c, `/rest/v1/captures?select=${COLUMNS}&status=neq.rejected&order=created_at.desc&limit=500`);
}

export async function setStatus(c, id, status) {
  await call(c, `/rest/v1/captures?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: { status }, headers: { Prefer: 'return=minimal' } });
}

const slug = (s) => (s || '').trim().replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'capture';

// ------------------------------------------------------------------------------- files in the cloud
/**
 * Every file under a folder of the bucket, sub-folders included: [{name (its full path), size (bytes)}].
 * A folder that isn't there (a scan whose cloud copy was freed) gives none.
 * @param page entries asked for at a time (the server gives at most 1000)
 */
export async function listFiles(c, prefix, page = 1000) {
  const out = [];
  const walk = async (dir) => {
    for (let offset = 0; ; offset += page) {
      const items = await call(c, `/storage/v1/object/list/${BUCKET}`, { method: 'POST', body: { prefix: dir, limit: page, offset } });
      for (const it of items) {
        // A file has an id and its size in metadata; a folder has neither.
        if (it.id) out.push({ name: `${dir}/${it.name}`, size: (it.metadata && +it.metadata.size) || 0 });
        else await walk(`${dir}/${it.name}`);
      }
      if (items.length < page) break;
    }
  };
  await walk(prefix);
  return out;
}

async function removeFiles(c, names) {
  for (let i = 0; i < names.length; i += 100) {
    await call(c, `/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 100) } });
  }
}

const tally = (files) => ({ bytes: files.reduce((s, f) => s + f.size, 0), files: files.length });

// What each scan's files take in the cloud, kept while SplatStation runs: once a scan has finished uploading,
// its files only change when they are freed or deleted here (a phone that removes its scan removes the row
// too). Measurements under way are shared, so two requests don't walk the same folders twice.
const measured = new Map(); // '<project>|<scan id>' -> Promise<{bytes, files}>
const sizeKey = (c, id) => `${c.url}|${id}`;

function measure(c, row, fresh) {
  const key = sizeKey(c, row.id);
  // A scan still being sent grows: measured each time, never kept.
  const keep = row.status !== 'uploading';
  if (keep && !fresh && measured.has(key)) return measured.get(key);
  const p = listFiles(c, row.storage_prefix).then(tally);
  if (keep) {
    measured.set(key, p);
    p.catch(() => measured.get(key) === p && measured.delete(key));
  }
  return p;
}

/**
 * How much of the club's cloud storage the scans take: {bytes, files, limit, scans: {<scan id>: {bytes, files}}}.
 * Every scan counts, also one still being sent; a scan with no files has had its cloud copy freed. Each
 * scan's folder is listed once and remembered (see `measured`); `fresh` lists them all again.
 */
export async function cloudUsage(c, { fresh = false } = {}) {
  const rows = await listAll(c, '/rest/v1/captures?select=id,status,storage_prefix&order=created_at.desc');
  const live = new Set(rows.map((r) => sizeKey(c, r.id)));
  for (const k of [...measured.keys()]) if (k.startsWith(c.url + '|') && !live.has(k)) measured.delete(k);
  // A few scans at a time; the answer lists them newest first whichever finishes first.
  const all = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const i = next++;
      all[i] = await measure(c, rows[i], fresh);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return {
    bytes: all.reduce((s, x) => s + x.bytes, 0), files: all.reduce((s, x) => s + x.files, 0), limit: CLOUD_LIMIT,
    scans: Object.fromEntries(rows.map((r, i) => [r.id, all[i]])),
  };
}

/** Scans the club has decided on: only their cloud copy can be freed. */
const REVIEWED = ['approved', 'rejected'];

/**
 * Free a reviewed scan's cloud copy: delete its files from the bucket and keep its row, so the member keeps
 * the points (the leaderboard adds up approved rows) and the scan's entry in My scans. After this the scan
 * can't be imported again: what this PC has of it is all there is. Never run by itself: the club's reviewer
 * asks for it, scan by scan. Returns what was freed: {files, bytes}.
 */
export async function freeUpload(c, id) {
  const [row] = await call(c, `/rest/v1/captures?select=id,status,storage_prefix&id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new Error('That scan is no longer in the club database');
  if (!REVIEWED.includes(row.status)) {
    throw Object.assign(new Error('Review this scan first (approve it or not): until then its cloud copy is the one SplatStation imports.'), { code: 'not-reviewed' });
  }
  const files = await listFiles(c, row.storage_prefix);
  const key = sizeKey(c, id);
  // The file list goes first: a scan freed only in part then says so when imported, instead of failing on a missing photo.
  const first = `${row.storage_prefix}/upload.json`;
  let left = [];
  try {
    await removeFiles(c, files.map((f) => f.name).sort((a, b) => (b === first) - (a === first)));
    if (files.length) left = await listFiles(c, row.storage_prefix); // looked at again, not assumed gone
  } catch (e) {
    measured.delete(key); // it stopped part way: the next look measures what is left
    throw e;
  }
  measured.set(key, Promise.resolve(tally(left)));
  if (left.length) throw new Error(`${left.length} of this scan’s ${files.length} files are still in the cloud. Try again.`);
  return tally(files);
}

/**
 * Download an upload into the inbox as a SplatScout ZIP (filed under the building, floor and room it was
 * uploaded as) and mark it 'processed': SplatStation has it, and the member sees it as being built and
 * reviewed. Points come later, when the club approves the splat. Returns the ZIP's path.
 * @param onProgress (fraction, text)
 */
export async function importUpload(c, id, inbox, onProgress = () => {}) {
  const [row] = await call(c, `/rest/v1/captures?select=${COLUMNS}&id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new Error('That upload is no longer in the club database');
  if (row.status === 'uploading') throw new Error('That upload hasn’t finished yet (the phone is still sending it, or stopped part way)');
  const file = (name) => `/storage/v1/object/${BUCKET}/${row.storage_prefix}/${name}`;
  let list;
  try {
    list = await call(c, file('upload.json'));
  } catch (e) {
    // No file list. If the folder is empty, the scan's cloud copy was freed (Club page): say that, not "Object not found".
    const left = await listFiles(c, row.storage_prefix).catch(() => null);
    if (left && !left.length) {
      throw Object.assign(new Error('That scan has no files in the club’s cloud storage any more (its cloud copy was freed), so it can’t be imported again. Its entry and points are kept.'), { code: 'no-cloud-copy' });
    }
    if (left && !left.some((f) => f.name === `${row.storage_prefix}/upload.json`)) {
      throw Object.assign(new Error(`That scan’s cloud copy isn’t whole (its file list is gone and ${left.length} file${left.length === 1 ? ' is' : 's are'} left: freeing it may have stopped part way), so it can’t be imported. Free cloud copy on the Club page removes the rest.`), { code: 'no-cloud-copy' });
    }
    throw e;
  }
  const total = list.files.reduce((s, f) => s + (f.size || 0), 0);
  const date = row.created_at.slice(0, 10).replace(/-/g, '');
  const base = `${slug(row.building_name)}_${slug(row.room)}_${date}_club-${row.id.slice(0, 8)}`;

  // Downloaded a few at a time, kept in order so the ZIP matches the phone's own export.
  const got = new Array(list.files.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < list.files.length) {
      const i = next++, f = list.files[i];
      const r = await call(c, file(f.name), { raw: true });
      got[i] = new Uint8Array(await r.arrayBuffer());
      done += got[i].length;
      onProgress(done / (total || 1), `Downloading ${i + 1}/${list.files.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  const zip = new ZipWriter();
  for (let i = 0; i < list.files.length; i++) {
    let data = got[i];
    if (list.files[i].name === 'splatscout.json') {
      // File it under the building name everyone shares (the phone may have typed it differently).
      const m = JSON.parse(Buffer.from(data).toString('utf8'));
      m.capture = { ...m.capture, typedBuilding: m.capture.building, building: row.building_name, floor: row.floor, room: row.room };
      m.club = { id: row.id, buildingCode: row.building_code, contributor: row.contributor, uploaded: row.created_at, grade: row.grade || null };
      data = JSON.stringify(m, null, 1);
    }
    await zip.add(`${base}/${list.files[i].name}`, data);
  }
  // Written under a dot name (the inbox ignores those), then renamed in one go.
  const dest = join(inbox, base + '.zip'), tmp = join(inbox, '.club-' + base + '.zip');
  try {
    await pipeline(Readable.fromWeb(zip.finish().stream()), createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  if (row.status === 'new') await setStatus(c, row.id, 'processed');
  return dest;
}

/**
 * Remove an upload for good: its files, then its row. The row is the member's points and their entry in
 * My scans, so to make room for a scan that was reviewed, free its cloud copy instead (freeUpload).
 */
export async function deleteUpload(c, id) {
  const [row] = await call(c, `/rest/v1/captures?select=${COLUMNS}&id=eq.${encodeURIComponent(id)}`);
  if (!row) return;
  // Every file under its folder, found by listing (an unfinished upload has no file list).
  await removeFiles(c, (await listFiles(c, row.storage_prefix)).map((f) => f.name));
  await call(c, `/rest/v1/captures?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}
