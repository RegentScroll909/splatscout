// 2D coverage maps:
//  * top-down floor plan (AR mode): surfaces coloured by how many angles they were captured from,
//    the scan area, the guide's path, your path, photo spots and where you are now;
//  * panorama (camera mode): every view direction, coloured by how often it was captured.

import { VoxelMap, BANDS } from '../core/coverage.js';
import { posePosition, poseForward, dirToAzEl } from '../core/math.js';
import { spaceOf } from '../core/spaces.js';

const QCOL = ['rgba(120,150,190,0.45)', '#f26d6d', '#f5b942', '#34d399'];
const ACCENT = '#3ddcff';

export function drawTopDown(canvas, { voxels, frames, pose, target, space = null, capture = null, bounds = null, draft = null, guidePath = null }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Collapse voxels to floor-plan columns, coloured by average capture quality (scan area only).
  const cols = new Map();
  for (const v of voxels.vox.values()) {
    if (!VoxelMap.isSolid(v)) continue;
    const k = v.ix * 65536 + v.iz;
    let c = cols.get(k);
    if (!c) cols.set(k, (c = { ix: v.ix, iz: v.iz, q: 0, n: 0, out: 0 }));
    if (!voxels.inBounds(v)) {
      c.out++;
      continue;
    }
    c.q += VoxelMap.quality(v);
    c.n++;
  }
  const pts = [];
  const s = voxels.size;
  const poly = bounds && bounds.poly;
  // With a scan area, frame the map on it; stray surfaces seen through windows don't zoom it out.
  if (poly) for (const p of poly) pts.push(p);
  else for (const c of cols.values()) pts.push([(c.ix + 0.5) * s, (c.iz + 0.5) * s]);
  if (draft) for (const p of draft) pts.push(p);
  const path = frames.filter((f) => f.tracked && f.pose && (space == null || spaceOf(f, capture) === space)).map((f) => posePosition(f.pose));
  for (const p of path) pts.push([p[0], p[2]]);
  const here = pose ? posePosition(pose) : null;
  if (here) pts.push([here[0], here[2]]);
  if (!pts.length) {
    drawEmpty(ctx, W, H, 'Map appears as you scan');
    return;
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const span = Math.max(x1 - x0, z1 - z0, 3) * 1.15;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const scale = Math.min(W, H) / span;
  const X = (x) => W / 2 + (x - cx) * scale;
  const Y = (z) => H / 2 + (z - cz) * scale;

  // 1 m grid.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.floor(cx - span); gx <= cx + span; gx++) {
    ctx.moveTo(Math.round(X(gx)) + 0.5, 0);
    ctx.lineTo(Math.round(X(gx)) + 0.5, H);
  }
  for (let gz = Math.floor(cz - span); gz <= cz + span; gz++) {
    ctx.moveTo(0, Math.round(Y(gz)) + 0.5);
    ctx.lineTo(W, Math.round(Y(gz)) + 0.5);
  }
  ctx.stroke();

  const cell = Math.max(1.5, s * scale);
  for (const c of cols.values()) {
    if (!c.n) {
      ctx.fillStyle = 'rgba(150,150,150,0.18)';
    } else {
      ctx.fillStyle = QCOL[Math.min(3, Math.round(c.q / c.n))];
    }
    ctx.fillRect(X(c.ix * s), Y(c.iz * s), cell, cell);
  }

  // Scan area outline and skipped spots.
  const outline = (p, closed) => {
    ctx.beginPath();
    p.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Y(z)) : ctx.moveTo(X(x), Y(z))));
    if (closed) ctx.closePath();
    ctx.stroke();
  };
  if (poly) {
    ctx.strokeStyle = 'rgba(230,246,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    outline(poly, true);
    ctx.setLineDash([]);
  }
  if (bounds && bounds.skips) {
    ctx.strokeStyle = 'rgba(200,200,200,0.7)';
    ctx.lineWidth = 1.5;
    for (const sk of bounds.skips) {
      ctx.beginPath();
      ctx.arc(X(sk[0]), Y(sk[2]), Math.max(3, sk[3] * scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (draft && draft.length) {
    ctx.strokeStyle = 'rgba(230,246,255,0.9)';
    ctx.fillStyle = '#e6f6ff';
    ctx.lineWidth = 2;
    outline(draft, draft.length >= 3);
    for (const [x, z] of draft) {
      ctx.beginPath();
      ctx.arc(X(x), Y(z), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // The guide's path for this pass: done parts green, the rest cyan.
  if (guidePath && guidePath.length) {
    for (const st of guidePath) {
      if (st.transit) continue;
      ctx.fillStyle = st.done ? 'rgba(52,211,153,0.85)' : 'rgba(61,220,255,0.75)';
      ctx.fillRect(X(st.pos[0]) - 1.5, Y(st.pos[2]) - 1.5, 3, 3);
    }
  }

  if (path.length > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2]))));
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    for (const p of path) {
      ctx.beginPath();
      ctx.arc(X(p[0]), Y(p[2]), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (target) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(X(target[0]), Y(target[2]), 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (here) {
    const f = poseForward(pose);
    const a = Math.atan2(f[2], f[0]);
    ctx.save();
    ctx.translate(X(here[0]), Y(here[2]));
    ctx.rotate(a);
    ctx.fillStyle = 'rgba(61,220,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 28, -0.55, 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

export function drawPanorama(canvas, { sphere, pose, need = 2 }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Centre the panorama on where the user is looking.
  let centerAz = 0;
  if (pose) centerAz = dirToAzEl(poseForward(pose))[0];
  const ax = (az) => ((((az - centerAz + 540) % 360) / 360) * W);
  const ey = (el) => ((90 - el) / 180) * H;
  for (const b of sphere.bins) {
    const n = b.distinct;
    ctx.fillStyle = n >= need ? 'rgba(52,211,153,0.75)' : n > 0 ? 'rgba(245,185,66,0.75)' : 'rgba(255,255,255,0.07)';
    const xa = ax(b.az0), xb = ax(b.az1);
    const y0 = ey(b.el1), y1 = ey(b.el0);
    if (xb > xa) ctx.fillRect(xa + 0.5, y0 + 0.5, xb - xa - 1, y1 - y0 - 1);
    else {
      ctx.fillRect(xa + 0.5, y0 + 0.5, W - xa - 1, y1 - y0 - 1);
      ctx.fillRect(0, y0 + 0.5, xb - 1, y1 - y0 - 1);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `${Math.round(H / 9)}px ui-monospace, Menlo, monospace`;
  ctx.fillText('ceiling', 4, H / 9 + 2);
  ctx.fillText('floor', 4, H - 4);
  for (const band of BANDS) {
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, ey(band.max));
    ctx.lineTo(W, ey(band.max));
    ctx.stroke();
  }
  if (pose) {
    const el = dirToAzEl(poseForward(pose))[1];
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - W * 0.09, ey(el) - H * 0.17, W * 0.18, H * 0.34);
  }
}

function drawEmpty(ctx, W, H, text) {
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `${Math.round(H / 11)}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = 'start';
}
