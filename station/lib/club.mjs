// Club beta, PC side: bring the photos phones sent onto this PC, check them, award points, run missions,
// invites and members, and turn the accepted photos of a room into a capture for the usual pipeline.
// Talks to the club's Supabase project with the secret key (see crowd.mjs and crowd/supabase-beta.sql).
// Photos that are accepted stay on this PC; rejected ones are deleted at once (they may show people).

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { call, listAll, deleteUpload } from './crowd.mjs';
import { analyzeImage } from '../../app/js/core/analyzer.js';
import { ZipWriter } from '../../app/js/core/zip.js';
import { distanceTo } from '../../app/js/data/campus.js';
import { dhash, hamming, NEAR_DUPLICATE, photoChecks, scorePhoto, lightSlot, phoenixDay, POINTS, validHandle } from '../../app/js/core/clubrules.js';

const BUCKET = 'club-photos';
const run = promisify(execFile);
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const inList = (ids) => `in.(${ids.join(',')})`;

// ------------------------------------------------------------------------------------ local copies
export function clubDir(workDir) {
  const d = join(workDir, 'club');
  for (const s of ['photos', 'thumbs']) mkdirSync(join(d, s), { recursive: true });
  return d;
}
export const photoFile = (dir, id) => join(dir, 'photos', id + '.jpg');
export const thumbFile = (dir, id) => join(dir, 'thumbs', id + '.jpg');
const indexFile = (dir) => join(dir, 'index.json');

/** What was measured when each photo was downloaded: {id: {w, h, sharp, mean, clipHi, texture, phash, bytes}}. */
export function loadIndex(dir) {
  try {
    return JSON.parse(readFileSync(indexFile(dir), 'utf8'));
  } catch {
    return {};
  }
}
const saveIndex = (dir, idx) => writeFileSync(indexFile(dir), JSON.stringify(idx));

/** Decode a photo to a 640-wide grayscale picture with ffmpeg, and read its real size. */
async function decodeGray(ffmpeg, file, W = 640) {
  const { stdout, stderr } = await run(ffmpeg, ['-hide_banner', '-v', 'info', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:-2,format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 });
  const m = /Video:[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr.toString('latin1'));
  const gray = new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length);
  return { gray, w: W, h: Math.floor(gray.length / W), srcW: m ? +m[1] : 0, srcH: m ? +m[2] : 0 };
}

/** Measure a downloaded photo the same way the phone did (sharpness, light, hash), plus its real size. */
export async function measure(ffmpeg, file) {
  const g = await decodeGray(ffmpeg, file);
  const a = analyzeImage(g.gray, g.w, g.h);
  return { w: g.srcW || g.w, h: g.srcH || g.h, sharp: +a.sharp.toFixed(2), mean: +a.mean.toFixed(1), clipHi: +a.clipHi.toFixed(3), texture: +a.texture.toFixed(3), phash: dhash(g.gray, g.w, g.h) };
}

const makeThumb = (ffmpeg, src, dst) => run(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vf', 'scale=360:-2', '-q:v', '5', dst]);

// ------------------------------------------------------------------------------------ syncing
/**
 * Download new photos (and measure them), so reviewing and building work from local copies.
 * @returns {Promise<{total:number, downloaded:number, failed:number}>}
 */
export async function sync(c, cfg, { say = () => {}, onProgress = () => {} } = {}) {
  const ffmpeg = cfg.tools && cfg.tools.ffmpeg;
  if (!ffmpeg) throw new Error('ffmpeg was not found: it is needed to check the photos. Set tools.ffmpeg in station.config.json.');
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir);
  const rows = await listAll(c, '/rest/v1/photos?select=id,storage_path&status=in.(new,accepted)&file_removed=eq.false');
  const todo = rows.filter((r) => !(idx[r.id] && existsSync(photoFile(dir, r.id))));
  let next = 0, downloaded = 0, failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      try {
        const resp = await call(c, `/storage/v1/object/${BUCKET}/${r.storage_path}`, { raw: true });
        const buf = Buffer.from(await resp.arrayBuffer());
        const file = photoFile(dir, r.id);
        writeFileSync(file, buf);
        idx[r.id] = { ...(await measure(ffmpeg, file)), bytes: buf.length };
        await makeThumb(ffmpeg, file, thumbFile(dir, r.id));
        downloaded++;
      } catch (e) {
        failed++;
        say(`Club photo ${r.id.slice(0, 8)}: ${String(e.message).split('\n')[0]}`);
      }
      onProgress((downloaded + failed) / todo.length, `${downloaded + failed}/${todo.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  saveIndex(dir, idx);
  return { total: rows.length, downloaded, failed };
}

// ------------------------------------------------------------------------------------ checking
/** The time a photo was taken, trusting the phone's clock only when it's believable. */
export function effectiveTaken(p) {
  const t = Date.parse(p.taken_at), c = Date.parse(p.created_at);
  return !t || t > c + 10 * 60e3 || t < c - 3 * 864e5 ? c : t;
}
export const effectiveLight = (p) => lightSlot(effectiveTaken(p));
const placeKey = (p) => [p.building_code, p.floor, p.room].join('|').toLowerCase();

/**
 * A first opinion on each new photo, for a human to confirm.
 * @param {object[]} rows photo rows
 * @param {object} idx local measurements by photo id
 * @param {Map} buildings ASU buildings by code (for the GPS sanity check)
 * @returns {Map<string, {level: 'accept'|'review'|'reject', reasons: string[]}>}
 */
export function autoVerdicts(rows, idx, buildings = new Map()) {
  // Sharpness is judged against the same outing: the 75th percentile of that session's photos.
  const bySession = new Map();
  for (const r of rows) if (idx[r.id] && r.session) (bySession.get(r.session) || bySession.set(r.session, []).get(r.session)).push(idx[r.id].sharp);
  const refOf = (s) => {
    const v = (bySession.get(s) || []).sort((a, b) => a - b);
    return v.length >= 6 ? v[Math.floor(v.length * 0.75)] : null;
  };
  const sameRoom = new Map();
  for (const r of rows) if (idx[r.id]) (sameRoom.get(placeKey(r)) || sameRoom.set(placeKey(r), []).get(placeKey(r))).push(r);

  const out = new Map();
  for (const r of rows) {
    const m = idx[r.id];
    if (!m) {
      out.set(r.id, { level: 'review', reasons: ['not downloaded yet'] });
      continue;
    }
    const ref = refOf(r.session);
    const pc = photoChecks({ w: m.w, h: m.h, mean: m.mean, clipHi: m.clipHi, rel: ref ? Math.min(1.2, m.sharp / ref) : null });
    const reasons = [...pc.reasons];
    let level = pc.level === 'ok' ? 'accept' : pc.level;
    const raise = (to, why) => {
      reasons.push(why);
      if (to === 'reject' || (to === 'review' && level === 'accept')) level = to;
    };
    for (const o of sameRoom.get(placeKey(r)) || []) {
      if (o.id === r.id) continue;
      const d = hamming(idx[o.id].phash, m.phash);
      if (o.user_id === r.user_id && d <= NEAR_DUPLICATE && (o.status === 'accepted' || o.created_at < r.created_at)) raise('reject', 'near-duplicate of their other photo');
      else if (o.user_id !== r.user_id && d <= 2) raise('review', 'almost identical to another member’s photo');
    }
    const b = buildings.get(r.building_code);
    if (b && r.lat != null && r.gps_accuracy_m != null && r.gps_accuracy_m <= 100) {
      const d = distanceTo(b, r.lat, r.lon);
      if (d > Math.max(150, 3 * r.gps_accuracy_m)) raise('review', `GPS puts it ${Math.round(d)} m from the building`);
    }
    const t = Date.parse(r.taken_at), cr = Date.parse(r.created_at);
    if (t > cr + 10 * 60e3 || t < cr - 3 * 864e5) raise('review', 'the phone’s clock looks wrong');
    if (b && b.restricted) raise('reject', 'restricted building');
    out.set(r.id, { level, reasons });
  }
  return out;
}

// ------------------------------------------------------------------------------------ points
/**
 * Points for photos about to be accepted, given the ones already accepted: the first photo of a room,
 * the first in each light slot, a mission's bonus, and the daily limit on base points.
 * @returns {{id: string, points: number, note: string}[]}
 */
export function planAwards(toAccept, accepted, missions = new Map()) {
  const rooms = new Set(accepted.map(placeKey));
  const lights = new Set(accepted.map((p) => placeKey(p) + '|' + effectiveLight(p)));
  const used = new Map();
  const dayKey = (p) => p.user_id + '|' + phoenixDay(effectiveTaken(p));
  for (const p of accepted) used.set(dayKey(p), (used.get(dayKey(p)) || 0) + 1);
  const out = [];
  for (const p of [...toAccept].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    const light = effectiveLight(p), k = placeKey(p), n = used.get(dayKey(p)) || 0;
    const m = p.mission_id ? missions.get(p.mission_id) : null;
    const s = scorePhoto({
      firstInRoom: !rooms.has(k), newLight: !lights.has(k + '|' + light), mission: m ? { bonus: m.bonus, light: m.light } : null,
      light, baseLeft: Math.max(0, POINTS.dailyBase - n * POINTS.photo),
    });
    rooms.add(k);
    lights.add(k + '|' + light);
    used.set(dayKey(p), n + 1);
    out.push({ id: p.id, points: s.points, note: s.parts.filter((x) => x[1]).map(([l, v]) => `${l} +${v}`).join(' · ') });
  }
  return out;
}

// ------------------------------------------------------------------------------------ reviewing
const SELECT = 'id,user_id,created_at,taken_at,building_code,building_name,floor,room,session,mission_id,lat,lon,gps_accuracy_m,width,height,bytes,device,camera,light,status,points,review_note,reviewed_at,storage_path,file_removed';

/** Everything the review page shows: photos still to review plus accepted ones, with first opinions. */
export async function reviewList(c, cfg, buildings = new Map()) {
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir);
  const [rows, profiles, missions] = await Promise.all([
    listAll(c, `/rest/v1/photos?select=${SELECT}&status=in.(new,accepted)&order=created_at.asc`),
    listAll(c, '/rest/v1/profiles?select=user_id,handle'),
    listAll(c, '/rest/v1/missions?select=id,title'),
  ]);
  const handle = new Map(profiles.map((p) => [p.user_id, p.handle]));
  const mission = new Map(missions.map((m) => [m.id, m.title]));
  const verdicts = autoVerdicts(rows, idx, buildings);
  return rows.map((r) => ({
    ...r, handle: handle.get(r.user_id) || '?', mission: r.mission_id ? mission.get(r.mission_id) || null : null,
    lightSlot: effectiveLight(r), local: !!idx[r.id], meta: idx[r.id] || null, verdict: r.status === 'new' ? verdicts.get(r.id) : null,
  }));
}

/**
 * Accept, reject or reopen photos. Accepting awards points; rejecting deletes the photo (here and in the
 * club database), because a rejected photo may well show a person.
 * @param {{ids: string[], action: 'accept'|'reject'|'reopen', note?: string}} o
 */
export async function review(c, cfg, { ids, action, note = '' }) {
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir), now = new Date().toISOString();
  const rows = [];
  for (const part of chunks(ids, 50)) rows.push(...(await call(c, `/rest/v1/photos?select=${SELECT}&id=${inList(part)}`)));
  const patch = (list, body) => Promise.all(chunks(list.map((r) => r.id), 50).map((part) => call(c, `/rest/v1/photos?id=${inList(part)}`, { method: 'PATCH', body, headers: { Prefer: 'return=minimal' } })));

  if (action === 'accept') {
    const todo = rows.filter((r) => r.status === 'new');
    if (!todo.length) return { changed: 0 };
    const [accepted, missions] = await Promise.all([
      listAll(c, '/rest/v1/photos?select=id,user_id,created_at,taken_at,building_code,floor,room&status=eq.accepted'),
      listAll(c, '/rest/v1/missions?select=id,bonus,light'),
    ]);
    const plan = planAwards(todo, accepted, new Map(missions.map((m) => [m.id, m])));
    const groups = new Map(); // same points and note: one request
    for (const p of plan) (groups.get(`${p.points}|${p.note}`) || groups.set(`${p.points}|${p.note}`, { points: p.points, note: p.note, ids: [] }).get(`${p.points}|${p.note}`)).ids.push(p.id);
    for (const g of groups.values()) await patch(g.ids.map((id) => ({ id })), { status: 'accepted', points: g.points, review_note: g.note || null, reviewed_at: now });
    return { changed: plan.length, points: plan.reduce((s, p) => s + p.points, 0) };
  }
  if (action === 'reject') {
    const todo = rows.filter((r) => r.status === 'new' || r.status === 'accepted');
    const files = todo.filter((r) => !r.file_removed).map((r) => r.storage_path);
    for (const part of chunks(files, 100)) await call(c, `/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: part } });
    await patch(todo, { status: 'rejected', points: 0, review_note: note || null, reviewed_at: now, file_removed: true });
    for (const r of todo) {
      rmSync(photoFile(dir, r.id), { force: true });
      rmSync(thumbFile(dir, r.id), { force: true });
      delete idx[r.id];
    }
    saveIndex(dir, idx);
    return { changed: todo.length };
  }
  if (action === 'reopen') {
    const todo = rows.filter((r) => r.status === 'accepted');
    await patch(todo, { status: 'new', points: 0, review_note: null, reviewed_at: null });
    return { changed: todo.length };
  }
  throw new Error('Unknown action');
}

/** Delete the cloud copies of photos already reviewed and kept here: frees the free plan's 1 GB. */
export async function freeCloud(c, cfg) {
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir);
  const rows = (await listAll(c, '/rest/v1/photos?select=id,storage_path&status=eq.accepted&file_removed=eq.false')).filter((r) => idx[r.id] && existsSync(photoFile(dir, r.id)));
  let bytes = 0;
  for (const part of chunks(rows, 100)) {
    await call(c, `/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: part.map((r) => r.storage_path) } });
    await call(c, `/rest/v1/photos?id=${inList(part.map((r) => r.id))}`, { method: 'PATCH', body: { file_removed: true }, headers: { Prefer: 'return=minimal' } });
    bytes += part.reduce((s, r) => s + (idx[r.id].bytes || 0), 0);
  }
  return { photos: rows.length, bytes };
}

// ------------------------------------------------------------------------------------ missions
const LIGHTS = ['any', 'morning', 'afternoon', 'evening', 'night'];

export const listMissions = (c) => listAll(c, '/rest/v1/missions?select=*&order=created_at.desc');

export async function createMission(c, m) {
  const body = {
    title: String(m.title || '').trim(), detail: String(m.detail || '').trim().slice(0, 400),
    building_code: m.building_code || null, floor: String(m.floor || '').trim().slice(0, 20), room: String(m.room || '').trim().slice(0, 80),
    light: LIGHTS.includes(m.light) ? m.light : 'any', bonus: Math.max(0, Math.min(50, Math.round(+m.bonus || 0))), wanted: Math.max(1, Math.min(5000, Math.round(+m.wanted || 20))),
    ends_at: m.ends_at || null,
  };
  if (body.title.length < 3 || body.title.length > 80) throw new Error('Give the mission a title of 3 to 80 characters');
  const [row] = await call(c, '/rest/v1/missions', { method: 'POST', body, headers: { Prefer: 'return=representation' } });
  return row;
}

export const updateMission = (c, id, patch) => call(c, `/rest/v1/missions?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: { active: !!patch.active }, headers: { Prefer: 'return=minimal' } });
export const deleteMission = (c, id) => call(c, `/rest/v1/missions?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

// ------------------------------------------------------------------------------------ invites and members
export const listInvites = (c) => listAll(c, '/rest/v1/invites?select=*&order=created_at.desc');

/** A new invite code like CLUB-7K3PQ2 (no look-alike characters; 6 characters, too many to guess), good for `max_uses` joins. */
export async function createInvite(c, { label = '', max_uses = 25 } = {}) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let tries = 0; tries < 5; tries++) {
    const code = 'CLUB-' + Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    try {
      const [row] = await call(c, '/rest/v1/invites', { method: 'POST', body: { code, label: String(label).slice(0, 60), max_uses: Math.max(1, Math.min(10000, Math.round(+max_uses || 25))) }, headers: { Prefer: 'return=representation' } });
      return row;
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message)) throw e;
    }
  }
  throw new Error('Could not make an unused code, try again');
}

export const setInviteActive = (c, code, active) => call(c, `/rest/v1/invites?code=eq.${encodeURIComponent(code)}`, { method: 'PATCH', body: { active: !!active }, headers: { Prefer: 'return=minimal' } });

export async function listMembers(c) {
  const [profiles, board] = await Promise.all([listAll(c, '/rest/v1/profiles?select=*&order=created_at.desc'), call(c, '/rest/v1/leaderboard?select=handle,points,photos,scans')]);
  const pts = new Map(board.map((r) => [r.handle.toLowerCase(), r]));
  return profiles.map((p) => ({ ...p, ...(pts.get(p.handle.toLowerCase()) || { points: 0, photos: 0, scans: 0 }) }));
}

/** Rename or pause a member. */
export async function setMember(c, userId, { handle, banned }) {
  const body = {};
  if (handle != null) {
    if (!validHandle(handle)) throw new Error('A handle is 3 to 20 letters, numbers or underscores');
    body.handle = handle;
  }
  if (banned != null) body.banned = !!banned;
  await call(c, `/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', body, headers: { Prefer: 'return=minimal' } });
}

/** Remove a member and everything they sent (on request): files and rows in the cloud, copies here, profile. */
export async function purgeMember(c, cfg, userId) {
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir);
  const uid = encodeURIComponent(userId);
  const photos = await listAll(c, `/rest/v1/photos?select=id,storage_path,file_removed&user_id=eq.${uid}`);
  for (const part of chunks(photos.filter((p) => !p.file_removed), 100)) await call(c, `/storage/v1/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: part.map((p) => p.storage_path) } });
  for (const p of photos) {
    rmSync(photoFile(dir, p.id), { force: true });
    rmSync(thumbFile(dir, p.id), { force: true });
    delete idx[p.id];
  }
  saveIndex(dir, idx);
  await call(c, `/rest/v1/photos?user_id=eq.${uid}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  for (const cap of await listAll(c, `/rest/v1/captures?select=id&user_id=eq.${uid}`)) await deleteUpload(c, cap.id);
  await call(c, `/rest/v1/profiles?user_id=eq.${uid}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { photos: photos.length };
}

// ------------------------------------------------------------------------------------ restricted places
export const listRestricted = (c) => listAll(c, '/rest/v1/restricted_buildings?select=code,reason&order=code.asc');

export async function setRestricted(c, code, reason) {
  if (reason) await call(c, '/rest/v1/restricted_buildings', { method: 'POST', body: { code, reason }, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  else await call(c, `/rest/v1/restricted_buildings?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

/** Put every building the list marks as restricted into the club database (where it is enforced). */
export async function syncRestricted(c, buildings) {
  const rows = [...buildings.values()].filter((b) => b.restricted).map((b) => ({ code: b.code, reason: b.restricted }));
  for (const part of chunks(rows, 100)) await call(c, '/rest/v1/restricted_buildings', { method: 'POST', body: part, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  return rows.length;
}

// ------------------------------------------------------------------------------------ photos → a capture
const slug = (s) => (s || '').trim().replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'capture';
const LENS_FOV = 68; // degrees across the long side: a phone's main camera

/**
 * Put the accepted photos of one room into a ZIP in the inbox, like a camera-mode capture without AR
 * positions, so the usual pipeline can make a splat from them. Photos from one phone in one orientation
 * share a camera; otherwise COLMAP works out each photo's lens by itself.
 */
export async function buildCapture(c, cfg, { building_code, floor = '', room = '' }, inbox, version = '2.5.0') {
  const dir = clubDir(cfg.workDir), idx = loadIndex(dir);
  const [rows, profiles] = await Promise.all([
    listAll(c, `/rest/v1/photos?select=${SELECT}&status=eq.accepted&building_code=eq.${encodeURIComponent(building_code)}&floor=eq.${encodeURIComponent(floor)}&room=eq.${encodeURIComponent(room)}`),
    listAll(c, '/rest/v1/profiles?select=user_id,handle'),
  ]);
  const have = rows.filter((r) => idx[r.id] && existsSync(photoFile(dir, r.id)));
  if (have.length < 10) throw new Error(`Only ${have.length} accepted photos of this room are on this PC (sync first); at least 10 are needed, 100 or more make a good splat.`);
  have.sort((a, b) => (a.session || '').localeCompare(b.session || '') || effectiveTaken(a) - effectiveTaken(b));
  const handle = new Map(profiles.map((p) => [p.user_id, p.handle]));

  const cams = new Set(have.map((r) => `${r.device}|${idx[r.id].w}x${idx[r.id].h}`));
  const intr = (m) => {
    const f = Math.max(m.w, m.h) / 2 / Math.tan((LENS_FOV / 2) * (Math.PI / 180));
    return { w: m.w, h: m.h, fx: +f.toFixed(2), fy: +f.toFixed(2), cx: m.w / 2, cy: m.h / 2 };
  };
  const names = have.map((_, i) => `${String(i + 1).padStart(4, '0')}.jpg`);
  const first = have[0];
  const day = new Date(effectiveTaken(first) - 7 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${slug(first.building_name)}_${slug(room || 'photos')}_${day}_club-photos`;
  const manifest = {
    app: 'SplatScout club photos', version, exportedAt: new Date().toISOString(),
    capture: { building: first.building_name, buildingCode: building_code, room, floor, tracking: 'none', engine: 'club-photos', createdAt: new Date(effectiveTaken(first)).toISOString(), author: null,
      notes: `${have.length} single photos from ${new Set(have.map((r) => r.user_id)).size} contributor(s), in ${new Set(have.map((r) => r.session)).size} outing(s)` },
    club: { contributors: [...new Set(have.map((r) => handle.get(r.user_id) || '?'))], lightSlots: [...new Set(have.map(effectiveLight))], photos: have.map((r) => r.id) },
    frames: have.map((r, i) => ({ file: `images/${names[i]}`, seq: i + 1, session: r.session, pass: 'club', takenAt: new Date(effectiveTaken(r)).toISOString(), light: effectiveLight(r), device: r.device,
      // A camera model is only offered when every photo can share it (same phone, same orientation).
      ...(cams.size === 1 ? { intrinsics: intr(idx[r.id]) } : {}) })),
  };
  const zip = new ZipWriter();
  for (let i = 0; i < have.length; i++) await zip.add(`${base}/images/${names[i]}`, readFileSync(photoFile(dir, have[i].id)));
  await zip.add(`${base}/splatscout.json`, JSON.stringify(manifest, null, 1));
  const dest = join(inbox, base + '.zip'), tmp = join(inbox, '.club-' + base + '.zip');
  try {
    await pipeline(Readable.fromWeb(zip.finish().stream()), createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { file: dest, photos: have.length, contributors: manifest.club.contributors, sharedCamera: cams.size === 1, lightSlots: manifest.club.lightSlots };
}
