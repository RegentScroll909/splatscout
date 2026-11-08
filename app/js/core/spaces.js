// Coordinate spaces. Each AR session ("segment") starts its own coordinates; a session that was
// re-aligned to an earlier one shares that one's space, so its photos, scan area and coverage line up.
// Space ids: segment * 100 for a session's own coordinates (+1, +2… if it had to start over mid-way).
//
// Parts: when tracking is lost and the view no longer lines up, scanning carries on as a new segment in
// a space of its own. Each space is one part of the scan: the export keeps every part in its own
// coordinates and SplatStation joins them from the photos where they overlap. The phone may still line
// a part up with the earlier scan while you scan (capture.links): that only puts the coverage map back
// together on the phone, it never changes the exported poses.

import { xfCompose, xfInverse, xfPose, xfPoints, xfApply } from './align.js';

const isDemo = (capture) => String((capture && capture.engine) || '').startsWith('demo');

/** The space a photo's pose is in. */
export function spaceOf(f, capture) {
  if (f.space != null) return f.space;
  // Before 2.1 the practice room had fixed coordinates, so all its sessions line up.
  return isDemo(capture) ? 100 : (f.segment || 0) * 100;
}

/** The space a saved scan area belongs to. */
export function boundsSpace(b, capture) {
  if (!b) return null;
  if (b.space != null) return b.space;
  if (isDemo(capture)) return 100;
  return b.segment != null ? b.segment * 100 : null;
}

/** The scan area marked in a space (each map keeps its own), or null. */
export function boundsFor(capture, space) {
  if (space == null || !capture) return null;
  const by = capture.boundsBySpace;
  if (by && Object.prototype.hasOwnProperty.call(by, space)) return by[space];
  return capture.bounds && boundsSpace(capture.bounds, capture) === space ? capture.bounds : null;
}

/** The space with the most tracked photos ({space, count}), or null. */
export function mainSpace(frames, capture, filter = (f) => f.tracked && f.pose) {
  const counts = new Map();
  for (const f of frames) {
    if (!filter(f)) continue;
    const s = spaceOf(f, capture);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = null;
  for (const [space, count] of counts) if (!best || count > best.count) best = { space, count };
  return best;
}

/** Number of different spaces among the tracked photos. */
export function spaceCount(frames, capture) {
  const set = new Set();
  for (const f of frames) if (f.tracked && f.pose) set.add(spaceOf(f, capture));
  return set.size;
}

/**
 * The transform ({yaw, t}) taking `from` coordinates into `to`, through the parts the phone lined up
 * (capture.links: [{from, to, xf}], xf taking `from` into `to`), or null when they aren't linked.
 */
export function spaceXf(capture, from, to) {
  if (from === to) return { yaw: 0, t: [0, 0, 0] };
  const links = (capture && capture.links) || [];
  const seen = new Map([[from, { yaw: 0, t: [0, 0, 0] }]]);
  const queue = [from];
  while (queue.length) {
    const s = queue.shift(), x = seen.get(s);
    for (const l of links) {
      const next = l.from === s ? l.to : l.to === s ? l.from : null;
      if (next == null || seen.has(next)) continue;
      const step = l.from === s ? l.xf : xfInverse(l.xf);
      const nx = xfCompose(step, x);
      if (next === to) return nx;
      seen.set(next, nx);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Tracked photos whose pose is in `space` or in a part lined up with it, moved into `space`'s
 * coordinates (copies; photos already there come back as they are). For coverage maps only.
 * @param {boolean} [o.points] move their depth points too (default true)
 */
export function framesIn(frames, capture, space, filter = (f) => f.tracked && f.pose, { points = true } = {}) {
  const xfs = new Map();
  const out = [];
  for (const f of frames) {
    if (!filter(f)) continue;
    const s = spaceOf(f, capture);
    if (s === space) {
      out.push(f);
      continue;
    }
    if (!xfs.has(s)) xfs.set(s, spaceXf(capture, s, space));
    const x = xfs.get(s);
    if (!x) continue;
    out.push({ ...f, space, pose: Array.from(xfPose(x, f.pose)), pts: points && f.pts && f.pts.length ? xfPoints(x, f.pts) : null, linkedFrom: s });
  }
  return out;
}

/** The scan area for `space`: its own, or one marked in a part lined up with it (moved), or null. */
export function boundsIn(capture, space) {
  const own = boundsFor(capture, space);
  if (own || !capture) return own;
  const spaces = new Set(Object.keys(capture.boundsBySpace || {}).map(Number));
  if (capture.bounds) spaces.add(boundsSpace(capture.bounds, capture));
  for (const s of spaces) {
    const b = boundsFor(capture, s);
    const x = b && s !== space ? spaceXf(capture, s, space) : null;
    if (!x) continue;
    const p = (q) => {
      const r = xfApply(x, [q[0], 0, q[1]]);
      return [r[0], r[2]];
    };
    return {
      ...b,
      poly: b.poly ? b.poly.map(p) : null,
      floorY: b.floorY == null ? null : b.floorY + x.t[1],
      top: b.top == null ? null : b.top + x.t[1],
      skips: (b.skips || []).map((k) => [...xfApply(x, k), k[3]]),
      space,
    };
  }
  return null;
}

/**
 * The scan's parts for the export: one per space with tracked photos, in the order they were
 * started, each with its segments and photos. The main part (most tracked photos) sets the
 * coordinates SplatStation works in.
 * @returns {Array<{part: number, space: number, segments: number[], frames: object[], tracked: number, main: boolean}>}
 */
export function partsOf(frames, capture) {
  const by = new Map();
  for (const f of frames) {
    if (!(f.tracked && f.pose)) continue;
    const s = spaceOf(f, capture);
    if (!by.has(s)) by.set(s, { space: s, segments: new Set(), frames: [], first: f.seq ?? 0 });
    const p = by.get(s);
    p.segments.add(f.segment);
    p.frames.push(f);
  }
  const main = mainSpace(frames, capture);
  return [...by.values()]
    .sort((a, b) => a.first - b.first)
    .map((p, i) => ({ part: i + 1, space: p.space, segments: [...p.segments].sort((a, b) => a - b), frames: p.frames, tracked: p.frames.length, main: !!main && p.space === main.space }));
}
