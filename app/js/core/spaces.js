// Coordinate spaces. Each AR session ("segment") starts its own coordinates; a session that was
// re-aligned to an earlier one shares that one's space, so its photos, scan area and coverage line up.
// Space ids: segment * 100 for a session's own coordinates (+1, +2… if it had to start over mid-way).

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
