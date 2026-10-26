// 2D coverage maps:
//  * top-down floor plan (AR mode): surfaces coloured by how many angles they were captured from,
//    the scan area, the guide's path, your path, photo spots and where you are now;
//  * panorama (camera mode): every view direction, coloured by how often it was captured.

import { VoxelMap, BANDS } from '../core/coverage.js';
import { posePosition, poseForward, dirToAzEl } from '../core/math.js';

const QCOL = ['rgba(120,160,255,0.45)', '#ff4d4d', '#ffbd2e', '#3ddc84'];

export function drawTopDown(canvas, { voxels, frames, pose, target, segment, bounds = null, draft = null, guidePath = null }) {
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
  const path = frames.filter((f) => f.tracked && (segment == null || f.segment === segment)).map((f) => posePosition(f.pose));
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
    ctx.strokeStyle = 'rgba(255,199,51,0.9)';
    ctx.lineWidth = 2;
    outline(poly, true);
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
    ctx.strokeStyle = 'rgba(255,199,51,0.9)';
    ctx.fillStyle = '#ffc733';
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
      ctx.fillStyle = st.done ? 'rgba(61,220,132,0.85)' : 'rgba(64,224,255,0.75)';
      ctx.fillRect(X(st.pos[0]) - 1.5, Y(st.pos[2]) - 1.5, 3, 3);
    }
  }

  if (path.length > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2]))));
    ctx.stroke();
    ctx.fillStyle = '#5ad8ff';
    for (const p of path) {
      ctx.beginPath();
      ctx.arc(X(p[0]), Y(p[2]), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (target) {
    ctx.strokeStyle = '#33e6ff';
    ctx.lineWidth = 2;
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
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
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
    ctx.fillStyle = n >= need ? 'rgba(61,220,132,0.75)' : n > 0 ? 'rgba(255,189,46,0.75)' : 'rgba(255,255,255,0.08)';
    const xa = ax(b.az0), xb = ax(b.az1);
    const y0 = ey(b.el1), y1 = ey(b.el0);
    if (xb > xa) ctx.fillRect(xa + 0.5, y0 + 0.5, xb - xa - 1, y1 - y0 - 1);
    else {
      ctx.fillRect(xa + 0.5, y0 + 0.5, W - xa - 1, y1 - y0 - 1);
      ctx.fillRect(0, y0 + 0.5, xb - 1, y1 - y0 - 1);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `${Math.round(H / 9)}px system-ui, sans-serif`;
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
  ctx.font = `${Math.round(H / 11)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
  ctx.textAlign = 'start';
}
