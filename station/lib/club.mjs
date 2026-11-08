// Club beta, PC side: the scans members send, the club's review of the splats built from them (approving
// one awards its points and puts it on the campus map), missions, invites, members and off-limits places.
// Talks to the club's Supabase project with the secret key (see crowd.mjs, crowd/supabase-beta.sql and
// supabase-scans-only.sql). The club takes full scans only; single photos were retired.

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { call, listAll, deleteUpload } from './crowd.mjs';
import { validHandle } from '../../app/js/core/clubrules.js';

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
/** Errors from a club database that hasn't had supabase-scans-only.sql: no review notes yet. */
const noNotes = (e) => /review_note/.test(e.message);

// ------------------------------------------------------------------------------------ scans
const SCAN_COLS = 'id,user_id,created_at,building_code,building_name,floor,room,photo_count,grade,status,points,reviewed_at,contributor,lat,lon,gps_accuracy_m';

/** Every scan members sent (not those still uploading), newest first, with the sender's handle. */
export async function listScans(c) {
  const rows = await listAll(c, `/rest/v1/captures?select=${SCAN_COLS},review_note&status=neq.uploading&order=created_at.desc`)
    .catch((e) => (noNotes(e) ? listAll(c, `/rest/v1/captures?select=${SCAN_COLS}&status=neq.uploading&order=created_at.desc`) : Promise.reject(e)));
  const handles = new Map((await listAll(c, '/rest/v1/profiles?select=user_id,handle')).map((p) => [p.user_id, p.handle]));
  return rows.map((r) => ({ review_note: null, ...r, handle: handles.get(r.user_id) || r.contributor || 'former member' }));
}

async function patchScan(c, id, body) {
  const send = (b) => call(c, `/rest/v1/captures?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: b, headers: { Prefer: 'return=minimal' } });
  try {
    await send(body);
  } catch (e) {
    if (!noNotes(e)) throw e;
    const { review_note, ...rest } = body;
    await send(rest);
  }
}

/** Approve a scan: its points go to the member (the leaderboard counts approved scans). */
export const approveScan = (c, id, points) =>
  patchScan(c, id, { status: 'approved', points: Math.max(0, Math.min(1000, Math.round(points))), reviewed_at: new Date().toISOString(), review_note: null });

/** Don't approve a scan; the note tells the member why (people in view, too blurry, ...). */
export const rejectScan = (c, id, note = '') =>
  patchScan(c, id, { status: 'rejected', points: 0, reviewed_at: new Date().toISOString(), review_note: String(note || '').trim().slice(0, 400) || null });

/**
 * The club's verdict on a splat, kept in its info.json: {status: 'approved'|'rejected', at, points, parts, note}.
 * Only approved club splats go on the campus map (splats made on this PC from your own scans always do).
 * @param {string} dir the splat's library folder
 */
export function setReview(dir, review) {
  const f = join(dir, 'info.json');
  if (!existsSync(f)) return null;
  const info = JSON.parse(readFileSync(f, 'utf8'));
  info.review = review ? { ...review, at: review.at || new Date().toISOString() } : undefined;
  writeFileSync(f, JSON.stringify(info, null, 2));
  return info.review || null;
}

// ------------------------------------------------------------------------------------ missions
const LIGHTS = ['any', 'morning', 'afternoon', 'evening', 'night'];

export const listMissions = (c) => listAll(c, '/rest/v1/missions?select=*&order=created_at.desc');

/** A mission: "scan this space" (optionally in one kind of light), worth `bonus` points when a scan of it is approved. */
export async function createMission(c, m) {
  const body = {
    title: String(m.title || '').trim(), detail: String(m.detail || '').trim().slice(0, 400),
    building_code: m.building_code || null, floor: String(m.floor || '').trim().slice(0, 20), room: String(m.room || '').trim().slice(0, 80),
    light: LIGHTS.includes(m.light) ? m.light : 'any', bonus: Math.max(0, Math.min(50, Math.round(+m.bonus || 0))), wanted: 1,
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
  const [profiles, board] = await Promise.all([listAll(c, '/rest/v1/profiles?select=*&order=created_at.desc'), call(c, '/rest/v1/leaderboard?select=handle,points,scans')]);
  const pts = new Map(board.map((r) => [r.handle.toLowerCase(), r]));
  return profiles.map((p) => ({ ...p, ...(pts.get(p.handle.toLowerCase()) || { points: 0, scans: 0 }) }));
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

/**
 * Remove a member and everything they sent (on request): their scans' files and rows in the cloud, any single
 * photos from before the club took scans only (and this PC's copies of them), and the profile.
 */
export async function purgeMember(c, cfg, userId) {
  const uid = encodeURIComponent(userId);
  const photos = await listAll(c, `/rest/v1/photos?select=id,storage_path,file_removed&user_id=eq.${uid}`);
  for (const part of chunks(photos.filter((p) => !p.file_removed), 100)) await call(c, '/storage/v1/object/club-photos', { method: 'DELETE', body: { prefixes: part.map((p) => p.storage_path) } });
  for (const p of photos) for (const sub of ['photos', 'thumbs']) rmSync(join(cfg.workDir, 'club', sub, p.id + '.jpg'), { force: true });
  if (photos.length) await call(c, `/rest/v1/photos?user_id=eq.${uid}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  const scans = await listAll(c, `/rest/v1/captures?select=id&user_id=eq.${uid}`);
  for (const cap of scans) await deleteUpload(c, cap.id);
  await call(c, `/rest/v1/profiles?user_id=eq.${uid}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return { photos: photos.length, scans: scans.length };
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
