// The campus summary SplatStation publishes for members (crowd/supabase-campus.sql and -campus-2.sql): every
// space on the campus map (its approved splats) with its quality and the floor area it counts for, how many
// scans of it are waiting for the club's review, plus the floor counts the club set. The copy last seen stays
// on the phone, so the Campus map opens in a basement with no signal. Building completion (the share of a
// building's floor area covered) follows the same rules as SplatStation's Campus page (core/campusmodel.js),
// so the phone and the club PC agree.

import { api, why } from './crowd.js';
import { buildingCoverage, floorArea, SIZES, completionBin as binOf, COMPLETION_LABELS, pctText, bandOf, BANDS, GOOD, EXCELLENT } from '../core/campusmodel.js';
import { distanceTo } from './campus.js';

export { BANDS, GOOD, EXCELLENT, bandOf, pctText };

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
      rows('campus_plans', '*', 'building_code.asc'), // * : the floors column only exists after supabase-campus-2.sql
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
 * The floor area (m²) a published space counts for: as SplatStation sent it, or typical for its kind when the
 * club's database doesn't have sizes yet (before supabase-campus-2.sql).
 */
export const areaOf = (x) => (x.area > 0 ? x.area : (SIZES[x.kind] || SIZES.room).area);

/**
 * Every building with its published spaces and how complete it is, by the same rules as SplatStation:
 * [{...building, restricted, spaces, floorArea, byFloor, completion, covered, good, started, best}].
 * A building is off limits if the building list or the club database says so.
 */
export function summarize(list, s = {}) {
  const floors = new Map((s.plans || []).filter((p) => p.floors > 0).map((p) => [p.building_code, p.floors]));
  const off = new Map((s.restricted || []).map((r) => [r.code, r.reason]));
  const byCode = new Map();
  for (const x of s.spaces || []) {
    if (!byCode.has(x.building_code)) byCode.set(x.building_code, []);
    byCode.get(x.building_code).push(x);
  }
  return list.map((b) => {
    const restricted = b.restricted || off.get(b.code) || null;
    const spaces = (byCode.get(b.code) || []).sort(byPlace);
    const fa = floorArea(b, floors.get(b.code));
    const cov = buildingCoverage(spaces.map((x) => ({ score: x.score, area: areaOf(x), floor: x.floor })), fa);
    return {
      ...b, restricted, spaces, floorArea: fa, byFloor: cov.byFloor,
      completion: restricted ? 0 : cov.completion, covered: restricted ? 0 : cov.covered, good: cov.good, started: cov.started,
      best: spaces.reduce((m, x) => Math.max(m, x.score), 0),
    };
  });
}

/** Completion as a step of the one-hue ramp (core/campusmodel.completionBin), 0 = nothing on the map yet. */
export const completionBin = (b) => binOf(b.completion, b.spaces.length > 0);
export const BIN_LABELS = ['Not on the map yet', ...COMPLETION_LABELS.slice(1)];

/** Where a space stands, in one sentence. */
export function needText(x) {
  if (x.score >= EXCELLENT) return 'Excellent: nothing more needed here.';
  if (x.score >= GOOD) return 'Good. A new scan graded A could make it Excellent.';
  if (x.builds) return `On the map, but ${bandOf(x.score).label.toLowerCase()}: a new scan graded A or B would make it better.`;
  if (x.scans || x.queued) return 'A scan of it is waiting for the club’s review.';
  return 'Not scanned yet.';
}

/** Spaces on the map that aren't Good yet, closest to Good first: the next scans worth making. */
export function notGoodYet(buildings, { limit = 5 } = {}) {
  const out = [];
  for (const b of buildings) {
    if (b.restricted) continue;
    for (const x of b.spaces) if (x.builds && x.score < GOOD) out.push({ b, x });
  }
  return out.sort((p, q) => q.x.score - p.x.score).slice(0, limit);
}

/** Buildings that can be scanned within `within` metres of a GPS fix, closest first: [{b, dist}]. */
export function nearby(buildings, fix, { within = 600, limit = 5 } = {}) {
  return buildings
    .filter((b) => !b.restricted)
    .map((b) => ({ b, dist: distanceTo(b, fix.lat, fix.lon) }))
    .filter((p) => p.dist <= within)
    .sort((p, q) => p.dist - q.dist)
    .slice(0, limit);
}

/** "Scan here": the capture setup with the place filled in. */
export const scanUrl = (code, floor = '', room = '') => '#/setup?' + new URLSearchParams({ building: code, floor: floor || '', room: room || '' });
