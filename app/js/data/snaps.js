// Single photos for the club: kept on the phone the moment they're taken, then sent in the background
// (works offline: the queue resumes when there's a connection). Each photo goes up in three small steps,
// each safe to repeat: a database row, the file, then marking it finished. Once sent, only a thumbnail
// stays on the phone.

import * as realStore from './store.js';
import * as club from './club.js';
import { api, why } from './crowd.js';
import { placeSlug } from './campus.js';

let store = realStore;
/** For tests: use another on-phone database (putSnap, getSnap, listSnaps, deleteSnap) instead of IndexedDB. */
export function useStore(s) {
  store = s;
}

const subs = new Set();
/** Call fn(status) whenever the queue changes; returns an unsubscribe function. */
export const subscribe = (fn) => (subs.add(fn), () => subs.delete(fn));

const st = { running: false, blocked: null, lastError: null };
const emit = () => subs.forEach((fn) => { try { fn({ ...st }); } catch {} });
export const status = () => ({ ...st });

const PENDING = new Set(['queued', 'row', 'file']);
let timer = 0;

/** (Re)start sending soon. Safe to call any time. */
export function kick(delay = 0) {
  clearTimeout(timer);
  timer = setTimeout(pump, delay);
  if (timer.unref) timer.unref(); // (Node, in the self-checks) a pending retry must not keep the process alive
}

/** Save a photo on the phone and start sending it. */
export async function saveSnap(rec) {
  await store.putSnap({ state: 'queued', ...rec });
  emit();
  kick();
}

/** Counts for the screens: waiting to send, failed, sent (waiting for review), accepted, rejected. */
export async function counts() {
  const all = await store.listSnaps();
  const c = { all: all.length, waiting: 0, failed: 0, sent: 0, accepted: 0, rejected: 0, points: 0 };
  for (const s of all) {
    if (PENDING.has(s.state)) c.waiting++;
    else if (s.state === 'failed') c.failed++;
    else if (s.serverStatus === 'accepted') (c.accepted++, (c.points += s.points || 0));
    else if (s.serverStatus === 'rejected') c.rejected++;
    else c.sent++;
  }
  return c;
}

export async function listSnaps() {
  return (await store.listSnaps()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Try a failed photo again. */
export async function retry(id) {
  const s = await store.getSnap(id);
  if (!s || s.state !== 'failed') return;
  await store.putSnap({ ...s, state: s.resume || 'queued', error: null });
  emit();
  kick();
}

/** Drop a photo from this phone (and, if it was part way up, from the club database). */
export async function remove(id) {
  const s = await store.getSnap(id);
  await store.deleteSnap(id);
  if (s && s.state !== 'queued') {
    // Best effort: a half-sent upload shouldn't linger on the server.
    api(`/storage/v1/object/club-photos`, { method: 'DELETE', body: { prefixes: [pathOf(s)] } })
      .then(() => api(`/rest/v1/photos?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }))
      .catch(() => {});
  }
  emit();
}

/** Copy the club's verdicts (accepted, points, notes) onto the photos kept here. */
export async function refreshStatuses() {
  const rows = await club.myPhotos();
  const by = new Map(rows.map((r) => [r.id, r]));
  for (const s of await store.listSnaps()) {
    const r = by.get(s.id);
    if (r && (s.serverStatus !== r.status || s.points !== r.points || s.note !== r.review_note)) {
      await store.putSnap({ ...s, serverStatus: r.status, points: r.points, note: r.review_note });
    }
  }
  emit();
  return rows;
}

const pathOf = (s) => `${s.building.code}/${placeSlug(s.floor, s.room)}/${s.id}.jpg`;

/** An error a retry can't fix (the database said no) is fatal; a dropped connection or a busy server isn't. */
function failure(r, what) {
  const msg = why(r);
  const e = new Error(/row-level security/i.test(msg) ? 'Refused: not a member, a restricted building, or the 400-a-day limit' : `${what}: ${msg}`);
  e.fatal = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  return e;
}
const isDuplicate = (r) => r.status === 409 || /duplicate|already exists/i.test(r.text || '');

async function sendOne(s) {
  const path = pathOf(s);
  const fatalAt = (state, e) => (e.fatal ? Object.assign(e, { resume: state }) : e);
  if (s.state === 'queued') {
    const g = s.geo || {};
    const r = await api('/rest/v1/photos', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: {
        id: s.id, taken_at: new Date(s.takenAt).toISOString(), building_code: s.building.code, building_name: s.building.name,
        floor: s.floor || '', room: s.room || '', storage_path: path, session: s.session, mission_id: s.missionId || null,
        lat: g.lat ?? null, lon: g.lon ?? null, gps_accuracy_m: g.acc ?? null, width: s.w, height: s.h, bytes: s.bytes,
        device: (s.device || '').slice(0, 120), camera: (s.camera || '').slice(0, 120), sharp: s.sharp, brightness: s.brightness,
        phash: s.phash, light: s.light, status: 'uploading',
      },
    });
    if (!r.ok && r.status !== 409) throw fatalAt('queued', failure(r, 'Could not add the photo'));
    s.state = 'row';
    await store.putSnap(s);
  }
  if (s.state === 'row') {
    const r = await api(`/storage/v1/object/club-photos/${path}`, { method: 'POST', body: s.blob, type: 'image/jpeg' });
    if (!r.ok && !isDuplicate(r)) throw fatalAt('row', failure(r, 'Could not send the file'));
    s.state = 'file';
    await store.putSnap(s);
  }
  if (s.state === 'file') {
    const r = await api(`/rest/v1/photos?id=eq.${s.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { status: 'new' } });
    if (!r.ok) throw fatalAt('file', failure(r, 'Could not finish the photo'));
    Object.assign(s, { state: 'done', blob: null, sentAt: Date.now(), serverStatus: 'new' }); // the file is safe on the server
    await store.putSnap(s);
  }
}

async function pump() {
  if (st.running) return;
  st.running = true;
  st.blocked = null;
  emit();
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    let me;
    try {
      me = await club.myProfile();
    } catch (e) {
      st.lastError = e.message;
      return kick(20000);
    }
    if (!me || me.banned) {
      st.blocked = me ? 'banned' : 'join';
      return;
    }
    for (;;) {
      const todo = (await store.listSnaps()).filter((s) => PENDING.has(s.state)).sort((a, b) => a.createdAt - b.createdAt);
      if (!todo.length) break;
      let dropped = false;
      await Promise.all(todo.slice(0, 2).map(async (s) => {
        try {
          await sendOne(s);
        } catch (e) {
          if (e.fatal) await store.putSnap({ ...s, state: 'failed', resume: e.resume || 'queued', error: e.message });
          else {
            dropped = true;
            st.lastError = e.message;
          }
        }
        emit();
      }));
      if (dropped) return kick(20000);
    }
    st.lastError = null;
  } finally {
    st.running = false;
    emit();
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => kick(500));
