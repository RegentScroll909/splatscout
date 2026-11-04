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
import { createFake } from './fake-supabase.mjs';

const port = Number(process.argv[2]) || 9999;
const fake = createFake();
fake.db.invites.set('CLUB-DEMO', { code: 'CLUB-DEMO', label: 'demo', max_uses: 50, uses: 0, active: true });

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
