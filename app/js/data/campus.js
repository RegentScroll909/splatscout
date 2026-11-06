// ASU buildings and GPS: which building a capture is in, and one fixed name per building so that
// uploads from different phones end up together. Outlines come from OpenStreetMap
// (app/data/asu-buildings.json, made by tools/asu-buildings.mjs).
//
// Phone GPS is good to a few metres outdoors but often 10–50 m indoors and can't tell floors apart,
// so it only suggests the building; floor and room come from the person.

let list = null;

/** All buildings: [{code, name, ref?, campus, c: [lat, lon], poly: [[lat, lon], ...]}]. */
export function buildings() {
  if (!list) {
    list = fetch(new URL('../../data/asu-buildings.json', import.meta.url))
      .then((r) => r.json())
      .then((j) => j.buildings)
      .catch(() => {
        list = null; // try again next time (offline before it was ever cached)
        return [];
      });
  }
  return list;
}

export const byCode = async (code) => (await buildings()).find((b) => b.code === code) || null;

// Metres in a flat frame around a point (fine at campus scale).
const toXY = ([lat, lon], [lat0, lon0]) => [(lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), (lat - lat0) * 110540];

/** Distance in metres from a point to a building's outline (0 inside it). */
export function distanceTo(b, lat, lon) {
  const o = [lat, lon], pts = b.poly.map((p) => toXY(p, o));
  let inside = false, best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xi - xj, dy = yi - yj, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, (-xj * dx - yj * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(xj + t * dx, yj + t * dy));
  }
  return inside ? 0 : best;
}

/**
 * Buildings a GPS fix could be in, closest first: [{b, dist}]. The fix's own accuracy sets how far
 * to look, so a poor indoor fix offers a few buildings to choose from instead of one wrong one.
 */
export async function near(fix, max = 4) {
  const reach = Math.min(150, Math.max(25, fix.acc * 1.5));
  return (await buildings())
    .map((b) => ({ b, dist: distanceTo(b, fix.lat, fix.lon) }))
    .filter((x) => x.dist <= reach)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max);
}

/** The building a fix is clearly in (inside its outline, fix good to 40 m, no other one close), or null. */
export async function sureBuilding(fix) {
  const n = await near(fix, 2);
  if (!n.length || n[0].dist > 0 || fix.acc > 40) return null;
  return n.length > 1 && n[1].dist < Math.min(15, fix.acc) ? null : n[0].b;
}

const STOP = new Set(['building', 'bldg', 'hall', 'center', 'centre', 'the', 'of', 'and', 'asu', 'arizona', 'state', 'university']);
const words = (s) => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** Best guess for a typed building name ("Schwada Building" → Schwada Classroom Office Building), or null. */
export async function matchName(name) {
  return matchNameIn(await buildings(), name);
}

/** The same, against a given list of buildings (SplatStation reads the list from disk). */
export function matchNameIn(all, name) {
  const q = (name || '').trim().toLowerCase();
  if (!q) return null;
  const exact = all.find((b) => b.name.toLowerCase() === q || (b.ref && b.ref.toLowerCase() === q));
  if (exact) return exact;
  const qw = words(q);
  if (!qw.length) return null;
  let best = null, score = 0;
  for (const b of all) {
    const bw = new Set(words(b.name));
    const s = qw.filter((w) => bw.has(w)).length / qw.length;
    if (s > score || (s === score && best && s > 0 && b.name.length < best.name.length)) [best, score] = [b, s];
  }
  return score >= 0.5 ? best : null;
}

/**
 * Where the phone is: watches GPS for a while and keeps the most accurate reading.
 * Resolves {lat, lon, acc, t} once a reading is good to `good` metres or time runs out with any
 * reading; rejects if location is off, refused or never arrives.
 */
export function locate({ timeout = 12000, good = 12 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can’t share your location'));
    let best = null;
    const done = (fn, v) => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      fn(v);
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const fix = { lat: +p.coords.latitude.toFixed(7), lon: +p.coords.longitude.toFixed(7), acc: Math.round(p.coords.accuracy), t: Date.now() };
        if (!best || fix.acc <= best.acc) best = fix;
        if (best.acc <= good) done(resolve, best);
      },
      (e) => done(reject, new Error(e.code === 1 ? 'Location is blocked for this site: allow it in the browser’s site settings' : 'No GPS fix: step near a window or outside')),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
    const timer = setTimeout(() => (best ? done(resolve, best) : done(reject, new Error('No GPS fix yet: step near a window or outside'))), timeout);
  });
}

/**
 * Keeps following GPS (for taking many photos): calls onFix({lat, lon, acc, t}) with each reading.
 * @returns {() => void} stop
 */
export function watchLocation(onFix, onError = () => {}) {
  if (!navigator.geolocation) {
    onError(new Error('This browser can’t share your location'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lat: +p.coords.latitude.toFixed(7), lon: +p.coords.longitude.toFixed(7), acc: Math.round(p.coords.accuracy), t: Date.now() }),
    (e) => onError(new Error(e.code === 1 ? 'Location is blocked for this site' : 'No GPS fix')),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Why a building is off limits for photos ('residence', 'health', ...), or null. */
export const restrictedReason = (b) => (b && b.restricted) || null;

export const RESTRICTED_TEXT = {
  residence: 'a residence hall or housing',
  health: 'a health or counseling building',
  safety: 'a police or courts building',
  children: 'a children’s center',
};

/** Whether the site may already use location without asking (so it can be read without a prompt). */
export async function locationAllowed() {
  try {
    return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted';
  } catch {
    return false;
  }
}

/** A folder-safe name for a floor and room: "2" + "Room 214" → "floor-2-room-214". */
export function placeSlug(floor, room) {
  const s = (x) => (x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const parts = [floor && `floor-${s(floor)}`, s(room)].filter(Boolean).join('-');
  return parts.slice(0, 100).replace(/-$/, '') || 'unsorted';
}
