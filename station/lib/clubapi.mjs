// The club's admin API for the SplatStation page (/club.html): review photos, points, missions, invites,
// members, restricted buildings, and building a capture from a room's accepted photos. Everything here
// uses the project's secret key, so it only answers requests from this PC (not from the Wi-Fi).

import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import * as crowd from './crowd.mjs';
import * as club from './club.mjs';
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

export const awardScan = (o) => scoreScan(o);

const syncState = { running: false, fraction: 0, text: '', result: null, error: null };
const busy = new Set(); // photo ids being reviewed (two clicks must not award twice)

/**
 * @param {object} ctx {req, res, path, url, cfg, readBody, sendJson, say, scanInbox, version}
 */
export async function handleClub(ctx) {
  const { req, res, path, cfg, readBody, sendJson, say, scanInbox, version } = ctx;
  if (!isLocal(req)) return sendJson(res, { error: 'The club tools only work on the PC running SplatStation.' }, 403);
  if (path === '/api/club/buildings') {
    return sendJson(res, [...buildings().values()].map(({ code, name, campus, restricted }) => ({ code, name, campus, restricted: restricted || null })));
  }
  const c = crowd.crowdConfig(cfg.workDir);
  if (c.error) return sendJson(res, { configured: false, error: c.error });
  const post = req.method === 'POST' ? await readBody(req) : {};
  try {
    // Local copies of photos, for the review grid.
    const f = path.match(/^\/api\/club\/(thumb|image)\/([0-9a-f-]{36})$/);
    if (f) {
      const dir = club.clubDir(cfg.workDir);
      const file = (f[1] === 'thumb' ? club.thumbFile : club.photoFile)(dir, f[2]);
      if (!existsSync(file)) return sendJson(res, { error: 'Not on this PC yet: press Sync' }, 404);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return createReadStream(file).pipe(res);
    }

    switch (path) {
      case '/api/club': {
        const [photos, profiles] = await Promise.all([crowd.listAll(c, '/rest/v1/photos?select=status'), crowd.listAll(c, '/rest/v1/profiles?select=user_id')]);
        const n = (s) => photos.filter((p) => p.status === s).length;
        return sendJson(res, { configured: true, stats: { members: profiles.length, uploading: n('uploading'), new: n('new'), accepted: n('accepted'), rejected: n('rejected') }, ffmpeg: !!(cfg.tools && cfg.tools.ffmpeg) });
      }
      case '/api/club/photos':
        return sendJson(res, { photos: await club.reviewList(c, cfg, buildings()) });

      case '/api/club/sync':
        if (req.method === 'GET') return sendJson(res, syncState);
        if (syncState.running) return sendJson(res, { error: 'Already syncing' }, 409);
        Object.assign(syncState, { running: true, fraction: 0, text: 'Starting…', result: null, error: null });
        club.sync(c, cfg, { say, onProgress: (fr, text) => Object.assign(syncState, { fraction: fr, text }) })
          .then((r) => {
            syncState.result = r;
            say(`Club photos: ${r.downloaded} downloaded${r.failed ? `, ${r.failed} failed` : ''}.`);
          })
          .catch((e) => (syncState.error = e.message))
          .finally(() => (syncState.running = false));
        return sendJson(res, { started: true });

      case '/api/club/review': {
        const ids = (post.ids || []).filter((id) => /^[0-9a-f-]{36}$/.test(id));
        if (!ids.length) return sendJson(res, { error: 'No photos chosen' }, 400);
        if (ids.some((id) => busy.has(id))) return sendJson(res, { error: 'Those photos are being reviewed already' }, 409);
        ids.forEach((id) => busy.add(id));
        try {
          const r = await club.review(c, cfg, { ids, action: post.action, note: String(post.note || '').slice(0, 200) });
          say(`Club review: ${post.action} ${r.changed} photo(s)${r.points ? `, ${r.points} points awarded` : ''}.`);
          if (r.changed && ctx.onPhotosChanged) ctx.onPhotosChanged(); // members' Campus map follows
          return sendJson(res, { ok: true, ...r });
        } finally {
          ids.forEach((id) => busy.delete(id));
        }
      }
      case '/api/club/free-cloud': {
        const r = await club.freeCloud(c, cfg);
        say(`Club: removed ${r.photos} photos (${(r.bytes / 1048576).toFixed(0)} MB) from the cloud; they stay on this PC.`);
        return sendJson(res, { ok: true, ...r });
      }
      case '/api/club/build': {
        const r = await club.buildCapture(c, cfg, { building_code: String(post.building_code || ''), floor: String(post.floor || ''), room: String(post.room || '') }, cfg.dirs.inbox, version);
        say(`Club photos of ${post.room || post.building_code}: ${r.photos} photos from ${r.contributors.join(', ')} are in Ready to process${r.ar && r.ar.session ? `, ${r.ar.photos} with AR positions to start the camera solve from` : ''}.`);
        setTimeout(scanInbox, 100);
        return sendJson(res, { ok: true, ...r, file: r.file.split(/[\\/]/).pop() });
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
          say(`Club: removed a member and ${r.photos} photo(s).`);
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
    return sendJson(res, { error: e.message }, 500);
  }
}
