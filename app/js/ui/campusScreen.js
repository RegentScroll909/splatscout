// Campus (club beta): where the club still needs photos. A map of ASU buildings coloured by how much of their
// floor area the club's photos cover, the buildings near you, and for each space about how many more photos, in which
// light, would make a good splat, with a button that opens Snap already filled in. SplatStation works the
// numbers out on the club PC and publishes them (data/campusmap.js); the colours follow the same rules as its
// Campus page. The list of buildings under the map carries the same information without the map.

import { h, mount, toast } from './dom.js';
import { icon } from './icons.js';
import * as campus from '../data/campus.js';
import * as club from '../data/club.js';
import * as CM from '../data/campusmap.js';
import { getSettings, setSettings } from '../data/settings.js';
import { LIGHT_SLOTS, LIGHT_LABEL } from '../core/clubrules.js';

const NS = 'http://www.w3.org/2000/svg';
/** Quality bands as status chips: colour + symbol + words, never colour alone (same as SplatStation). */
const STATUS = { good: ['var(--st-good)', '✓'], warning: ['var(--st-warning)', '!'], serious: ['var(--st-serious)', '~'], critical: ['var(--st-critical)', '×'] };
const BIN_COLOR = [null, 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
const SHORT = { Tempe: 'Tempe', Polytechnic: 'Poly', 'West Valley': 'West', 'Downtown Phoenix': 'Downtown' };
const LABEL_PX = 11; // building names on the map, screen pixels
const HIT_PX = 24; // a tap this close to a building picks it

function s(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  return el;
}
const pct = CM.pctText; // "0.3%", "2.4%", "24%": small progress still shows
const fmtArea = (m2) => `${Math.round(m2).toLocaleString()} m²`;
const fmtDist = (m) => (m < 1 ? 'you’re here' : m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
const placeName = (x) => [x.floor && `Floor ${x.floor}`, x.room].filter(Boolean).join(' · ') || 'Unnamed';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 36 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const bandOf = (x) => CM.BANDS.find((b) => b.id === x.band) || CM.bandOf(x.score);

/** A quality band as a chip. */
function chip(x) {
  const band = bandOf(x);
  const [color, sym] = STATUS[band.status];
  return h('span.qchip', { title: band.means }, h('i', { style: { background: color }, 'aria-hidden': 'true' }, sym), band.label, h('span.muted.mono', String(x.score)));
}

/** A thin completion meter (fill on a darker step of the same blue). */
const meter = (x) => h('div.cmeter', { role: 'meter', 'aria-valuenow': +(x * 100).toFixed(2), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Floor area covered' }, h('div', { style: { width: `${Math.max(x > 0 ? 2 : 0, x * 100)}%` } }));

export async function campusScreen(root, { navigate, query }) {
  const settings = getSettings();
  const S = {
    list: [], summary: null, buildings: [], campus: settings.campusMapCampus || null, sel: query.get('b') || null,
    fix: null, locating: false, geoMsg: '', show: 'started', q: '', loading: true, picked: !!settings.campusMapCampus,
  };
  let alive = true;
  const status = h('div.status-line', h('span.status-dot.pending'), h('span.small', 'Loading the campus map…'));
  const seg = h('div.seg.campus-seg', { role: 'group', 'aria-label': 'Campus' });
  const svg = s('svg', { id: 'cmap', role: 'img', 'aria-label': 'Map of the campus: buildings coloured by how much of their floor area the club’s photos cover. The list of buildings below has the same information.' });
  const legend = h('div.c-legend');
  const mapCard = h('section.card.cmap-card',
    h('div.cmap-wrap', svg,
      h('div.cmap-tools',
        h('button.icon-btn.small.glass', { onclick: () => zoom(0.6), 'aria-label': 'Zoom in' }, icon('plus')),
        h('button.icon-btn.small.glass', { onclick: () => zoom(1 / 0.6), 'aria-label': 'Zoom out' }, icon('minus')),
        h('button.icon-btn.small.glass', { onclick: () => setView(fitBox(map.fit)), 'aria-label': 'Show the whole campus' }, icon('area')),
        h('button.icon-btn.small.glass', { onclick: () => locate(false), 'aria-label': 'Show where I am' }, icon('align')))),
    legend);
  const detail = h('section.card.c-detail', { 'aria-live': 'polite' });
  const listCard = h('section.card');
  mount(root, h('div.page.campus',
    h('header.page-head',
      h('button.icon-btn', { onclick: () => navigate('#/club'), 'aria-label': 'Back' }, icon('back')),
      h('div.head-text', h('div.kicker', 'Club beta'), h('h1', 'Campus')),
      h('span', { style: { flex: '1' } }),
      h('button.icon-btn', { onclick: () => refresh(), 'aria-label': 'Refresh' }, icon('refresh'))),
    status, seg, mapCard, detail, listCard));

  // ------------------------------------------------------------------ data
  const campusBuildings = () => S.buildings.filter((b) => b.campus === S.campus);
  const byCode = (code) => S.buildings.find((b) => b.code === code) || null;
  const distOf = (b) => (S.fix ? campus.distanceTo(b, S.fix.lat, S.fix.lon) : null);

  function apply(summary) {
    S.summary = summary;
    S.buildings = CM.summarize(S.list, summary || {});
    if (!S.list.some((b) => b.campus === S.campus)) S.campus = 'Tempe';
    const sel = S.sel && byCode(S.sel);
    if (sel) S.campus = sel.campus;
  }

  function paintStatus() {
    const sm = S.summary;
    const n = sm && sm.spaces ? sm.spaces.length : 0;
    let dot = 'ok', text;
    if (S.loading && !sm) [dot, text] = ['pending', 'Loading the campus map…'];
    else if (!sm) [dot, text] = ['warn', S.error ? `Couldn’t load the campus map: ${S.error}` : 'No campus map yet.'];
    else if (sm.missing) [dot, text] = ['warn', 'The club hasn’t switched the campus map on yet. Buildings are shown without colours.'];
    else if (!sm.at) [dot, text] = ['warn', 'The club PC hasn’t published what it needs yet. Buildings are shown without colours.'];
    else if (sm.offline) [dot, text] = ['warn', `Offline: the map as of ${ago(sm.at)} (${n} spaces).`];
    else text = `Updated by the club PC ${ago(sm.at)} · ${n} space${n === 1 ? '' : 's'} with photos`;
    mount(status, h('span.status-dot.' + dot + (S.loading ? '.pending' : '')), h('span.small', text));
  }

  async function refresh() {
    S.loading = true;
    mapCard.style.opacity = S.summary ? '0.6' : '1';
    paintStatus();
    try {
      const sm = await CM.load();
      if (!alive) return;
      S.error = sm.offline ? sm.error : null;
      apply(sm);
    } catch (e) {
      S.error = e.message;
    }
    S.loading = false;
    mapCard.style.opacity = '1';
    if (alive) renderAll(false);
  }

  // ------------------------------------------------------------------ GPS
  async function locate(quiet) {
    if (S.locating) return;
    S.locating = true;
    S.geoMsg = '';
    if (!quiet) renderDetail();
    try {
      S.fix = await campus.locate({ timeout: 10000, good: 20 });
      // The first fix picks the campus you're on, unless you chose one yourself.
      const closest = S.buildings.map((b) => ({ b, d: campus.distanceTo(b, S.fix.lat, S.fix.lon) })).sort((a, b) => a.d - b.d)[0];
      if (closest && closest.d < 2000 && !S.picked && !S.sel && closest.b.campus !== S.campus) {
        S.campus = closest.b.campus;
        drawMap(true);
      }
      if (!quiet && closest && closest.b.campus === S.campus) panTo(S.fix);
      S.geoMsg = `GPS good to ${S.fix.acc} m`;
    } catch (e) {
      S.geoMsg = quiet ? '' : e.message;
    }
    S.locating = false;
    if (!alive) return;
    drawYou();
    renderSeg();
    renderLegend();
    renderDetail();
  }

  // ------------------------------------------------------------------ map
  const map = { view: null, fit: null, proj: null, shapes: [], labels: [], layers: {}, k: 1 };

  function projector(bs) {
    const lat0 = bs.reduce((n, b) => n + b.c[0], 0) / bs.length, lon0 = bs.reduce((n, b) => n + b.c[1], 0) / bs.length;
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    return ([lat, lon]) => [(lon - lon0) * kx, -(lat - lat0) * 110540];
  }

  function drawMap(fit) {
    const bs = campusBuildings();
    if (!bs.length) return;
    map.proj = projector(bs);
    const gB = s('g'), gL = s('g'), gY = s('g');
    map.shapes = [];
    for (const b of bs) {
      const pts = b.poly.map(map.proj);
      map.shapes.push({ b, pts });
      const bin = CM.completionBin(b);
      const p = s('path', {
        d: 'M' + pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join('L') + 'Z',
        class: 'b' + (b.restricted ? ' off' : !bin ? ' none' : '') + (S.sel === b.code ? ' sel' : ''),
        'data-code': b.code,
      });
      if (!b.restricted && bin) p.style.fill = BIN_COLOR[bin];
      gB.append(p);
      if (b.spaces.length || S.sel === b.code) {
        const [cx, cy] = map.proj(b.c);
        const t = s('text', { class: 'lab', x: cx.toFixed(1), y: cy.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
        t.textContent = b.ref && b.ref.length >= 2 ? b.ref : b.name;
        t.dataset.pri = S.sel === b.code ? 9 : b.completion;
        gL.append(t);
      }
    }
    map.layers = { b: gB, l: gL, y: gY };
    svg.replaceChildren(gB, gL, gY);
    map.labels = [...gL.children].sort((a, b) => b.dataset.pri - a.dataset.pri);
    // The whole-campus view frames where most buildings are: a few outlying ones would shrink everything.
    const cs = bs.map((b) => map.proj(b.c));
    const q = (arr, f) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
    const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
    const fx0 = q(xs, 0.04), fx1 = q(xs, 0.96), fy0 = q(ys, 0.04), fy1 = q(ys, 0.96);
    const pad = Math.max(80, Math.max(fx1 - fx0, fy1 - fy0) * 0.06);
    map.fit = { x: fx0 - pad, y: fy0 - pad, w: fx1 - fx0 + 2 * pad, h: fy1 - fy0 + 2 * pad };
    const sel = S.sel && byCode(S.sel);
    if (fit || !map.view) setView(sel && sel.campus === S.campus ? focusBox(sel) : fitBox(map.fit));
    else setView(map.view);
    drawYou();
  }

  /** Keep the map's shape: widen the box to the drawing's aspect ratio. */
  function fitBox(b) {
    const r = (svg.clientWidth || 360) / (svg.clientHeight || 420);
    const w = Math.max(b.w, b.h * r), hh = w / r;
    return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - hh) / 2, w, h: hh };
  }
  function focusBox(b) {
    const pts = b.poly.map(map.proj);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys), pad = Math.max(w, hh, 60) * 1.4;
    return fitBox({ x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: w + 2 * pad, h: hh + 2 * pad });
  }

  function setView(v) {
    if (!v || !Number.isFinite(v.w)) return;
    map.view = v;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const k = (map.k = v.w / Math.max(1, svg.clientWidth || 360)); // map metres per screen pixel
    // Names stay 11 px on screen; one that would cover a more complete building's name is hidden.
    const placed = [], fs = LABEL_PX * k;
    for (const t of map.labels) {
      t.setAttribute('font-size', fs.toFixed(2));
      t.setAttribute('stroke-width', (3 * k).toFixed(2));
      const w = t.textContent.length * fs * 0.56, hh = fs * 1.3, x = +t.getAttribute('x') - w / 2, y = +t.getAttribute('y') - hh / 2;
      const clash = placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + hh > p.y);
      t.style.display = clash ? 'none' : '';
      if (!clash) placed.push({ x, y, w, h: hh });
    }
    for (const c of map.layers.y ? map.layers.y.querySelectorAll('[data-px]') : []) c.setAttribute('r', (+c.dataset.px * k).toFixed(2));
  }

  function zoom(f, cx, cy) {
    const v = map.view;
    if (!v) return;
    const w = clamp(v.w * f, 60, map.fit.w * 3), hh = (w * v.h) / v.w;
    cx ??= v.x + v.w / 2;
    cy ??= v.y + v.h / 2;
    setView({ x: cx - ((cx - v.x) * w) / v.w, y: cy - ((cy - v.y) * hh) / v.h, w, h: hh });
  }

  function panTo(fix) {
    if (!map.proj || !map.view) return;
    const [x, y] = map.proj([fix.lat, fix.lon]);
    const w = Math.min(map.view.w, 700), hh = (w * map.view.h) / map.view.w;
    setView({ x: x - w / 2, y: y - hh / 2, w, h: hh });
  }

  /** You on the map: a white dot with the GPS reading's accuracy around it. */
  function drawYou() {
    const g = map.layers.y;
    if (!g) return;
    g.replaceChildren();
    if (!S.fix || !map.proj) return;
    const [x, y] = map.proj([S.fix.lat, S.fix.lon]);
    g.append(s('circle', { class: 'acc', cx: x.toFixed(1), cy: y.toFixed(1), r: Math.max(5, S.fix.acc) }));
    g.append(s('circle', { class: 'you', cx: x.toFixed(1), cy: y.toFixed(1), r: (7 * map.k).toFixed(2), 'data-px': 7 }));
    setView(map.view);
  }

  /** The building under a tap, or the closest one within a fingertip. */
  function hit(clientX, clientY) {
    const r = svg.getBoundingClientRect(), v = map.view;
    const mx = v.x + ((clientX - r.left) / r.width) * v.w, my = v.y + ((clientY - r.top) / r.height) * v.h;
    let best = null, bestD = HIT_PX * map.k;
    for (const { b, pts } of map.shapes) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > my !== yj > my && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
        const dx = xi - xj, dy = yi - yj, L = dx * dx + dy * dy;
        const t = L ? clamp(((mx - xj) * dx + (my - yj) * dy) / L, 0, 1) : 0;
        const d = Math.hypot(xj + t * dx - mx, yj + t * dy - my);
        if (d < bestD) [best, bestD] = [b, d];
      }
      if (inside) return b;
    }
    return best;
  }

  // One finger pans, two pinch; a tap picks a building. The wheel zooms on a computer.
  const pointers = new Map();
  let gesture = null;
  const startGesture = () => {
    const pts = [...pointers.values()];
    const r = svg.getBoundingClientRect();
    gesture = { view: { ...map.view }, rect: r, moved: gesture ? gesture.moved : 0, multi: pts.length > 1 || (gesture && gesture.multi) };
    if (pts.length === 1) gesture.p = { ...pts[0] };
    else {
      const [a, b] = pts;
      gesture.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture.dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    }
  };
  svg.addEventListener('pointerdown', (e) => {
    if (!map.view) return;
    try {
      svg.setPointerCapture(e.pointerId); // keep the drag when the finger leaves the map
    } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) gesture = null;
    startGesture();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    const v0 = gesture.view, r = gesture.rect, k = v0.w / r.width;
    const pts = [...pointers.values()];
    if (pts.length === 1 && gesture.p) {
      if (gesture.moved < 6) return;
      svg.classList.add('dragging');
      setView({ ...v0, x: v0.x - (pts[0].x - gesture.p.x) * k, y: v0.y - (pts[0].y - gesture.p.y) * k });
    } else if (pts.length >= 2 && gesture.mid) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const w = clamp(v0.w * (gesture.dist / dist), 60, map.fit.w * 3), hh = (w * v0.h) / v0.w;
      // The point under the fingers' midpoint stays under it.
      const px = v0.x + ((gesture.mid.x - r.left) / r.width) * v0.w, py = v0.y + ((gesture.mid.y - r.top) / r.height) * v0.h;
      setView({ x: px - ((mid.x - r.left) / r.width) * w, y: py - ((mid.y - r.top) / r.height) * hh, w, h: hh });
    }
  });
  const end = (e, cancelled) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size) return startGesture(); // one finger left after a pinch: carry on panning from here
    svg.classList.remove('dragging');
    const g = gesture;
    gesture = null;
    if (cancelled || !g || g.multi || g.moved >= 8) return;
    const b = hit(e.clientX, e.clientY);
    if (b) select(b.code, false);
  };
  svg.addEventListener('pointerup', (e) => end(e, false));
  svg.addEventListener('pointercancel', (e) => end(e, true));
  svg.addEventListener('wheel', (e) => {
    if (!map.view) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect(), v = map.view;
    zoom(Math.exp(e.deltaY * 0.0015), v.x + ((e.clientX - r.left) / r.width) * v.w, v.y + ((e.clientY - r.top) / r.height) * v.h);
  }, { passive: false });
  const onResize = () => map.view && setView(fitBox(map.view));
  addEventListener('resize', onResize);

  function renderLegend() {
    const key = (sw, text) => h('span.key', sw, text);
    mount(legend,
      h('span.small.muted', 'Floor area covered:'),
      key(h('span.sw', { style: { background: 'transparent', border: '1px solid rgba(255,255,255,0.22)' } }), CM.BIN_LABELS[0]),
      CM.BIN_LABELS.slice(1).map((t, i) => key(h('span.sw', { style: { background: BIN_COLOR[i + 1] } }), t)),
      key(h('span.sw', { style: { background: 'var(--off)', border: '1px solid rgba(255,255,255,0.08)' } }), 'Off limits'),
      S.fix ? key(h('span.dot.you-key'), 'You') : null);
  }

  // ------------------------------------------------------------------ selection
  function select(code, zoomTo) {
    S.sel = code;
    const b = code && byCode(code);
    if (b && b.campus !== S.campus) {
      S.campus = b.campus;
      renderSeg();
      drawMap(true);
    } else drawMap(false);
    if (b && zoomTo) setView(focusBox(b));
    renderDetail();
    // Keep the address up to date, so Snap's back button returns to this building.
    history.replaceState(null, '', '#/campus' + (code ? `?b=${encodeURIComponent(code)}` : ''));
    if (code) (zoomTo ? mapCard : detail).scrollIntoView({ behavior: 'smooth', block: zoomTo ? 'start' : 'nearest' });
  }

  const snapUrl = (b, x) => '#/snap?' + new URLSearchParams({
    building: b.code, floor: x ? x.floor || '' : '1', room: x ? x.room : 'Main entrance',
    ...(x && x.need_light && x.score < CM.EXCELLENT ? { light: x.need_light } : {}),
    back: `#/campus?b=${b.code}`,
  });

  // ------------------------------------------------------------------ the panel under the map
  function renderDetail() {
    const b = S.sel && byCode(S.sel);
    mount(detail, b ? buildingPanel(b) : overviewPanel());
  }

  const placeRow = (b, x, meta) => h('button.c-row', { onclick: () => select(b.code, true) },
    h('span.c-row-main', h('span.c-row-title', `${b.name} · ${placeName(x)}`), h('span.c-row-meta', meta)),
    chip(x));

  function overviewPanel() {
    const bs = campusBuildings();
    const now = CM.lightNow();
    const shoot = CM.closestToGood(bs, { light: now, limit: 4 });
    // The quickest wins in other light too: worth knowing when to come back.
    const other = CM.closestToGood(bs, { limit: 8 }).filter((p) => !shoot.some((q) => q.x === p.x)).slice(0, 3);
    const near = S.fix ? CM.nearby(bs, S.fix, { within: 700, limit: 5 }) : [];
    const withDist = (b, text) => (S.fix ? `${fmtDist(distOf(b))} · ${text}` : text);
    return [
      h('h2', 'Where to go'),
      h('p.small.muted.c-now', `Now: ${CM.lightWords(now)}`),
      h('h4', 'Near you'),
      S.fix
        ? near.length
          ? h('div.c-rows', near.map(({ b, dist }) => {
              const top = CM.closestToGood([b], { limit: 1 })[0];
              const tip = top ? ` · ${placeName(top.x)}: ~${top.x.need_good}${top.x.need_light ? ' ' + top.x.need_light : ''} photos to Good` : '';
              return h('button.c-row', { onclick: () => select(b.code, true) },
                h('span.c-row-main', h('span.c-row-title', b.name), h('span.c-row-meta', `${fmtDist(dist)} · ${b.spaces.length ? `${pct(b.completion)} covered` : 'no photos yet'}${tip}`)),
                h('span.sw.big', { style: { background: BIN_COLOR[CM.completionBin(b)] || 'transparent' }, 'aria-hidden': 'true' }));
            }))
          : h('p.small.muted', `No ASU building that can be photographed within 700 m (GPS good to ${S.fix.acc} m).`)
        : h('div.geo-row', h('button.btn.small', { onclick: () => locate(false), disabled: S.locating }, icon('pin'), S.locating ? 'Finding you…' : 'Show buildings near me'), S.geoMsg ? h('span.small.muted', S.geoMsg) : null),
      h('h4', `Good to shoot now · ${LIGHT_LABEL[now]} light`),
      shoot.length
        ? h('div.c-rows', shoot.map(({ b, x }) => placeRow(b, x, withDist(b, `~${x.need_good} more photo${x.need_good === 1 ? '' : 's'} to Good`))))
        : h('p.small.muted', S.summary && S.summary.at ? `No space on the ${S.campus} campus is waiting for ${LIGHT_LABEL[now].toLowerCase()} light right now.` : 'Once the club PC publishes what it needs, the spaces closest to a good splat show up here.'),
      other.length ? [h('h4', 'Closest to Good, other light'), h('div.c-rows', other.map(({ b, x }) => placeRow(b, x, withDist(b, `~${x.need_good} more in ${x.need_light ? CM.lightWords(x.need_light) : 'one kind of light'}`))))] : null,
      h('p.small.muted', 'Tap a building on the map or in the list for its spaces and what each one needs.'),
    ];
  }

  function buildingPanel(b) {
    const head = h('div.row.space', h('span.kicker', [b.campus, b.ref].filter(Boolean).join(' · ')), h('button.btn.small.ghost', { onclick: () => select(null, false) }, 'All buildings'));
    if (b.restricted) {
      return [head, h('h3', b.name), h('p.small.muted', `Off limits: this is ${campus.RESTRICTED_TEXT[b.restricted] || 'a building the club doesn’t photograph'}, so the club doesn’t take photos here.`)];
    }
    const sum = (k) => b.spaces.reduce((n, x) => n + (k === 'photos' ? CM.photosOf(x) : x[k] || 0), 0);
    const dist = distOf(b);
    return [
      head,
      h('h3', b.name),
      h('div.c-big', h('span.big', pct(b.completion)), h('span.small.muted', `of its floor area · about ${fmtArea(b.covered)} of ${fmtArea(b.floorArea.area)}`)),
      meter(b.completion),
      h('p.small.muted', [
        b.spaces.length ? `${sum('photos')} photos accepted` : `${b.floorArea.floors} floor${b.floorArea.floors === 1 ? '' : 's'} of ${fmtArea(b.floorArea.footprint)}`, sum('pending') ? `${sum('pending')} waiting for review` : null,
        sum('builds') ? `${sum('builds')} splat${sum('builds') === 1 ? '' : 's'} built` : null, dist != null ? fmtDist(dist) + (dist >= 1 ? ' away' : '') : null,
      ].filter(Boolean).join(' · ')),
      b.byFloor.length ? h('p.small.muted', 'By floor: ', b.byFloor.map((f) => `${f.floor ? `Floor ${f.floor}` : 'floor not given'} ${pct(f.share)}`).join(' · ')) : null,
      b.spaces.length
        ? [h('h4', `Spaces (${b.spaces.length})`), h('div.c-spaces', b.spaces.map((x) => spaceCard(b, x))),
            h('button.btn.small.ghost', { onclick: () => navigate(snapUrl(b, { floor: '', room: '' })) }, icon('camera'), 'Photos of another space here')]
        : [h('p.small', `Nothing yet. Start with the main entrance or lobby: about ${CM.photosForGood('large')} photos in one kind of light make a big space like that Good. Walk a few steps between photos so every wall is seen from several spots.`),
            h('button.btn.primary', { onclick: () => navigate(snapUrl(b, null)) }, icon('camera'), 'Take photos here')],
    ];
  }

  function spaceCard(b, x) {
    const extra = [
      x.pending ? `${x.pending} waiting for review` : null,
      x.builds ? `${x.builds} splat${x.builds === 1 ? '' : 's'} built` : null,
      x.queued ? `${x.queued} capture${x.queued === 1 ? '' : 's'} waiting on the club PC` : null,
      x.scans ? `${x.scans} scan${x.scans === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const now = CM.lightNow();
    return h('div.c-space',
      h('div.row.space', h('b', placeName(x)), chip(x)),
      h('div.lights', { role: 'list', 'aria-label': 'Accepted photos in each kind of light' }, LIGHT_SLOTS.map((k) => {
        const want = x.need_light === k && x.score < CM.EXCELLENT;
        return h('div' + (want ? '.want' : ''), { role: 'listitem', title: `${LIGHT_LABEL[k]} light, ${CM.LIGHT_HOURS[k]}` },
          h('span', LIGHT_LABEL[k]), h('b.mono', String(x[k] || 0)), h('i', want ? 'needed' : k === now ? 'now' : ' '));
      })),
      h('p.small', CM.needText(x)),
      extra ? h('p.small.muted', extra) : null,
      x.score < CM.EXCELLENT ? h('button.btn.small', { onclick: () => navigate(snapUrl(b, x)) }, icon('camera'), 'Take photos here') : null);
  }

  // ------------------------------------------------------------------ campuses and the list of buildings
  function renderSeg() {
    const ids = [...new Set(S.list.map((b) => b.campus))];
    mount(seg, ids.map((id) => h('button.seg-btn' + (S.campus === id ? '.active' : ''), {
      'aria-pressed': String(S.campus === id), title: id,
      onclick: () => {
        if (S.campus === id) return;
        S.campus = id;
        S.picked = true;
        S.sel = null;
        setSettings({ campusMapCampus: id });
        history.replaceState(null, '', '#/campus');
        renderAll(true);
      },
    }, SHORT[id] || id)));
  }

  function renderList() {
    const all = campusBuildings();
    const q = S.q.trim().toLowerCase();
    let bs = all.filter((b) => (S.show === 'started' ? b.spaces.length && !b.restricted : S.show === 'todo' ? !b.spaces.length && !b.restricted : true))
      .filter((b) => !q || b.name.toLowerCase().includes(q) || (b.ref || '').toLowerCase().includes(q));
    bs = S.show === 'started' ? bs.sort((a, c) => c.completion - a.completion || a.name.localeCompare(c.name)) : bs.sort((a, c) => a.name.localeCompare(c.name));
    const search = h('input', { type: 'search', value: S.q, placeholder: 'Find a building', 'aria-label': 'Find a building', autocomplete: 'off',
      oninput: (e) => { S.q = e.target.value; renderList(); const i = listCard.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } });
    const counts = { started: all.filter((b) => b.spaces.length && !b.restricted).length, todo: all.filter((b) => !b.spaces.length && !b.restricted).length, all: all.length };
    mount(listCard,
      h('div.card-head', h('h2', `Buildings · ${S.campus}`), h('span.mono.muted', String(bs.length))),
      search,
      h('div.seg', [['started', 'Started'], ['todo', 'Not started'], ['all', 'All']].map(([k, label]) =>
        h('button.seg-btn' + (S.show === k ? '.active' : ''), { 'aria-pressed': String(S.show === k), onclick: () => { S.show = k; renderList(); } }, `${label} ${counts[k]}`))),
      bs.length
        ? h('div.c-rows', bs.map((b) => h('button.c-row', { onclick: () => !b.restricted && select(b.code, true), disabled: !!b.restricted },
            h('span.sw.big', { style: b.restricted ? { background: 'var(--off)' } : { background: BIN_COLOR[CM.completionBin(b)] || 'transparent', border: CM.completionBin(b) ? '0' : '1px solid rgba(255,255,255,0.22)' }, 'aria-hidden': 'true' }),
            h('span.c-row-main',
              h('span.c-row-title', b.name + (b.ref && b.ref.length >= 2 ? ` (${b.ref})` : '')),
              h('span.c-row-meta', b.restricted ? 'Off limits' : b.spaces.length ? `${pct(b.completion)} of its floor area · ${b.spaces.length} space${b.spaces.length === 1 ? '' : 's'}, ${b.good} Good · best ${bandOf({ score: b.best }).label}` : `No photos yet · ${fmtArea(b.floorArea.area)} of floor`)),
            b.restricted ? null : icon('chevron', 'dim'))))
        : h('p.small.muted', S.show === 'started' ? `No building on the ${S.campus} campus has photos yet.` : 'No buildings match.'));
  }

  function renderAll(fit) {
    paintStatus();
    renderSeg();
    drawMap(fit);
    renderLegend();
    renderDetail();
    renderList();
  }

  // ------------------------------------------------------------------ start
  let me = club.cachedProfile();
  try {
    me = await club.myProfile();
  } catch {}
  if (!alive) return;
  if (!me) {
    mount(root, h('div.page',
      h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/club'), 'aria-label': 'Back' }, icon('back')), h('div.head-text', h('div.kicker', 'Club beta'), h('h1', 'Campus'))),
      h('section.card', h('h2', 'Members only'), h('p.small', 'The campus map shows where the club still needs photos. Join the club to see it.'), h('button.btn.primary', { onclick: () => navigate('#/club?join=1&back=' + encodeURIComponent('#/campus')) }, 'Join the club'))));
    return () => (alive = false);
  }
  S.list = await campus.buildings();
  apply(CM.cached());
  renderAll(true);
  refresh();
  campus.locationAllowed().then((ok) => ok && alive && locate(true));

  return () => {
    alive = false;
    removeEventListener('resize', onResize);
  };
}
