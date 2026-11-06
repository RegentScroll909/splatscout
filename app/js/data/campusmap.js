// The campus summary SplatStation publishes for members (crowd/supabase-campus.sql): every space's expected
// splat quality, its accepted photos in each kind of light and about how many more (in which light) would
// make it Good, plus the club's own building plans. The copy last seen stays on the phone, so the Campus map
// opens in a basement with no signal. Building completion follows the same rules as SplatStation's Campus page
// (core/campusmodel.js), so the phone and the club PC agree.

import { api, why } from './crowd.js';
import { buildingProgress, defaultPlan, bandOf, photosNeeded, BANDS, GOOD, EXCELLENT } from '../core/campusmodel.js';
import { LIGHT_SLOTS, LIGHT_LABEL, lightSlot } from '../core/clubrules.js';
import { distanceTo } from './campus.js';

export { BANDS, GOOD, EXCELLENT, bandOf };
/** Photos in one kind of light that make an empty space of this kind ('room', 'hallway', 'large') Good: the same count the Campus page gives. */
export const photosForGood = (kind) => photosNeeded({ room: { room: 'Room', hallway: 'Hallway', large: 'Lobby' }[kind] || 'Room' }, GOOD).n;

const KEY = 'splatscout-campus-summary';
let store = {
  get: () => {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {}
  },
};
/** Swap where the last summary is kept (the self-checks use a plain object). */
export const useCache = (s) => (store = s);

/** When each kind of light is (Phoenix time; see clubrules.lightSlot). */
export const LIGHT_HOURS = { morning: '6–11 am', afternoon: '11 am–4 pm', evening: '4–8 pm', night: '8 pm–6 am' };
export const lightWords = (k) => (k ? `${LIGHT_LABEL[k].toLowerCase()} light (${LIGHT_HOURS[k]})` : 'one kind of light');

/** Every row of a members-only table, 1000 at a time. */
async function rows(table, select, order) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await api(`/rest/v1/${table}?select=${select}&order=${order}&limit=1000&offset=${offset}`);
    if (!r.ok) throw new Error(why(r));
    out.push(...r.body);
    if (r.body.length < 1000) return out;
  }
}

/** The summary as this phone last saw it, or null. */
export const cached = () => store.get();

const missingTable = (msg) => /campus_(spaces|plans)/.test(msg) && /could not find|does not exist|schema cache/i.test(msg);

/**
 * The published summary: {spaces, plans, restricted, at, fetched}. `at` is when SplatStation last published
 * (ms, or null if it never has). When the club database can't be reached it is the copy last seen, with
 * `offline` and `error` set; `missing` says the club hasn't added the campus tables yet.
 */
export async function load() {
  try {
    const [spaces, plans, restricted] = await Promise.all([
      rows('campus_spaces', '*', 'space_key.asc'),
      rows('campus_plans', 'building_code,spaces,updated_at', 'building_code.asc'),
      rows('restricted_buildings', 'code,reason', 'code.asc'),
    ]);
    const at = [...spaces, ...plans].reduce((t, r) => Math.max(t, Date.parse(r.updated_at) || 0), 0) || null;
    const s = { spaces, plans, restricted, at, fetched: Date.now() };
    store.set(s);
    return s;
  } catch (e) {
    const c = cached();
    if (missingTable(e.message)) return { spaces: [], plans: [], restricted: (c && c.restricted) || [], at: null, missing: true, error: e.message };
    if (c) return { ...c, offline: true, error: e.message };
    throw e;
  }
}

const byPlace = (a, b) => (a.floor || '').localeCompare(b.floor || '', undefined, { numeric: true }) || a.room.localeCompare(b.room);

/**
 * Every building with its published spaces and how complete it is, by the same rules as SplatStation:
 * [{...building, restricted, spaces, planned, planSet, completion, credit, good, started, best}].
 * A building is off limits if the building list or the club database says so.
 */
export function summarize(list, s = {}) {
  const plans = new Map((s.plans || []).map((p) => [p.building_code, p.spaces]));
  const off = new Map((s.restricted || []).map((r) => [r.code, r.reason]));
  const byCode = new Map();
  for (const x of s.spaces || []) {
    if (!byCode.has(x.building_code)) byCode.set(x.building_code, []);
    byCode.get(x.building_code).push(x);
  }
  return list.map((b) => {
    const restricted = b.restricted || off.get(b.code) || null;
    const spaces = (byCode.get(b.code) || []).sort(byPlace);
    const planned = plans.has(b.code) ? plans.get(b.code) : defaultPlan(b).spaces;
    const prog = buildingProgress(spaces.map((x) => x.score), planned);
    return {
      ...b, restricted, spaces, planned, planSet: plans.has(b.code),
      completion: restricted ? 0 : prog.completion, credit: prog.credit, good: prog.good, started: prog.started,
      best: spaces.reduce((m, x) => Math.max(m, x.score), 0),
    };
  });
}

/** Completion as a bin of the one-hue ramp (1 = started, under 25% … 5 = complete), 0 = no photos yet. */
export const completionBin = (b) => (!b.spaces.length ? 0 : b.completion >= 1 ? 5 : b.completion >= 0.75 ? 4 : b.completion >= 0.5 ? 3 : b.completion >= 0.25 ? 2 : 1);
export const BIN_LABELS = ['No photos yet', 'Started, under 25%', '25–49%', '50–74%', '75–99%', 'Complete'];

/** Accepted photos of a space, all lights together. */
export const photosOf = (x) => LIGHT_SLOTS.reduce((n, k) => n + (x[k] || 0), 0);

/** What a space still needs, in one sentence ("About 35 more photos in evening light (4–8 pm) would make it Good."). */
export function needText(x) {
  const light = lightWords(x.need_light);
  const more = photosOf(x) ? ' more' : '';
  if (x.score < GOOD && x.need_good > 0) return `About ${x.need_good}${more} photo${x.need_good === 1 ? '' : 's'} in ${light} would make it Good.`;
  if (x.score < EXCELLENT && x.need_excellent > 0) return `Good already. About ${x.need_excellent} more in ${light} would make it Excellent.`;
  if (x.score >= EXCELLENT) return 'Excellent: nothing more needed here.';
  return 'Good already.';
}

/** Spaces still short of Good, fewest photos needed first; `light` keeps those that want that light (or any). */
export function closestToGood(buildings, { light = null, limit = 5 } = {}) {
  const out = [];
  for (const b of buildings) {
    if (b.restricted) continue;
    for (const x of b.spaces) if (x.score < GOOD && x.need_good > 0 && (!light || !x.need_light || x.need_light === light)) out.push({ b, x });
  }
  return out.sort((p, q) => p.x.need_good - q.x.need_good || q.x.score - p.x.score).slice(0, limit);
}

/** Buildings that can be photographed within `within` metres of a GPS fix, closest first: [{b, dist}]. */
export function nearby(buildings, fix, { within = 600, limit = 5 } = {}) {
  return buildings
    .filter((b) => !b.restricted)
    .map((b) => ({ b, dist: distanceTo(b, fix.lat, fix.lon) }))
    .filter((p) => p.dist <= within)
    .sort((p, q) => p.dist - q.dist)
    .slice(0, limit);
}

/** The light it is now, and the words for it. */
export const lightNow = (t = Date.now()) => lightSlot(t);
