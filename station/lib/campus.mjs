// Everything SplatStation's Campus page shows: per ASU building and per space, what is on the campus map
// (splats the club approved, and splats made on this PC from your own scans), what is waiting for review
// (members' scans and the splats built from them), how complete each building is, and how good each splat
// is. Built on request from three sources: the club database (when set up), this PC's library and job queue,
// and the ASU building list. The rules live in app/js/core/campusmodel.js. A summary of it (counts and
// sizes per space, no names or locations) is published for the phones' Campus map.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAll, call } from './crowd.mjs';
import { matchNameIn } from '../../app/js/data/campus.js';
import { LIGHT_SLOTS, lightSlot, phoenixDay } from '../../app/js/core/clubrules.js';
import * as M from '../../app/js/core/campusmodel.js';

/** "Room 214 (East)" → "room 214 east": how two names for the same room are matched. */
export const normRoom = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------------------------------ the club's own settings
// <workDir>/campus.json: {since, floors: {code: n}, sizes: {spaceKey: size}, published: {at, spaces, plans, by, legacy}}
const stateFile = (workDir) => join(workDir, 'campus.json');
function readState(workDir) {
  try {
    return JSON.parse(readFileSync(stateFile(workDir), 'utf8')) || {};
  } catch {
    return {};
  }
}
const writeState = (workDir, patch) => writeFileSync(stateFile(workDir), JSON.stringify({ ...readState(workDir), ...patch }, null, 1));

/** The club's settings: {since (ISO or null), floors: {code: n}, sizes: {spaceKey: size}}. */
export function loadSettings(workDir) {
  const s = readState(workDir);
  return { since: s.since || null, floors: s.floors || {}, sizes: s.sizes || {} };
}

/**
 * A fresh start: count only scans, splats and captures from `since` on ('now', an ISO time, or null to
 * count everything again). Nothing is deleted. Returns the time saved (ISO) or null.
 */
export function setSince(workDir, since) {
  const t = since == null ? null : new Date(since === 'now' ? Date.now() : since);
  if (t && isNaN(t)) throw new Error('That isn’t a time.');
  writeState(workDir, { since: t ? t.toISOString() : null });
  return t ? t.toISOString() : null;
}

/** Set (1 or more) or clear (null: OpenStreetMap's count, or 2) a building's number of floors. */
export function saveFloors(workDir, code, n) {
  const floors = { ...loadSettings(workDir).floors };
  if (n == null) delete floors[code];
  else floors[code] = Math.max(1, Math.min(60, Math.round(n)));
  writeState(workDir, { floors });
  return floors;
}

/** Set (one of SIZES) or clear (null: guessed from its name, or measured by a scan) a space's size. */
export function saveSize(workDir, key, size) {
  if (size != null && !M.SIZES[size]) throw new Error('Unknown size of space.');
  const sizes = { ...loadSettings(workDir).sizes };
  if (size == null) delete sizes[key];
  else sizes[key] = size;
  writeState(workDir, { sizes });
  return sizes;
}

/** When the summary was last published for members: {at, spaces, plans, by}, or null. */
export const loadPublished = (workDir) => readState(workDir).published || null;
export const savePublished = (workDir, p) => writeState(workDir, { published: p });

// ------------------------------------------------------------------------------------ gathering
const manifests = new Map(); // job id -> the capture's splatscout.json (or null)
function manifestOf(jobsDir, jobId) {
  if (!jobId || !jobsDir) return null;
  if (!manifests.has(jobId)) {
    let m = null;
    try {
      const f = join(jobsDir, jobId, 'dataset', 'splatscout.json');
      if (existsSync(f)) m = JSON.parse(readFileSync(f, 'utf8'));
    } catch {}
    manifests.set(jobId, m);
  }
  return manifests.get(jobId);
}

/**
 * The floor area (m²) a splat's scan outline covers, when its reconstruction is in metres (lined up with the
 * phone's AR tracking); null otherwise (a COLMAP-only solve has no scale). With no outline (club photos taken
 * with Track position), the floor of the space as measured on the splat itself (info.floor, from its walk map).
 */
export function measuredArea(info) {
  const mode = info && info.colmap && info.colmap.mode;
  const areas = info && info.crop && info.crop.areas;
  if (!/^(ar-poses|sfm-ar)$/.test(mode || '')) return null;
  if (!Array.isArray(areas) || !areas.length) {
    const a = info.floor && info.floor.area;
    return Number.isFinite(a) && a >= 2 && a <= 20000 ? Math.round(a) : null;
  }
  let sum = 0;
  for (const a of areas) {
    const p = (a && a.poly) || [];
    let twice = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
      twice += x0 * y1 - x1 * y0;
    }
    sum += Math.abs(twice) / 2;
  }
  return sum >= 2 && sum <= 20000 ? Math.round(sum) : null;
}

/** When a library splat was made (ms): info.json's time, else its folder's name (2026-10-25_2108, this PC's clock). */
function builtAt(it) {
  const t = Date.parse((it.info && it.info.created) || '');
  if (Number.isFinite(t)) return t;
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/.exec(it.stamp || '');
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00`).getTime() : 0;
}

/**
 * @param {object} o
 * @param {{url, key}|null} o.club the club database, or null if it isn't set up
 * @param {object[]} o.library finished splats: [{path, building, room, stamp, info}]
 * @param {object[]} o.jobs captures waiting, queued or running on this PC
 * @param {Map<string, object>} o.buildings ASU buildings by code
 * @param {string} o.workDir SplatStation's folder (the club's settings live in campus.json)
 * @param {string} [o.jobsDir] where jobs keep their capture's manifest
 */
export async function campusData({ club, library = [], jobs = [], buildings, workDir, jobsDir }) {
  const list = [...buildings.values()];
  const settings = loadSettings(workDir);
  const since = settings.since ? Date.parse(settings.since) : null;
  const notes = [];

  // ---- the club database: the scans members sent (scans the club didn't approve are left out)
  let scans = [], handles = new Map(), clubError = null;
  if (club) {
    try {
      [scans, handles] = await Promise.all([
        listAll(club, '/rest/v1/captures?select=id,user_id,created_at,building_code,building_name,floor,room,photo_count,grade,status,points,reviewed_at,lat,lon,gps_accuracy_m&status=in.(new,processed,approved)'),
        listAll(club, '/rest/v1/profiles?select=user_id,handle').then((r) => new Map(r.map((p) => [p.user_id, p.handle]))),
      ]);
    } catch (e) {
      clubError = e.message;
      notes.push(`Couldn’t reach the club database (${e.message}); showing this PC’s splats only.`);
    }
  } else notes.push('The club database isn’t set up on this PC (crowd.json), so only this PC’s splats and captures are shown.');

  // ---- a fresh start leaves out everything from before it (nothing is deleted)
  const hidden = { scans: 0, builds: 0, jobs: 0 };
  if (since != null) {
    const keep = (arr, key, when) => {
      const kept = arr.filter((x) => when(x) >= since);
      hidden[key] = arr.length - kept.length;
      return kept;
    };
    scans = keep(scans, 'scans', (c) => Date.parse(c.created_at) || 0);
    library = keep(library, 'builds', builtAt);
    jobs = keep(jobs, 'jobs', (j) => j.created || 0);
  }
  const scanById = new Map(scans.map((c) => [c.id, c]));

  // ---- spaces: building + floor + room
  const spaces = new Map();
  const spaceOf = (code, floor, room, name) => {
    const key = `${code}|${(floor || '').trim().toLowerCase()}|${normRoom(room)}`;
    if (!spaces.has(key)) spaces.set(key, { key, code, floor: (floor || '').trim(), room: (room || '').trim() || 'Unnamed', buildingName: name, scans: [], builds: [], jobs: [], users: new Set() });
    return spaces.get(key);
  };
  /** Library items and jobs often have no floor: match a space of that room on any floor first. */
  const spaceByRoom = (code, floor, room, name) => {
    if (!floor) for (const s of spaces.values()) if (s.code === code && normRoom(s.room) === normRoom(room)) return s;
    return spaceOf(code, floor, room, name);
  };
  const codeFor = (name, manifest, clubInfo) => {
    const c = (clubInfo && clubInfo.buildingCode) || (manifest && manifest.capture && manifest.capture.buildingCode);
    if (c && buildings.has(c)) return c;
    const b = matchNameIn(list, name);
    return b ? b.code : null;
  };

  // Scans not approved yet: waiting for the club. Approved ones are on the map through their splats (a space
  // isn't made for an approved scan whose splat isn't on this PC).
  for (const c of scans) {
    if (!buildings.has(c.building_code) || c.status === 'approved') continue;
    spaceOf(c.building_code, c.floor, c.room, c.building_name).scans.push({ id: c.id, grade: c.grade, photos: c.photo_count, status: c.status, created: c.created_at, user: handles.get(c.user_id) || null });
  }
  // A member's splat goes on the campus map when the club approves it; a rejected one stays off. Splats made on
  // this PC from your own scans count as they are.
  const verdict = (info) => {
    if (!info.club) return 'own';
    const row = scanById.get(info.club.id);
    if ((info.review && info.review.status === 'approved') || (row && row.status === 'approved')) return 'approved';
    if (info.review && info.review.status === 'rejected') return 'rejected';
    return 'review';
  };
  const elsewhere = []; // splats and captures that aren't in an ASU building (practice rooms, typos)
  const waitingScans = new Set(); // scans whose splat is built and waiting for the club's review
  for (const it of library) {
    const info = it.info || {};
    const review = verdict(info);
    if (review === 'rejected') continue;
    const m = manifestOf(jobsDir, info.jobId);
    const code = codeFor(info.building || it.building, m, info.club);
    const room = info.room || it.room;
    const build = {
      path: it.path, stamp: it.stamp, created: info.created || null, photos: info.photos || 0, placed: info.placed != null ? info.placed : info.photos || 0,
      reprojError: info.colmap ? info.colmap.reprojError : null, mode: info.colmap ? info.colmap.mode : null, points: info.colmap ? info.colmap.points : null,
      preset: info.training ? info.training.preset : null, splats: info.training ? info.training.splats : null,
      grade: info.capture ? info.capture.grade : null, gradeScore: info.capture && info.capture.score != null ? info.capture.score : null,
      area: measuredArea(info), // m² of floor its scan outline covers, when the splat is in metres
      // Measured quality, when it was trained with photos held back: {psnr, ssim, views, step, every}.
      eval: info.training && info.training.eval && Number.isFinite(info.training.eval.psnr) ? info.training.eval : null,
      view: info.view || null, title: `${info.building || it.building} · ${room}`,
      review, club: info.club ? { id: info.club.id, contributor: info.club.contributor || null } : null,
    };
    if (!code) {
      elsewhere.push({ kind: 'splat', building: info.building || it.building, room, ...build });
      continue;
    }
    const s = spaceByRoom(code, (typeof info.level === 'string' && info.level) || (m && m.capture && m.capture.floor) || '', room, buildings.get(code).name);
    s.builds.push(build);
    if (review === 'review') waitingScans.add(info.club.id);
    if (review === 'approved') s.users.add(handles.get((scanById.get(info.club.id) || {}).user_id) || info.club.contributor || 'former member');
  }
  // A scan whose splat is built waits as that splat, not twice.
  for (const s of spaces.values()) s.scans = s.scans.filter((x) => !waitingScans.has(x.id));
  for (const j of jobs) {
    const code = codeFor(j.building, null, j.club);
    const entry = { id: j.id, status: j.status, photos: j.summary ? j.summary.photos : null, name: j.source ? j.source.name : '', club: j.club ? j.club.id : null };
    if (!code) elsewhere.push({ kind: 'job', building: j.building, room: j.room, ...entry });
    else spaceByRoom(code, j.floor || '', j.room || 'Unnamed', buildings.get(code).name).jobs.push(entry);
  }

  // ---- per space: what's on the map (approved splats and your own), and what's waiting
  const outSpaces = [];
  for (const s of spaces.values()) {
    const sizeSet = M.SIZES[settings.sizes[s.key]] ? settings.sizes[s.key] : null;
    const size = sizeSet || M.sizeOf(s.room);
    const kind = M.SIZES[size].kind;
    const builds = s.builds.map((b) => ({ ...b, ...M.builtEstimate(b, kind) }));
    const onMap = builds.filter((b) => b.review !== 'review'), waiting = builds.filter((b) => b.review === 'review');
    // Its size: the club's choice, else the floor a splat on the map measured, else typical for its name.
    const measured = (onMap.length ? onMap : waiting).reduce((a, b) => (b.area != null && (a == null || b.area > a) ? b.area : a), null);
    const area = sizeSet || measured == null ? M.SIZES[size].area : measured;
    const est = M.spaceEstimate({ room: s.room, kind, builds: onMap }, { advice: false });
    const advice = [];
    if (waiting.length) advice.push(`${waiting.length} splat${waiting.length === 1 ? ' is' : 's are'} waiting for your review on the Club page.`);
    if (s.scans.length) advice.push(`${s.scans.length} scan${s.scans.length === 1 ? '' : 's'} from members ${s.scans.length === 1 ? 'isn’t' : 'aren’t'} built yet: import ${s.scans.length === 1 ? 'it' : 'them'} on the Club page.`);
    if (s.jobs.length) advice.push(`${s.jobs.length} capture${s.jobs.length === 1 ? ' is' : 's are'} on the dashboard: process ${s.jobs.length === 1 ? 'it' : 'them'}.`);
    if (!onMap.length && !advice.length) advice.push('Not on the map yet: one scan graded B or better (10–20 minutes with the capture coach) puts it there.');
    else if (onMap.length && est.score < M.GOOD) advice.push(`On the map, but ${est.band.label.toLowerCase()}: a new scan graded A or B would make it better.`);
    else if (onMap.length && est.score < M.EXCELLENT) advice.push('Good. A new scan graded A could make it Excellent.');
    if (est.built && !est.built.measured) advice.push('Its quality is estimated: process the capture again with Measure quality ticked for a measured one.');
    outSpaces.push({
      key: s.key, code: s.code, building: s.buildingName || buildings.get(s.code).name, floor: s.floor, room: s.room,
      kind, score: est.score, band: est.band.id, source: est.built ? 'built' : 'none',
      // How much floor it covers, for building completion: its area in proportion to how close it is to Good.
      size, sizeSet: !!sizeSet, area, areaSource: sizeSet ? 'set' : measured != null ? 'measured' : 'typical', covered: area * M.coveredShare(est.score),
      onMap: onMap.length, waiting: waiting.length, builds,
      built: est.built ? { score: est.built.score, parts: est.built.parts, path: est.built.path, measured: est.built.measured, eval: est.built.eval } : null,
      scans: s.scans, jobs: s.jobs, contributors: [...s.users].map((handle) => ({ handle })), advice,
    });
  }

  // ---- buildings and campuses
  const byCode = new Map();
  for (const s of outSpaces) (byCode.get(s.code) || byCode.set(s.code, []).get(s.code)).push(s);
  const light = new Map(); // scans per building and light slot (when they were sent)
  for (const c of scans) {
    if (!light.has(c.building_code)) light.set(c.building_code, Object.fromEntries(LIGHT_SLOTS.map((k) => [k, 0])));
    light.get(c.building_code)[lightSlot(Date.parse(c.created_at))]++;
  }
  const outBuildings = list.map((b) => {
    const sp = byCode.get(b.code) || [];
    const fa = M.floorArea(b, settings.floors[b.code]);
    const cov = M.buildingCoverage(sp, fa);
    const users = new Set();
    for (const s of sp) for (const c of s.contributors) users.add(c.handle);
    return {
      code: b.code, name: b.name, ref: b.ref || null, campus: b.campus, c: b.c, poly: b.poly, restricted: b.restricted || null,
      area: b.area || null, levels: b.levels || null,
      floorArea: fa, byFloor: cov.byFloor, covered: b.restricted ? 0 : cov.covered,
      completion: b.restricted ? 0 : cov.completion, good: cov.good, started: cov.started, spaces: sp.length,
      best: sp.reduce((m, s) => Math.max(m, s.score), 0),
      onMap: sp.reduce((n, s) => n + s.onMap, 0), waiting: sp.reduce((n, s) => n + s.waiting + s.scans.length, 0), jobs: sp.reduce((n, s) => n + s.jobs.length, 0),
      builds: sp.reduce((n, s) => n + s.builds.length, 0), // every splat of it on this PC, on the map or waiting
      light: light.get(b.code) || Object.fromEntries(LIGHT_SLOTS.map((k) => [k, 0])), contributors: users.size,
    };
  });
  const campuses = [...new Set(list.map((b) => b.campus))].map((id) => {
    const bs = outBuildings.filter((b) => b.campus === id && !b.restricted);
    const area = bs.reduce((n, b) => n + b.floorArea.area, 0), covered = bs.reduce((n, b) => n + b.covered, 0);
    return {
      id, buildings: bs.length, started: bs.filter((b) => b.spaces > 0).length, area, covered, completion: area ? covered / area : 0,
      spaces: bs.reduce((n, b) => n + b.spaces, 0), good: bs.reduce((n, b) => n + b.good, 0),
    };
  });

  // ---- where scans were made (GPS), and activity per day
  const points = scans.filter((c) => c.lat != null && buildings.has(c.building_code))
    .map((c) => ({ lat: c.lat, lon: c.lon, acc: c.gps_accuracy_m, kind: 'scan', status: c.status, code: c.building_code, t: Date.parse(c.created_at) }));
  const days = new Map();
  const day = (t) => {
    const d = phoenixDay(t);
    if (!days.has(d)) days.set(d, { day: d, scans: 0, approved: 0, builds: 0, byLight: {} });
    return days.get(d);
  };
  for (const c of scans) {
    const t = Date.parse(c.created_at), d = day(t), slot = lightSlot(t);
    d.scans++;
    d.byLight[slot] = (d.byLight[slot] || 0) + 1;
    if (c.status === 'approved' && c.reviewed_at) day(Date.parse(c.reviewed_at)).approved++;
  }
  for (const it of library) if (it.info && it.info.created) day(Date.parse(it.info.created)).builds++;

  return {
    generatedAt: new Date().toISOString(), club: !!club, clubError, notes, published: loadPublished(workDir),
    since: settings.since, hidden,
    totals: {
      scans: scans.filter((c) => c.status !== 'approved').length, approved: scans.filter((c) => c.status === 'approved').length,
      onMap: outSpaces.reduce((n, s) => n + s.onMap, 0), waiting: outSpaces.reduce((n, s) => n + s.waiting, 0), builds: library.length,
      contributors: new Set(scans.map((x) => x.user_id)).size,
    },
    campuses, buildings: outBuildings, spaces: outSpaces, elsewhere, points,
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    model: {
      bands: M.BANDS, good: M.GOOD, excellent: M.EXCELLENT, minPhotos: M.MIN_PHOTOS, psnrStops: M.PSNR_STOPS,
      sizes: M.SIZES, completionSteps: M.COMPLETION_STEPS, completionLabels: M.COMPLETION_LABELS, defaultFootprint: M.DEFAULT_FOOTPRINT,
      kinds: Object.fromEntries(Object.entries(M.KINDS).map(([k, v]) => [k, { ...v, good: M.photosFor(M.GOOD, k), excellent: M.photosFor(M.EXCELLENT, k), curve: M.curvePoints(k) }])),
    },
  };
}

/**
 * What approving a member's splat would add to the campus map: its space, the floor it newly covers there,
 * and whether that space was Good already (a rescan). From campusData(), where the splat is still waiting.
 * @returns {{space, build, newArea: number, rescan: boolean}|null}
 */
export function approvalFacts(data, path) {
  const space = data.spaces.find((x) => x.builds.some((b) => b.path === path));
  if (!space) return null;
  const build = space.builds.find((b) => b.path === path);
  const area = space.sizeSet || build.area == null ? space.area : build.area;
  return { space, build, newArea: Math.max(0, area * M.coveredShare(build.score) - space.covered), rescan: space.score >= M.GOOD };
}

// ------------------------------------------------------------------------------------ the summary members see
const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100000, Math.round(v))) : v > 0 ? 100000 : 0);

/**
 * The rows the phones' Campus map reads (crowd/supabase-campus.sql and -campus-2.sql), from campusData(): every
 * space in a building that can be scanned, with its quality, the floor area it counts for, how many splats of it
 * are on the map and how many scans of it wait for review, plus the floor counts the club set. Counts only: no
 * handles, no GPS.
 * @param {string} at the time of this publish (rows older than it are removed afterwards)
 * @param {{legacy?: boolean}} [o] legacy: for a database without supabase-campus-2.sql (no sizes, no floor counts)
 */
export function summaryRows(data, at = new Date().toISOString(), { legacy = false } = {}) {
  const open = new Set(data.buildings.filter((b) => !b.restricted).map((b) => b.code));
  const spaces = data.spaces.filter((x) => open.has(x.code)).map((x) => ({
    space_key: x.key.slice(0, 200), building_code: x.code, floor: (x.floor || '').slice(0, 20), room: (x.room || 'Unnamed').slice(0, 80),
    kind: x.kind, score: x.score, band: x.band, ...(legacy ? {} : { area: Math.max(1, Math.min(100000, Math.round(x.area))) }),
    // Single photos were retired: the per-light photo counts and photo needs stay in the table, as zeros.
    ...Object.fromEntries(LIGHT_SLOTS.map((k) => [k, 0])), pending: 0, need_good: 0, need_excellent: 0, need_light: null,
    builds: count(x.onMap), // splats on the campus map (approved, or the club's own)
    scans: count(x.waiting + x.scans.length), // scans waiting for the club's review
    queued: count(x.jobs.length), // captures waiting on the club PC
    updated_at: at,
  }));
  const plans = legacy ? [] : data.buildings.filter((b) => b.floorArea.set && open.has(b.code)).map((b) => ({ building_code: b.code, floors: b.floorArea.floors, updated_at: at }));
  return { spaces, plans };
}

/**
 * Publish the summary for members with the secret key: upsert every row, then remove what is no longer there
 * (a space whose scans were all rejected or that a fresh start left out, a floor count set back). A view built
 * without the club database (not set up or not reachable) is never published: it would wipe the
 * members' map. A database that hasn't had supabase-campus-2.sql gets the summary without sizes (`legacy`).
 * @returns {Promise<{at: string, spaces: number, plans: number, legacy: boolean}>}
 */
export async function publishSummary(club, data) {
  if (!club || !data.club || data.clubError) throw new Error(`The club database couldn’t be read${data.clubError ? ` (${data.clubError})` : ''}, so nothing was published.`);
  const at = new Date().toISOString();
  const send = async (rows) => {
    for (const [table, list] of [['campus_spaces', rows.spaces], ['campus_plans', rows.plans]]) {
      for (let i = 0; i < list.length; i += 500) {
        await call(club, `/rest/v1/${table}`, { method: 'POST', body: list.slice(i, i + 500), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      }
      await call(club, `/rest/v1/${table}?updated_at=lt.${encodeURIComponent(at)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
    return rows;
  };
  let rows, legacy = false;
  try {
    try {
      rows = await send(summaryRows(data, at));
    } catch (e) {
      if (!/'(area|floors)' column/i.test(e.message)) throw e;
      legacy = true;
      rows = await send(summaryRows(data, at, { legacy: true }));
    }
  } catch (e) {
    if (/campus_(spaces|plans)/.test(e.message) && /could not find|does not exist|schema cache/i.test(e.message)) {
      throw new Error('The club database has no campus tables yet: run crowd/supabase-campus.sql in the Supabase SQL editor (after supabase-beta.sql).');
    }
    throw e;
  }
  return { at, spaces: rows.spaces.length, plans: rows.plans.length, legacy };
}
