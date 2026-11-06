// Everything SplatStation's Campus page shows: per ASU building and per space, what the club has (photos and
// scans from phones, finished splats and queued jobs on this PC), how complete each building is, and how good
// a splat to expect. Built on request from three sources: the club database (when set up), this PC's library
// and job queue, and the ASU building list. The rules live in app/js/core/campusmodel.js. A summary of it
// (counts and what each space needs, no names or locations) is published for the phones' Campus map.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAll, call } from './crowd.mjs';
import { effectiveTaken } from './club.mjs';
import { matchNameIn } from '../../app/js/data/campus.js';
import { LIGHT_SLOTS, lightSlot, phoenixDay } from '../../app/js/core/clubrules.js';
import * as M from '../../app/js/core/campusmodel.js';

/** "Room 214 (East)" → "room 214 east": how two names for the same room are matched. */
export const normRoom = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

// ------------------------------------------------------------------------------------ the club's own plans
// <workDir>/campus.json: {plans: {code: n}, published: {at, spaces, plans, by}}
const plansFile = (workDir) => join(workDir, 'campus.json');
function readState(workDir) {
  try {
    return JSON.parse(readFileSync(plansFile(workDir), 'utf8')) || {};
  } catch {
    return {};
  }
}
const writeState = (workDir, patch) => writeFileSync(plansFile(workDir), JSON.stringify({ ...readState(workDir), ...patch }, null, 1));

/** Planned number of spaces per building, where the club has set one: {code: n}. */
export const loadPlans = (workDir) => readState(workDir).plans || {};

/** Set (n >= 0) or clear (null) a building's planned number of spaces. 0 leaves a building out of the plan. */
export function savePlan(workDir, code, n) {
  const plans = loadPlans(workDir);
  if (n == null) delete plans[code];
  else plans[code] = Math.max(0, Math.min(500, Math.round(n)));
  writeState(workDir, { plans });
  return plans;
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
 * @param {object} o
 * @param {{url, key}|null} o.club the club database, or null if it isn't set up
 * @param {object[]} o.library finished splats: [{path, building, room, stamp, info}]
 * @param {object[]} o.jobs captures waiting, queued or running on this PC
 * @param {Map<string, object>} o.buildings ASU buildings by code
 * @param {string} o.workDir SplatStation's folder (plans live in campus.json)
 * @param {string} [o.jobsDir] where jobs keep their capture's manifest
 */
export async function campusData({ club, library = [], jobs = [], buildings, workDir, jobsDir }) {
  const list = [...buildings.values()];
  const plans = loadPlans(workDir);
  const notes = [];

  // ---- the club database: photos and scans phones sent (rejected photos are already deleted)
  let photos = [], scans = [], handles = new Map(), clubError = null;
  if (club) {
    try {
      [photos, scans, handles] = await Promise.all([
        listAll(club, '/rest/v1/photos?select=id,user_id,created_at,taken_at,building_code,building_name,floor,room,session,device,lat,lon,gps_accuracy_m,status,reviewed_at&status=in.(new,accepted)'),
        listAll(club, '/rest/v1/captures?select=id,user_id,created_at,building_code,building_name,floor,room,photo_count,grade,status,lat,lon,gps_accuracy_m&status=in.(new,approved,processed)'),
        listAll(club, '/rest/v1/profiles?select=user_id,handle').then((r) => new Map(r.map((p) => [p.user_id, p.handle]))),
      ]);
    } catch (e) {
      clubError = e.message;
      notes.push(`Couldn’t reach the club database (${e.message}); showing this PC’s splats only.`);
    }
  } else notes.push('The club database isn’t set up on this PC (crowd.json), so only this PC’s splats and captures are shown.');

  // ---- spaces: building + floor + room
  const spaces = new Map();
  const spaceOf = (code, floor, room, name) => {
    const key = `${code}|${(floor || '').trim().toLowerCase()}|${normRoom(room)}`;
    if (!spaces.has(key)) {
      spaces.set(key, {
        key, code, floor: (floor || '').trim(), room: (room || '').trim() || 'Unnamed', buildingName: name,
        photos: { accepted: 0, pending: 0, byLight: {}, sessions: new Set(), devices: new Set(), users: new Map(), times: [], first: null, last: null },
        scans: [], builds: [], jobs: [],
      });
    }
    return spaces.get(key);
  };
  /** Library items and jobs often have no floor: match a space of that room on any floor first. */
  const spaceByRoom = (code, floor, room, name) => {
    if (!floor) for (const s of spaces.values()) if (s.code === code && normRoom(s.room) === normRoom(room)) return s;
    return spaceOf(code, floor, room, name);
  };
  const codeFor = (name, manifest) => {
    const c = manifest && manifest.capture && manifest.capture.buildingCode;
    if (c && buildings.has(c)) return c;
    const b = matchNameIn(list, name);
    return b ? b.code : null;
  };

  for (const p of photos) {
    if (!buildings.has(p.building_code)) continue;
    const s = spaceOf(p.building_code, p.floor, p.room, p.building_name).photos;
    const t = effectiveTaken(p);
    if (p.status === 'accepted') {
      s.accepted++;
      const slot = lightSlot(t);
      s.byLight[slot] = (s.byLight[slot] || 0) + 1;
      s.times.push(t);
    } else s.pending++;
    if (p.session) s.sessions.add(p.session);
    if (p.device) s.devices.add(p.device);
    s.users.set(p.user_id, (s.users.get(p.user_id) || 0) + 1);
    s.first = s.first == null ? t : Math.min(s.first, t);
    s.last = s.last == null ? t : Math.max(s.last, t);
  }
  for (const c of scans) {
    if (!buildings.has(c.building_code)) continue;
    const s = spaceOf(c.building_code, c.floor, c.room, c.building_name);
    s.scans.push({ grade: c.grade, photos: c.photo_count, status: c.status, created: c.created_at, user: handles.get(c.user_id) || null });
  }
  const elsewhere = []; // splats and captures that aren't in an ASU building (practice rooms, typos)
  for (const it of library) {
    const info = it.info || {};
    const m = manifestOf(jobsDir, info.jobId);
    const code = codeFor(info.building || it.building, m);
    const room = info.room || it.room;
    const build = {
      path: it.path, stamp: it.stamp, created: info.created || null, photos: info.photos || 0, placed: info.placed != null ? info.placed : info.photos || 0,
      reprojError: info.colmap ? info.colmap.reprojError : null, mode: info.colmap ? info.colmap.mode : null, points: info.colmap ? info.colmap.points : null,
      preset: info.training ? info.training.preset : null, splats: info.training ? info.training.splats : null,
      grade: info.capture ? info.capture.grade : null, gradeScore: info.capture && info.capture.score != null ? info.capture.score : null,
      // Measured quality, when it was trained with photos held back: {psnr, ssim, views, step, every}.
      eval: info.training && info.training.eval && Number.isFinite(info.training.eval.psnr) ? info.training.eval : null,
      view: info.view || null, title: `${info.building || it.building} · ${room}`,
    };
    if (!code) {
      elsewhere.push({ kind: 'splat', building: info.building || it.building, room, ...build });
      continue;
    }
    spaceByRoom(code, (m && m.capture && m.capture.floor) || '', room, buildings.get(code).name).builds.push(build);
  }
  for (const j of jobs) {
    const code = codeFor(j.building, null);
    const entry = { id: j.id, status: j.status, photos: j.summary ? j.summary.photos : null, name: j.source ? j.source.name : '' };
    if (!code) elsewhere.push({ kind: 'job', building: j.building, room: j.room, ...entry });
    else spaceByRoom(code, '', j.room || 'Unnamed', buildings.get(code).name).jobs.push(entry);
  }

  // ---- estimates per space
  const outSpaces = [];
  for (const s of spaces.values()) {
    const lastBuild = s.builds.reduce((t, b) => Math.max(t, Date.parse(b.created) || 0), 0);
    const input = {
      room: s.room,
      photos: { byLight: s.photos.byLight, devices: s.photos.devices.size || 1, pending: s.photos.pending, sinceBuild: lastBuild ? s.photos.times.filter((t) => t > lastBuild).length : 0 },
      scans: s.scans,
      builds: s.builds,
    };
    const est = M.spaceEstimate(input);
    const toGood = M.photosNeeded(input, M.GOOD), toExcellent = M.photosNeeded(input, M.EXCELLENT);
    const top = [...s.photos.users.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, n]) => ({ handle: handles.get(u) || 'former member', photos: n }));
    outSpaces.push({
      key: s.key, code: s.code, building: s.buildingName || buildings.get(s.code).name, floor: s.floor, room: s.room,
      kind: est.kind, score: est.score, band: est.band.id, source: est.source, predicted: est.predicted,
      photos: { accepted: s.photos.accepted, pending: s.photos.pending, byLight: s.photos.byLight, sessions: s.photos.sessions.size, devices: s.photos.devices.size, first: s.photos.first, last: s.photos.last, effective: +est.photos.effective.toFixed(1), dominant: est.photos.dominant, share: est.photos.share, score: est.photos.score, parts: est.photos.parts },
      scans: s.scans, scanScore: est.scan.score,
      builds: s.builds.map((b) => ({ ...b, ...M.builtEstimate(b, est.kind) })),
      built: est.built ? { score: est.built.score, parts: est.built.parts, path: est.built.path, measured: est.built.measured, eval: est.built.eval } : null,
      jobs: s.jobs, contributors: top, advice: est.advice,
      need: { good: M.photosFor(M.GOOD, est.kind), excellent: M.photosFor(M.EXCELLENT, est.kind) },
      // About how many more accepted photos, in which light (null: any one), would make it Good / Excellent.
      more: { good: toGood.n, excellent: toExcellent.n, light: toExcellent.light },
    });
  }

  // ---- buildings and campuses
  const byCode = new Map();
  for (const s of outSpaces) (byCode.get(s.code) || byCode.set(s.code, []).get(s.code)).push(s);
  const outBuildings = list.map((b) => {
    const sp = byCode.get(b.code) || [];
    const def = M.defaultPlan(b);
    const planned = plans[b.code] != null ? plans[b.code] : def.spaces;
    const prog = M.buildingProgress(sp.map((s) => s.score), planned);
    const light = Object.fromEntries(LIGHT_SLOTS.map((k) => [k, sp.reduce((n, s) => n + (s.photos.byLight[k] || 0), 0)]));
    const users = new Set();
    for (const s of sp) for (const c of s.contributors) users.add(c.handle);
    return {
      code: b.code, name: b.name, ref: b.ref || null, campus: b.campus, c: b.c, poly: b.poly, restricted: b.restricted || null,
      area: b.area || null, levels: b.levels || null,
      plan: { ...def, spaces: planned, set: plans[b.code] != null, default: def.spaces },
      completion: b.restricted ? 0 : prog.completion, credit: prog.credit, good: prog.good, started: prog.started, spaces: sp.length,
      best: sp.reduce((m, s) => Math.max(m, s.score), 0),
      photos: sp.reduce((n, s) => n + s.photos.accepted, 0), pending: sp.reduce((n, s) => n + s.photos.pending, 0),
      scans: sp.reduce((n, s) => n + s.scans.length, 0), builds: sp.reduce((n, s) => n + s.builds.length, 0), jobs: sp.reduce((n, s) => n + s.jobs.length, 0),
      light, contributors: users.size,
    };
  });
  const campuses = [...new Set(list.map((b) => b.campus))].map((id) => {
    const bs = outBuildings.filter((b) => b.campus === id && !b.restricted);
    const planned = bs.reduce((n, b) => n + b.plan.spaces, 0);
    return {
      id, buildings: bs.length, started: bs.filter((b) => b.spaces > 0).length, planned,
      credit: +bs.reduce((n, b) => n + b.credit, 0).toFixed(2), completion: planned ? bs.reduce((n, b) => n + b.credit, 0) / planned : 0,
      good: bs.reduce((n, b) => n + b.good, 0),
    };
  });

  // ---- where photos and scans were taken (GPS), and activity per day
  const points = [
    ...photos.filter((p) => p.lat != null && buildings.has(p.building_code)).map((p) => ({ lat: p.lat, lon: p.lon, acc: p.gps_accuracy_m, kind: 'photo', status: p.status, code: p.building_code, t: effectiveTaken(p) })),
    ...scans.filter((c) => c.lat != null && buildings.has(c.building_code)).map((c) => ({ lat: c.lat, lon: c.lon, acc: c.gps_accuracy_m, kind: 'scan', status: c.status, code: c.building_code, t: Date.parse(c.created_at) })),
  ];
  const days = new Map();
  const day = (t) => {
    const d = phoenixDay(t);
    if (!days.has(d)) days.set(d, { day: d, photos: 0, accepted: 0, pending: 0, scans: 0, builds: 0, byLight: {} });
    return days.get(d);
  };
  for (const p of photos) {
    const d = day(Date.parse(p.created_at));
    d.photos++;
    d[p.status === 'accepted' ? 'accepted' : 'pending']++;
    const slot = lightSlot(effectiveTaken(p));
    d.byLight[slot] = (d.byLight[slot] || 0) + 1;
  }
  for (const c of scans) day(Date.parse(c.created_at)).scans++;
  for (const it of library) if (it.info && it.info.created) day(Date.parse(it.info.created)).builds++;

  return {
    generatedAt: new Date().toISOString(), club: !!club, clubError, notes, published: loadPublished(workDir),
    totals: {
      photos: photos.filter((p) => p.status === 'accepted').length, pending: photos.filter((p) => p.status === 'new').length,
      scans: scans.length, builds: library.length, contributors: new Set([...photos, ...scans].map((x) => x.user_id)).size,
    },
    campuses, buildings: outBuildings, spaces: outSpaces, elsewhere, points,
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    model: {
      bands: M.BANDS, good: M.GOOD, excellent: M.EXCELLENT, minPhotos: M.MIN_PHOTOS, psnrStops: M.PSNR_STOPS,
      kinds: Object.fromEntries(Object.entries(M.KINDS).map(([k, v]) => [k, { ...v, good: M.photosFor(M.GOOD, k), excellent: M.photosFor(M.EXCELLENT, k), curve: M.curvePoints(k) }])),
    },
  };
}

// ------------------------------------------------------------------------------------ the summary members see
const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100000, Math.round(v))) : v > 0 ? 100000 : 0);

/**
 * The rows the phones' Campus map reads (crowd/supabase-campus.sql), from campusData(): every space in a
 * building that can be photographed, with its expected quality, accepted photos per light and about how many
 * more (in which light) would make it Good, plus the plans the club set. Counts only: no handles, no GPS.
 * @param {string} at the time of this publish (rows older than it are removed afterwards)
 */
export function summaryRows(data, at = new Date().toISOString()) {
  const open = new Set(data.buildings.filter((b) => !b.restricted).map((b) => b.code));
  const spaces = data.spaces.filter((x) => open.has(x.code)).map((x) => ({
    space_key: x.key.slice(0, 200), building_code: x.code, floor: (x.floor || '').slice(0, 20), room: (x.room || 'Unnamed').slice(0, 80),
    kind: x.kind, score: x.score, band: x.band,
    ...Object.fromEntries(LIGHT_SLOTS.map((k) => [k, count(x.photos.byLight[k] || 0)])),
    pending: count(x.photos.pending), scans: count(x.scans.length), builds: count(x.builds.length), queued: count(x.jobs.length),
    need_good: count(x.more.good), need_excellent: count(x.more.excellent), need_light: x.more.light || null,
    updated_at: at,
  }));
  const plans = data.buildings.filter((b) => b.plan.set).map((b) => ({ building_code: b.code, spaces: b.plan.spaces, updated_at: at }));
  return { spaces, plans };
}

/**
 * Publish the summary for members with the secret key: upsert every row, then remove what is no longer there
 * (a space whose photos were all rejected, a plan set back to the default). A view built without the club's
 * photos (database not set up or not reachable) is never published: it would wipe the members' map.
 * @returns {Promise<{at: string, spaces: number, plans: number}>}
 */
export async function publishSummary(club, data) {
  if (!club || !data.club || data.clubError) throw new Error(`The club database couldn’t be read${data.clubError ? ` (${data.clubError})` : ''}, so nothing was published.`);
  const at = new Date().toISOString();
  const rows = summaryRows(data, at);
  try {
    for (const [table, list] of [['campus_spaces', rows.spaces], ['campus_plans', rows.plans]]) {
      for (let i = 0; i < list.length; i += 500) {
        await call(club, `/rest/v1/${table}`, { method: 'POST', body: list.slice(i, i + 500), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
      }
      await call(club, `/rest/v1/${table}?updated_at=lt.${encodeURIComponent(at)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  } catch (e) {
    if (/campus_(spaces|plans)/.test(e.message) && /could not find|does not exist|schema cache/i.test(e.message)) {
      throw new Error('The club database has no campus tables yet: run crowd/supabase-campus.sql in the Supabase SQL editor (after supabase-beta.sql).');
    }
    throw e;
  }
  return { at, spaces: rows.spaces.length, plans: rows.plans.length };
}
