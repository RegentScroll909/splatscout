// Club uploads: send a capture (the export's photos and metadata, file by file) to the club's
// Supabase project, filed as <building>/<floor-room>/<capture id>/, so captures from many phones
// build up one dataset for SplatStation to process. Set up with crowd/supabase-setup.sql.
//
// Each phone signs in anonymously (no account). The database lets a phone add, finish and delete
// only its own uploads; reviewing and downloading them needs SplatStation's secret key.
// Uploads resume where they stopped: files already sent are skipped.

import { placeSlug } from './campus.js';

// Public by design: the database rules decide what this key may do.
export const CROWD = {
  url: 'https://xxxcdeeekufcjrhbkrll.supabase.co',
  key: 'sb_publishable_b0Lka-jfdOkaaDZ4TSe6zw_xi-GQrsV',
  bucket: 'captures',
};
const SESSION_KEY = 'splatscout-crowd-session';

// ------------------------------------------------------------------------------- sign-in
let current = null, sessionReq = null;

async function auth(path, body) {
  const r = await fetch(`${CROWD.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: CROWD.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) return { error: j.msg || j.error_description || j.message || `sign-in failed (${r.status})` };
  return { access_token: j.access_token, refresh_token: j.refresh_token, user: j.user && j.user.id, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
}

/** This phone's anonymous sign-in, refreshed when it runs out (kept so it can delete its uploads later). */
function session() {
  const valid = (s) => s && s.expires_at - 120 > Date.now() / 1000;
  if (valid(current)) return Promise.resolve(current);
  if (sessionReq) return sessionReq;
  sessionReq = (async () => {
    let s = current;
    try {
      s = s || JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch {}
    if (valid(s)) return (current = s);
    let fresh = s && s.refresh_token ? await auth('token?grant_type=refresh_token', { refresh_token: s.refresh_token }) : null;
    if (!fresh || fresh.error) fresh = await auth('signup', { data: {} });
    if (fresh.error) throw new Error('Could not reach the club database: ' + fresh.error);
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
    } catch {}
    return (current = fresh);
  })().finally(() => (sessionReq = null));
  return sessionReq;
}

export async function api(path, { method = 'GET', body, type = 'application/json', headers = {} } = {}) {
  const s = await session();
  const r = await fetch(CROWD.url + path, {
    method,
    headers: { apikey: CROWD.key, Authorization: `Bearer ${s.access_token}`, ...(body != null ? { 'Content-Type': type } : {}), ...headers },
    body: body == null ? undefined : type === 'application/json' && typeof body !== 'string' ? JSON.stringify(body) : body,
  });
  const text = await r.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: r.ok, status: r.status, body: j, text };
}

export const why = (r) => (r.body && (r.body.message || r.body.error || r.body.msg)) || r.text || `error ${r.status}`;

// ------------------------------------------------------------------------------- uploads
/** The bucket's limit on each file (file_size_limit in crowd/supabase-setup.sql). */
export const FILE_LIMIT = 20 * 1048576;
const sizeOf = (f) => (typeof f.data === 'string' ? f.data.length : f.data.size ?? f.data.length);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * The export as the club gets it. SplatStation reads only the cameras and photos of the COLMAP
 * models (it triangulates its own points), so their points3D.txt goes without its points: on a big
 * scan it outgrows the bucket's limit. The same points are in poses/points.ply, which is left out
 * only when it is too big itself. Anything else over the limit stops the upload before it starts.
 */
export function forClub(files) {
  const out = [];
  for (const f of files) {
    if (/(^|\/)colmap\/sparse\/0\/points3D\.txt$/.test(f.name) && typeof f.data === 'string') {
      const head = f.data.split('\n').filter((l) => l.startsWith('#')).join('\n');
      out.push({ ...f, data: `${head}\n# (points left out of the club upload: they are in poses/points.ply)\n` });
      continue;
    }
    if (sizeOf(f) <= FILE_LIMIT) out.push(f);
    else if (f.name !== 'poses/points.ply') {
      throw Object.assign(new Error(`${f.name} is ${mb(sizeOf(f))}; the club takes files up to ${mb(FILE_LIMIT)} each.`), { code: 'too-big' });
    }
  }
  return out;
}

/**
 * Upload a capture.
 * @param capture capture record (its .upload keeps the progress, so save it after each call)
 * @param files from exportFiles(): [{name, data, type}]
 * @param tags {buildingCode, buildingName, floor, room, contributor}
 * @param o.save (capture) persist the capture record (called as files finish)
 * @param o.frameIds the photos chosen (kept, so a resumed upload sends the same ones)
 * @param o.onProgress (fraction, label)
 * @param o.signal AbortSignal to stop (resume later)
 */
export async function uploadCapture(capture, files, tags, { save, frameIds = null, onProgress = () => {}, signal } = {}) {
  files = forClub(files);
  const prefix = `${tags.buildingCode}/${placeSlug(tags.floor, tags.room)}`;
  let up = capture.upload;
  // An unfinished upload filed somewhere else (the tags changed): remove it and start again.
  if (up && up.status === 'uploading' && !up.prefix.startsWith(prefix + '/')) {
    await deleteUpload(capture).catch(() => {});
    up = null;
  }
  if (!up || up.status !== 'uploading') {
    const id = crypto.randomUUID();
    up = capture.upload = { id, prefix: `${prefix}/${id}`, status: 'uploading', sent: [], started: Date.now(), tags, frameIds };
    await save(capture);
  }
  const manifest = files.find((f) => f.name === 'splatscout.json');
  const geo = capture.geo || {};
  const row = {
    id: up.id,
    building_code: tags.buildingCode,
    building_name: tags.buildingName,
    floor: tags.floor || '',
    room: tags.room || '',
    storage_prefix: up.prefix,
    lat: geo.lat ?? null,
    lon: geo.lon ?? null,
    gps_accuracy_m: geo.acc ?? null,
    photo_count: files.filter((f) => f.name.startsWith('images/')).length,
    grade: capture.score ? capture.score.grade : null,
    mode: capture.engine,
    device: navigator.userAgent.slice(0, 200),
    contributor: (tags.contributor || '').slice(0, 60) || null,
    manifest: manifest ? JSON.parse(manifest.data) : null,
    status: 'uploading',
  };
  let r = await api('/rest/v1/captures', { method: 'POST', body: row, headers: { Prefer: 'return=minimal' } });
  if (!r.ok && r.status !== 409) {
    // Row-level security: not a member (or banned), or a building the club doesn't photograph.
    if (/row-level security/i.test(why(r))) throw Object.assign(new Error('The club database refused this upload: join the club first, and check the building isn’t a restricted one.'), { code: 'refused' });
    throw new Error('The club database refused the capture: ' + why(r));
  }

  // Files, a few at a time; the list of everything sent goes last so SplatStation knows it's whole.
  const sent = new Set(up.sent);
  const todo = files.filter((f) => !sent.has(f.name));
  const size = sizeOf;
  const total = files.reduce((s, f) => s + size(f), 0);
  let done = files.filter((f) => sent.has(f.name)).reduce((s, f) => s + size(f), 0);
  const report = () => onProgress(done / total, `Sent ${sent.size} of ${files.length} files · ${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB`);
  report();
  let next = 0, lastSave = 0, failed = null;
  const worker = async () => {
    // Stops at the first failure (or pause); the others finish the file they're on, then stop too.
    while (next < todo.length && !failed) {
      if (signal && signal.aborted) {
        failed = new Error('Upload paused');
        break;
      }
      const f = todo[next++];
      try {
        await putFile(`${up.prefix}/${f.name}`, f.data, f.type);
      } catch (e) {
        failed = failed || e;
        break;
      }
      sent.add(f.name);
      done += size(f);
      report();
      if (Date.now() - lastSave > 2000) {
        lastSave = Date.now();
        up.sent = [...sent];
        await save(capture);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  up.sent = [...sent];
  await save(capture);
  if (failed) throw failed;
  const list = { capture: up.id, files: files.map((f) => ({ name: f.name, size: size(f) })) };
  await putFile(`${up.prefix}/upload.json`, JSON.stringify(list), 'application/json');

  r = await api(`/rest/v1/captures?id=eq.${up.id}`, { method: 'PATCH', body: { status: 'new' }, headers: { Prefer: 'return=minimal' } });
  if (!r.ok) throw new Error('Could not finish the upload: ' + why(r));
  Object.assign(up, { status: 'done', finished: Date.now(), files: [...list.files.map((f) => f.name), 'upload.json'] });
  delete up.sent;
  delete up.frameIds;
  await save(capture);
  return up;
}

/** One file, retried a few times on a bad connection. Already there (an earlier try) counts as sent. */
async function putFile(path, data, type) {
  for (let k = 0; ; k++) {
    let r;
    try {
      r = await api(`/storage/v1/object/${CROWD.bucket}/${path}`, { method: 'POST', body: data, type: type || 'application/octet-stream' });
    } catch (e) {
      r = { ok: false, status: 0, text: e.message };
    }
    if (r.ok) return;
    const dup = r.status === 409 || /exists|duplicate/i.test(r.text || '');
    if (dup) return;
    if (r.status === 400 || r.status === 403 || r.status === 413 || r.status === 415 || k >= 3) throw new Error(`Could not upload ${path.split('/').slice(3).join('/')}: ${why(r)}`);
    await new Promise((res) => setTimeout(res, 1500 * (k + 1)));
  }
}

/** Remove this phone's upload of a capture from the club database (files, then the row). */
export async function deleteUpload(capture) {
  const up = capture.upload;
  if (!up) return;
  const names = up.files || [...(up.sent || []), 'upload.json'];
  for (let i = 0; i < names.length; i += 100) {
    const r = await api(`/storage/v1/object/${CROWD.bucket}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 100).map((n) => `${up.prefix}/${n}`) } });
    if (!r.ok) throw new Error('Could not delete the photos: ' + why(r));
  }
  const r = await api(`/rest/v1/captures?id=eq.${up.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!r.ok) throw new Error('Could not delete the upload: ' + why(r));
}

/** Where this phone's uploads stand on the server: {id: status}. */
export async function myUploads() {
  const r = await api('/rest/v1/captures?select=id,status');
  if (!r.ok) throw new Error(why(r));
  return Object.fromEntries(r.body.map((x) => [x.id, x.status]));
}

/** Every file under a folder of a storage bucket (listing goes down into sub-folders). */
export async function listObjects(bucket, prefix) {
  const names = [];
  const walk = async (dir) => {
    for (let offset = 0; ; offset += 1000) {
      const r = await api(`/storage/v1/object/list/${bucket}`, { method: 'POST', body: { prefix: dir, limit: 1000, offset } });
      if (!r.ok) throw new Error(why(r));
      for (const it of r.body) {
        if (it.id) names.push(`${dir}/${it.name}`);
        else await walk(`${dir}/${it.name}`);
      }
      if (r.body.length < 1000) break;
    }
  };
  await walk(prefix);
  return names;
}

/** Delete files from a storage bucket (up to 100 per request). */
export async function removeObjects(bucket, names) {
  for (let i = 0; i < names.length; i += 100) {
    const r = await api(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: names.slice(i, i + 100) } });
    if (!r.ok) throw new Error(why(r));
  }
}
