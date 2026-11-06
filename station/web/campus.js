// SplatStation Campus page: ASU buildings coloured by how complete they are, headline numbers, charts of
// expected splat quality, completion, light coverage and activity, and the details of a building or space.
// Everything comes from /api/campus (station/lib/campus.mjs); the rules are in app/js/core/campusmodel.js.

const $ = (q) => document.querySelector(q);
const NS = 'http://www.w3.org/2000/svg';

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
/** An SVG element. Colours go in `style` so CSS variables work. */
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
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
const pct = (x) => (x > 0 && x < 0.01 ? '<1%' : `${Math.round(x * 100)}%`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const LIGHTS = [['morning', 'Morning', '6–11 am'], ['afternoon', 'Afternoon', '11–4'], ['evening', 'Evening', '4–8 pm'], ['night', 'Night', '8 pm–6']];
const KIND_COLOR = { room: 'var(--cat-1)', hallway: 'var(--cat-2)', large: 'var(--cat-3)' };
const STATUS = { good: ['var(--st-good)', '✓'], warning: ['var(--st-warning)', '!'], serious: ['var(--st-serious)', '~'], critical: ['var(--st-critical)', '×'] };

const S = { data: null, campus: 'Tempe', period: 30, building: null, space: null, sort: { key: 'completion', dir: -1 }, show: 'open', search: '', tables: {} };

// ------------------------------------------------------------------ tooltip
const tip = $('#tip');
function showTip(e, ...rows) {
  put(tip, ...rows);
  tip.style.display = 'block';
  const pad = 14, r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.style.display = 'none');
const tipValue = (v, label) => [h('div', { class: 'v' }, v), label ? h('div', { class: 'r' }, label) : null];
const tipRow = (text, color) => h('div', { class: 'r' }, color ? h('span', { class: 'k', style: `background:${color}` }) : null, text);

// ------------------------------------------------------------------ shared bits
const band = (id) => S.data.model.bands.find((b) => b.id === id);
const bandForScore = (q) => S.data.model.bands.reduce((best, b) => (q >= b.min ? b : best), S.data.model.bands[0]);
/** A quality band as a chip: status colour + symbol + words (never colour alone). */
function chip(b, extra) {
  const [color, sym] = STATUS[b.status];
  return h('span', { class: 'chip', title: b.means }, h('span', { class: 'ic2', style: `background:${color}` }, sym), b.label, extra ? h('span', { class: 'muted' }, extra) : null);
}
const compColor = (b) => (b.restricted ? 'var(--off)' : !b.spaces ? null : b.completion >= 1 ? 'var(--seq-5)' : b.completion >= 0.75 ? 'var(--seq-4)' : b.completion >= 0.5 ? 'var(--seq-3)' : b.completion >= 0.25 ? 'var(--seq-2)' : 'var(--seq-1)');
const COMP_KEYS = [['var(--seq-1)', 'Started, under 25%'], ['var(--seq-2)', '25–49%'], ['var(--seq-3)', '50–74%'], ['var(--seq-4)', '75–99%'], ['var(--seq-5)', 'Complete']];
const heatColor = (n) => (!n ? null : n >= 200 ? 'var(--seq-5)' : n >= 100 ? 'var(--seq-4)' : n >= 50 ? 'var(--seq-3)' : n >= 10 ? 'var(--seq-2)' : 'var(--seq-1)');
const heatInk = (n) => (n >= 100 ? '#0b0b0b' : '#ffffff');
const HEAT_KEYS = [['var(--seq-1)', '1–9'], ['var(--seq-2)', '10–49'], ['var(--seq-3)', '50–99'], ['var(--seq-4)', '100–199'], ['var(--seq-5)', '200+']];

const campusBuildings = () => S.data.buildings.filter((b) => b.campus === S.campus);
const campusSpaces = () => {
  const codes = new Set(campusBuildings().map((b) => b.code));
  return S.data.spaces.filter((x) => codes.has(x.code));
};
const spacesOf = (code) => S.data.spaces.filter((x) => x.code === code);
const buildingOf = (code) => S.data.buildings.find((b) => b.code === code);
const placeName = (x) => [x.floor && `Floor ${x.floor}`, x.room].filter(Boolean).join(' · ');

/** A card with a title, a one-line description and a Table toggle: every chart has a table view. */
function frame(card, id, title, desc, draw, table, legend) {
  const open = !!S.tables[id];
  const toggle = table && h('button', { class: 'tbtn' + (open ? ' on' : ''), 'aria-pressed': String(open), onclick: () => { S.tables[id] = !open; renderCharts(); } }, open ? 'Chart' : 'Table');
  put(card,
    h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('h2', {}, title), h('p', { class: 'desc' }, desc)), toggle),
    open ? h('div', { class: 'tablev' }, table()) : draw(),
    !open && legend ? legend : null);
}
const tableOf = (heads, rows, numeric = []) => h('table', {},
  h('thead', {}, h('tr', {}, heads.map((t, i) => h('th', { style: numeric.includes(i) ? 'text-align:right' : null }, t)))),
  h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'n' : null }, c))))));
const empty = (text) => h('div', { class: 'empty-note' }, text);
/** A horizontal bar with a square start and a 4px rounded data-end. */
function barPath(x, y, w, hgt, r = 4) {
  if (w <= 0) return '';
  r = Math.min(r, w, hgt / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}
/** A vertical column with a square base and a 4px rounded top. */
function colPath(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  r = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
const width = (el, min = 300) => Math.max(min, Math.floor(el.clientWidth - 32));

// ------------------------------------------------------------------ load
async function load() {
  document.body.style.opacity = S.data ? '0.6' : '1';
  try {
    S.data = await api('/api/campus');
  } catch (e) {
    put($('#notes'), h('div', { class: 'err' }, e.message));
    document.body.style.opacity = '1';
    return;
  }
  document.body.style.opacity = '1';
  if (!S.data.campuses.some((c) => c.id === S.campus)) S.campus = S.data.campuses[0].id;
  $('#updated').textContent = `Updated ${new Date(S.data.generatedAt).toLocaleTimeString()}`;
  renderPublished();
  put($('#notes'), S.data.notes.map((n) => h('div', { class: 'muted small' }, n)));
  put($('#bnames'), S.data.buildings.map((b) => h('option', { value: b.name })));
  renderAll(true);
}

function renderAll(fit) {
  renderFilters();
  renderKpis();
  renderMap(fit);
  renderSide();
  renderCharts();
  renderTable();
  renderHow();
}

function renderFilters() {
  put($('#campusSeg'), S.data.campuses.map((c) => h('button', { class: S.campus === c.id ? 'on' : '', 'aria-pressed': String(S.campus === c.id), onclick: () => { S.campus = c.id; S.building = S.space = null; renderAll(true); } }, c.id)));
  put($('#periodSeg'), [[7, '7 days'], [30, '30 days'], [90, '90 days']].map(([d, label]) => h('button', { class: S.period === d ? 'on' : '', 'aria-pressed': String(S.period === d), onclick: () => { S.period = d; renderFilters(); renderCharts(); } }, label)));
}

// ------------------------------------------------------------------ headline numbers
function renderKpis() {
  const bs = campusBuildings(), open = bs.filter((b) => !b.restricted), sp = campusSpaces();
  const c = S.data.campuses.find((x) => x.id === S.campus);
  const good = sp.filter((x) => x.score >= S.data.model.good).length;
  const sum = (k) => bs.reduce((n, b) => n + b[k], 0);
  const tile = (label, value, sub, cls = '', extra = null) => h('div', { class: 'kpi ' + cls }, h('span', { class: 'lbl' }, label), h('span', { class: 'val' }, value), extra, sub ? h('span', { class: 'sub' }, sub) : null);
  put($('#kpis'),
    tile('Spaces ready for a good splat', fmt(good), `of ${fmt(c.planned)} planned spaces on the ${S.campus} campus`, 'hero'),
    tile('Campus covered', pct(c.completion), `${c.credit.toFixed(1)} of ${fmt(c.planned)} spaces' worth`, '', h('div', { class: 'meter', role: 'meter', 'aria-valuenow': Math.round(c.completion * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${Math.max(c.completion > 0 ? 2 : 0, c.completion * 100)}%` }))),
    tile('Buildings started', fmt(c.started), `of ${fmt(open.length)} that can be photographed`),
    tile('Photos accepted', fmt(sum('photos')), `${fmt(sum('pending'))} waiting for review`),
    tile('Splats built', fmt(sum('builds')), `${fmt(sum('jobs'))} in the queue · ${fmt(sum('scans'))} scans sent`),
    tile('Members contributing', fmt(S.data.totals.contributors), 'all campuses'));
}

// ------------------------------------------------------------------ map
const map = { svg: $('#map'), view: null, fit: null, proj: null, layers: {} };

function projector(bs) {
  const lat0 = bs.reduce((n, b) => n + b.c[0], 0) / bs.length, lon0 = bs.reduce((n, b) => n + b.c[1], 0) / bs.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return ([lat, lon]) => [(lon - lon0) * kx, -(lat - lat0) * 110540];
}

function renderMap(fit) {
  const bs = campusBuildings();
  const svg = map.svg;
  map.proj = projector(bs);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const gB = s('g'), gP = s('g'), gL = s('g');
  for (const b of bs) {
    const pts = b.poly.map(map.proj);
    for (const [x, y] of pts) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    const color = compColor(b);
    const p = s('path', {
      d: 'M' + pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join('L') + 'Z',
      class: 'b' + (b.restricted ? ' off' : !b.spaces ? ' none' : '') + (S.building === b.code ? ' sel' : ''),
      style: color ? `fill:${color}` : null, 'data-code': b.code,
    });
    p.addEventListener('pointermove', (e) => !map.drag && showTip(e, ...buildingTip(b)));
    p.addEventListener('pointerleave', hideTip);
    p.addEventListener('click', () => {
      if (map.moved > 6 || b.restricted) return;
      select(b.code, null, false);
    });
    gB.append(p);
    if (b.spaces || S.building === b.code) {
      const [cx, cy] = map.proj(b.c);
      gL.append(s('text', { class: 'lab', x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'data-pri': S.building === b.code ? 9 : b.completion }, b.ref && b.ref.length >= 2 ? b.ref : b.name));
    }
  }
  const codes = new Set(bs.map((b) => b.code));
  for (const pt of S.data.points.filter((q) => codes.has(q.code))) {
    const [x, y] = map.proj([pt.lat, pt.lon]);
    gP.append(s('circle', { class: 'pt', cx: x.toFixed(1), cy: y.toFixed(1), r: 3, style: `fill:${pt.status === 'accepted' || pt.status === 'approved' || pt.status === 'processed' ? 'var(--st-good)' : 'var(--st-warning)'}` }));
  }
  map.layers = { b: gB, p: gP, l: gL };
  gP.style.display = $('#lyrPoints').checked ? '' : 'none';
  gL.style.display = $('#lyrLabels').checked ? '' : 'none';
  put(svg, gB, gP, gL);
  // The whole-campus view frames where most buildings are: a few outlying ones would shrink everything.
  const cs = bs.map((b) => map.proj(b.c));
  const q = (arr, f) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
  const cx = cs.map((p) => p[0]), cy = cs.map((p) => p[1]);
  const fx0 = q(cx, 0.04), fx1 = q(cx, 0.96), fy0 = q(cy, 0.04), fy1 = q(cy, 0.96);
  const pad = Math.max(120, Math.max(fx1 - fx0, fy1 - fy0) * 0.08);
  map.fit = { x: fx0 - pad, y: fy0 - pad, w: fx1 - fx0 + 2 * pad, h: fy1 - fy0 + 2 * pad };
  map.labels = [...gL.children].sort((a, b) => b.dataset.pri - a.dataset.pri);
  if (fit || !map.view) setView(fitBox(map.fit));
  else setView(map.view);
  put($('#mapLegend'),
    h('span', { class: 'key' }, h('span', { class: 'sw', style: 'background:transparent;border:1px solid var(--axis)' }), 'No photos yet'),
    COMP_KEYS.map(([c, t]) => h('span', { class: 'key' }, h('span', { class: 'sw', style: `background:${c}` }), t)),
    h('span', { class: 'key' }, h('span', { class: 'sw', style: 'background:var(--off);border:1px solid var(--grid)' }), 'Off limits'),
    h('span', { class: 'key' }, h('span', { class: 'dot', style: 'background:var(--st-good)' }), 'Photo or scan accepted'),
    h('span', { class: 'key' }, h('span', { class: 'dot', style: 'background:var(--st-warning)' }), 'Waiting for review'));
}

/** Keep the map's shape: widen the box to the drawing's aspect ratio. */
function fitBox(b) {
  const r = (map.svg.clientWidth || 800) / (map.svg.clientHeight || 500);
  const w = Math.max(b.w, b.h * r), hgt = w / r;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - hgt) / 2, w, h: hgt };
}

function setView(v) {
  map.view = v;
  map.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  const k = v.w / Math.max(1, map.svg.clientWidth); // map units per screen pixel
  for (const c of map.layers.p.children) c.setAttribute('r', (4 * k).toFixed(2));
  map.layers.p.style.strokeWidth = '1px';
  // Names stay 11 px on screen; one that would overlap a more complete building's name is hidden.
  const placed = [], fs = 11 * k;
  for (const t of map.labels || []) {
    t.setAttribute('font-size', fs.toFixed(2));
    t.setAttribute('stroke-width', (3 * k).toFixed(2));
    const w = t.textContent.length * fs * 0.56, hh = fs * 1.3, x = +t.getAttribute('x') - w / 2, y = +t.getAttribute('y') - hh / 2;
    const clash = placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + hh > p.y);
    t.style.display = clash ? 'none' : '';
    if (!clash) placed.push({ x, y, w, h: hh });
  }
}

function zoom(f, cx, cy) {
  const v = map.view;
  const w = clamp(v.w * f, 60, map.fit.w * 2.5), hgt = (w * v.h) / v.w;
  cx ??= v.x + v.w / 2;
  cy ??= v.y + v.h / 2;
  setView({ x: cx - ((cx - v.x) * w) / v.w, y: cy - ((cy - v.y) * hgt) / v.h, w, h: hgt });
}

map.svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = map.svg.getBoundingClientRect(), v = map.view;
  zoom(Math.exp(e.deltaY * 0.0015), v.x + ((e.clientX - r.left) / r.width) * v.w, v.y + ((e.clientY - r.top) / r.height) * v.h);
}, { passive: false });
map.svg.addEventListener('pointerdown', (e) => {
  map.drag = { x: e.clientX, y: e.clientY, v: { ...map.view } };
  map.moved = 0;
});
addEventListener('pointermove', (e) => {
  if (!map.drag) return;
  const dx = e.clientX - map.drag.x, dy = e.clientY - map.drag.y;
  map.moved = Math.abs(dx) + Math.abs(dy);
  if (map.moved < 4) return;
  map.svg.classList.add('dragging');
  hideTip();
  const k = map.drag.v.w / map.svg.clientWidth;
  setView({ ...map.drag.v, x: map.drag.v.x - dx * k, y: map.drag.v.y - dy * k });
});
addEventListener('pointerup', () => {
  map.drag = null;
  map.svg.classList.remove('dragging');
});
$('#zin').onclick = () => zoom(0.7);
$('#zout').onclick = () => zoom(1 / 0.7);
$('#zfit').onclick = () => setView(fitBox(map.fit));
$('#lyrPoints').onchange = (e) => (map.layers.p.style.display = e.target.checked ? '' : 'none');
$('#lyrLabels').onchange = (e) => (map.layers.l.style.display = e.target.checked ? '' : 'none');
$('#find').addEventListener('change', (e) => {
  const b = S.data.buildings.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
  if (!b) return;
  e.target.value = '';
  select(b.code, null, true);
});
addEventListener('resize', () => S.data && (setView(map.view), renderCharts()));

function focusBuilding(b) {
  const pts = b.poly.map(map.proj);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys), pad = Math.max(w, hh, 60) * 1.6;
  setView(fitBox({ x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: w + 2 * pad, h: hh + 2 * pad }));
}

function buildingTip(b) {
  if (b.restricted) return [...tipValue(b.name, 'Off limits for photos')];
  const out = tipValue(b.spaces ? `${pct(b.completion)} complete` : 'No photos yet', b.name + (b.ref ? ` (${b.ref})` : ''));
  if (b.spaces) {
    out.push(tipRow(`${b.good} of ${b.plan.spaces} planned spaces good · best: ${bandForScore(b.best).label}`));
    out.push(tipRow(`${fmt(b.photos)} photos accepted${b.pending ? `, ${fmt(b.pending)} waiting` : ''} · ${b.builds} splat${b.builds === 1 ? '' : 's'}`));
  } else out.push(tipRow(`Plan: ${b.plan.spaces} spaces`));
  return out;
}

// ------------------------------------------------------------------ selection and the side panel
function select(code, spaceKey, zoomTo) {
  S.building = code;
  S.space = spaceKey;
  for (const p of map.layers.b.children) p.classList.toggle('sel', p.dataset.code === code);
  const b = code && buildingOf(code);
  if (b && b.campus !== S.campus) {
    S.campus = b.campus;
    renderAll(true);
  }
  if (b && zoomTo) focusBuilding(b);
  renderSide();
  renderCharts();
  if (zoomTo) $('#side').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSide() {
  const side = $('#side');
  if (S.space) return put(side, spacePanel(S.data.spaces.find((x) => x.key === S.space)));
  if (S.building) return put(side, buildingPanel(buildingOf(S.building)));
  put(side, overviewPanel());
}

function overviewPanel() {
  const sp = campusSpaces();
  const close = sp.filter((x) => x.score >= 40 && x.score < S.data.model.good).sort((a, b) => b.score - a.score).slice(0, 5);
  const ready = sp.filter((x) => x.score >= S.data.model.good && !x.builds.length).slice(0, 5);
  const elsewhere = S.data.elsewhere;
  const row = (x, meta) => h('div', { class: 'srow', onclick: () => select(x.code, x.key, true) },
    h('span', { class: 'sname' }, `${x.building} · ${placeName(x)}`), chip(bandForScore(x.score)), h('span', { class: 'smeta' }, meta));
  return [
    h('span', { class: 'kicker' }, S.campus),
    h('h3', {}, 'Where to go next'),
    h('p', { class: 'muted small', style: 'margin:0' }, 'Click a building on the map, in the charts or in the table to see its spaces.'),
    h('h2', { style: 'margin-top:8px' }, 'Closest to good'),
    close.length ? h('div', { class: 'rows' }, close.map((x) => row(x, x.advice[0] || ''))) : h('p', { class: 'muted small' }, 'No space is between Rough and Good yet.'),
    ready.length ? [h('h2', { style: 'margin-top:8px' }, 'Good, but not built yet'), h('div', { class: 'rows' }, ready.map((x) => row(x, x.scans.length ? 'Process its scan on the dashboard.' : 'Build a capture from its photos on the Club page.')))] : null,
    elsewhere.length ? [h('h2', { style: 'margin-top:8px' }, 'Not in an ASU building'), h('p', { class: 'muted small', style: 'margin:0' }, elsewhere.map((e) => `${e.building} / ${e.room}`).join(' · '))] : null,
  ];
}

function buildingPanel(b) {
  const sp = spacesOf(b.code).sort((a, c) => c.score - a.score);
  const input = h('input', { type: 'number', min: 0, max: 500, value: String(b.plan.spaces), 'aria-label': 'Planned spaces' });
  const rule = b.plan.set ? `set by the club; the default is ${b.plan.default}` : `entrance + ${b.plan.perFloor} per floor × ${b.plan.floors} floors${b.plan.guessed ? ' (floors guessed)' : ' (floors from OpenStreetMap)'}`;
  return [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, h('span', { class: 'kicker' }, `${b.campus}${b.ref ? ` · ${b.ref}` : ''}`), h('button', { class: 'tbtn', onclick: () => select(null, null) }, 'Back to campus')),
    h('h3', {}, b.name),
    b.restricted ? h('p', { class: 'muted' }, 'Off limits: the club doesn’t photograph this building.') : [
      h('div', { style: 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap' }, h('span', { class: 'big' }, pct(b.completion)), h('span', { class: 'muted small' }, `complete · ${b.credit.toFixed(1)} of ${b.plan.spaces} planned spaces' worth`)),
      h('div', { class: 'meter' }, h('div', { style: `width:${Math.max(b.completion > 0 ? 2 : 0, b.completion * 100)}%` })),
      h('div', { class: 'plan' }, 'Plan:', input, 'spaces', h('button', {
        class: 'tbtn', onclick: async () => {
          await api('/api/campus/plan', { code: b.code, spaces: input.value }).catch((e) => alert(e.message));
          await load();
        },
      }, 'Save'), b.plan.set ? h('button', { class: 'tbtn', onclick: async () => { await api('/api/campus/plan', { code: b.code, spaces: null }); await load(); } }, 'Reset') : null, h('span', {}, `(${rule})`)),
      h('p', { class: 'muted small', style: 'margin:0' }, `${fmt(b.photos)} photos accepted${b.pending ? ` · ${fmt(b.pending)} waiting for review` : ''} · ${b.scans} scan${b.scans === 1 ? '' : 's'} · ${b.builds} splat${b.builds === 1 ? '' : 's'} built${b.jobs ? ` · ${b.jobs} in the queue` : ''}`),
      h('h2', { style: 'margin-top:6px' }, `Spaces (${sp.length})`),
      sp.length
        ? h('div', { class: 'rows' }, sp.map((x) => h('div', { class: 'srow', tabindex: 0, onclick: () => select(b.code, x.key), onkeydown: (e) => e.key === 'Enter' && select(b.code, x.key) },
            h('span', { class: 'sname' }, placeName(x) || 'Unnamed'), chip(bandForScore(x.score), String(x.score)),
            h('div', { class: 'bar1' }, h('div', { style: `width:${x.score}%;background:${STATUS[bandForScore(x.score).status][0]}` })),
            h('span', { class: 'smeta' }, spaceLine(x)))))
        : h('p', { class: 'muted small' }, `Nothing yet. Members can take about ${S.data.model.kinds.room.good} photos of a room (in one kind of light), or do a full scan.`),
      sp.length ? null : missionButton({ code: b.code, building: b.name, floor: '', room: 'Main entrance', need: S.data.model.kinds.large.good }),
    ],
  ];
}

const spaceLine = (x) => [
  x.photos.accepted ? `${x.photos.accepted} photos` : null, x.photos.pending ? `${x.photos.pending} waiting` : null,
  x.scans.length ? `${x.scans.length} scan${x.scans.length === 1 ? '' : 's'}` : null, x.builds.length ? `${x.builds.length} built` : null, x.jobs.length ? `${x.jobs.length} in the queue` : null,
  `${S.data.model.kinds[x.kind].label.toLowerCase()}`,
].filter(Boolean).join(' · ');

function spacePanel(x) {
  if (!x) return overviewPanel();
  const b = bandForScore(x.score);
  const src = { built: 'from the splat already built', scan: 'from its scan', photos: 'from its photos', none: '' }[x.source];
  const parts = [...(x.photos.parts || []), ...(x.scanScore && !x.photos.score ? [[`Scan`, x.scanScore]] : []), ...(x.built && x.source === 'built' ? x.built.parts : [])];
  const maxLight = Math.max(1, ...LIGHTS.map(([k]) => x.photos.byLight[k] || 0));
  return [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, h('span', { class: 'kicker' }, x.building), h('button', { class: 'tbtn', onclick: () => select(x.code, null) }, 'Back to building')),
    h('h3', {}, placeName(x) || 'Unnamed space'),
    h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, h('span', { class: 'big' }, String(x.score)), h('span', { class: 'muted small' }, '/ 100'), chip(b)),
    h('p', { class: 'small', style: 'margin:0' }, b.means),
    h('p', { class: 'muted small', style: 'margin:0' }, `${x.source === 'built' && x.built && x.built.measured ? 'Measured on the splat already built, with photos held back from its training' : `Expected quality ${src}`}. ${S.data.model.kinds[x.kind].label}: about ${x.need.good} photos in one kind of light make it Good, ${x.need.excellent} Excellent.`),
    parts.length ? [h('h2', { style: 'margin-top:6px' }, 'How the number was reached'), h('table', { class: 'parts' }, parts.map(([label, v]) => h('tr', {}, h('td', {}, label), h('td', { class: 'v' }, v > 0 && label !== parts[0][0] ? `+${v}` : String(v)))))] : null,
    x.photos.accepted ? [
      h('h2', { style: 'margin-top:6px' }, 'Accepted photos by light'),
      h('div', { class: 'lightbars' }, LIGHTS.map(([k, label]) => {
        const n = x.photos.byLight[k] || 0;
        return [h('span', {}, label), h('span', { class: 'b2', style: `width:${(n / maxLight) * 100}%;background:var(--seq-3);${n ? '' : 'visibility:hidden'}` }), h('span', { class: 'n' }, String(n))];
      })),
    ] : null,
    x.builds.length ? [h('h2', { style: 'margin-top:6px' }, 'Splats built'), h('div', { class: 'rows' }, x.builds.map((bd) => h('div', { class: 'srow', style: 'cursor:default' },
      h('span', { class: 'sname' }, fmtDate(bd.created || bd.stamp)), chip(bandForScore(bd.score), String(bd.score)),
      h('span', { class: 'smeta' }, measuredNote(bd), `${bd.placed}/${bd.photos} photos placed · reprojection ${bd.reprojError != null ? bd.reprojError.toFixed(2) + ' px' : '?'} · ${bd.preset || '?'} training${bd.grade ? ` · scan grade ${bd.grade}` : ''} `,
        h('a', { href: viewerUrl(bd), target: '_blank', class: 'link' }, 'View splat'))))),
      x.builds.some((bd) => !bd.measured) ? h('p', { class: 'muted small', style: 'margin:0' }, 'Estimated scores are worked out from how the build went. For a measured one, process the capture again on the dashboard with Measure quality ticked.') : null] : null,
    x.jobs.length ? h('p', { class: 'muted small' }, `${x.jobs.length} capture${x.jobs.length === 1 ? '' : 's'} of this space ${x.jobs.length === 1 ? 'is' : 'are'} on the dashboard (${x.jobs.map((j) => j.status).join(', ')}).`) : null,
    x.contributors.length ? h('p', { class: 'muted small' }, 'Photos by ', x.contributors.map((c) => `@${c.handle} (${c.photos})`).join(', ')) : null,
    x.advice.length ? [h('h2', { style: 'margin-top:6px' }, 'What would make it better'), h('ul', { class: 'advice' }, x.advice.map((a) => h('li', {}, a)))] : null,
    x.score < S.data.model.excellent ? missionButton(x) : null,
  ];
}

/** How a built splat's score was reached: measured on held-back photos, or estimated from the build. */
const measuredNote = (bd) => (bd.measured && bd.eval
  ? h('b', { title: `Every ${bd.eval.every || 12}th photo was held back from training; PSNR and SSIM compare the splat's renders of those views with the photos.` },
    `Measured: PSNR ${bd.eval.psnr.toFixed(1)} dB · SSIM ${Number.isFinite(bd.eval.ssim) ? bd.eval.ssim.toFixed(3) : '?'}${bd.eval.views ? ` on ${bd.eval.views} photos` : ''} · `)
  : 'Estimated · ');

const viewerUrl = (bd) => {
  const q = new URLSearchParams({ ply: '/files/library/' + bd.path.split('/').map(encodeURIComponent).join('/') + '/scene.ply', title: bd.title });
  if (bd.view) q.set('view', JSON.stringify(bd.view));
  return '/viewer.html?' + q;
};

/** Ask members for photos of a space: a mission on the Club page, in the light most photos are in. */
function missionButton(x) {
  if (!S.data.club) return null;
  const note = h('span', { class: 'muted small' });
  const need = x.photos ? Math.max(10, x.more && x.more.good ? x.more.good : x.need.good) : x.need;
  const light = x.photos && x.photos.dominant && x.photos.share < 1 ? x.photos.dominant : 'any';
  const btn = h('button', {
    class: 'btn small', onclick: async () => {
      btn.disabled = true;
      try {
        await api('/api/club/mission', { op: 'create', title: `${x.building}: ${x.room || 'Main entrance'}${light !== 'any' ? `, ${light} light` : ''}`.slice(0, 80), building_code: x.code, floor: x.floor, room: x.room || 'Main entrance', light, bonus: 2, wanted: need });
        note.textContent = 'Mission added: members see it in the app.';
      } catch (e) {
        note.textContent = e.message;
        btn.disabled = false;
      }
    },
  }, 'Ask members for photos');
  return h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px' }, btn, note);
}

// ------------------------------------------------------------------ charts
function renderCharts() {
  qualityChart();
  rankChart();
  lightChart();
  activityChart();
}

/** Expected quality against photos, the rule of thumb per kind of space, and where the club's spaces sit. */
function qualityChart() {
  const card = $('#qualityCard'), m = S.data.model;
  const sp = S.building ? spacesOf(S.building) : campusSpaces();
  const dots = sp.filter((x) => x.photos.accepted > 0);
  const builds = sp.flatMap((x) => x.builds.map((bd) => ({ ...bd, x })));
  const kinds = Object.entries(m.kinds);
  const legend = h('div', { class: 'legend' },
    kinds.map(([k, v]) => h('span', { class: 'key' }, h('span', { class: 'sw line', style: `background:${KIND_COLOR[k]}` }), v.label)),
    h('span', { class: 'key' }, h('span', { class: 'dot', style: 'background:var(--text)' }), 'Spaces: expected from their photos'),
    h('span', { class: 'key' }, h('span', { style: 'display:inline-block;width:8px;height:8px;background:var(--text);transform:rotate(45deg)' }), 'Splats built: measured'),
    h('span', { class: 'key' }, h('span', { style: 'display:inline-block;width:8px;height:8px;box-sizing:border-box;border:1.5px solid var(--text);transform:rotate(45deg)' }), 'estimated from the build'));
  frame(card, 'quality', 'How good a splat to expect',
    `Expected quality against photos of one space taken in one kind of light. Lines: the rule of thumb for each kind of space. ${S.building ? 'This building' : `The ${S.campus} campus`}'s spaces and splats on top.`,
    () => {
      const W = width(card, 320), H = 300, L = 34, R = 92, T = 8, B = 38;
      const lx = (n) => (Math.log10(clamp(n, 10, 1500)) - 1) / (Math.log10(1500) - 1);
      const x = (n) => L + lx(n) * (W - L - R), y = (q) => T + (1 - q / 100) * (H - T - B);
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Expected splat quality against number of photos, with the club’s spaces' });
      // band boundaries and names
      m.bands.forEach((bnd, i) => {
        const top = i + 1 < m.bands.length ? m.bands[i + 1].min : 100;
        if (bnd.min > 0) svg.append(s('line', { class: 'gridline', x1: L, x2: W - R, y1: y(bnd.min), y2: y(bnd.min) }));
        svg.append(s('text', { x: W - R + 8, y: y((bnd.min + top) / 2) + 4 }, bnd.label));
      });
      svg.append(s('line', { class: 'axisline', x1: L, x2: W - R, y1: y(0), y2: y(0) }));
      for (const q of [0, 25, 50, 75, 100]) svg.append(s('text', { x: L - 6, y: y(q) + 4, 'text-anchor': 'end' }, String(q)));
      for (const n of [10, 20, 50, 100, 200, 500, 1000]) {
        svg.append(s('line', { class: 'axisline', x1: x(n), x2: x(n), y1: y(0), y2: y(0) + 4 }));
        svg.append(s('text', { x: x(n), y: y(0) + 16, 'text-anchor': 'middle' }, n.toLocaleString()));
      }
      svg.append(s('text', { x: L + (W - L - R) / 2, y: H - 4, 'text-anchor': 'middle' }, 'photos in one kind of light (log scale)'));
      // Below the minimum, COLMAP rarely places photos at all: the curves start there.
      svg.append(s('text', { x: x(10) + 4, y: y(4) }, `under ${m.minPhotos} photos`));
      svg.append(s('line', { class: 'gridline', x1: x(m.minPhotos), x2: x(m.minPhotos), y1: y(0), y2: y(100) }));
      for (const [k, v] of kinds) {
        const pts = v.curve.filter(([n]) => n >= m.minPhotos);
        svg.append(s('path', { d: 'M' + pts.map(([n, q]) => `${x(n).toFixed(1)},${y(q).toFixed(1)}`).join('L'), fill: 'none', style: `stroke:${KIND_COLOR[k]}`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
      const hit = (cx, cy, rows) => s('circle', { class: 'hit', cx, cy, r: 12, onpointermove: (e) => showTip(e, ...rows), onpointerleave: hideTip });
      for (const d of dots) {
        const cx = x(Math.max(10, d.photos.effective)), cy = y(d.photos.score);
        svg.append(s('circle', { cx, cy, r: 4.5, style: `fill:${KIND_COLOR[d.kind]};stroke:var(--surface)`, 'stroke-width': 2 }));
        svg.append(hit(cx, cy, [...tipValue(`${d.photos.score} expected from photos`, `${d.building} · ${placeName(d)}`), tipRow(`${d.photos.accepted} photos, ${Math.round(d.photos.effective)} counting light`), tipRow(bandForScore(d.photos.score).label)]));
      }
      for (const bd of builds) {
        // Filled: measured on held-back photos. Outlined: estimated from how the build went. (A filled
        // diamond's dark edge eats into it, an outline's spreads out: sizes chosen so both look the same.)
        const cx = x(Math.max(10, bd.placed)), cy = y(bd.score), r = bd.measured ? 7 : 5.5;
        const look = bd.measured ? `fill:${KIND_COLOR[bd.x.kind]};stroke:var(--surface)` : `fill:var(--surface);stroke:${KIND_COLOR[bd.x.kind]}`;
        svg.append(s('path', { d: `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`, style: look, 'stroke-width': 2 }));
        svg.append(hit(cx, cy, [...tipValue(`${bd.score}: ${bandForScore(bd.score).label}`, `Built: ${bd.x.building} · ${placeName(bd.x)}`), tipRow(`${bd.placed} of ${bd.photos} photos placed${bd.grade ? ` · scan grade ${bd.grade}` : ''}`),
          tipRow(bd.measured && bd.eval ? `Measured: PSNR ${bd.eval.psnr.toFixed(1)} dB, SSIM ${Number.isFinite(bd.eval.ssim) ? bd.eval.ssim.toFixed(3) : '?'}${bd.eval.views ? ` on ${bd.eval.views} held-back photos` : ''}` : 'Estimated from the build')]));
      }
      if (!dots.length && !builds.length) svg.append(s('text', { x: L + 12, y: T + 18 }, 'No spaces with photos or splats here yet: the lines show what to expect.'));
      return svg;
    },
    () => tableOf(['Space', 'Kind', 'Photos', 'Expected from photos', 'Scan', 'Built', 'Overall'],
      sp.map((x) => [`${x.building} · ${placeName(x)}`, m.kinds[x.kind].label, String(x.photos.accepted), x.photos.accepted ? String(x.photos.score) : '–', x.scanScore ? String(x.scanScore) : '–', x.built ? `${x.built.score} ${x.built.measured ? 'measured' : 'estimated'}` : '–', `${x.score} ${bandForScore(x.score).label}`]), [2, 3, 4, 5]),
    legend);
}

/** Started buildings, ranked by completion. */
function rankChart() {
  const card = $('#rankCard');
  const bs = campusBuildings().filter((b) => !b.restricted && b.spaces > 0).sort((a, b) => b.completion - a.completion || b.credit - a.credit).slice(0, 12);
  frame(card, 'rank', 'Buildings by completion', `How much of each building’s plan has data good enough for a good splat (${S.campus}, started buildings).`,
    () => {
      if (!bs.length) return empty('No building on this campus has photos or splats yet.');
      const W = width(card, 300), row = 30, labelW = Math.min(190, W * 0.38), valueW = 92, H = bs.length * row + 6;
      const bw = W - labelW - valueW;
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Buildings ranked by completion' });
      svg.append(s('line', { class: 'axisline', x1: labelW, x2: labelW, y1: 0, y2: H }));
      bs.forEach((b, i) => {
        const y0 = i * row + 8, len = Math.max(b.completion > 0 ? 3 : 0, b.completion * bw);
        const name = b.name.length > 28 ? b.name.slice(0, 27) + '…' : b.name;
        svg.append(s('text', { x: labelW - 8, y: y0 + 11, 'text-anchor': 'end', style: `fill:${S.building === b.code ? 'var(--text)' : 'var(--ink-muted)'}` }, name));
        svg.append(s('path', { d: barPath(labelW, y0, len, 14), style: 'fill:var(--cat-1)' }));
        svg.append(s('text', { x: labelW + len + 6, y: y0 + 11 }, `${pct(b.completion)} · ${b.good}/${b.plan.spaces}`));
        svg.append(s('rect', {
          class: 'hit', x: 0, y: y0 - 7, width: W, height: row, tabindex: 0,
          onpointermove: (e) => showTip(e, ...buildingTip(b)), onpointerleave: hideTip, onclick: () => select(b.code, null, true), onkeydown: (e) => e.key === 'Enter' && select(b.code, null, true),
        }));
      });
      return svg;
    },
    () => tableOf(['Building', 'Complete', 'Good spaces', 'Planned', 'Photos', 'Splats'], bs.map((b) => [b.name, pct(b.completion), String(b.good), String(b.plan.spaces), fmt(b.photos), String(b.builds)]), [1, 2, 3, 4, 5]));
}

/** Accepted photos per light slot: buildings (or a building's spaces) against morning…night. */
function lightChart() {
  const card = $('#lightCard');
  const b = S.building && buildingOf(S.building);
  const rows = b
    ? spacesOf(b.code).map((x) => ({ name: placeName(x) || 'Unnamed', light: x.photos.byLight, total: x.photos.accepted }))
    : campusBuildings().filter((x) => x.photos > 0).sort((a, c) => c.photos - a.photos).slice(0, 10).map((x) => ({ name: x.name, light: x.light, total: x.photos }));
  const legend = h('div', { class: 'legend' }, h('span', {}, 'Accepted photos:'), HEAT_KEYS.map(([c, t]) => h('span', { class: 'key' }, h('span', { class: 'sw', style: `background:${c}` }), t)));
  frame(card, 'light', 'Light coverage', b ? `${b.name}: accepted photos of each space in each kind of light. A splat is cleanest from one light; empty columns are chances for missions.` : `Accepted photos per building in each kind of light (${S.campus}, top 10). A splat is cleanest from one light.`,
    () => {
      if (!rows.length) return empty(b ? 'No accepted photos in this building yet.' : 'No accepted photos on this campus yet.');
      const W = width(card, 300), labelW = Math.min(190, W * 0.36), head = 34, row = 30, gap = 2;
      const cw = (W - labelW) / 4, H = head + rows.length * row;
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': 'Accepted photos by light slot' });
      LIGHTS.forEach(([, label, hours], j) => {
        svg.append(s('text', { x: labelW + cw * j + cw / 2, y: 12, 'text-anchor': 'middle', style: 'fill:var(--text)' }, label));
        svg.append(s('text', { x: labelW + cw * j + cw / 2, y: 26, 'text-anchor': 'middle' }, hours));
      });
      rows.forEach((r, i) => {
        const y0 = head + i * row;
        svg.append(s('text', { x: labelW - 8, y: y0 + row / 2 + 4, 'text-anchor': 'end' }, r.name.length > 26 ? r.name.slice(0, 25) + '…' : r.name));
        LIGHTS.forEach(([k, label], j) => {
          const n = r.light[k] || 0, c = heatColor(n), x0 = labelW + cw * j + gap / 2;
          if (c) svg.append(s('rect', { x: x0, y: y0 + gap / 2, width: cw - gap, height: row - gap, rx: 3, style: `fill:${c}` }));
          else svg.append(s('rect', { x: x0, y: y0 + gap / 2, width: cw - gap, height: row - gap, rx: 3, style: 'fill:none;stroke:var(--grid)' }));
          svg.append(s('text', { x: x0 + (cw - gap) / 2, y: y0 + row / 2 + 4, 'text-anchor': 'middle', style: `fill:${c ? heatInk(n) : 'var(--dim)'}` }, n ? String(n) : '–'));
          svg.append(s('rect', { class: 'hit', x: x0, y: y0, width: cw, height: row, onpointermove: (e) => showTip(e, ...tipValue(`${n} accepted photo${n === 1 ? '' : 's'}`, `${r.name} · ${label.toLowerCase()} light`), tipRow(`${r.total ? Math.round((n / r.total) * 100) : 0}% of its photos`)), onpointerleave: hideTip }));
        });
      });
      return svg;
    },
    () => tableOf([b ? 'Space' : 'Building', ...LIGHTS.map((l) => l[1]), 'Total'], rows.map((r) => [r.name, ...LIGHTS.map(([k]) => String(r.light[k] || 0)), String(r.total)]), [1, 2, 3, 4, 5]),
    rows.length ? legend : null);
}

/** Photos sent per day over the chosen period. */
function activityChart() {
  const card = $('#activityCard');
  const byDay = new Map(S.data.days.map((d) => [d.day, d]));
  const today = new Date(Date.now() - 7 * 3600e3);
  const days = [];
  for (let i = S.period - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5).toISOString().slice(0, 10);
    days.push(byDay.get(d) || { day: d, photos: 0, accepted: 0, pending: 0, scans: 0, builds: 0, byLight: {} });
  }
  const total = days.reduce((n, d) => n + d.photos, 0);
  frame(card, 'activity', 'Photos sent per day', `Single photos sent by members over the last ${S.period} days (all campuses). Hover a day for scans and splats built.`,
    () => {
      if (!S.data.club) return empty('The club database isn’t set up on this PC, so there is no photo activity to show.');
      const W = width(card, 300), H = 220, L = 34, R = 8, T = 8, B = 26;
      const max = Math.max(4, ...days.map((d) => d.photos));
      const step = max <= 10 ? 2 : max <= 50 ? 10 : max <= 100 ? 20 : max <= 250 ? 50 : 100;
      const top = Math.ceil(max / step) * step;
      const y = (n) => T + (1 - n / top) * (H - T - B);
      const slot = (W - L - R) / days.length, cw = Math.min(24, Math.max(2, slot - 2));
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Photos sent per day, last ${S.period} days` });
      for (let v = 0; v <= top; v += step) {
        svg.append(s('line', { class: v ? 'gridline' : 'axisline', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
        svg.append(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v.toLocaleString()));
      }
      const every = Math.ceil(days.length / 6);
      days.forEach((d, i) => {
        const x0 = L + i * slot + (slot - cw) / 2;
        if (d.photos) svg.append(s('path', { d: colPath(x0, y(d.photos), cw, y(0) - y(d.photos)), style: 'fill:var(--cat-1)' }));
        if ((days.length - 1 - i) % every === 0) svg.append(s('text', { x: x0 + cw / 2, y: H - 8, 'text-anchor': 'middle' }, fmtDay(d.day)));
        svg.append(s('rect', {
          class: 'hit', x: L + i * slot, y: T, width: slot, height: H - T - B,
          onpointermove: (e) => showTip(e, ...tipValue(`${d.photos} photo${d.photos === 1 ? '' : 's'}`, fmtDay(d.day)),
            d.photos ? tipRow(`${d.accepted} accepted · ${d.pending} waiting`) : null,
            d.photos ? tipRow(LIGHTS.filter(([k]) => d.byLight[k]).map(([k, l]) => `${l.toLowerCase()} ${d.byLight[k]}`).join(' · ')) : null,
            d.scans || d.builds ? tipRow(`${d.scans} scan${d.scans === 1 ? '' : 's'} sent · ${d.builds} splat${d.builds === 1 ? '' : 's'} built`) : null),
          onpointerleave: hideTip,
        }));
      });
      if (!total) svg.append(s('text', { x: L + 10, y: T + 16 }, `No photos sent in the last ${S.period} days.`));
      return svg;
    },
    () => tableOf(['Day', 'Photos', 'Accepted', 'Waiting', 'Scans', 'Splats built'], days.filter((d) => d.photos || d.scans || d.builds).reverse().map((d) => [fmtDay(d.day), String(d.photos), String(d.accepted), String(d.pending), String(d.scans), String(d.builds)]), [1, 2, 3, 4, 5]));
}

// ------------------------------------------------------------------ the table of every building
function renderTable() {
  const card = $('#tableCard');
  const all = campusBuildings();
  const q = S.search.trim().toLowerCase();
  let bs = all.filter((b) => (S.show === 'all' ? true : S.show === 'started' ? b.spaces > 0 && !b.restricted : S.show === 'open' ? !b.restricted : b.restricted))
    .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.ref || '').toLowerCase().includes(q));
  const key = S.sort.key, dir = S.sort.dir;
  const val = { name: (b) => b.name.toLowerCase(), completion: (b) => b.completion, good: (b) => b.good, plan: (b) => b.plan.spaces, best: (b) => b.best, photos: (b) => b.photos, pending: (b) => b.pending, builds: (b) => b.builds, contributors: (b) => b.contributors }[key];
  bs = bs.sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : a.name.localeCompare(b.name)));
  const th = (label, k, num) => h('th', { class: 'sortable', style: num ? 'text-align:right' : null, 'aria-sort': S.sort.key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none', onclick: () => { S.sort = { key: k, dir: S.sort.key === k ? -dir : k === 'name' ? 1 : -1 }; renderTable(); } }, label + (S.sort.key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''));
  const search = h('input', { type: 'search', value: S.search, placeholder: 'Filter by name', style: 'font:inherit;font-size:0.85rem;color:var(--text);background:var(--surface-2);border:1px solid var(--line-2);border-radius:8px;padding:5px 10px', oninput: (e) => { S.search = e.target.value; renderTable(); setTimeout(() => { const i = $('#tableCard input[type=search]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); } });
  put(card,
    h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('h2', {}, `Every building · ${S.campus}`), h('p', { class: 'desc' }, 'Sort by any column; click a row to see the building on the map.')),
      search,
      h('div', { class: 'seg' }, [['started', 'Started'], ['open', 'Can be photographed'], ['off', 'Off limits'], ['all', 'All']].map(([k, l]) => h('button', { class: S.show === k ? 'on' : '', onclick: () => { S.show = k; renderTable(); } }, l)))),
    bs.length ? h('div', { class: 'tablev', style: 'max-height:460px' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, th('Building', 'name'), th('Complete', 'completion'), th('Good spaces', 'good', true), th('Planned', 'plan', true), th('Best space', 'best'), th('Photos', 'photos', true), th('Waiting', 'pending', true), th('Splats', 'builds', true), h('th', {}, 'Light'), th('Members', 'contributors', true))),
      h('tbody', {}, bs.map((b) => h('tr', { class: 'click' + (b.restricted ? ' off' : ''), tabindex: 0, onclick: () => !b.restricted && select(b.code, null, true), onkeydown: (e) => e.key === 'Enter' && !b.restricted && select(b.code, null, true) },
        h('td', {}, b.name, b.ref && b.ref.length >= 2 ? h('span', { class: 'muted' }, ` ${b.ref}`) : null),
        h('td', {}, b.restricted ? 'Off limits' : [h('span', { class: 'tbar' }, h('i', { style: `width:${b.completion * 100}%` })), pct(b.completion)]),
        h('td', { class: 'n' }, String(b.good)), h('td', { class: 'n' }, String(b.plan.spaces)),
        h('td', {}, b.spaces ? chip(bandForScore(b.best)) : '–'),
        h('td', { class: 'n' }, fmt(b.photos)), h('td', { class: 'n' }, fmt(b.pending)), h('td', { class: 'n' }, String(b.builds)),
        h('td', {}, h('span', { class: 'mini', title: LIGHTS.map(([k, l]) => `${l}: ${b.light[k] || 0}`).join(', ') }, LIGHTS.map(([k]) => h('span', { style: `background:${heatColor(b.light[k] || 0) || 'transparent'};outline:1px solid var(--grid)` })))),
        h('td', { class: 'n' }, String(b.contributors))))))) : empty('No buildings match.'));
}

// ------------------------------------------------------------------ how the numbers work
function renderHow() {
  const m = S.data.model;
  put($('#howCard'),
    h('div', { class: 'card-head' }, h('div', { class: 'grow' }, h('h2', {}, 'How the numbers work'))),
    h('p', {}, 'Most numbers here are estimates from rules of thumb. They are meant to tell the club where to go next, and they should be checked against the club’s own results: the diamonds in the quality chart are splats already built on this PC, filled where SplatStation measured them.'),
    h('h3', {}, 'Quality bands'),
    h('div', { class: 'tablev', style: 'max-height:none' }, tableOf(['Band', 'Score', 'What a splat looks like'], m.bands.map((b, i) => [chip(b), `${b.min}–${i + 1 < m.bands.length ? m.bands[i + 1].min - 1 : 100}`, b.means]))),
    h('h3', {}, 'Expected quality of a space'),
    h('p', {}, `From photos: the more photos of a space in one kind of light, the better, with diminishing returns. A room reaches Good at about ${m.kinds.room.good} photos and Excellent at about ${m.kinds.room.excellent}; a hallway needs ${m.kinds.hallway.good} and ${m.kinds.hallway.excellent}; a large open space like a lobby ${m.kinds.large.good} and ${m.kinds.large.excellent} (the kind is guessed from the space’s name). Photos in other light count a quarter, because a splat can’t agree with two lightings at once, and a space whose photos are spread over several kinds of light loses up to 20 points. Fewer than ${m.minPhotos} photos rarely give COLMAP enough to place them at all.`),
    h('p', {}, 'From a scan: the capture coach’s grade (it scores coverage, sharpness and light as you scan), less a little because a good scan can still fail to process.'),
    h('p', {}, 'From a splat already built: measured, when it was processed with Measure quality ticked on the dashboard. Every 12th photo was then held back from training, and the PSNR of the splat’s renders of those views against the photos sets the score (table below), less for photos COLMAP couldn’t place. Otherwise estimated: what its photos or scan promised, discounted when COLMAP placed fewer than 95% of the photos, when the reprojection error is above 1 pixel, or when it was trained with the quick preset. In the quality chart, measured splats are filled diamonds and estimated ones outlined.'),
    m.psnrStops ? h('div', { class: 'tablev', style: 'max-height:none' }, tableOf(['Measured PSNR', 'Score', 'Band'], m.psnrStops.map(([db, q]) => [`${db} dB`, String(q), chip(bandForScore(q))]), [1])) : null,
    h('h3', {}, 'Completion'),
    h('p', {}, 'Each building has a plan: how many spaces it should have before it counts as complete. By default that is the entrance plus 2 spaces per floor (3 in buildings over 4,000 m² of footprint), using the number of floors from OpenStreetMap where it is known and 2 where it isn’t. Change the plan on a building’s panel; 0 leaves a building out. A space counts fully once it reaches Good and partly before that, and a building is complete when its spaces add up to its plan. Campus coverage adds up every building that can be photographed.'),
    h('p', {}, 'Off-limits buildings (residence halls, health, police and courts, children’s centers) are shown in dark grey and never count.'),
    h('h3', {}, 'What members see'),
    h('p', {}, 'Publish to members sends a summary to the Campus map in the phone app: each space’s expected quality, its accepted photos in each kind of light, how many wait for review, and about how many more photos, in which light, would make it Good (counted with the same rules, so the phone says what this page says). Building plans go too, so the map is coloured the same. No member names and no GPS points are sent, and nothing in off-limits buildings. It also happens by itself a few seconds after you review photos on the Club page.'));
}

// ------------------------------------------------------------------ publishing for members' phones
const fmtWhen = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const PUBLISH_TIP = $('#publish').title;
function renderPublished() {
  const p = S.data.published, e = S.data.publishError, el = $('#pubState');
  const failed = e && (!p || Date.parse(e.at) > Date.parse(p.at));
  el.textContent = failed ? `Couldn’t publish: ${e.message}` : p ? `Members see ${p.spaces} space${p.spaces === 1 ? '' : 's'} from ${fmtWhen(p.at)}` : 'Not published to members yet';
  el.classList.toggle('warn', !!failed);
  $('#publish').disabled = !S.data.club;
  $('#publish').title = S.data.club ? PUBLISH_TIP : 'Set up the club database on this PC (crowd.json) first.';
}
$('#publish').onclick = async () => {
  const b = $('#publish');
  b.disabled = true;
  b.textContent = 'Publishing…';
  try {
    S.data.published = await api('/api/campus/publish', {});
    S.data.publishError = null;
  } catch (e) {
    S.data.publishError = { at: new Date().toISOString(), message: e.message };
  }
  b.textContent = 'Publish to members';
  renderPublished();
};

$('#refresh').onclick = load;
load();
