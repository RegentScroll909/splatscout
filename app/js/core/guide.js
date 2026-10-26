// Guided capture. Turns the scan area into a walking path for each pass (where to stand, which way to
// aim), ticks off the parts of it that were photographed, and when a pass has no path (details,
// freestyle, stairs) plans the best next viewpoint for surfaces that still need angles.

import { offsetPoly, principalAxes, clipLine, polyCentroid, inwardNormal, horiz, dist2D } from './bounds.js';
import { DEG, v3, clamp, angleBetween, poseForward, posePosition } from './math.js';
import { VoxelMap } from './coverage.js';

const SPACING = 0.4; // m between path stations
const DONE_RADIUS = 0.6; // a photo this close to a station (and aimed about right) completes it
const DONE_ANGLE = 35 * DEG;
const HEIGHT = { chest: 1.4, high: 1.9, low: 0.85 };

export const passHeight = (pass) => HEIGHT[pass && pass.height] || HEIGHT.chest;

/** Aim direction from a horizontal heading (unit x/z) and a pitch in degrees. */
function aimFrom(hx, hz, pitchDeg) {
  const c = Math.cos(pitchDeg * DEG), s = Math.sin(pitchDeg * DEG);
  const l = Math.hypot(hx, hz) || 1;
  return [(hx / l) * c, s, (hz / l) * c];
}

/** Evenly spaced samples along a closed polygon, with the inward normal and walking direction. */
function sampleLoop(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.round(L / SPACING));
    const nrm = inwardNormal(a, b);
    const tan = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, nrm, tan });
    }
  }
  // Smooth normals around corners so the aim sweeps across them instead of snapping.
  const m = out.length;
  return out.map((p, i) => {
    let nx = 0, nz = 0;
    for (let d = -3; d <= 3; d++) {
      const q = out[(i + d + m) % m];
      nx += q.nrm[0];
      nz += q.nrm[1];
    }
    const l = Math.hypot(nx, nz) || 1;
    return { ...p, nrm: [nx / l, nz / l] };
  });
}

/**
 * Build the stations for one pass.
 * @returns {Array<{pos, aim, s, transit?, done}>|null} null when this pass has no path
 */
export function planPass(spec, bounds, pass, from) {
  if (!spec || !bounds || !bounds.poly || spec.kind === 'gaps') return null;
  const y = bounds.floorY + passHeight(pass);
  const ax = principalAxes(bounds.poly);
  const width = ax.short1 - ax.short0;
  let stations = [];

  if (spec.kind === 'loop') {
    let inset = spec.inset === 'center' ? width * 0.42 : Math.min(spec.inset, width * 0.32);
    inset = Math.max(0.25, inset);
    let poly = offsetPoly(bounds.poly, inset);
    if (!poly) poly = offsetPoly(bounds.poly, inset / 2);
    if (!poly) return null;
    const pts = sampleLoop(poly);
    if (pts.length < 3) return null;
    // Start at the point nearest the user; the polygon is counter-clockwise, so walking it keeps the
    // area on your left: you face into the space and sidestep to your right.
    let i0 = 0;
    if (from) {
      let bd = Infinity;
      pts.forEach((p, i) => {
        const d = Math.hypot(p.x - from[0], p.z - from[2]);
        if (d < bd) [bd, i0] = [d, i];
      });
    }
    const yaw = (spec.yaw || 0) * DEG;
    // A little past the start, so the loop closes.
    const n = pts.length + Math.min(pts.length, Math.round(1.2 / SPACING));
    for (let k = 0; k < n; k++) {
      const p = pts[(i0 + k) % pts.length];
      const hx = p.nrm[0] * Math.cos(yaw) + p.tan[0] * Math.sin(yaw);
      const hz = p.nrm[1] * Math.cos(yaw) + p.tan[1] * Math.sin(yaw);
      stations.push({ pos: [p.x, y, p.z], aim: aimFrom(hx, hz, spec.pitch || 0) });
    }
  } else if (spec.kind === 'lanes') {
    const inset = Math.min(spec.inset, width * 0.3);
    const inner = offsetPoly(bounds.poly, inset) || bounds.poly;
    const n = Math.max(1, Math.floor((width - 2 * inset) / spec.spacing) + 1);
    const span = (n - 1) * spec.spacing;
    const mid = (ax.short0 + ax.short1) / 2;
    const lanes = [];
    for (let k = 0; k < n; k++) {
      const off = mid - span / 2 + k * spec.spacing;
      const p = [ax.center[0] + ax.short[0] * off, ax.center[1] + ax.short[1] * off];
      const c = clipLine(p, ax.long, inner);
      if (!c || c[1] - c[0] < 0.8) continue;
      lanes.push([p, c]);
    }
    if (!lanes.length) return null;
    // Start with the lane end nearest the user, then go back and forth (lawnmower).
    let flip = false;
    if (from) {
      const [p, c] = lanes[0];
      const e0 = [p[0] + ax.long[0] * c[0], p[1] + ax.long[1] * c[0]], e1 = [p[0] + ax.long[0] * c[1], p[1] + ax.long[1] * c[1]];
      const [q, d] = lanes[lanes.length - 1];
      const f0 = [q[0] + ax.long[0] * d[0], q[1] + ax.long[1] * d[0]];
      const dists = [Math.hypot(e0[0] - from[0], e0[1] - from[2]), Math.hypot(e1[0] - from[0], e1[1] - from[2]), Math.hypot(f0[0] - from[0], f0[1] - from[2])];
      if (dists[2] < Math.min(dists[0], dists[1])) lanes.reverse();
      const [p2, c2] = lanes[0];
      const g0 = [p2[0] + ax.long[0] * c2[0], p2[1] + ax.long[1] * c2[0]], g1 = [p2[0] + ax.long[0] * c2[1], p2[1] + ax.long[1] * c2[1]];
      flip = Math.hypot(g1[0] - from[0], g1[1] - from[2]) < Math.hypot(g0[0] - from[0], g0[1] - from[2]);
    }
    lanes.forEach(([p, c], li) => {
      const fwd = (li % 2 === 0) !== flip ? 1 : -1;
      const t0 = fwd > 0 ? c[0] : c[1], t1 = fwd > 0 ? c[1] : c[0];
      const L = Math.abs(t1 - t0);
      const m = Math.max(1, Math.round(L / SPACING));
      const dir = [ax.long[0] * fwd, ax.long[1] * fwd];
      // Aim to the left of the walking direction; with one lane only, sweep left and right.
      const left = [dir[1], -dir[0]];
      if (li > 0) {
        // Short transit to the start of this lane.
        const prev = stations[stations.length - 1];
        const start = [p[0] + ax.long[0] * t0, p[1] + ax.long[1] * t0];
        const gap = Math.hypot(start[0] - prev.pos[0], start[1] - prev.pos[2]);
        const k = Math.max(1, Math.round(gap / SPACING));
        for (let j = 1; j < k; j++) {
          const u = j / k;
          stations.push({ pos: [prev.pos[0] + (start[0] - prev.pos[0]) * u, y, prev.pos[2] + (start[1] - prev.pos[2]) * u], aim: prev.aim, transit: true });
        }
      }
      for (let j = 0; j <= m; j++) {
        const t = t0 + ((t1 - t0) * j) / m;
        const side = lanes.length === 1 && Math.floor(j / 3) % 2 === 1 ? -1 : 1;
        stations.push({ pos: [p[0] + ax.long[0] * t, y, p[1] + ax.long[1] * t], aim: aimFrom(left[0] * side, left[1] * side, spec.pitch || 0) });
      }
    });
  } else if (spec.kind === 'orbit') {
    const [cx, cz] = polyCentroid(bounds.poly);
    const R = Math.max(...bounds.poly.map(([x, z]) => Math.hypot(x - cx, z - cz))) + spec.radius;
    const n = Math.max(12, Math.round((2 * Math.PI * R) / SPACING));
    let a0 = 0;
    if (from) a0 = Math.atan2(from[2] - cz, from[0] - cx);
    // Decreasing angle = counter-clockwise seen from above: facing the object, you walk to your right.
    const total = n + Math.round(n / 12);
    for (let k = 0; k < total; k++) {
      const a = a0 - (k / n) * 2 * Math.PI;
      const px = cx + Math.cos(a) * R, pz = cz + Math.sin(a) * R;
      stations.push({ pos: [px, y, pz], aim: aimFrom(cx - px, cz - pz, spec.pitch || 0) });
    }
  } else {
    return null;
  }

  let s = 0;
  stations = stations.map((st, i) => {
    if (i) s += dist2D(st.pos, stations[i - 1].pos);
    return { ...st, s, done: false };
  });
  return stations;
}

export class Guide {
  /**
   * @param {object} o
   * @param {object} o.template capture template
   * @param {import('./bounds.js').Bounds|null} o.bounds scan area (paths need one)
   * @param {VoxelMap} o.voxels coverage map
   */
  constructor({ template, bounds, voxels }) {
    this.template = template;
    this.bounds = bounds;
    this.voxels = voxels;
    this.pass = null;
    this.stations = null;
    this.k = 0;
    this.gap = null;
    this.skipped = new Map(); // cluster key -> skip until t
    this.state = null;
  }

  get floorY() {
    if (this.bounds && this.bounds.poly) return this.bounds.floorY;
    const f = this.voxels.floorY();
    return f == null ? null : f;
  }

  /** True when this pass is walked along a planned path. */
  get hasPath() {
    return !!(this.stations && this.stations.length);
  }

  setBounds(b) {
    this.bounds = b;
    if (this.pass) this.setPass(this.pass, this._from);
  }

  setPass(pass, from) {
    this.pass = pass;
    this._from = from;
    this.stations = planPass(pass.guide, this.bounds, pass, from);
    this.k = 0;
    this.gap = null;
    this.complete = false;
  }

  /** Fraction of the current path that has been photographed. */
  progress() {
    if (!this.stations) return null;
    let n = 0, d = 0;
    for (const st of this.stations) {
      if (st.transit) continue;
      n++;
      if (st.done) d++;
    }
    return n ? d / n : 1;
  }

  /** A photo was taken from `pose`: complete nearby stations / the current gap target. */
  onPhoto(pose) {
    const p = posePosition(pose), f = poseForward(pose);
    if (this.stations) {
      for (const st of this.stations) {
        if (st.done || st.transit) continue;
        if (dist2D(st.pos, p) < DONE_RADIUS && Math.abs(st.pos[1] - p[1]) < 0.5 && angleBetween(f, st.aim) < DONE_ANGLE) st.done = true;
      }
    }
    if (this.gap && v3.dist(this.gap.pos, p) < 0.8 && angleBetween(f, this.gap.aim) < 30 * DEG) this.gap.hits = (this.gap.hits || 0) + 1;
  }

  /**
   * Per guidance tick (about 1 Hz).
   * @returns guide state: {mode, next, aimPoint, instruction, progress, complete, trail, stand, ghost}
   */
  update({ pos, fwd, t }) {
    const floorY = this.floorY != null ? this.floorY : pos[1] - 1.4;
    let st;
    if (this.stations) st = this._updatePath(pos, fwd, floorY);
    else st = this._updateGaps(pos, fwd, t, floorY);
    this.state = st;
    return st;
  }

  _updatePath(pos, fwd, floorY) {
    const S = this.stations;
    // Where along the path is the user? Look near the last position first, so a path that passes
    // close to itself (laps, lanes) doesn't make the progress jump.
    let k = this.k, bd = Infinity;
    for (let i = Math.max(0, this.k - 3); i < Math.min(S.length, this.k + 14); i++) {
      const d = dist2D(S[i].pos, pos);
      if (d < bd) [bd, k] = [d, i];
    }
    if (bd > 2.5) {
      for (let i = 0; i < S.length; i++) {
        const d = dist2D(S[i].pos, pos);
        if (d < bd - 0.5) [bd, k] = [d, i];
      }
    }
    this.k = k;
    let next = -1;
    for (let i = k; i < S.length; i++) {
      if (S[i].done || S[i].transit) continue;
      // Furniture where the path wants you to stand: walk around it, that spot doesn't count.
      if (this._blocked(S[i].pos)) {
        S[i].transit = true;
        continue;
      }
      next = i;
      break;
    }
    let missed = false;
    if (next < 0) {
      // Reached the end: send the user back to spots that were skipped, nearest first.
      let best = Infinity;
      S.forEach((s2, i) => {
        if (s2.done || s2.transit) return;
        const d = dist2D(s2.pos, pos);
        if (d < best) [best, next] = [d, i];
      });
      missed = next >= 0;
    }
    const progress = this.progress();
    const complete = next < 0 || (progress >= 0.94 && k >= S.length - 3);
    if (complete) {
      this.complete = true;
      return { mode: 'path', progress, complete: true, next: null, trail: [], instruction: null };
    }
    const target = S[next];
    // Trail: from the user's feet to the next station, then along the path for a few metres.
    const trail = [[pos[0], floorY, pos[2]]];
    let len = 0;
    for (let i = next; i < S.length && len < 6; i++) {
      const p = S[i].pos;
      const last = trail[trail.length - 1];
      len += Math.hypot(p[0] - last[0], p[2] - last[2]);
      trail.push([p[0], floorY, p[2]]);
      if (missed) break;
    }
    const distTo = dist2D(target.pos, pos);
    const aimPoint = this._aimPoint(target.pos, target.aim);
    const offAim = angleBetween(fwd, target.aim) / DEG;
    let instruction;
    if (distTo > 1.2) {
      instruction = {
        title: missed ? 'Go back to a spot you missed' : 'Walk to the path',
        detail: `Follow the dotted trail on the floor (${distTo.toFixed(1)} m).`,
      };
    } else if (offAim > 40) {
      instruction = { title: 'Aim at the ring', detail: 'Turn the phone towards the blue ring, then keep walking along the path.' };
    } else {
      instruction = { title: 'Follow the path', detail: 'Keep the blue ring near the centre and move the way the arrow points, at a slow, steady pace.' };
    }
    return {
      mode: 'path', progress, complete: false, missed, next: target, aimPoint, offAim, distTo, trail, instruction,
      ghost: distTo > 1.2 ? { pos: target.pos, aim: target.aim } : null,
      stand: distTo > 1.2 ? [target.pos[0], floorY, target.pos[2]] : null,
    };
  }

  _updateGaps(pos, fwd, t, floorY) {
    // Keep the current target until it's photographed enough, gone, or clearly being ignored.
    if (this.gap) {
      const c = this.voxels.weakClusters(0.8, 3).find((x) => x.key === this.gap.key);
      const fixed = !c || c.deficit <= this.gap.deficit0 * 0.45 || (this.gap.hits || 0) >= 1;
      if (fixed) this.gap = null;
      else if (t - this.gap.t0 > 30) {
        this.skipped.set(this.gap.key, t + 120);
        this.gap = null;
      }
    }
    if (!this.gap) this.gap = this.planGap(pos, fwd, t, floorY);
    const g = this.gap;
    const st = this.voxels.stats();
    const complete = !g && st.solid > 50 && st.coverage >= 0.85;
    if (!g) {
      return { mode: 'gaps', progress: null, complete, next: null, trail: [], instruction: null };
    }
    const distTo = dist2D(g.pos, pos);
    const offAim = angleBetween(fwd, g.aim) / DEG;
    const instruction = distTo > 0.7
      ? { title: 'Next spot: walk to the marker', detail: `Stand on the ring on the floor (${distTo.toFixed(1)} m), then aim at the red area.` }
      : offAim > 25
        ? { title: 'Aim at the ring', detail: 'Point the phone at the red area inside the blue ring and hold steady.' }
        : { title: 'Hold steady', detail: 'Hold still for a moment so the photo is sharp.' };
    return {
      mode: 'gaps', progress: null, complete: false, next: g, aimPoint: g.target, offAim, distTo, instruction,
      trail: distTo > 0.7 ? [[pos[0], floorY, pos[2]], [g.pos[0], floorY, g.pos[2]]] : [],
      stand: [g.pos[0], floorY, g.pos[2]],
      ghost: distTo > 0.7 ? { pos: g.pos, aim: g.aim } : null,
    };
  }

  _blocked(p) {
    const vm = this.voxels, r = vm.size;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      if (vm.isSolidAt(p[0] + dx, p[1], p[2] + dz)) return true;
    }
    return false;
  }

  /** Where a station's aim lands: the first surface along it, or a point 2.5 m ahead. */
  _aimPoint(p, aim) {
    const hit = this.voxels.raycast(p, aim, 8, 0.3);
    return hit ? hit.point : v3.add(p, v3.scale(aim, 2.5));
  }

  /**
   * Next-best view: the weak surface cluster that a reachable, unobstructed viewpoint would add the
   * most new angles to, discounted by walking distance.
   */
  planGap(pos, fwd, t, floorY) {
    const r = this.template.viewDist || 1.6;
    const b = this.bounds;
    let best = null;
    for (const c of this.voxels.weakClusters(0.8, 3)) {
      const until = this.skipped.get(c.key);
      if (until && t < until) continue;
      if (!(b && b.poly) && v3.dist(c.center, pos) > this.template.maxObsDist) continue;
      let m = [0, 0, 0];
      for (const d of c.dirs) m = v3.add(m, d);
      if (v3.len(m) < 1e-3) m = v3.sub(pos, c.center);
      const mh = horiz(m);
      const baseEl = clamp(Math.asin(clamp(v3.norm(m)[1], -1, 1)) / DEG, -35, 35);
      for (const dy of [0, -35, 35, -70, 70]) {
        const ca = Math.cos(dy * DEG), sa = Math.sin(dy * DEG);
        const hx = mh[0] * ca - mh[2] * sa, hz = mh[0] * sa + mh[2] * ca;
        for (const de of [0, 25, -20]) {
          const el = clamp(baseEl + de, -50, 55) * DEG;
          const v = [hx * Math.cos(el), Math.sin(el), hz * Math.cos(el)];
          let novelty = 90;
          for (const d of c.dirs) novelty = Math.min(novelty, angleBetween(v, d) / DEG);
          if (novelty < 22) continue;
          const cam = v3.add(c.center, v3.scale(v, r));
          if (cam[1] < floorY + 0.45 || cam[1] > floorY + 2.05) continue;
          if (b && !b.standable(cam[0], cam[2], 0.4)) continue;
          if (this.voxels.isSolidAt(cam[0], cam[1], cam[2])) continue;
          // Line of sight from the viewpoint to the surface.
          const hit = this.voxels.raycast(cam, v3.scale(v, -1), r + 0.3, 0.1);
          if (hit && hit.t < r - 0.45 && v3.dist(hit.point, c.center) > 0.5) continue;
          const walk = dist2D(pos, cam);
          const facing = 0.75 + 0.25 * v3.dot(fwd, v3.norm(v3.sub(c.center, pos)));
          const score = (c.deficit * Math.min(1, novelty / 45) * facing) / (1 + walk / 3);
          if (!best || score > best.score) {
            best = { score, pos: cam, aim: v3.scale(v, -1), target: c.center, key: c.key, deficit0: c.deficit, t0: t, kind: 'gap' };
          }
        }
      }
    }
    return best;
  }

  /** Skip the current gap target for a while (the user can't or won't get there). */
  skipGap(t) {
    if (this.gap) this.skipped.set(this.gap.key, t + 180);
    this.gap = null;
  }

  /** For the practice room's autopilot: where to walk and aim next. */
  autopilot(pos) {
    const st = this.state;
    if (!st || !st.next) return null;
    if (st.mode === 'path' && this.stations) {
      const i = this.stations.indexOf(st.next);
      const ahead = this.stations[Math.min(this.stations.length - 1, i + 1)];
      return { pos: ahead.pos, aim: st.next.aim };
    }
    return { pos: st.next.pos, aim: st.next.aim };
  }
}
