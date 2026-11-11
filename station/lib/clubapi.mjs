// The club's admin API for the SplatStation page (/club.html): the scans members send and the review of the
// splats built from them (approve: points and the campus map; or not, with a note), how full the club's cloud
// storage is and freeing a reviewed scan's copy there, missions, invites, members and restricted buildings.
// Everything here uses the project's secret key, so it only answers requests from this PC (not from the Wi-Fi).

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import * as crowd from './crowd.mjs';
import * as club from './club.mjs';
import { readZipText } from './zipread.mjs';
import { approvalFacts, normRoom } from './campus.mjs';
import { scoreScan } from '../../app/js/core/clubrules.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Whether a request comes from this PC: the loopback address, or this PC's own address on the network
 * (the dashboard opened by its Wi-Fi address on the PC itself). Other devices on the Wi-Fi are not local.
 */
export function isLocal(req) {
  const from = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (from === '127.0.0.1' || from === '::1') return true;
  return Object.values(networkInterfaces()).some((list) => (list || []).some((i) => i.address === from));
}

let buildingList = null;
/** ASU buildings by code (the same list the phone uses). */
export const buildings = () =>
  (buildingList ||= new Map(JSON.parse(readFileSync(join(HERE, '..', '..', 'app', 'data', 'asu-buildings.json'), 'utf8')).buildings.map((b) => [b.code, b])));

const busy = new Set(); // scans being imported or reviewed (two clicks must not award twice)

/** The job and the library splat made from a member's scan (the ZIP's name carries its id). */
function localOf(row, library, jobs) {
  const tag = `club-${row.id.slice(0, 8)}`;
  const job = jobs.find((j) => (j.club && j.club.id === row.id) || String((j.source && (j.source.name || (j.source.file && basename(j.source.file)))) || '').includes(tag)) || null;
  const item = library.find((it) => it.info && it.info.club && it.info.club.id === row.id) || null;
  return { job, item };
}

const zipScan = new Map(); // '<file>|<size>|<changed>' -> the club scan a ZIP holds (the id in its manifest), or null
/** Which member's scan a ZIP on this PC is: importUpload wrote the scan's id into its splatscout.json. */
async function scanIn(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!zipScan.has(key)) {
    let id = null;
    try {
      const m = JSON.parse(await readZipText(file, 'splatscout.json'));
      id = (m.club && m.club.id) || null;
    } catch {}
    zipScan.set(key, id);
  }
  return zipScan.get(key);
}

/**
 * This PC's own copy of a member's scan: the ZIP it was imported as, kept in its job's folder for as long as
 * the job is in History (or still in the inbox, a moment after importing). {name, in: 'job'|'inbox'}, or null
 * when there is none (never imported here, or its jobs were deleted): then the photos are only in the cloud.
 * The page says which before it frees a cloud copy, so a ZIP only counts when its manifest names this scan
 * (the eight characters of the id in its file name could be another scan's).
 */
async function zipOf(row, jobs, inbox) {
  const tag = `club-${row.id.slice(0, 8)}`;
  for (const j of jobs) {
    const mine = !!j.source && !j.source.parts && !!j.club && j.club.id === row.id; // processed here as this scan (a ZIP that was renamed)
    for (const s of j.source ? j.source.parts || [j.source] : []) {
      if (!s.file || !/\.zip$/i.test(s.file) || !(mine || basename(s.file).includes(tag))) continue;
      if ((await scanIn(s.file)) === row.id) return { name: basename(s.file), in: 'job' };
    }
  }
  let waiting = [];
  try {
    waiting = readdirSync(inbox).filter((n) => !n.startsWith('.') && n.includes(tag) && /\.zip$/i.test(n));
  } catch {}
  for (const name of waiting) if ((await scanIn(join(inbox, name))) === row.id) return { name, in: 'inbox' };
  return null;
}

const mb = (bytes) => {
  const n = bytes / 1048576;
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} MB`;
};
/** What the page is told when a request can't be done as asked (anything else is a 500). */
const REFUSED = { 'not-reviewed': 409, 'no-cloud-copy': 410 };

/**
 * What approving a scan would earn: its grade, the floor it adds to the campus map (none for a space already
 * Good, a rescan) and an open mission for its space. From the campus view, where its splat still waits.
 */
function pointsFor(row, item, data, missions) {
  const f = item && data ? approvalFacts(data, item.path) : null;
  const mission = missions.find((m) => m.active && (!m.ends_at || Date.parse(m.ends_at) > Date.now()) && m.building_code === row.building_code && (!m.room || normRoom(m.room) === normRoom(row.room))) || null;
  const pts = scoreScan({ grade: row.grade || '', newArea: f ? f.newArea : 0, rescan: f ? f.rescan : false, mission });
  return { ...pts, facts: f ? { score: f.build.score, band: f.build.band || null, measured: !!f.build.measured, newArea: Math.round(f.newArea), rescan: f.rescan, space: f.space.key } : null };
}

/**
 * @param {object} ctx {req, res, path, url, cfg, readBody, sendJson, say, scanInbox, version,
 *   library(): this PC's splats, jobs(): its jobs, campus(c): the campus view, onCampusChanged(): publish for members}
 */
export async function handleClub(ctx) {
  const { req, res, path, cfg, readBody, sendJson, say, scanInbox } = ctx;
  if (!isLocal(req)) return sendJson(res, { error: 'The club tools only work on the PC running SplatStation.' }, 403);
  if (path === '/api/club/buildings') {
    return sendJson(res, [...buildings().values()].map(({ code, name, campus, restricted }) => ({ code, name, campus, restricted: restricted || null })));
  }
  const c = crowd.crowdConfig(cfg.workDir);
  if (c.error) return sendJson(res, { configured: false, error: c.error });
  const post = req.method === 'POST' ? await readBody(req) : {};
  try {
    switch (path) {
      case '/api/club': {
        const [scans, profiles] = await Promise.all([crowd.listAll(c, '/rest/v1/captures?select=status'), crowd.listAll(c, '/rest/v1/profiles?select=user_id')]);
        const n = (s) => scans.filter((x) => x.status === s).length;
        return sendJson(res, { configured: true, stats: { members: profiles.length, uploading: n('uploading'), new: n('new'), processed: n('processed'), approved: n('approved'), rejected: n('rejected') } });
      }

      case '/api/club/scans': {
        // Every scan with what this PC made of it, and what approving its splat would earn.
        const [rows, missions] = await Promise.all([club.listScans(c), club.listMissions(c)]);
        const library = ctx.library(), jobs = ctx.jobs();
        const data = rows.some((r) => localOf(r, library, []).item) ? await ctx.campus(c) : null;
        const scans = [];
        for (const row of rows) {
          const { job, item } = localOf(row, library, jobs);
          scans.push({
            ...row, busy: busy.has(row.id),
            job: job ? { id: job.id, status: job.status, stage: job.stage || null, error: job.error || null } : null,
            splat: item ? { path: item.path, title: `${item.info.building || item.building} · ${item.info.room || item.room}`, created: item.info.created || null, view: item.info.view || null, review: item.info.review || null } : null,
            award: item && row.status !== 'approved' && row.status !== 'rejected' ? pointsFor(row, item, data, missions) : null,
            zip: await zipOf(row, jobs, cfg.dirs.inbox), // this PC's own copy of the scan, if it still has one
          });
        }
        return sendJson(res, { scans });
      }

      case '/api/club/storage':
        // How full the club's cloud storage is, and what each scan takes there (?fresh=1 measures them all again).
        return sendJson(res, await crowd.cloudUsage(c, { fresh: !!ctx.url && ctx.url.searchParams.get('fresh') === '1' }));

      case '/api/club/scan': {
        const id = String(post.id || '');
        if (!/^[0-9a-f-]{36}$/.test(id)) return sendJson(res, { error: 'Bad scan id' }, 400);
        if (busy.has(id)) return sendJson(res, { error: 'Already working on that scan' }, 409);
        busy.add(id);
        try {
          const [row] = await crowd.call(c, `/rest/v1/captures?select=id,user_id,building_code,building_name,floor,room,grade,status,points,contributor&id=eq.${encodeURIComponent(id)}`);
          if (!row && post.op !== 'delete') return sendJson(res, { error: 'That scan is no longer in the club database' }, 404);
          const place = row ? [row.building_name, row.room].filter(Boolean).join(' · ') : 'a scan';
          if (post.op === 'import') {
            let last = 0;
            const file = await crowd.importUpload(c, id, cfg.dirs.inbox, (p) => {
              if (p - last >= 0.25) say(`Club scan: downloading ${Math.round((last = p) * 100)}%`);
            });
            say(`Club scan of ${place} is in Ready to process: ${basename(file)}`);
            setTimeout(scanInbox, 100);
            return sendJson(res, { ok: true, file: basename(file) });
          }
          if (post.op === 'delete') {
            await crowd.deleteUpload(c, id);
            say(`Club: deleted the scan of ${place} from the club database.`);
            if (ctx.onCampusChanged) ctx.onCampusChanged();
            return sendJson(res, { ok: true });
          }
          if (post.op === 'free') {
            // A reviewed scan's files leave the cloud; its row stays, and with it the member's points and their
            // entry in My scans. Only ever on the reviewer's say-so (the page asks first).
            const freed = await crowd.freeUpload(c, id);
            say(`Club: freed the cloud copy of the scan of ${place} (${freed.files} files, ${mb(freed.bytes)}). Its entry in the club database stays${row.status === 'approved' ? `, and so do its ${row.points} points` : ''}.`);
            return sendJson(res, { ok: true, ...freed });
          }
          const { item } = localOf(row, ctx.library(), []);
          if (post.op === 'approve') {
            if (!item) return sendJson(res, { error: 'Build its splat first: approving puts the splat on the campus map.' }, 400);
            if (row.status === 'approved') return sendJson(res, { error: 'Already approved' }, 409);
            const award = pointsFor(row, item, await ctx.campus(c), await club.listMissions(c));
            await club.approveScan(c, id, award.points);
            club.setReview(join(cfg.dirs.library, item.path), { status: 'approved', points: award.points, parts: award.parts });
            say(`Club: approved the scan of ${place} (+${award.points} points).`);
            if (ctx.onCampusChanged) ctx.onCampusChanged();
            return sendJson(res, { ok: true, points: award.points, parts: award.parts });
          }
          if (post.op === 'reject') {
            const note = String(post.note || '').trim().slice(0, 400);
            await club.rejectScan(c, id, note);
            if (item) club.setReview(join(cfg.dirs.library, item.path), { status: 'rejected', note });
            say(`Club: didn’t approve the scan of ${place}${note ? ` (${note})` : ''}.`);
            if (ctx.onCampusChanged) ctx.onCampusChanged();
            return sendJson(res, { ok: true });
          }
          return sendJson(res, { error: 'Unknown operation' }, 400);
        } finally {
          busy.delete(id);
        }
      }

      case '/api/club/missions':
        return sendJson(res, { missions: await club.listMissions(c) });
      case '/api/club/mission': {
        if (post.op === 'create') return sendJson(res, { ok: true, mission: await club.createMission(c, post) });
        if (post.op === 'toggle') await club.updateMission(c, post.id, { active: post.active });
        else if (post.op === 'delete') await club.deleteMission(c, post.id);
        else return sendJson(res, { error: 'Unknown operation' }, 400);
        return sendJson(res, { ok: true });
      }

      case '/api/club/invites':
        return sendJson(res, { invites: await club.listInvites(c) });
      case '/api/club/invite': {
        if (post.op === 'create') return sendJson(res, { ok: true, invite: await club.createInvite(c, post) });
        if (post.op === 'toggle') await club.setInviteActive(c, String(post.code), post.active);
        else return sendJson(res, { error: 'Unknown operation' }, 400);
        return sendJson(res, { ok: true });
      }

      case '/api/club/members':
        return sendJson(res, { members: await club.listMembers(c) });
      case '/api/club/member': {
        const id = String(post.user_id || '');
        if (!/^[0-9a-f-]{36}$/.test(id)) return sendJson(res, { error: 'Bad member id' }, 400);
        if (post.op === 'rename') await club.setMember(c, id, { handle: String(post.handle || '') });
        else if (post.op === 'ban') await club.setMember(c, id, { banned: !!post.banned });
        else if (post.op === 'purge') {
          const r = await club.purgeMember(c, cfg, id);
          say(`Club: removed a member, ${r.scans} scan(s)${r.photos ? ` and ${r.photos} old photo(s)` : ''}.`);
          if (ctx.onCampusChanged) ctx.onCampusChanged();
        } else return sendJson(res, { error: 'Unknown operation' }, 400);
        return sendJson(res, { ok: true });
      }

      case '/api/club/restricted':
        if (req.method === 'GET') return sendJson(res, { restricted: await club.listRestricted(c) });
        if (post.op === 'sync') return sendJson(res, { ok: true, count: await club.syncRestricted(c, buildings()) });
        if (post.op === 'set') {
          if (!/^[a-z0-9-]{1,40}$/.test(post.code || '')) return sendJson(res, { error: 'Bad building code' }, 400);
          await club.setRestricted(c, post.code, post.reason ? String(post.reason).slice(0, 40) : null);
          return sendJson(res, { ok: true });
        }
        return sendJson(res, { error: 'Unknown operation' }, 400);
    }
    return sendJson(res, { error: 'Not found' }, 404);
  } catch (e) {
    return sendJson(res, { error: e.message }, REFUSED[e.code] || 500);
  }
}
