// Dev tool: the in-memory Supabase stand-in (tools/fake-supabase.mjs) as a local web server, so the real
// phone app and SplatStation can be tried together without touching the real club project:
//
//   node tools/fake-supabase-server.mjs [port]            (default 9999)
//
// Then point the phone app at it (in the browser console of http://localhost:8081:
//   (await import('/js/data/crowd.js')).CROWD.url = 'http://localhost:9999')
// and put {"url": "http://localhost:9999", "secretKey": "sb_secret_demo"} in the station's crowd.json.
// Everything lives in memory and is gone when the server stops. Invite code CLUB-DEMO works.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createFake } from './fake-supabase.mjs';

const port = Number(process.argv[2]) || 9999;
const fake = createFake();
fake.db.invites.set('CLUB-DEMO', { code: 'CLUB-DEMO', label: 'demo', max_uses: 50, uses: 0, active: true });
if (process.argv.includes('--demo')) demo();

/**
 * --demo: made-up members ("Demo_…") and the scans they sent around a few Tempe buildings, so the Campus and
 * Club pages have something to show: some approved, some waiting for the club, one turned down. Rows only (no
 * files), spread over the last four weeks and all four kinds of light.
 */
function demo() {
  const list = JSON.parse(readFileSync(new URL('../app/data/asu-buildings.json', import.meta.url), 'utf8')).buildings;
  const at = (name) => list.find((b) => b.name === name);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const users = ['Demo_Fox', 'Demo_Owl', 'Demo_Hawk', 'Demo_Gecko'].map((handle, i) => {
    const id = `de000000-0000-4000-8000-00000000000${i}`;
    fake.db.profiles.set(id, { user_id: id, handle, banned: false, created_at: new Date(Date.now() - 30 * 864e5).toISOString() });
    return [id, handle];
  });
  const HOURS = { morning: 9, afternoon: 13, evening: 18, night: 21 };
  const day = 864e5, now = Date.now();
  // [building, floor, room, grade, photos, status, days ago, light, points when approved]
  const plan = [
    ['Hayden Library', '1', 'Main lobby', 'A', 420, 'approved', 12, 'afternoon', 60],
    ['Hayden Library', '2', 'Reading room', 'B', 380, 'processed', 3, 'morning', 0],
    ['Hayden Library', '3', 'Hallway', 'B', 260, 'new', 1, 'evening', 0],
    ['Memorial Union', '1', 'Food court', 'A', 350, 'approved', 9, 'evening', 42],
    ['Memorial Union', '2', 'Ballroom foyer', 'B', 380, 'new', 2, 'afternoon', 0],
    ['Old Main', '1', 'Main hall', 'A', 410, 'approved', 20, 'morning', 51],
    ['Biodesign Institute Building A', '1', 'Atrium', 'B', 300, 'rejected', 6, 'night', 0],
    ['Armstrong Hall', '1', 'Lobby', 'A', 280, 'new', 0, 'morning', 0],
  ];
  let k = 0;
  for (const [bname, floor, room, grade, photos, status, daysAgo, light, points] of plan) {
    const b = at(bname);
    if (!b) continue;
    const [user, handle] = users[Math.floor(rnd() * users.length)];
    const base = new Date(now - daysAgo * day);
    const t = Math.min(now - 6e4, Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), HOURS[light] + 7, Math.floor(rnd() * 50)));
    const id = `5ca00000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
    const done = status === 'approved' || status === 'rejected';
    fake.db.captures.set(id, {
      id, user_id: user, created_at: new Date(t).toISOString(), building_code: b.code, building_name: b.name, floor, room, photo_count: photos, grade, status,
      points: status === 'approved' ? points : 0, reviewed_at: done ? new Date(Math.min(now, t + day)).toISOString() : null, review_note: status === 'rejected' ? 'A person is in the scan' : null,
      contributor: handle, lat: b.c[0] + (rnd() - 0.5) * 0.0003, lon: b.c[1] + (rnd() - 0.5) * 0.0003, gps_accuracy_m: Math.round(8 + rnd() * 20), storage_prefix: `${b.code}/x/${id}`,
    });
  }
  console.log(`Demo data: ${fake.db.captures.size} scans, ${users.length} demo members`);
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, prefer, x-upsert, range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  try {
    const r = await fake.fetch(`http://localhost:${port}${req.url}`, {
      method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' || !body.length ? undefined : body,
    });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ message: String(e.message || e) }));
  }
}).listen(port, () => console.log(`Fake Supabase (in memory): http://localhost:${port}   invite code CLUB-DEMO`));
