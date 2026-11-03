// Club uploads: captures phones sent to the club's Supabase project (see crowd/supabase-setup.sql).
// SplatStation lists them by building, and imports one by downloading its files into an ordinary
// SplatScout ZIP in the inbox, where it waits to be processed like any other capture.
//
// Reading everyone's uploads needs the project's secret key. It stays on this PC, in
// <workDir>/crowd.json: {"url": "https://<project>.supabase.co", "secretKey": "sb_secret_..."}.

import { existsSync, readFileSync, createWriteStream, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipWriter } from '../../app/js/core/zip.js';

const BUCKET = 'captures';
const COLUMNS = 'id,created_at,building_code,building_name,floor,room,photo_count,grade,mode,contributor,status,gps_accuracy_m,storage_prefix';

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
  if (!/^https:\/\/[\w.-]+$/.test(url)) return { error: `Put the project URL ("url") in ${file}.`, file };
  if (!key) return { error: `Paste the project's secret key ("secretKey", from Supabase → Project Settings → API Keys) into ${file}.`, file };
  if (key.startsWith('sb_publishable_')) return { error: `${file} has the publishable key; SplatStation needs the secret key (sb_secret_…).`, file };
  return { url, key };
}

async function call(c, path, { method = 'GET', body, headers = {}, raw = false } = {}) {
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
  if (!r.ok) throw new Error((j && (j.message || j.error || j.msg)) || text || `error ${r.status}`);
  return j;
}

/** Uploads, newest first (not the ones rejected). */
export async function listUploads(c) {
  return call(c, `/rest/v1/captures?select=${COLUMNS}&status=neq.rejected&order=created_at.desc&limit=500`);
}

export async function setStatus(c, id, status) {
  await call(c, `/rest/v1/captures?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: { status }, headers: { Prefer: 'return=minimal' } });
}

const slug = (s) => (s || '').trim().replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'capture';

/**
 * Download an upload into the inbox as a SplatScout ZIP (filed under the building, floor and room
 * it was uploaded as) and mark it approved. Returns the ZIP's path.
 * @param onProgress (fraction, text)
 */
export async function importUpload(c, id, inbox, onProgress = () => {}) {
  const [row] = await call(c, `/rest/v1/captures?select=${COLUMNS}&id=eq.${encodeURIComponent(id)}`);
  if (!row) throw new Error('That upload is no longer in the club database');
  if (row.status === 'uploading') throw new Error('That upload hasn’t finished yet (the phone is still sending it, or stopped part way)');
  const file = (name) => `/storage/v1/object/${BUCKET}/${row.storage_prefix}/${name}`;
  const list = await call(c, file('upload.json'));
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
      m.club = { id: row.id, buildingCode: row.building_code, contributor: row.contributor, uploaded: row.created_at };
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
  await setStatus(c, row.id, 'approved');
  return dest;
}

/** Remove an upload for good: its files, then its row (frees the club's storage). */
export async function deleteUpload(c, id) {
  const [row] = await call(c, `/rest/v1/captures?select=${COLUMNS}&id=eq.${encodeURIComponent(id)}`);
  if (!row) return;
  // Every file under its folder, found by listing (an unfinished upload has no file list).
  const names = [];
  const walk = async (dir) => {
    for (let offset = 0; ; offset += 1000) {
      const items = await call(c, `/storage/v1/object/list/${BUCKET}`, { method: 'POST', body: { prefix: dir, limit: 1000, offset } });
      for (const it of items) (it.id ? names.push(`${dir}/${it.name}`) : await walk(`${dir}/${it.name}`));
      if (items.length < 1000) break;
    }
  };
  await walk(row.storage_prefix);
  for (let i = 0; i < names.length; i += 100) {
    await call(c, `/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 100) } });
  }
  await call(c, `/rest/v1/captures?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}
