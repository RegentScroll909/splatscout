// Floor plans of one building, drawn into a canvas: its OpenStreetMap footprint and, on one floor, each capture's
// scan outline, points (context: plain walls give few) and cameras, a dot where each photo was taken with a cone
// the way it looked. Camera positions are the main sign of what has been done. Used by the Campus page's building
// panel and the building view (building.js). The data comes from /api/campus/building.

import * as P from './place.js';

// The validated categorical order for SplatStation's dark surfaces (adjacent pairs pass for colour-blind readers).
// A capture's colour follows it everywhere (it's its place in the building's list, oldest first); a ninth and later
// fold into one neutral. Every capture is also labelled with its room, so colour never carries identity alone.
export const SLOTS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#8794a2';
export const colorOf = (c) => (c.slot < SLOTS.length ? SLOTS[c.slot] : OTHER);

const INK = '#e8edf2', MUTED = '#8794a2', GRID = 'rgba(255,255,255,0.05)', AXIS = 'rgba(255,255,255,0.28)';
const CONE = 1.4; // m: how long the view cones are drawn (a direction, not how far the photo saw)

/** Where a capture sits: the club's placement, else the guess, with its model's floor height. */
export function placementOf(c, live) {
  const p = (live && live.get(c.key)) || c.placement || c.guess;
  return { ...p, floorY: c.floorY };
}
/** "placed" (the club placed it), "gps" (guessed from its GPS fix) or "none" (guessed with nothing to go on). */
export const statusOf = (c, live) => (live && live.has(c.key)) || c.placement ? 'placed' : c.guess && c.guess.from === 'gps' ? 'gps' : 'none';
export const STATUS_TEXT = { placed: 'placed by the club', gps: 'guessed from GPS', none: 'not placed yet' };

/** The building's floors as numbers (1 = ground), plus any floor a capture sits on outside them (a basement). */
export function floorsOf(data, live) {
  const set = new Set(Array.from({ length: data.building.floors }, (_, i) => i + 1));
  for (const c of data.captures) set.add(placementOf(c, live).floor ?? 1);
  return [...set].sort((a, b) => a - b);
}

/** Pixels from building metres and back: x = ox + e·k, y = oy − n·k. */
export const toPx = (v, e, n) => [v.ox + e * v.k, v.oy - n * v.k];
export const toM = (v, x, y) => [(x - v.ox) / v.k, (v.oy - y) / v.k];

/** A view that fits the footprint (and any extra [e, n] points) into w × h pixels. */
export function fitView(footprint, w, h, pad = 16, extra = []) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [...footprint, ...extra]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  const k = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0));
  return { k, ox: w / 2 - ((x0 + x1) / 2) * k, oy: h / 2 + ((y0 + y1) / 2) * k };
}

/** Zoom a view by f about the pixel (x, y). */
export const zoomView = (v, f, x, y) => ({ k: v.k * f, ox: x - (x - v.ox) * f, oy: y - (y - v.oy) * f });

/** Camera rows ([x, y, z, fx, fy, fz, ux, uy, uz, lens?]) of a capture in building metres: {at: [e, n], h, dir: [e, n], lo, hi} (cone angles, radians). */
export function camerasOf(c, pl) {
  const out = [];
  for (const row of c.cams) {
    const lens = c.lenses[row[9] || 0] || c.lenses[0] || { tanX: 0.6, tanY: 0.35 };
    const f = row.slice(3, 6), u = row.slice(6, 9);
    const r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
    const fp = P.dirOf(pl, f), at = P.planOf(pl, row[0], row[2]);
    const flat = Math.hypot(fp[0], fp[1]);
    let lo = 0, hi = 0;
    const a0 = Math.atan2(fp[1], fp[0]);
    if (flat > 0.25) {
      lo = Infinity;
      hi = -Infinity;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const d = P.dirOf(pl, [0, 1, 2].map((k) => f[k] + r[k] * sx * lens.tanX + u[k] * sy * lens.tanY));
        let a = Math.atan2(d[1], d[0]) - a0;
        a = Math.atan2(Math.sin(a), Math.cos(a));
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      lo = Math.max(lo, -1.4);
      hi = Math.min(hi, 1.4);
    }
    out.push({ at, h: P.heightOf(pl, row[1]), dir: a0, flat, lo, hi });
  }
  return out;
}

/** The captures on one floor, each with its placement and cameras in building metres (cached per placement). */
export function onFloor(data, floor, live) {
  return data.captures.filter((c) => (placementOf(c, live).floor ?? 1) === floor).map((c) => {
    const pl = placementOf(c, live), key = JSON.stringify(pl);
    if (!c._cache || c._cache.key !== key) {
      const cams = camerasOf(c, pl);
      const pts = [];
      for (let i = 0; i + 1 < c.plan.length; i += 2) pts.push(P.planOf(pl, c.plan[i], c.plan[i + 1]));
      const outlines = c.outlines.map((poly) => poly.map(([x, z]) => P.planOf(pl, x, z)));
      let start = null;
      if (!c.cams.length && c.start) {
        const a = P.planOf(pl, c.start.position[0], c.start.position[2]), b = P.planOf(pl, c.start.lookAt[0], c.start.lookAt[2]);
        start = { at: a, dir: Math.atan2(b[1] - a[1], b[0] - a[0]) };
      }
      // Where to put its name: the middle of its photos (or points).
      const src = cams.length ? cams.map((k) => k.at) : pts;
      const mid = src.length ? [0, 1].map((k) => src.reduce((s, p) => s + p[k], 0) / src.length) : P.planOf(pl, c.anchor[0], c.anchor[1]);
      c._cache = { key, pl, cams, pts, outlines, start, mid };
    }
    return { c, ...c._cache, status: statusOf(c, live), color: colorOf(c) };
  });
}

/** How much of each floor the club has been over (placed captures only, and guesses on top). */
export function coverageOf(data, floor, live) {
  const caps = onFloor(data, floor, live);
  const sets = (list) => list.map((x) => ({ cams: x.cams.map((k) => k.at), outlines: x.outlines }));
  const placed = caps.filter((x) => x.status === 'placed');
  const a = P.floorCoverage(data.building.footprint, sets(placed));
  const all = P.floorCoverage(data.building.footprint, sets(caps));
  return { placed: a, withGuesses: all, captures: caps.length, placedCount: placed.length };
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Draw one floor.
 * @param {CanvasRenderingContext2D} ctx already scaled for the device's pixels
 * @param {object} o
 * @param {number} o.w width in CSS pixels
 * @param {number} o.h height
 * @param {object} o.view {ox, oy, k} (fitView)
 * @param {object} o.data the /api/campus/building answer
 * @param {number} o.floor 1 = ground floor
 * @param {Map} [o.live] key → placement being edited (drawn instead of the saved one)
 * @param {string} [o.focus] a capture to bring forward (the others are dimmed)
 * @param {{points?: boolean, cones?: boolean, labels?: boolean, maxCones?: number}} [o.show] cones: false hides the cameras (dots and cones)
 * @param {Array} [o.marks] extra marks: [{at: [e, n], color, label}]
 */
export function drawPlan(ctx, { w, h, view, data, floor, live = null, focus = null, show = {}, marks = [] }) {
  const { points = true, cones = true, labels = true, maxCones = 160 } = show;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0c0f13';
  ctx.fillRect(0, 0, w, h);
  // A 5 m grid (10 m when zoomed out), lined up with the building's frame (north up).
  const step = view.k < 3 ? 10 : 5;
  const [e0, n1] = toM(view, 0, 0), [e1, n0] = toM(view, w, h);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let e = Math.ceil(e0 / step) * step; e <= e1; e += step) {
    const [x] = toPx(view, e, 0);
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
  }
  for (let n = Math.ceil(n0 / step) * step; n <= n1; n += step) {
    const [, y] = toPx(view, 0, n);
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
  }
  ctx.stroke();
  // The footprint.
  const fp = data.building.footprint;
  ctx.beginPath();
  fp.forEach(([e, n], i) => ctx[i ? 'lineTo' : 'moveTo'](...toPx(view, e, n)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const caps = onFloor(data, floor, live);
  const order = focus ? [...caps.filter((x) => x.c.key !== focus), ...caps.filter((x) => x.c.key === focus)] : caps;
  for (const x of order) {
    const dim = focus && x.c.key !== focus ? 0.35 : 1;
    const guessed = x.status !== 'placed';
    ctx.save();
    ctx.globalAlpha = dim * (guessed ? 0.7 : 1);
    // Scan outlines: what the phone was told the scan covers.
    for (const poly of x.outlines) {
      ctx.beginPath();
      poly.forEach(([e, n], i) => ctx[i ? 'lineTo' : 'moveTo'](...toPx(view, e, n)));
      ctx.closePath();
      ctx.fillStyle = rgba(x.color, 0.12);
      ctx.fill();
      ctx.setLineDash(guessed ? [5, 4] : []);
      ctx.strokeStyle = rgba(x.color, 0.8);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // View cones for an even spread of photos (faint: a room photographed a thousand times would turn solid),
    // then its points (walls and furniture), then a dot for every photo.
    if (cones && x.cams.length) {
      const every = Math.max(1, Math.ceil(x.cams.length / maxCones)), L = Math.min(CONE * view.k, 34);
      ctx.fillStyle = rgba(x.color, 0.07);
      ctx.strokeStyle = rgba(x.color, 0.22);
      ctx.lineWidth = 1;
      for (let i = 0; i < x.cams.length; i += every) {
        const k = x.cams[i];
        if (k.flat <= 0.25) continue;
        const [px, py] = toPx(view, k.at[0], k.at[1]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        // Canvas angles run clockwise (y down): building angle a is −a on screen.
        ctx.arc(px, py, L, -(k.dir + k.hi), -(k.dir + k.lo));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
    if (points) {
      ctx.fillStyle = rgba(x.color, 0.5);
      const r = view.k > 12 ? 1.6 : 1.1;
      for (const [e, n] of x.pts) {
        const [px, py] = toPx(view, e, n);
        if (px < -2 || py < -2 || px > w + 2 || py > h + 2) continue;
        ctx.fillRect(px - r / 2, py - r / 2, r, r);
      }
    }
    ctx.fillStyle = x.color;
    const dr = view.k > 12 ? 2.2 : 1.6;
    for (const k of cones ? x.cams : []) {
      const [px, py] = toPx(view, k.at[0], k.at[1]);
      ctx.beginPath();
      ctx.arc(px, py, dr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (x.start) {
      // No cameras (its job folder is gone): only where its first photo was taken.
      const [px, py] = toPx(view, x.start.at[0], x.start.at[1]);
      ctx.strokeStyle = x.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(x.start.dir) * 14, py - Math.sin(x.start.dir) * 14);
      ctx.stroke();
    }
    ctx.restore();
  }
  // Names last, so nothing covers them: the room, with a dot of its colour.
  if (labels) {
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const x of order) {
      const [px, py] = toPx(view, x.mid[0], x.mid[1]);
      const text = x.c.room + (x.status === 'placed' ? '' : ' (guess)');
      ctx.globalAlpha = focus && x.c.key !== focus ? 0.5 : 1;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#0c0f13';
      ctx.strokeText(text, px + 9, py);
      ctx.fillStyle = INK;
      ctx.fillText(text, px + 9, py);
      ctx.fillStyle = x.color;
      ctx.beginPath();
      ctx.arc(px + 3, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  for (const m of marks) {
    const [px, py] = toPx(view, m.at[0], m.at[1]);
    ctx.strokeStyle = m.color || INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px - 7, py);
    ctx.lineTo(px + 7, py);
    ctx.moveTo(px, py - 7);
    ctx.lineTo(px, py + 7);
    ctx.stroke();
    if (m.label) {
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = m.color || INK;
      ctx.fillText(m.label, px + 9, py - 9);
    }
  }
  // North and a scale bar.
  ctx.fillStyle = MUTED;
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 1.5;
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.beginPath();
  ctx.moveTo(w - 18, 30);
  ctx.lineTo(w - 18, 12);
  ctx.moveTo(w - 22, 17);
  ctx.lineTo(w - 18, 12);
  ctx.lineTo(w - 14, 17);
  ctx.stroke();
  ctx.fillText('N', w - 22, 44);
  const bar = [1, 2, 5, 10, 20, 50].find((m) => m * view.k >= 50) || 50, bx1 = w - 14, bx0 = bx1 - bar * view.k;
  ctx.beginPath();
  ctx.moveTo(bx0, h - 12);
  ctx.lineTo(bx1, h - 12);
  ctx.moveTo(bx0, h - 16);
  ctx.lineTo(bx0, h - 8);
  ctx.moveTo(bx1, h - 16);
  ctx.lineTo(bx1, h - 8);
  ctx.stroke();
  ctx.textAlign = 'right';
  ctx.fillText(`${bar} m`, bx0 - 5, h - 8);
  ctx.textAlign = 'left';
}

/** The photo nearest a pixel (within `r` px) on a floor: {x (capture on the floor), i (photo), d}, or null. */
export function cameraAt(data, floor, live, view, px, py, r = 9) {
  let best = null;
  for (const x of onFloor(data, floor, live)) {
    x.cams.forEach((k, i) => {
      const [cx, cy] = toPx(view, k.at[0], k.at[1]), d = Math.hypot(cx - px, cy - py);
      if (d <= r && (!best || d < best.d)) best = { x, i, d };
    });
    if (!x.cams.length && x.start) {
      const [cx, cy] = toPx(view, x.start.at[0], x.start.at[1]), d = Math.hypot(cx - px, cy - py);
      if (d <= r && (!best || d < best.d)) best = { x, i: -1, d };
    }
  }
  return best;
}

/** The capture whose photos (or points) come nearest a pixel, within `r` px. */
export function captureAt(data, floor, live, view, px, py, r = 14) {
  let best = null;
  for (const x of onFloor(data, floor, live)) {
    for (const p of x.cams.length ? x.cams.map((k) => k.at) : x.pts) {
      const [cx, cy] = toPx(view, p[0], p[1]), d = Math.hypot(cx - px, cy - py);
      if (d <= r && (!best || d < best.d)) best = { x, d };
    }
  }
  return best && best.x;
}

/** A canvas sized to its box at the device's pixel ratio; returns its 2-D context and size in CSS pixels. */
export function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
