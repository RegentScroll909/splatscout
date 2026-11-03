// Builds app/data/asu-buildings.json: named buildings on ASU's campuses with their outlines, from
// OpenStreetMap (© OpenStreetMap contributors, ODbL). SplatScout uses it to tell which building a
// capture is in from GPS, and to file uploads under one name per building.
//   node tools/asu-buildings.mjs [--from saved-overpass.json]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'data', 'asu-buildings.json');

// Each campus: a box to search, and (for the ones mapped as a university area) that area's name.
const CAMPUSES = [
  { id: 'Tempe', box: [33.412, -111.945, 33.43, -111.919], area: /^Arizona State University$/ },
  { id: 'Downtown Phoenix', box: [33.449, -112.078, 33.457, -112.068], area: null },
  { id: 'Polytechnic', box: [33.3, -111.686, 33.314, -111.669], area: /Polytechnic/ },
  { id: 'West Valley', box: [33.603, -112.166, 33.614, -112.154], area: /West Campus/ },
];

async function overpass() {
  const bb = (c) => c.box.join(',');
  const q = `[out:json][timeout:90];
(${CAMPUSES.map((c) => `way["building"]["name"](${bb(c)});relation["building"]["name"](${bb(c)});`).join('')});
out body geom;
(${CAMPUSES.map((c) => `wr["amenity"="university"](${bb(c)});`).join('')});
out body geom;`;
  for (const ep of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SplatScout-building-list' } }).catch(() => null);
    if (r && r.ok) return r.json();
    console.log(`${ep}: ${r ? r.status : 'no answer'}, trying the next server`);
  }
  throw new Error('No Overpass server answered; try again in a few minutes');
}

/** Outer rings of a way or multipolygon relation, as [[lat, lon], ...]. */
function rings(e) {
  if (e.type === 'way') return e.geometry ? [e.geometry.map((p) => [p.lat, p.lon])] : [];
  // Relation: join its outer member ways end to end.
  const parts = (e.members || []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry.map((p) => [p.lat, p.lon]));
  const out = [];
  while (parts.length) {
    let ring = parts.shift();
    for (let grew = true; grew && ring.length && !same(ring[0], ring[ring.length - 1]);) {
      grew = false;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], end = ring[ring.length - 1];
        if (same(p[0], end)) ring = ring.concat(p.slice(1));
        else if (same(p[p.length - 1], end)) ring = ring.concat(p.slice(0, -1).reverse());
        else continue;
        parts.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(ring);
  }
  return out;
}
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

// Metres in a local flat frame around a point (fine at campus scale).
const toXY = ([lat, lon], [lat0, lon0]) => [(lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), (lat - lat0) * 110540];

function area(ring) {
  const o = ring[0];
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = toXY(ring[j], o), [x2, y2] = toXY(ring[i], o);
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

function inRing([lat, lon], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, oi] = ring[i], [aj, oj] = ring[j];
    if (ai > lat !== aj > lat && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker to `tol` metres: outlines stay accurate to about a metre with far fewer points. */
function simplify(ring, tol = 1) {
  if (ring.length <= 4) return ring;
  const o = ring[0], xy = ring.map((p) => toXY(p, o));
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bi = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const d = L > 1e-6 ? Math.abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / L : Math.hypot(xy[i][0] - ax, xy[i][1] - ay);
      if (d > best) [best, bi] = [d, i];
    }
    if (best > tol) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
const r6 = (v) => Math.round(v * 1e6) / 1e6;

const from = process.argv.indexOf('--from');
const osm = from > 0 ? JSON.parse(readFileSync(process.argv[from + 1], 'utf8')) : await overpass();

const uni = osm.elements.filter((e) => e.tags && e.tags.amenity === 'university');
const campusRings = CAMPUSES.map((c) => (c.area ? uni.filter((u) => c.area.test(u.tags.name || '')).flatMap(rings) : null));
const inBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

const seen = new Set(), codes = new Set(), buildings = [];
for (const e of osm.elements) {
  if (!e.tags || !e.tags.building || !e.tags.name || seen.has(e.type + e.id)) continue;
  seen.add(e.type + e.id);
  const ring = rings(e).sort((a, b) => area(b) - area(a))[0];
  if (!ring || ring.length < 4 || area(ring) < 40) continue; // sheds, kiosks
  const c = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  // On a campus: inside its mapped university area, or (no area mapped) owned or named as ASU.
  const k = CAMPUSES.findIndex((cp, i) => inBox(c, cp.box) && (campusRings[i]
    ? campusRings[i].some((r) => inRing(c, r))
    : /arizona state|\basu\b/i.test(`${e.tags.operator || ''} ${e.tags.owner || ''} ${e.tags.name}`) || e.tags.building === 'university'));
  if (k < 0) continue;
  let code = slug(e.tags.name) || 'building';
  if (codes.has(code)) code = slug(`${e.tags.name} ${e.tags.ref || CAMPUSES[k].id}`);
  for (let n = 2; codes.has(code); n++) code = slug(e.tags.name).slice(0, 36) + '-' + n;
  codes.add(code);
  buildings.push({
    code,
    name: e.tags.name,
    ...(e.tags.ref ? { ref: e.tags.ref } : {}),
    campus: CAMPUSES[k].id,
    c: c.map(r6),
    poly: simplify(ring.slice(0, -1).concat([ring[0]])).slice(0, -1).map((p) => p.map(r6)),
  });
}
buildings.sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  source: 'Building outlines © OpenStreetMap contributors, available under the Open Database License (openstreetmap.org/copyright)',
  made: new Date().toISOString().slice(0, 10),
  buildings,
}));
const by = Object.groupBy(buildings, (b) => b.campus);
console.log(`${buildings.length} buildings → ${OUT}`);
for (const [k, v] of Object.entries(by)) console.log(`  ${k}: ${v.length}`);
