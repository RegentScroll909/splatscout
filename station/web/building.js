// SplatStation building view: one ASU building's OpenStreetMap footprint, extruded by its floors, with every capture
// filed under it: its points coloured by capture and a small frustum where each photo was taken, looking the way the
// photo looked. Splats (lighter copies of the real ones) can be shown in place too. The Plan view shows one floor
// from above. A capture is placed on the footprint by dragging it, turning it, lining up two points, or snapping it
// onto captures already placed; placements are saved in campus.json.
//
// Review mode, building.html?code=<building>&review=<library path>: a new splat opens among its placed neighbours,
// shown as real splats, ready to be moved into place like a jigsaw piece, with Approve and Reject (see review.js).
// Data: /api/campus/building (station/lib/placement.mjs). Maths: place.js. Floor plans: plan.js.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import * as P from './place.js';
import * as PL from './plan.js';
import { decide } from './review.js';

const $ = (q) => document.querySelector(q);
function h(tag, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) kids.unshift(attrs);
    attrs = {};
  }
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `error ${r.status}`);
  return j;
};
const fmt = (n) => Math.round(n).toLocaleString();
const pct = (x) => (!(x > 0) ? '0%' : x < 0.001 ? '<0.1%' : x < 0.1 ? `${(x * 100).toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(Math.min(1, x) * 100)}%`);
const deg = (r) => (r * 180) / Math.PI;
const cm = (m) => (Math.abs(m) < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`);
const floorName = (f) => (f === 1 ? 'Floor 1 (ground)' : f <= 0 ? (f === 0 ? 'Basement' : `Basement ${1 - f}`) : `Floor ${f}`);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const params = new URLSearchParams(location.search);
const code = params.get('code'), REVIEW = params.get('review');
const S = { data: null, mode: params.get('view') === 'plan' ? 'plan' : '3d', floor: params.get('floor') ? +params.get('floor') : 'all', focus: params.get('key') || REVIEW, rgb: false };
const live = new Map(); // key → placement being edited (drawn instead of the saved one)
// The placement editor: the capture, its placement, the two-point line-up's clicks, undo, the last snap.
const E = { key: null, c: null, pl: null, start: null, step: 0, picks: [], fit: null, undo: [], snap: null, lastNudge: 0, decided: null };
const STATUS_CHIP = { placed: ['var(--good)', '✓'], gps: ['var(--warn)', '~'], none: ['var(--warn)', '?'] };

const capOf = (key) => S.data && S.data.captures.find((c) => c.key === key);
const plOf = (c) => PL.placementOf(c, live);
const floorOf = (c) => plOf(c).floor ?? 1;
const isPlaced = (c) => PL.statusOf(c, live) === 'placed';
/** The floor the plan shows: the one picked, else the focused capture's, else the ground floor. */
const planFloor = () => (S.floor !== 'all' ? S.floor : S.focus && capOf(S.focus) ? floorOf(capOf(S.focus)) : 1);

if (REVIEW) {
  // Reviewing is about how the splats look together: frustums would cover them (they're one click away).
  $('#showSplats').checked = true;
  $('#showPoints').checked = false;
  $('#showCams').checked = false;
}

// ------------------------------------------------------------------ load
async function load(first = false) {
  if (!code) return put($('#msg'), 'No building given: open this page from a building on the Campus page.');
  try {
    S.data = await api('/api/campus/building?code=' + encodeURIComponent(code));
  } catch (e) {
    put($('#msg'), h('span', { class: 'err' }, e.message));
    return;
  }
  const b = S.data.building;
  document.title = `SplatStation · ${REVIEW ? 'Review · ' : ''}${b.name}`;
  put($('#title'), REVIEW ? `Review · ${b.name}` : b.name, ' ', h('span', { class: 'tag new' }, 'Beta'));
  put($('#subtitle'), `${b.campus}${b.ref ? ` · ${b.ref}` : ''} · ${REVIEW ? 'a new splat among the ones already placed' : 'where the club’s photos were taken, on its OpenStreetMap footprint'}`);
  $('#back').href = `campus.html#${encodeURIComponent(b.code)}`;
  if (S.focus && !capOf(S.focus)) S.focus = null;
  $('#msg').textContent = S.data.captures.length ? '' : 'No splats in this building on this PC yet.';
  if (REVIEW && !capOf(REVIEW)) $('#msg').textContent = 'That splat isn’t filed under this building on this PC.';
  build3d();
  if (first) {
    fit3d();
    if (REVIEW && capOf(REVIEW)) fly3d(capOf(REVIEW));
  }
  renderAll();
  ensureSplats();
}

function renderAll() {
  renderBar();
  renderSide();
  show();
}

// ------------------------------------------------------------------ toolbar
function renderBar() {
  put($('#modeSeg'), [['3d', '3D'], ['plan', 'Plan']].map(([k, label]) => h('button', {
    class: S.mode === k ? 'on' : '', 'aria-pressed': String(S.mode === k), disabled: k === '3d' && !T.ok,
    onclick: () => {
      if (k === '3d' && !T.ok) return;
      S.mode = k;
      if (E.step && k === '3d') stopPicking();
      renderAll();
    },
  }, label)));
  const floors = PL.floorsOf(S.data, live);
  put($('#floorSeg'), (S.mode === 'plan' ? [] : [['all', 'All floors']]).concat(floors.map((f) => [f, f <= 0 ? (f === 0 ? 'B' : `B${1 - f}`) : String(f)])).map(([k, label]) => {
    const on = S.mode === 'plan' ? planFloor() === k : S.floor === k;
    return h('button', { class: on ? 'on' : '', 'aria-pressed': String(on), title: k === 'all' ? 'Every floor' : floorName(k), onclick: () => { S.floor = k; renderAll(); } }, label);
  }));
  $('#showSplats').closest('label').hidden = !T.ok || S.mode === 'plan';
  $('#rgb').closest('label').hidden = S.mode === 'plan';
  put($('#help'), S.mode === 'plan'
    ? (E.key ? 'Drag to move it · Shift + drag to turn it · arrow keys nudge it, [ and ] turn it · Ctrl + Z undoes · scroll to zoom · right-drag to pan' : 'Scroll to zoom · drag to pan · hover a dot for its photo · click a capture to pick it')
    : (E.key ? 'Shift + drag to move it along its floor · Alt + drag to turn it · arrow keys nudge it · Ctrl + Z undoes · drag to orbit · right-drag to pan' : 'Drag to orbit · right-drag to pan · scroll to zoom · click a capture in the list to go to it'));
}

function show() {
  const plan = S.mode === 'plan';
  $('#plan').hidden = !plan;
  $('#three').style.visibility = plan ? 'hidden' : 'visible';
  $('#labels').hidden = plan;
  if (plan) drawPlanView();
  else {
    style3d();
    render3d();
    startLoop();
  }
}

for (const id of ['showPoints', 'showCams']) $('#' + id).onchange = () => show();
$('#rgb').onchange = (e) => {
  S.rgb = e.target.checked;
  show();
};
$('#showSplats').onchange = () => {
  if (GS.viewer) GS.viewer.visible = $('#showSplats').checked;
  ensureSplats();
  show();
};
$('#fit').onclick = () => {
  if (S.mode === 'plan') {
    plan.v = null;
    drawPlanView();
  } else fit3d();
};

let statusTimer = 0;
function status(text, ms = 0) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(statusTimer);
  if (text && ms) statusTimer = setTimeout(() => (el.hidden = true), ms);
}

// ------------------------------------------------------------------ side panel
function chip(status) {
  const [color, sym] = STATUS_CHIP[status];
  return h('span', { class: 'chip' }, h('span', { class: 'ic2', style: `background:${color}` }, sym), PL.STATUS_TEXT[status]);
}

function renderSide() {
  const side = $('#side');
  if (E.key) {
    put(side, editorPanel());
    renderEditorReadout();
    return scheduleFit();
  }
  const d = S.data, b = d.building;
  const floors = PL.floorsOf(d, live);
  const caps = [...d.captures].sort((a, c) => floorOf(a) - floorOf(c) || (a.room < c.room ? -1 : 1));
  const rule = b.floorsSet ? 'set by the club' : b.floorsGuessed ? 'guessed: OpenStreetMap doesn’t say; set it on the Campus page' : 'from OpenStreetMap';
  const fc = floors.map((f) => ({ f, ...PL.coverageOf(d, f, live) }));
  put(side,
    h('span', { class: 'kicker' }, `${b.campus}${b.ref ? ` · ${b.ref}` : ''}`),
    h('h3', {}, b.name),
    h('p', { class: 'note' }, `${b.floors} floor${b.floors === 1 ? '' : 's'} (${rule}), ${P.FLOOR_HEIGHT} m apart · footprint ${fmt(b.area)} m²`),
    h('h2', {}, 'Floor by floor'),
    h('div', { class: 'cov' }, fc.map((x) => {
      const on = (S.mode === 'plan' ? planFloor() : S.floor) === x.f;
      const extra = Math.max(0, x.withGuesses.share - x.placed.share);
      return [
        h('span', { class: 'fl' + (on ? ' on' : ''), tabindex: 0, onclick: () => { S.floor = x.f; renderAll(); }, onkeydown: (e) => e.key === 'Enter' && ((S.floor = x.f), renderAll()), title: floorName(x.f) }, x.f <= 0 ? floorName(x.f) : `Floor ${x.f}`),
        h('span', { class: 'fb', title: `${pct(x.placed.share)} photographed at placed positions${extra > 0 ? `, ${pct(extra)} more at guessed ones` : ''}` },
          h('i', { style: `width:${Math.max(x.placed.share > 0 ? 2 : 0, x.placed.share * 100)}%` }), extra > 0 ? h('i', { class: 'g', style: `width:${Math.max(2, extra * 100)}%` }) : null),
        h('span', { class: 'n' }, x.captures ? `${fmt(x.placed.area)} m² · ${pct(x.placed.share)}${x.placedCount < x.captures ? ` (+${fmt(x.withGuesses.area - x.placed.area)} guessed)` : ''}` : '–'),
      ];
    })),
    h('p', { class: 'note' }, 'Photographed: footprint within 1.5 m of where a photo was taken, or inside a scan’s outline. Only placed captures count; hatched is at guessed positions. Gaps are what’s left.'),
    h('h2', {}, `Captures (${caps.length})`),
    caps.length ? h('div', { class: 'caps' }, caps.map(capRow)) : h('p', { class: 'note' }, 'No splats of this building on this PC yet. Process a capture on the dashboard and it shows up here.'),
    caps.some((c) => !c.placement) ? h('p', { class: 'note' }, 'A capture nobody has placed yet is drawn at a guess: at its GPS fix when it has one (moved inside the footprint), else spread along the building, turned so its walls run with the building’s. Place it to make it count.') : null);
}

function capRow(c) {
  const st = PL.statusOf(c, live), pl = plOf(c);
  const line = [
    floorName(pl.floor ?? 1) + (c.floorGiven == null && !c.placement ? ' (not given)' : ''),
    c.cams.length ? `${fmt(c.cams.length)} photos placed` : c.source === 'splat' ? 'camera positions unknown: its job folder was deleted' : c.error || 'no model',
    c.points ? `${fmt(c.points)} points` : null,
    c.metric ? 'in metres' : `scale ${pl.s.toFixed(2)}${c.placement ? '' : ' (guessed)'}`,
  ].filter(Boolean).join(' · ');
  return h('div', { class: 'cap' + (S.focus === c.key ? ' on' : ''), tabindex: 0, onclick: () => focusOn(c.key), onkeydown: (e) => e.key === 'Enter' && focusOn(c.key) },
    h('span', { class: 'sw', style: `background:${PL.colorOf(c)}` }),
    h('span', { class: 'nm', title: c.title }, c.room),
    chip(st),
    h('span', { class: 'cmeta' }, line, c.created ? ` · built ${fmtDate(c.created)}` : ''),
    h('span', { class: 'acts' },
      h('button', { class: 'tbtn', onclick: (e) => { e.stopPropagation(); startEdit(c, { plan: S.mode === 'plan' || !T.ok }); } }, c.placement ? 'Move' : 'Place'),
      h('a', { class: 'tbtn', href: viewerUrl(c), target: '_blank', onclick: (e) => e.stopPropagation() }, 'View splat')));
}

const viewerUrl = (c) => {
  const q = new URLSearchParams({ ply: '/files/library/' + c.key.split('/').map(encodeURIComponent).join('/') + '/scene.ply', title: c.title });
  if (c.view) q.set('view', JSON.stringify(c.view));
  return '/viewer.html?' + q;
};

function focusOn(key) {
  S.focus = S.focus === key ? null : key;
  const c = capOf(key);
  if (S.focus && c) {
    if (S.mode === '3d') fly3d(c);
    else if (S.floor !== 'all' && floorOf(c) !== S.floor) S.floor = floorOf(c);
  }
  renderAll();
  ensureSplats();
}

// ------------------------------------------------------------------ 3D
const T = { ok: false, groups: new Map(), points: new Map(), building: null, plates: [], ray: new THREE.Raycaster(), drag: null };
const BG = 0x0c0f13;

function init3d() {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    $('#three').append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.addEventListener('change', render3d);
    Object.assign(T, { ok: true, renderer, scene, camera, controls });
    new ResizeObserver(() => {
      resize3d();
      if (S.mode === 'plan' && S.data) drawPlanView();
    }).observe($('#stage'));
    resize3d();
    hook3dEditing(renderer.domElement);
  } catch (e) {
    T.ok = false;
    S.mode = 'plan';
    $('#msg').textContent = `3D isn’t available in this browser (${e.message}). The plan still works.`;
  }
}

function resize3d() {
  if (!T.ok) return;
  const r = $('#stage').getBoundingClientRect();
  T.renderer.setSize(r.width, r.height);
  T.camera.aspect = r.width / Math.max(1, r.height);
  T.camera.updateProjectionMatrix();
  render3d();
}

const V = ([e, n], hgt) => new THREE.Vector3(e, hgt, -n); // building metres → three.js (x east, y up, z south)
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The footprint at every floor, its corners and a plate per floor (the chosen one lit). */
function buildingObject() {
  const d = S.data, fp = d.building.footprint, H = d.floorHeight, N = d.building.floors;
  const g = new THREE.Group();
  for (let i = 0; i <= N; i++) {
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(fp.map((p) => V(p, i * H))),
      new THREE.LineBasicMaterial({ color: 0x8794a2, transparent: true, opacity: i === 0 || i === N ? 0.75 : 0.4 }));
    g.add(line);
  }
  const vs = [];
  for (const p of fp) vs.push(V(p, 0), V(p, N * H));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vs), new THREE.LineBasicMaterial({ color: 0x8794a2, transparent: true, opacity: 0.22 })));
  const shape = new THREE.Shape(fp.map(([e, n]) => new THREE.Vector2(e, n)));
  T.plates = [];
  for (const f of PL.floorsOf(d, live)) {
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // (e, n) in the shape's plane → (e, 0, −n)
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3ddcff, transparent: true, opacity: 0.03, side: THREE.DoubleSide, depthWrite: false }));
    m.position.y = (f - 1) * H + 0.01;
    m.userData.floor = f;
    T.plates.push(m);
    g.add(m);
  }
  // A ground grid, 10 m.
  const grid = new THREE.GridHelper(400, 40, 0x1c232b, 0x151b21);
  grid.position.y = -0.02;
  g.add(grid);
  return g;
}

/** One capture: its frustums, the path its photos were taken along, and (once loaded) its points, in model coordinates. */
function captureObject(c) {
  const g = new THREE.Group(), color = new THREE.Color(PL.colorOf(c));
  const pl = plOf(c), size = 0.16 / (pl.s || 1);
  const v = [];
  for (const row of c.cams) {
    const lens = c.lenses[row[9] || 0] || c.lenses[0] || { tanX: 0.6, tanY: 0.35 };
    const C = row.slice(0, 3), f = row.slice(3, 6), u = row.slice(6, 9), r = cross(f, u);
    const corner = (sx, sy) => C.map((k, i) => k + size * (f[i] + r[i] * sx * lens.tanX + u[i] * sy * lens.tanY));
    const a = corner(-1, 1), b = corner(1, 1), cc = corner(1, -1), dd = corner(-1, -1);
    for (const p of [a, b, cc, dd]) v.push(...C, ...p);
    v.push(...a, ...b, ...b, ...cc, ...cc, ...dd, ...dd, ...a);
  }
  if (!c.cams.length && c.start) {
    // No cameras (its job folder is gone): only where its first photo was taken, as a bigger marker.
    const C = c.start.position, L = c.start.lookAt.map((k, i) => k - C[i]), n = Math.hypot(...L) || 1, f = L.map((k) => k / n);
    const s2 = size * 3, up = [0, 1, 0], r = cross(f, up), u = cross(r, f);
    const corner = (sx, sy) => C.map((k, i) => k + s2 * (f[i] * 1.5 + r[i] * sx + u[i] * sy * 0.6));
    const a = corner(-1, 1), b = corner(1, 1), cc = corner(1, -1), dd = corner(-1, -1);
    for (const p of [a, b, cc, dd]) v.push(...C, ...p);
    v.push(...a, ...b, ...b, ...cc, ...cc, ...dd, ...dd, ...a);
  }
  // Cameras are the main sign of what was done: drawn over the points (which hide them otherwise), a lighter
  // tint of the capture's colour so they stand apart from its points.
  const fr = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3)),
    new THREE.LineBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.45), transparent: true, opacity: 0.85, depthTest: false }));
  fr.renderOrder = 2;
  g.add(fr);
  let path = null;
  if (c.cams.length > 1) {
    path = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(c.cams.flatMap((row) => row.slice(0, 3)), 3)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 }));
    g.add(path);
  }
  const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 1.6 * Math.min(2, devicePixelRatio || 1), sizeAttenuation: false, color, transparent: true, opacity: 0.6, depthWrite: false }));
  pts.visible = false;
  g.add(pts);
  // Its name floats above the middle of its photos.
  const src = c.cams.length ? c.cams.map((row) => row.slice(0, 3)) : c.start ? [c.start.position] : [];
  const mid = src.length ? [0, 1, 2].map((k) => src.reduce((s, p) => s + p[k], 0) / src.length) : [c.anchor[0], c.floorY, c.anchor[1]];
  const st = PL.statusOf(c, live);
  const label = h('div', { class: 'lab' }, h('i', { style: `background:${PL.colorOf(c)}` }), c.room,
    c.key === REVIEW ? h('span', { style: 'color:var(--accent);font-weight:600' }, ' · reviewing') : st === 'placed' ? '' : h('span', { style: 'color:var(--muted);font-weight:500' }, ' (guess)'));
  $('#labels').append(label);
  return { g, fr, path, pts, label, mid, color };
}

function build3d() {
  if (!T.ok) return;
  if (T.building) {
    T.scene.remove(T.building);
    T.building.traverse((o) => o.geometry && o.geometry.dispose());
  }
  T.building = buildingObject();
  T.scene.add(T.building);
  for (const x of T.groups.values()) {
    T.scene.remove(x.g);
    x.g.traverse((o) => o.geometry && o.geometry.dispose());
  }
  T.groups.clear();
  put($('#labels'));
  for (const c of S.data.captures) {
    const x = captureObject(c);
    T.groups.set(c.key, x);
    T.scene.add(x.g);
    showPoints(c, x);
  }
  place3d();
}

/** A capture's thinned points (model coordinates), fetched once: {n, xyz: Float32Array, rgb: Uint8Array}. */
async function pointsOf(c) {
  if (!c.points) return { n: 0, xyz: new Float32Array(0), rgb: new Uint8Array(0) };
  if (!T.points.has(c.key)) {
    T.points.set(c.key, fetch('/api/campus/building/points?key=' + encodeURIComponent(c.key))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`error ${r.status}`))))
      .then((buf) => {
        const n = new DataView(buf).getUint32(0, true);
        return { n, xyz: new Float32Array(buf, 4, n * 3), rgb: new Uint8Array(buf, 4 + n * 12, n * 3) };
      })
      .catch(() => {
        T.points.delete(c.key);
        return { n: 0, xyz: new Float32Array(0), rgb: new Uint8Array(0) };
      }));
  }
  return T.points.get(c.key);
}

async function showPoints(c, x) {
  const p = await pointsOf(c);
  if (!p.n || T.groups.get(c.key) !== x) return;
  const geo = x.pts.geometry;
  geo.setAttribute('position', new THREE.BufferAttribute(p.xyz, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(p.rgb, 3, true));
  geo.computeBoundingSphere();
  style3d();
  render3d();
}

/** Where a capture sits in three.js: turned about the vertical, scaled, its floor on its building floor. */
function transformOf(c) {
  const pl = plOf(c), base = ((pl.floor ?? 1) - 1) * S.data.floorHeight;
  return { position: [pl.e, base - pl.s * pl.floorY + (pl.dh || 0), -pl.n], theta: pl.theta, s: pl.s };
}

/** Move each capture (and its splat, when shown) to where it sits. */
function place3d() {
  if (!T.ok || !S.data) return;
  for (const c of S.data.captures) {
    const x = T.groups.get(c.key), t = transformOf(c);
    if (x) {
      x.g.position.set(...t.position);
      x.g.rotation.set(0, t.theta, 0);
      x.g.scale.setScalar(t.s);
    }
    const i = GS.keys.indexOf(c.key);
    if (i >= 0 && GS.viewer && i < GS.viewer.getSceneCount()) {
      const sc = GS.viewer.getSplatScene(i);
      sc.position.set(...t.position);
      sc.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.theta);
      sc.scale.setScalar(t.s);
    }
  }
}

/** Show the chosen floor (others faint), the focused capture (others dimmed), points and cameras as ticked. */
function style3d() {
  if (!T.ok || !S.data) return;
  const chosen = S.floor === 'all' ? null : S.floor;
  for (const m of T.plates) m.material.opacity = chosen == null ? 0.025 : m.userData.floor === chosen ? 0.1 : 0.015;
  for (const c of S.data.captures) {
    const x = T.groups.get(c.key);
    if (!x) continue;
    const onFloor = chosen == null || floorOf(c) === chosen, focused = !S.focus || S.focus === c.key;
    const a = !onFloor ? 0.07 : focused ? 1 : 0.3;
    x.fr.material.opacity = 0.85 * a;
    x.fr.visible = $('#showCams').checked;
    if (x.path) {
      x.path.material.opacity = 0.3 * a;
      x.path.visible = $('#showCams').checked;
    }
    const m = x.pts.material;
    m.opacity = (S.rgb ? 0.9 : 0.6) * a;
    if (m.vertexColors !== S.rgb) {
      m.vertexColors = S.rgb;
      m.needsUpdate = true;
    }
    m.color.set(S.rgb ? 0xffffff : x.color);
    x.pts.visible = $('#showPoints').checked && !!x.pts.geometry.getAttribute('position');
    x.label.style.display = onFloor ? '' : 'none';
    x.label.classList.toggle('dim', !focused);
  }
}

function render3d() {
  if (!T.ok || S.mode !== '3d' || !S.data) return;
  T.renderer.render(T.scene, T.camera);
  // Names: each capture's label over the middle of its photos, 1 m above them.
  const r = $('#stage').getBoundingClientRect();
  for (const c of S.data.captures) {
    const x = T.groups.get(c.key);
    if (!x || x.label.style.display === 'none') continue;
    const p = new THREE.Vector3(...x.mid).applyMatrix4(x.g.matrixWorld);
    p.y += 1;
    p.project(T.camera);
    const vis = p.z < 1 && p.z > -1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
    x.label.style.visibility = vis ? 'visible' : 'hidden';
    x.label.style.left = `${((p.x + 1) / 2) * r.width}px`;
    x.label.style.top = `${((1 - p.y) / 2) * r.height}px`;
  }
}

/** Look at the whole building from the south-west, a little above it. */
function fit3d() {
  if (!T.ok || !S.data) return;
  const fp = S.data.building.footprint, H = S.data.floorHeight * S.data.building.floors;
  const c = P.centroid(fp);
  let R = 0;
  for (const p of fp) R = Math.max(R, Math.hypot(p[0] - c[0], p[1] - c[1]));
  const target = V(c, H * 0.35), D = Math.max(25, R * 2.1);
  T.controls.target.copy(target);
  T.camera.position.copy(target).add(new THREE.Vector3(-0.45 * D, 0.75 * D, 0.62 * D));
  T.camera.near = Math.max(0.05, D / 2000);
  T.camera.far = D * 40;
  T.camera.updateProjectionMatrix();
  T.controls.update();
  render3d();
}

/** Go to one capture: look at the middle of its photos from a few metres away. */
function fly3d(c) {
  const x = T.groups.get(c.key);
  if (!T.ok || !x) return;
  x.g.updateMatrixWorld();
  const p = new THREE.Vector3(...x.mid).applyMatrix4(x.g.matrixWorld);
  const dir = T.camera.position.clone().sub(T.controls.target).normalize();
  T.controls.target.copy(p);
  T.camera.position.copy(p).add(dir.multiplyScalar(14));
  T.controls.update();
  render3d();
}

// ------------------------------------------------------------------ splats in place
// Lighter copies of the real splats (/api/campus/building/splat): the one under review (or picked) in more detail,
// then the placed captures nearest it. They move with their placement like the points do. The renderer is the
// dashboard viewer's (GaussianSplats3D), dropped into this scene. Its sorting runs between frames, so the view
// redraws continuously while splats are shown.
const GS = { viewer: null, keys: [], loading: false, limit: 6, failed: new Set() };
const splatsOn = () => !!(GS.viewer && GS.viewer.visible && GS.keys.length);

/** The splats to show, in order: the reviewed (or focused) capture, then placed ones nearest it. */
function splatList() {
  if (!S.data) return [];
  const lead = capOf(REVIEW) || capOf(S.focus) || null;
  const at = (c) => {
    const x = T.groups.get(c.key);
    if (!x) return [0, 0, 0];
    x.g.updateMatrixWorld();
    return new THREE.Vector3(...x.mid).applyMatrix4(x.g.matrixWorld).toArray();
  };
  const from = lead ? at(lead) : V(P.centroid(S.data.building.footprint), 0).toArray();
  const others = S.data.captures.filter((c) => c !== lead && isPlaced(c) && c.key !== E.key)
    .map((c) => ({ c, d: Math.hypot(...at(c).map((v, k) => v - from[k])) })).sort((a, b) => a.d - b.d);
  return [...(lead ? [{ c: lead, detail: lead.key === REVIEW ? 'near' : 'far', d: 0 }] : []), ...others.slice(0, GS.limit).map((x) => ({ ...x, detail: 'far' }))];
}
const neighbourCount = () => (S.data ? S.data.captures.filter((c) => c.key !== REVIEW && c.key !== E.key && isPlaced(c)).length : 0);

async function ensureSplats() {
  if (!T.ok || !$('#showSplats').checked || GS.loading || !S.data) return;
  const todo = splatList().filter((w) => !GS.keys.includes(w.c.key) && !GS.failed.has(w.c.key));
  if (!todo.length) return;
  if (!GS.viewer) {
    GS.viewer = new GaussianSplats3D.DropInViewer({ sharedMemoryForWorkers: false, dynamicScene: true, sphericalHarmonicsDegree: 0, logLevel: GaussianSplats3D.LogLevel.None });
    T.scene.add(GS.viewer);
  }
  GS.loading = true;
  const opts = (w) => {
    const t = transformOf(w.c), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.theta);
    return { path: `/api/campus/building/splat?key=${encodeURIComponent(w.c.key)}&detail=${w.detail}`, format: GaussianSplats3D.SceneFormat.Splat, splatAlphaRemovalThreshold: 5, showLoadingUI: false, progressiveLoad: false, position: t.position, rotation: q.toArray(), scale: [t.s, t.s, t.s] };
  };
  try {
    // One at a time, nearest first: the one under review shows while its neighbours are still on their way.
    for (const [i, w] of todo.entries()) {
      status(`Loading splats: ${w.c.room}${todo.length > 1 ? ` (${i + 1} of ${todo.length})` : ''}… the first time, SplatStation makes a lighter copy of each.`);
      try {
        const o = opts(w);
        await GS.viewer.addSplatScene(o.path, o);
        GS.keys.push(w.c.key);
      } catch (e) {
        GS.failed.add(w.c.key);
        status(`Couldn’t show ${w.c.room} as a splat: ${e.message || e}`, 6000);
      }
      place3d();
      startLoop();
    }
    if (!GS.failed.size) status('');
  } finally {
    GS.loading = false;
    if (E.key) renderSide();
  }
  ensureSplats(); // anything asked for meanwhile
}

let looping = false;
function startLoop() {
  if (looping || !splatsOn() || S.mode !== '3d') return;
  looping = true;
  const frame = () => {
    if (!splatsOn() || S.mode !== '3d') {
      looping = false;
      return;
    }
    render3d();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ moving a capture in 3D
// Shift + drag slides it along its floor; Alt + drag turns it about its middle. (Plain drags orbit as usual.)
function floorHit(e) {
  const r = T.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  T.ray.setFromCamera(ndc, T.camera);
  const hgt = ((E.pl.floor ?? 1) - 1) * S.data.floorHeight, p = new THREE.Vector3();
  return T.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -hgt), p) ? [p.x, -p.z] : null;
}

function hook3dEditing(el) {
  el.addEventListener('pointerdown', (e) => {
    if (!E.key || S.mode !== '3d' || e.button !== 0 || !(e.shiftKey || e.altKey)) return;
    const at = floorHit(e);
    if (!at) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // not an orbit
    T.controls.enabled = false;
    el.setPointerCapture(e.pointerId);
    T.drag = { mode: e.altKey ? 'turn' : 'move', at, pl: { ...E.pl }, mid: midOf(E.c), moved: false };
  }, { capture: true });
  el.addEventListener('pointermove', (e) => {
    const d = T.drag;
    if (!d) return;
    const p = floorHit(e);
    if (!p) return;
    if (!d.moved) {
      pushUndo(d.pl);
      d.moved = true;
    }
    if (d.mode === 'move') setPl({ ...d.pl, e: d.pl.e + p[0] - d.at[0], n: d.pl.n + p[1] - d.at[1] }, false);
    else setPl(P.turnAbout(d.pl, Math.atan2(p[1] - d.mid[1], p[0] - d.mid[0]) - Math.atan2(d.at[1] - d.mid[1], d.at[0] - d.mid[0]), d.mid), false);
    render3d();
  });
  const end = () => {
    if (!T.drag) return;
    const moved = T.drag.moved;
    T.drag = null;
    T.controls.enabled = true;
    if (moved) afterChange();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ plan
const plan = { v: null, drag: null };
const canvas = $('#plan');

function drawPlanView() {
  if (!S.data) return;
  const { ctx, w, h: hh } = PL.fitCanvas(canvas);
  if (!plan.v) {
    const c = E.key ? capOf(E.key) : null;
    const extra = c ? PL.onFloor(S.data, floorOf(c), live).filter((x) => x.c.key === c.key).flatMap((x) => x.cams.map((k) => k.at).concat(x.pts)) : [];
    plan.v = PL.fitView(S.data.building.footprint, w, hh, 36, extra);
  }
  PL.drawPlan(ctx, { w, h: hh, view: plan.v, data: S.data, floor: planFloor(), live, focus: E.key || S.focus, show: { points: $('#showPoints').checked || !!E.key, cones: $('#showCams').checked || !!E.key, maxCones: 240 }, marks: editMarks() });
}

const tip = $('#tip');
function showTip(e, ...rows) {
  put(tip, ...rows);
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.style.display = 'none');

const local = (e) => {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = local(e);
  plan.v = PL.zoomView(plan.v, Math.exp(-e.deltaY * 0.0015), x, y);
  drawPlanView();
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const [x, y] = local(e);
  canvas.setPointerCapture(e.pointerId);
  hideTip();
  if (E.key && E.step && e.button === 0) return pick(x, y);
  const mode = !E.key || e.button === 2 || e.button === 1 || e.altKey ? 'pan' : e.shiftKey ? 'turn' : 'move';
  plan.drag = { mode, x, y, v: { ...plan.v }, pl: E.pl ? { ...E.pl } : null, moved: 0, mid: E.key ? midOf(capOf(E.key)) : null, pushed: false };
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  const [x, y] = local(e);
  const d = plan.drag;
  if (!d) {
    if (E.key && E.step) return hideTip();
    const hit = PL.cameraAt(S.data, planFloor(), live, plan.v, x, y);
    if (!hit) return hideTip();
    const c = hit.x.c, n = c.cams.length;
    return showTip(e, h('div', { class: 'v' }, `${c.room}${hit.i >= 0 ? ` · photo ${hit.i + 1} of ${n}` : ''}`),
      h('div', { class: 'r' }, hit.i >= 0 ? `${(hit.x.cams[hit.i].h).toFixed(1)} m above the ground floor` : 'Its first photo: camera positions are unknown (its job folder was deleted)'),
      h('div', { class: 'r' }, PL.STATUS_TEXT[hit.x.status]));
  }
  d.moved = Math.max(d.moved, Math.hypot(x - d.x, y - d.y));
  if (d.mode !== 'pan' && !d.pushed && d.moved >= 2) {
    pushUndo(d.pl);
    d.pushed = true;
  }
  if (d.mode === 'pan') {
    plan.v = { ...d.v, ox: d.v.ox + x - d.x, oy: d.v.oy + y - d.y };
  } else if (d.mode === 'move') {
    setPl({ ...d.pl, e: d.pl.e + (x - d.x) / plan.v.k, n: d.pl.n - (y - d.y) / plan.v.k }, false);
  } else if (d.mode === 'turn') {
    const [mx, my] = PL.toPx(plan.v, d.mid[0], d.mid[1]);
    const da = -(Math.atan2(y - my, x - mx) - Math.atan2(d.y - my, d.x - mx));
    setPl(P.turnAbout(d.pl, da, d.mid), false);
  }
  drawPlanView();
});
canvas.addEventListener('pointerup', (e) => {
  const d = plan.drag;
  plan.drag = null;
  canvas.classList.remove('dragging');
  if (!d) return;
  if (d.moved < 4 && !E.key && d.mode === 'pan') {
    // A click: pick the capture under it.
    const [x, y] = local(e);
    const hit = PL.captureAt(S.data, planFloor(), live, plan.v, x, y);
    S.focus = hit ? hit.c.key : null;
    renderSide();
    drawPlanView();
  } else if (E.key && d.pushed) afterChange();
});
canvas.addEventListener('pointerleave', hideTip);

// ------------------------------------------------------------------ placing a capture
/** The middle of a capture's photos (or points) on the floor, in building metres. */
function midOf(c) {
  const x = PL.onFloor(S.data, floorOf(c), live).find((k) => k.c.key === c.key);
  return x ? x.mid : [0, 0];
}

const plainPl = (p) => ({ s: p.s, theta: p.theta, e: p.e, n: p.n, floor: p.floor ?? 1, dh: p.dh || 0 });

/** Start moving a capture: in the plan (precise, two-point line-up) or in 3D (among the splats). */
function startEdit(c, { plan: inPlan = true, keepUndo = false } = {}) {
  const undo = keepUndo ? E.undo : [];
  Object.assign(E, { key: c.key, c, pl: plainPl(c.placement || c.guess), step: 0, picks: [], fit: null, undo, snap: null, decided: null, decidedMsg: '', decidedBad: false });
  E.start = { ...E.pl };
  live.set(c.key, E.pl);
  S.focus = c.key;
  if (inPlan || !T.ok) {
    S.mode = 'plan';
    S.floor = E.pl.floor;
    plan.v = null;
  }
  canvas.classList.add('move');
  dst.key = null;
  renderAll();
  ensureSplats();
}

function endEdit() {
  live.delete(E.key);
  Object.assign(E, { key: null, c: null, pl: null, step: 0, picks: [], undo: [], snap: null });
  $('#step').hidden = true;
  canvas.classList.remove('move', 'pick');
}

/** Change the placement being edited; `full` updates the panel too (a drag only redraws until it ends). */
function setPl(pl, full = true) {
  E.pl = plainPl({ ...pl, floor: pl.floor ?? E.pl.floor });
  live.set(E.key, E.pl);
  place3d();
  if (full) afterChange();
}

function afterChange() {
  renderEditorReadout();
  scheduleFit();
  if (S.mode === 'plan') drawPlanView();
  else render3d();
  const u = document.getElementById('undoBtn');
  if (u) u.disabled = !E.undo.length;
}

function pushUndo(pl = E.pl) {
  E.undo.push({ ...pl });
  if (E.undo.length > 80) E.undo.shift();
  const u = document.getElementById('undoBtn');
  if (u) u.disabled = false;
}

function undo() {
  const p = E.undo.pop();
  if (!p) return;
  E.snap = null;
  setPl(p);
  if (p.floor !== undefined && S.mode === 'plan') S.floor = p.floor;
  renderSide();
  if (S.mode === 'plan') drawPlanView();
}

const STEPS = {
  1: (room) => `1 of 4 · Click a point of ${room} that you can also find on the footprint: a corner of the room, or the end of an outside wall.`,
  2: () => '2 of 4 · Click where that point is on the footprint. Corners of the outline snap.',
  3: (room) => `3 of 4 · Click a second point of ${room}, as far from the first as you can.`,
  4: () => '4 of 4 · Click where that one is on the footprint.',
};
function showStep() {
  const el = $('#step');
  el.hidden = !E.step;
  canvas.classList.toggle('pick', !!E.step);
  if (E.step) put(el, STEPS[E.step](E.c.room), ' ', h('button', { class: 'tbtn', onclick: () => { stopPicking(); drawPlanView(); } }, 'Stop'));
}
function stopPicking() {
  E.step = 0;
  E.picks = [];
  showStep();
}
function startPicking() {
  if (S.mode !== 'plan') {
    S.mode = 'plan';
    S.floor = E.pl.floor;
    plan.v = null;
    renderAll();
  }
  pushUndo();
  E.step = 1;
  E.picks = [];
  E.fit = null;
  showStep();
  drawPlanView();
}

/** A click on the footprint snaps to an outline corner within 12 px, else to its edge within 8 px. */
function snapToOutline(x, y) {
  const fp = S.data.building.footprint;
  let best = null;
  for (const p of fp) {
    const [px, py] = PL.toPx(plan.v, p[0], p[1]), d = Math.hypot(px - x, py - y);
    if (d <= 12 && (!best || d < best.d)) best = { p, d };
  }
  if (best) return best.p;
  const m = PL.toM(plan.v, x, y), e = P.closestOnEdge(fp, m[0], m[1]);
  return e.d * plan.v.k <= 8 ? e.p : m;
}

function pick(x, y) {
  const m = PL.toM(plan.v, x, y);
  if (E.step === 1 || E.step === 3) {
    E.picks.push({ model: P.modelOf(plOf(E.c), m[0], m[1]), target: null });
    E.step++;
  } else {
    const t = snapToOutline(x, y), last = E.picks[E.picks.length - 1];
    last.target = t;
    if (E.step === 2) {
      setPl(P.moveTo(plOf(E.c), last.model, t));
      E.step = 3;
    } else {
      // Two pairs: a turn and a shift (and a scale, for a model that isn't in metres).
      const fit = P.fitPoints(E.picks.map((p) => [p.model, p.target]), { scale: E.c.metric ? E.pl.s : null });
      if (fit) {
        setPl({ ...fit, floor: E.pl.floor, dh: E.pl.dh });
        E.fit = fit;
      } else E.fit = { failed: true };
      E.step = 0;
      renderSide(); // says how well it lined up
    }
  }
  showStep();
  renderEditorReadout();
  drawPlanView();
}

/** The two-point line-up's clicks: where each point of the capture now is, and where it should go. */
function editMarks() {
  if (!E.key || !E.picks.length) return [];
  const pl = plOf(E.c), out = [];
  E.picks.forEach((p, i) => {
    out.push({ at: P.planOf(pl, p.model[0], p.model[1]), color: PL.colorOf(E.c), label: String(i + 1) });
    if (p.target) out.push({ at: p.target, color: '#e8edf2', label: `${i + 1}′` });
  });
  return out;
}

function turn(dDeg) {
  pushUndo();
  setPl(P.turnAbout(E.pl, (dDeg * Math.PI) / 180, midOf(E.c)));
}

/** Arrow keys: east/north on the plan; in 3D, away from you and sideways, along the floor. */
function nudge(key, big) {
  const step = big ? 1 : 0.1;
  let f = [0, 1];
  if (S.mode === '3d' && T.ok) {
    const d = T.camera.getWorldDirection(new THREE.Vector3());
    const L = Math.hypot(d.x, d.z) || 1;
    f = [d.x / L, -d.z / L];
  }
  const r = [f[1], -f[0]];
  const v = { ArrowUp: f, ArrowDown: [-f[0], -f[1]], ArrowRight: r, ArrowLeft: [-r[0], -r[1]] }[key];
  if (Date.now() - E.lastNudge > 800) pushUndo();
  E.lastNudge = Date.now();
  setPl({ ...E.pl, e: E.pl.e + v[0] * step, n: E.pl.n + v[1] * step });
}

addEventListener('keydown', (e) => {
  if (!E.key || (e.target && e.target.matches && e.target.matches('input, select, textarea'))) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
  }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    nudge(e.key, e.shiftKey);
  } else if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    turn((e.key === '[' ? 1 : -1) * (e.shiftKey ? 5 : 1));
  } else if (e.key === 'Escape' && E.step) {
    stopPicking();
    drawPlanView();
  }
});

// ------------------------------------------------------------------ fitting with neighbours (the jigsaw)
// The capture's points against the points of every placed capture near it, all in building metres.
const dst = { key: null, pts: new Float32Array(0), rooms: [] };
async function snapSets() {
  const c = E.c, pl = plOf(c);
  const own = await pointsOf(c);
  const every = Math.max(1, Math.floor(own.n / 8000)), src = [];
  for (let i = 0; i < own.n; i += every) src.push(...P.toBuilding(pl, [own.xyz[3 * i], own.xyz[3 * i + 1], own.xyz[3 * i + 2]]));
  // Neighbours don't move while this one is being placed: theirs are worked out once.
  const nb = S.data.captures.filter((x) => x.key !== c.key && isPlaced(x));
  const key = nb.map((x) => x.key + JSON.stringify(plOf(x))).join('|');
  if (dst.key !== key) {
    const all = [];
    for (const x of nb) {
      const p = await pointsOf(x), xp = plOf(x), k = Math.max(1, Math.floor(p.n / 25000));
      for (let i = 0; i < p.n; i += k) all.push(...P.toBuilding(xp, [p.xyz[3 * i], p.xyz[3 * i + 1], p.xyz[3 * i + 2]]));
    }
    Object.assign(dst, { key, pts: Float32Array.from(all), rooms: nb.map((x) => x.room) });
  }
  // Only what's within reach of where it might go.
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < src.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (src[i + k] < b[k]) b[k] = src[i + k];
      if (src[i + k] > b[k + 3]) b[k + 3] = src[i + k];
    }
  }
  const near = [];
  for (let i = 0; i < dst.pts.length; i += 3) {
    const x = dst.pts[i], y = dst.pts[i + 1], z = dst.pts[i + 2];
    if (x > b[0] - 4 && x < b[3] + 4 && y > b[1] - 4 && y < b[4] + 4 && z > b[2] - 1 && z < b[5] + 1) near.push(x, y, z);
  }
  return { src: Float32Array.from(src), dst: Float32Array.from(near), placed: nb.length };
}

let fitTimer = 0, fitRun = 0;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(updateFit, 160);
}
async function updateFit() {
  const el = document.getElementById('fitbox');
  if (!el || !E.key) return;
  const run = ++fitRun, sets = await snapSets();
  if (run !== fitRun || !document.getElementById('fitbox')) return;
  let text;
  if (!sets.placed) text = 'Nothing else in this building is placed yet, so there’s nothing to fit against: put it where it goes on the footprint.';
  else if (!sets.dst.length) text = 'No placed capture within a few metres: move it next to the one it joins, then snap.';
  else {
    const f = P.fitOf(sets.src, sets.dst);
    text = f.pairs < 40 ? 'Not touching a placed capture yet: none of their points is within 12 cm of its.' : `Fits its neighbours to ${cm(f.rms)} where they meet: ${pct(f.overlap)} of its points sit on theirs (within 12 cm).`;
  }
  put(document.getElementById('fitbox'), h('span', {}, text), snapNote());
}

function snapNote() {
  const r = E.snap;
  if (!r) return null;
  if (!r.ok) return h('span', { class: 'warn' }, ` ${r.reason}`);
  const moved = Math.hypot(r.shift[0], r.shift[1]);
  return h('span', { class: 'ok' }, ` Snapped: moved ${cm(moved)}, turned ${deg(r.turn).toFixed(1)}°${Math.abs(r.shift[2]) >= 0.01 ? `, ${r.shift[2] > 0 ? 'raised' : 'lowered'} ${cm(Math.abs(r.shift[2]))}` : ''}; it was ${cm(r.before.rms)} off over ${pct(r.before.overlap)} of its points.`);
}

async function snapNow() {
  const btn = document.getElementById('snapBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Snapping…';
  }
  await new Promise((r) => setTimeout(r, 30)); // let the button show it's working
  try {
    const sets = await snapSets();
    if (!sets.placed || !sets.dst.length) {
      E.snap = { ok: false, reason: sets.placed ? 'No placed capture within a few metres: move it next to the one it joins first.' : 'Nothing else in this building is placed yet.' };
    } else {
      const r = P.snapPoints(sets.src, sets.dst);
      E.snap = r;
      if (r.ok) {
        pushUndo();
        setPl(P.applySnap(E.pl, r));
      }
    }
  } finally {
    renderSide();
  }
}

// ------------------------------------------------------------------ the editor and review panel
function editorPanel() {
  const c = E.c, b = S.data.building, rev = c.key === REVIEW, floors = [];
  for (let f = Math.min(0, ...PL.floorsOf(S.data, live)); f <= Math.max(b.floors, E.pl.floor); f++) floors.push(f);
  const floorSel = h('select', {
    'aria-label': 'Floor',
    onchange: () => {
      pushUndo();
      setPl({ ...E.pl, floor: +floorSel.value });
      S.floor = E.pl.floor;
      renderBar();
      if (S.mode === 'plan') drawPlanView();
    },
  }, floors.map((f) => h('option', { value: String(f) }, floorName(f))));
  floorSel.value = String(E.pl.floor);
  const scale = h('input', {
    type: 'number', step: '0.01', min: '0.01', value: E.pl.s.toFixed(3), 'aria-label': 'Scale',
    onchange: () => {
      const s = +scale.value;
      if (!(s > 0)) return;
      pushUndo();
      setPl(P.scaleAbout(E.pl, s / E.pl.s, midOf(c)));
    },
  });
  const was = c.placement ? `Placed by the club${c.placement.at ? ` on ${fmtDate(c.placement.at)}` : ''}.` : c.guess.from === 'gps' ? `Not placed yet: drawn at its GPS fix${c.geo && c.geo.acc ? ` (good to ${c.geo.acc} m)` : ''}, moved inside the footprint.` : 'Not placed yet: it has no GPS fix, so it starts at a guess along the building.';
  const facts = [
    c.author ? `by ${c.author}` : null, c.created ? `built ${fmtDate(c.created)}` : null,
    c.grade ? `scan grade ${c.grade}${c.score != null ? ` (${c.score})` : ''}` : null,
    c.cams.length ? `${fmt(c.cams.length)} of ${fmt(c.photos || c.cams.length)} photos placed` : null,
    c.eval && Number.isFinite(c.eval.psnr) ? `measured ${c.eval.psnr.toFixed(1)} dB` : null,
    c.splats ? `${fmt(c.splats)} splats` : null,
  ].filter(Boolean).join(' · ');
  const nb = splatList().filter((w) => w.c !== c);
  const more = neighbourCount() - Math.min(GS.limit, neighbourCount());
  return [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
      h('span', { class: 'kicker' }, rev ? 'Review a new splat' : 'Placing a capture'),
      h('span', { style: 'display:flex;gap:6px' },
        T.ok ? h('button', { class: 'tbtn', title: 'Turn the 3D view to it', onclick: () => { if (S.mode !== '3d') { S.mode = '3d'; renderAll(); } fly3d(c); } }, 'Look at it') : null,
        rev ? null : h('button', { class: 'tbtn', onclick: () => { endEdit(); renderAll(); } }, 'Close'))),
    h('h3', {}, c.room, h('span', { class: 'sw', style: `display:inline-block;width:12px;height:12px;border-radius:3px;margin-left:8px;background:${PL.colorOf(c)}` })),
    facts ? h('p', { class: 'note' }, facts, ' · ', h('a', { class: 'link', href: viewerUrl(c), target: '_blank' }, 'open the full splat')) : null,
    h('p', { class: 'note' }, was),
    h('div', { class: 'edit' },
      h('p', { class: 'note', style: 'color:#cdd6df' }, rev
        ? `Fit ${c.room} in with what’s already placed, like a jigsaw piece: move it next to the capture it joins (Shift + drag in 3D, or drag on the plan), then Snap to neighbours. Check doorways and shared walls line up, then approve it.`
        : `Put ${c.room} where it is in the building: drag it, turn it, line it up by two points, or snap it onto a placed capture it overlaps.`),
      h('div', { class: 'fitbox', id: 'fitbox' }, 'Working out how it fits…'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', id: 'snapBtn', title: 'Move it a little so its points sit on its placed neighbours’ (a shared doorway or wall). It turns and shifts only.', onclick: snapNow }, 'Snap to neighbours'),
        h('button', { class: 'btn small ghost', id: 'undoBtn', disabled: !E.undo.length, title: 'Undo the last move (Ctrl + Z)', onclick: undo }, 'Undo'),
        h('button', { class: 'btn small ghost', title: 'Click two points of it and where they are on the outline', onclick: startPicking }, 'Line up two points')),
      E.fit && !E.fit.failed ? h('p', { class: 'note' }, c.metric ? `Lined up: the points sit within ${E.fit.rms.toFixed(2)} m of your clicks (scale kept: in metres).` : `Lined up: scale ${E.fit.s.toFixed(3)} from your clicks.`) : null,
      E.fit && E.fit.failed ? h('p', { class: 'err' }, 'Those two points were on top of each other: try again further apart.') : null,
      h('div', { class: 'row' }, 'Turn',
        [[90, '⟲ 90°'], [5, '⟲ 5°'], [1, '⟲ 1°'], [-1, '⟳ 1°'], [-5, '⟳ 5°'], [-90, '⟳ 90°']].map(([d, label]) => h('button', { class: 'tbtn', onclick: () => turn(d), title: d > 0 ? 'Turn left (counter-clockwise)' : 'Turn right (clockwise)' }, label))),
      h('div', { class: 'row' }, 'Floor', floorSel, c.floorGiven != null ? h('span', {}, `(the capture says ${c.floorText})`) : h('span', {}, '(the capture didn’t say)')),
      h('div', { class: 'row' }, 'Scale', c.metric ? h('span', {}, '1: lined up with the phone’s AR tracking, so in metres') : [scale, h('span', {}, 'metres per model unit (COLMAP alone has no scale; lining up two points sets it)')]),
      h('div', { class: 'row readout', id: 'readout' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn small' + (rev ? '' : ' primary'), onclick: saveEdit }, rev ? 'Save its place' : 'Save'),
        h('button', { class: 'btn small ghost', title: 'Back to where it was when this page opened', onclick: () => { pushUndo(); setPl(E.start); renderSide(); } }, 'Start over'),
        c.placement ? h('button', { class: 'btn small ghost', title: 'Forget where it was placed and show the guess again', onclick: forgetPlacement }, 'Back to the guess') : null),
      h('p', { class: 'note', id: 'editMsg' })),
    rev ? [
      h('h2', {}, 'Decision'),
      h('p', { class: 'note' }, 'Approving saves where it sits and passes it on to be published; rejecting sends it back with your reason.'),
      h('div', { class: 'row decide' },
        h('button', { class: 'btn small primary', id: 'approveBtn', onclick: () => decideNow('approve'), disabled: E.decided === 'approve' }, '✓ Approve'),
        h('button', { class: 'btn small danger', id: 'rejectBtn', onclick: () => decideNow('reject'), disabled: E.decided === 'reject' }, '✕ Reject')),
      h('p', { class: 'note' + (E.decidedBad ? ' err' : ''), id: 'decideMsg' }, E.decidedMsg || ''),
    ] : null,
    T.ok ? [
      h('h2', {}, rev ? 'Its neighbours' : 'Shown as splats'),
      nb.length ? h('div', { class: 'caps' }, nb.map((w) => h('div', { class: 'cap', style: 'cursor:default' },
        h('span', { class: 'sw', style: `background:${PL.colorOf(w.c)}` }), h('span', { class: 'nm' }, w.c.room),
        h('span', { class: 'chip' }, GS.keys.includes(w.c.key) ? 'splat shown' : GS.failed.has(w.c.key) ? 'couldn’t load' : $('#showSplats').checked ? 'loading…' : 'splats off'),
        h('span', { class: 'cmeta' }, `${cm(w.d)} away · ${floorName(floorOf(w.c))}`))))
        : h('p', { class: 'note' }, 'No other capture in this building is placed yet. Placed ones show here, nearest first, as splats.'),
      more > 0 ? h('button', { class: 'tbtn', onclick: () => { GS.limit += 6; ensureSplats(); renderSide(); } }, `Show ${Math.min(6, more)} more`) : null,
    ] : null,
  ];
}

function renderEditorReadout() {
  const el = document.getElementById('readout');
  if (!el || !E.pl) return;
  el.textContent = `${E.pl.e.toFixed(2)} m east, ${E.pl.n.toFixed(2)} m north of the middle · turned ${deg(Math.atan2(Math.sin(E.pl.theta), Math.cos(E.pl.theta))).toFixed(1)}° · scale ${E.pl.s.toFixed(3)}${Math.abs(E.pl.dh || 0) >= 0.005 ? ` · ${E.pl.dh > 0 ? 'raised' : 'lowered'} ${cm(Math.abs(E.pl.dh))}` : ''}`;
}

const editMsg = (text) => {
  const m = document.getElementById('editMsg');
  if (m) m.textContent = text;
};

async function saveEdit() {
  try {
    await api('/api/campus/building/place', { key: E.key, placement: E.pl });
  } catch (err) {
    return editMsg(err.message);
  }
  await reloadEditing();
  editMsg('Saved.');
}

async function forgetPlacement() {
  if (!confirm(`Forget where ${E.c.room} was placed? It goes back to the guess.`)) return;
  try {
    await api('/api/campus/building/place', { key: E.key, placement: null });
  } catch (err) {
    return editMsg(err.message);
  }
  await reloadEditing();
}

/** After saving: read the building again; in review mode keep the capture open (with its undo), else close it. */
async function reloadEditing() {
  const key = E.key, undoStack = E.undo, inPlan = S.mode === 'plan', { decided, decidedMsg, decidedBad } = E;
  endEdit();
  await load();
  const c = capOf(key);
  if (c && key === REVIEW) {
    E.undo = undoStack;
    startEdit(c, { plan: inPlan, keepUndo: true });
    Object.assign(E, { decided, decidedMsg, decidedBad });
    renderSide();
  }
}

/** Approve or Reject (review mode): the hook in review.js passes it on to the review queue. */
async function decideNow(decision) {
  const msg = (text, bad) => {
    E.decidedMsg = text;
    E.decidedBad = !!bad;
    const m = document.getElementById('decideMsg');
    if (m) {
      m.textContent = text;
      m.classList.toggle('err', !!bad);
    }
  };
  let reason = '';
  if (decision === 'reject') {
    reason = prompt(`Why is ${E.c.room} rejected? The member sees this.`, '');
    if (reason == null) return;
  } else {
    // It's published where it sits now.
    try {
      await api('/api/campus/building/place', { key: E.key, placement: E.pl });
    } catch (err) {
      return msg(`Couldn’t save where it sits: ${err.message}`, true);
    }
  }
  for (const id of ['approveBtn', 'rejectBtn']) document.getElementById(id).disabled = true;
  msg(decision === 'approve' ? 'Approving…' : 'Rejecting…');
  let r;
  try {
    r = await decide({ decision, key: E.key, code, room: E.c.room, placement: { ...E.pl }, reason });
  } catch (err) {
    r = { ok: false, message: err.message || String(err) };
  }
  if (!r || !r.ok) {
    for (const id of ['approveBtn', 'rejectBtn']) document.getElementById(id).disabled = false;
    return msg((r && r.message) || 'Nothing happened.', true);
  }
  E.decided = decision;
  msg(r.message || (decision === 'approve' ? 'Approved.' : 'Rejected.'));
  if (r.next) location.href = r.next;
  else if (decision === 'approve') await reloadEditing();
}

// ------------------------------------------------------------------ start
init3d();
canvas.tabIndex = 0;
load(true).then(() => {
  const c = capOf(REVIEW) || (params.get('place') && capOf(params.get('place')));
  if (c) startEdit(c, { plan: !REVIEW || !T.ok });
});
