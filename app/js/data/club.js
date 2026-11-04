// The club (beta): who you are in it, the leaderboard and missions, and leaving. Talks to the same
// Supabase project as crowd.js (see crowd/supabase-beta.sql). You join with an invite code and a handle;
// without that, the database accepts no uploads at all.

import { api, why, listObjects, removeObjects } from './crowd.js';
import { CONSENT_VERSION } from '../core/clubrules.js';

const KEY = 'splatscout-club-profile';
let profile; // undefined: not asked yet; null: not a member

/** The profile as last seen (works offline); null if never joined on this phone. */
export function cachedProfile() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function remember(p) {
  profile = p;
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {}
}

/** {handle, consent_version, banned, created_at}, or null if this phone hasn't joined. Throws offline. */
export async function myProfile({ fresh = false } = {}) {
  if (profile !== undefined && !fresh) return profile;
  const r = await api('/rest/v1/profiles?select=handle,consent_version,banned,created_at&limit=1');
  if (!r.ok) throw new Error(why(r));
  remember(r.body[0] || null);
  return profile;
}

/** Join with a handle and an invite code (the rules were agreed to on screen). Throws with a readable message. */
export async function join(handle, code) {
  const r = await api('/rest/v1/rpc/join_club', { method: 'POST', body: { p_handle: handle.trim(), p_code: code.trim(), p_consent: CONSENT_VERSION } });
  if (!r.ok) throw new Error(why(r));
  remember(r.body);
  return r.body;
}

const list = async (path) => {
  const r = await api(path);
  if (!r.ok) throw new Error(why(r));
  return r.body;
};

/** [{handle, points, photos, scans}] best first; period 'all' or 'week'. */
export const leaderboard = (period = 'all') => list(`/rest/v1/${period === 'week' ? 'leaderboard_week' : 'leaderboard'}?select=handle,points,photos,scans`);

/** Open missions: [{id, title, detail, building_code, floor, room, light, bonus, wanted, ends_at, done}]. */
export const missions = () => list('/rest/v1/missions_open?select=*');

/** Buildings the club doesn't photograph, as a Map code -> reason (the database enforces it). */
export async function restrictedCodes() {
  return new Map((await list('/rest/v1/restricted_buildings?select=code,reason')).map((r) => [r.code, r.reason]));
}

/** Your photos as the club database has them (status, points, review note). */
export const myPhotos = () => list('/rest/v1/photos?select=id,status,points,review_note,building_name,room,created_at,mission_id&order=created_at.desc&limit=300');

/**
 * Leave the club and delete everything you sent: photos and their files, scans and theirs, then the
 * profile. Files go first: a phone can only delete a file while its row still exists. 3D models the
 * club already built from your photos are not touched (the consent text says so).
 */
export async function leave(onProgress = () => {}) {
  onProgress('Removing your photos…');
  for (;;) {
    const rows = await list('/rest/v1/photos?select=id,storage_path,file_removed&limit=200');
    if (!rows.length) break;
    await removeObjects('club-photos', rows.filter((p) => !p.file_removed).map((p) => p.storage_path));
    const del = await api(`/rest/v1/photos?id=in.(${rows.map((p) => p.id).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error(why(del));
  }
  onProgress('Removing your scans…');
  for (const c of await list('/rest/v1/captures?select=id,storage_prefix')) {
    await removeObjects('captures', await listObjects('captures', c.storage_prefix));
    const del = await api(`/rest/v1/captures?id=eq.${c.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!del.ok) throw new Error(why(del));
  }
  onProgress('Leaving the club…');
  const gone = await api('/rest/v1/profiles?user_id=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!gone.ok) throw new Error(why(gone));
  remember(null);
}
