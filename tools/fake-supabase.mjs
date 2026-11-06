// An in-memory stand-in for the club's Supabase project: the calls the phone app and SplatStation make,
// with the rules that matter to them (membership, restricted buildings, files only into your own
// unfinished photo, points only from SplatStation, the campus summary readable by members and written only by
// SplatStation). It lets the self-checks run without a network and
// lets the screens be tried in a browser (tools/serve.mjs serves it at /__tools/fake-supabase.mjs).
// The real rules live in crowd/supabase-*.sql and are tested against Postgres (tools/sql-test.mjs).

export const FAKE_HOST = 'fake.supabase.co';
export const FAKE_URL = 'https://' + FAKE_HOST;

const json = (v, status = 200) => new Response(v == null ? null : JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const rls = (table) => json({ code: '42501', message: `new row violates row-level security policy for table "${table}"` }, 403);
const bad = (message, code = 'P0001') => json({ code, message }, 400);

const PHX = -7 * 3600e3;
const weekStart = (ms) => {
  const d = new Date(ms + PHX);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) - PHX;
};

export function createFake() {
  const db = {
    profiles: new Map(), invites: new Map(), restricted_buildings: new Map(), missions: new Map(), photos: new Map(), captures: new Map(),
    campus_spaces: new Map(), campus_plans: new Map(), // the summary SplatStation publishes (crowd/supabase-campus.sql)
    files: new Map(), // 'bucket/path' -> Buffer
    posts: new Map(), // 'bucket/path' -> times a file was sent
    failOnce: new Set(), // path endings whose next upload is refused (a 400)
    flaky: new Set(), // path endings whose next upload gets a 503 (a busy server: worth retrying)
    tokens: new Map(), users: 0,
    clock: () => Date.now(),
  };
  const tables = { profiles: [db.profiles, 'user_id'], invites: [db.invites, 'code'], restricted_buildings: [db.restricted_buildings, 'code'], missions: [db.missions, 'id'], photos: [db.photos, 'id'], captures: [db.captures, 'id'],
    campus_spaces: [db.campus_spaces, 'space_key'], campus_plans: [db.campus_plans, 'building_code'] };
  const CAMPUS = new Set(['campus_spaces', 'campus_plans']);

  const compare = (a, b) => (typeof a === 'number' && !isNaN(+b) ? a - +b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
  function matches(val, spec) {
    const dot = spec.indexOf('.');
    const op = spec.slice(0, dot), arg = spec.slice(dot + 1);
    switch (op) {
      case 'eq': return String(val) === arg;
      case 'neq': return String(val) !== arg;
      case 'in': return arg.slice(1, -1).split(',').includes(String(val));
      case 'is': return arg === 'null' ? val == null : String(val) === arg;
      case 'not': return !matches(val, arg);
      case 'gte': return compare(val, arg) >= 0;
      case 'lte': return compare(val, arg) <= 0;
      case 'gt': return compare(val, arg) > 0;
      case 'lt': return compare(val, arg) < 0;
      default: throw new Error(`fake Supabase: filter ${op} isn't supported`);
    }
  }
  function select(rows, params) {
    let out = rows.filter((r) => [...params].every(([k, v]) => ['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k) || matches(r[k], v)));
    const order = params.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      out = out.sort((a, b) => compare(a[col] ?? '', b[col] ?? '') * (dir === 'desc' ? -1 : 1));
    }
    const off = +(params.get('offset') || 0), lim = params.get('limit') ? +params.get('limit') : Infinity;
    out = out.slice(off, off + lim);
    const cols = params.get('select');
    if (cols && cols !== '*') {
      const want = cols.split(',');
      out = out.map((r) => Object.fromEntries(want.map((c) => [c, r[c]])));
    }
    return out;
  }

  const member = (uid) => {
    const p = db.profiles.get(uid);
    return p && !p.banned ? p : null;
  };
  const restricted = (code) => db.restricted_buildings.has(code);

  // ---- views
  const leaderboard = (since = 0) => {
    const pts = new Map();
    const add = (row, kind) => {
      const e = pts.get(row.user_id) || { points: 0, photos: 0, scans: 0 };
      e.points += row.points;
      e[kind]++;
      pts.set(row.user_id, e);
    };
    for (const p of db.photos.values()) if (p.status === 'accepted' && (!since || Date.parse(p.reviewed_at) >= since)) add(p, 'photos');
    for (const c of db.captures.values()) if (['approved', 'processed'].includes(c.status) && (!since || Date.parse(c.reviewed_at) >= since)) add(c, 'scans');
    return [...db.profiles.values()].filter((p) => !p.banned)
      .map((p) => ({ handle: p.handle, ...(pts.get(p.user_id) || { points: 0, photos: 0, scans: 0 }) }))
      .sort((a, b) => b.points - a.points || a.handle.localeCompare(b.handle));
  };
  const missionsOpen = () => [...db.missions.values()].filter((m) => m.active && (!m.ends_at || Date.parse(m.ends_at) > db.clock()))
    .map((m) => ({ ...m, done: [...db.photos.values()].filter((p) => p.status === 'accepted' && p.mission_id === m.id).length }));

  async function handle(req) {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;
    const key = req.headers.get('apikey') || '';
    const admin = key.startsWith('sb_secret_');
    const uid = admin ? null : db.tokens.get((req.headers.get('authorization') || '').replace(/^Bearer /, '')) || null;
    const body = async () => {
      const t = await req.text();
      try {
        return t ? JSON.parse(t) : null;
      } catch {
        return t;
      }
    };

    // ---- auth
    if (p === '/auth/v1/signup') {
      const id = `00000000-0000-4000-8000-${String(++db.users).padStart(12, '0')}`;
      const token = 'phone-' + id;
      db.tokens.set(token, id);
      return json({ access_token: token, refresh_token: 'r-' + id, expires_in: 3600, user: { id, is_anonymous: true } });
    }
    if (p.startsWith('/auth/v1/token')) {
      const { refresh_token: rt } = (await body()) || {};
      const id = (rt || '').replace(/^r-/, '');
      if (![...db.tokens.values()].includes(id)) return json({ error_description: 'Invalid Refresh Token' }, 400);
      return json({ access_token: 'phone-' + id, refresh_token: rt, expires_in: 3600, user: { id } });
    }
    if (!admin && !uid) return json({ message: 'permission denied (not signed in)' }, 401);

    // ---- REST
    let mm = p.match(/^\/rest\/v1\/rpc\/join_club$/);
    if (mm && m === 'POST') {
      const { p_handle: handle, p_code: code, p_consent: consent } = await body();
      if (!uid) return bad('Not signed in');
      if (db.profiles.has(uid)) return json(db.profiles.get(uid));
      if (!/^[A-Za-z0-9_]{3,20}$/.test(handle || '')) return bad('A handle is 3 to 20 letters, numbers or underscores');
      if (!consent) return bad('Agree to the rules first');
      const inv = db.invites.get(String(code || '').trim().toUpperCase());
      if (!inv || !inv.active || inv.uses >= inv.max_uses) return bad("That invite code isn't valid, or it has been used up");
      if ([...db.profiles.values()].some((x) => x.handle.toLowerCase() === handle.toLowerCase())) return bad('That handle is taken, try another');
      inv.uses++;
      const prof = { user_id: uid, handle, invite_code: inv.code, consent_version: consent, consent_at: new Date(db.clock()).toISOString(), banned: false, created_at: new Date(db.clock()).toISOString() };
      db.profiles.set(uid, prof);
      return json(prof);
    }
    mm = p.match(/^\/rest\/v1\/(leaderboard|leaderboard_week|missions_open)$/);
    if (mm && m === 'GET') {
      if (!uid && !admin) return json({ message: 'permission denied' }, 401);
      if (!admin && !member(uid)) return json([]); // the views show members only
      const rows = mm[1] === 'missions_open' ? missionsOpen() : leaderboard(mm[1] === 'leaderboard_week' ? weekStart(db.clock()) : 0);
      return json(select(rows, url.searchParams));
    }
    mm = p.match(/^\/rest\/v1\/(\w+)$/);
    if (mm && tables[mm[1]]) {
      const name = mm[1], [map, pk] = tables[name];
      const own = (r) => admin || name === 'restricted_buildings' || r.user_id === uid;
      if (!admin && ['invites', 'missions'].includes(name)) return json({ code: '42501', message: `permission denied for table ${name}` }, 403);
      if (!admin && CAMPUS.has(name)) {
        // Members read the campus summary (a stranger gets no rows); only the secret key writes it.
        if (m !== 'GET') return json({ code: '42501', message: `permission denied for table ${name}` }, 403);
        return json(member(uid) ? select([...map.values()], url.searchParams) : []);
      }
      if (m === 'GET') return json(select([...map.values()].filter(own), url.searchParams));
      if (m === 'POST') {
        const rows = [].concat(await body());
        const keep = (req.headers.get('prefer') || '').includes('return=representation');
        for (const row of rows) {
          if (!admin) {
            if (!['photos', 'captures'].includes(name)) return json({ code: '42501', message: `permission denied for table ${name}` }, 403);
            if (!member(uid) || restricted(row.building_code) || row.status !== 'uploading' || (row.points || 0) !== 0 || row.reviewed_at || row.review_note) return rls(name);
            if (name === 'photos' && [...db.photos.values()].filter((x) => x.user_id === uid && db.clock() - Date.parse(x.created_at) < 864e5).length >= 400) return rls(name);
            row.user_id = uid;
          }
          if (map.has(row[pk]) && !(req.headers.get('prefer') || '').includes('merge-duplicates')) return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
          const defaults = name === 'photos' ? { points: 0, file_removed: false, review_note: null, reviewed_at: null }
            : name === 'captures' ? { points: 0, reviewed_at: null }
            : name === 'missions' ? { id: crypto.randomUUID(), detail: '', light: 'any', bonus: 2, wanted: 20, active: true, floor: '', room: '', building_code: null, ends_at: null }
            : name === 'invites' ? { label: '', max_uses: 25, uses: 0, active: true }
            : {};
          map.set(row[pk] ?? defaults[pk], { ...defaults, created_at: new Date(db.clock()).toISOString(), ...row });
        }
        return keep ? json(rows.map((r) => map.get(r[pk] ?? [...map.values()].at(-1)[pk]))) : json(null, 201);
      }
      if (m === 'PATCH' || m === 'DELETE') {
        const hit = select([...map.values()].filter(own), new URLSearchParams([...url.searchParams].filter(([k]) => !['select', 'order', 'limit'].includes(k))));
        if (m === 'PATCH') {
          const patch = await body();
          for (const r of hit) {
            if (!admin) {
              if (Object.keys(patch).some((k) => k !== 'status')) return json({ code: '42501', message: `permission denied for table ${name}` }, 403);
              if (r.status !== 'uploading' || !['uploading', 'new'].includes(patch.status)) continue; // not visible to the policy: no rows change
            }
            Object.assign(r, patch);
          }
        } else for (const r of hit) map.delete(r[pk]);
        return json(null, 204);
      }
    }

    // ---- storage
    mm = p.match(/^\/storage\/v1\/object\/(captures|club-photos)\/(.+)$/);
    if (mm) {
      const bucket = mm[1], path = decodeURIComponent(mm[2]), k = `${bucket}/${path}`;
      if (m === 'POST') {
        db.posts.set(k, (db.posts.get(k) || 0) + 1);
        const fail = [...db.failOnce].find((s) => path.endsWith(s));
        if (fail && db.failOnce.delete(fail)) return json({ message: 'simulated: connection dropped' }, 400);
        const busy = [...db.flaky].find((s) => path.endsWith(s));
        if (busy && db.flaky.delete(busy)) return json({ message: 'simulated: server busy' }, 503);
        if (!admin) {
          const [table, field, prefixed] = bucket === 'captures' ? [db.captures, 'storage_prefix', true] : [db.photos, 'storage_path', false];
          const ok = [...table.values()].some((r) => r.user_id === uid && r.status === 'uploading' && (prefixed ? path.startsWith(r[field] + '/') : path === r[field]));
          if (!ok) return rls('objects');
        }
        if (db.files.has(k)) return json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, 400);
        const data = await req.arrayBuffer();
        db.files.set(k, new Uint8Array(data));
        return json({ Key: k });
      }
      if (m === 'GET') return db.files.has(k) ? new Response(db.files.get(k)) : json({ message: 'not found' }, 404);
    }
    mm = p.match(/^\/storage\/v1\/object\/(captures|club-photos)$/);
    if (mm && m === 'DELETE') {
      const { prefixes } = await body();
      const gone = [];
      for (const path of prefixes) if (db.files.delete(`${mm[1]}/${path}`)) gone.push({ name: path });
      return json(gone);
    }
    mm = p.match(/^\/storage\/v1\/object\/list\/(captures|club-photos)$/);
    if (mm && m === 'POST') {
      const { prefix } = await body();
      const seen = new Map();
      for (const k of db.files.keys()) {
        const path = k.slice(mm[1].length + 1);
        if (!path.startsWith(prefix + '/')) continue;
        const [first, ...rest] = path.slice(prefix.length + 1).split('/');
        seen.set(first, rest.length ? { name: first, id: null } : { name: first, id: k });
      }
      return json([...seen.values()]);
    }
    return json({ message: `fake Supabase doesn't know ${m} ${p}` }, 500);
  }

  return {
    db,
    /** fetch() for the fake host. */
    fetch: async (input, init = {}) => handle(new Request(input, init)),
    /** Make `g.fetch` answer for the fake host; everything else goes to the real fetch (or `passthrough`). */
    install(g = globalThis, passthrough = g.fetch) {
      g.fetch = (input, init) => {
        const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        return u.host === FAKE_HOST ? this.fetch(input, init) : passthrough.call(g, input, init);
      };
    },
  };
}
