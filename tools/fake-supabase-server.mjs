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
 * --demo: made-up members ("Demo_…"), photos and scans around a few Tempe buildings, so the Campus page has
 * something to show. Rows only (no photo files), spread over the last four weeks and all four kinds of light.
 */
function demo() {
  const list = JSON.parse(readFileSync(new URL('../app/data/asu-buildings.json', import.meta.url), 'utf8')).buildings;
  const at = (name) => list.find((b) => b.name === name);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const users = ['Demo_Fox', 'Demo_Owl', 'Demo_Hawk', 'Demo_Gecko'].map((handle, i) => {
    const id = `de000000-0000-4000-8000-00000000000${i}`;
    fake.db.profiles.set(id, { user_id: id, handle, banned: false, created_at: new Date(Date.now() - 30 * 864e5).toISOString() });
    return id;
  });
  const HOURS = { morning: 9, afternoon: 13, evening: 18, night: 21 };
  const day = 864e5, now = Date.now();
  // [building, floor, room, {light: [accepted, waiting]}]
  const plan = [
    ['Hayden Library', '1', 'Main lobby', { afternoon: [150, 6], evening: [30, 0] }],
    ['Hayden Library', '2', 'Reading room', { morning: [70, 12] }],
    ['Hayden Library', '3', 'Hallway', { afternoon: [24, 0], night: [10, 0] }],
    ['Memorial Union', '1', 'Food court', { evening: [95, 0], afternoon: [40, 4] }],
    ['Old Main', '1', 'Main hall', { morning: [210, 0] }],
    ['Old Main', '2', 'Ballroom', { afternoon: [40, 8] }],
    ['Biodesign Institute Building A', '1', 'Atrium', { afternoon: [35, 0], evening: [35, 0], night: [30, 0] }],
    ['Armstrong Hall', '1', 'Lobby', { morning: [12, 9] }],
  ];
  let k = 0;
  for (const [bname, floor, room, lights] of plan) {
    const b = at(bname);
    if (!b) continue;
    const session = () => `5e550000-0000-4000-8000-${String(Math.floor(rnd() * 1e6)).padStart(12, '0')}`;
    for (const [light, [accepted, waiting]] of Object.entries(lights)) {
      const s1 = session(), user = users[Math.floor(rnd() * users.length)];
      for (let i = 0; i < accepted + waiting; i++) {
        const id = `d0000000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
        const dayAgo = Math.floor(rnd() * 26) + (i >= accepted ? 0 : 2);
        const base = new Date(now - dayAgo * day);
        const t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), HOURS[light] + 7, Math.floor(rnd() * 50));
        const ok = i < accepted;
        fake.db.photos.set(id, {
          id, user_id: user, created_at: new Date(t + 3e5).toISOString(), taken_at: new Date(t).toISOString(),
          building_code: b.code, building_name: b.name, floor, room, storage_path: `${b.code}/x/${id}.jpg`, session: s1, mission_id: null,
          lat: b.c[0] + (rnd() - 0.5) * 0.0004, lon: b.c[1] + (rnd() - 0.5) * 0.0004, gps_accuracy_m: Math.round(8 + rnd() * 30),
          device: 'Pixel 8', status: ok ? 'accepted' : 'new', points: ok ? 1 : 0, reviewed_at: ok ? new Date(t + 864e5).toISOString() : null, file_removed: false,
        });
      }
    }
  }
  const scan = (bname, floor, room, grade, photos, daysAgo) => {
    const b = at(bname);
    if (!b) return;
    const id = `5ca00000-0000-4000-8000-${String(++k).padStart(12, '0')}`;
    fake.db.captures.set(id, { id, user_id: users[1], created_at: new Date(now - daysAgo * day).toISOString(), building_code: b.code, building_name: b.name, floor, room, photo_count: photos, grade, status: 'approved', points: 60, reviewed_at: new Date(now - daysAgo * day).toISOString(), lat: b.c[0], lon: b.c[1], gps_accuracy_m: 15, storage_prefix: `${b.code}/x/${id}` });
  };
  scan('Memorial Union', '2', 'Ballroom foyer', 'B', 380, 5);
  scan('Durham Language and Literature Building', '1', 'Lobby', 'C', 210, 9);
  console.log(`Demo data: ${fake.db.photos.size} photos, ${fake.db.captures.size} scans, ${users.length} demo members`);
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
