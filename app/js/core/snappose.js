// Where a Snap photo was taken, when it was taken in AR ("Track position (AR)" on the Snap screen): the AR
// camera's pose (position and rotation, metres) and lens, and the AR session it belongs to. Within one AR
// session the poses are good to centimetres, so SplatStation hands one session's poses to COLMAP as its
// starting cameras (the photos line up faster, and in metres). Also: which floor the phone is probably on,
// from how far it went up or down since the AR session started.
// The club database checks the same shape (crowd/supabase-snap-pose.sql).

export const POSE_VERSION = 1;
export const STOREY = 4.0; // metres from one floor to the next in a typical ASU building (3.6–4.6 m)
const MAX_TEXT = 1500; // characters: what the database accepts for one pose
const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d || 0; // (|| 0: no -0, which JSON would turn into 0 anyway)
const SESSION = /^[0-9a-f-]{36}$/;

/**
 * The pose saved with an AR photo, and sent with it as photos.pose.
 * @param {ArrayLike<number>} m camera-to-world 4×4, column-major, OpenGL camera (x right, y up, looks down -z),
 *   world y up, metres: the AR frame the photo was taken in
 * @param {{fx, fy, cx, cy, w, h}} intr the AR camera's intrinsics for its whole image (pixels, top-left origin)
 * @param {string} session the AR session: one set of coordinates (a new one when tracking starts over)
 * @param {number} t seconds since that session started
 * @param {number} [k] the scale the photo was saved at (1: the camera image's own size)
 */
export function poseRecord(m, intr, session, t, k = 1) {
  return {
    v: POSE_VERSION,
    session,
    m: Array.from(m, (x, i) => (i >= 12 && i < 15 ? r(x, 4) : r(x, 6))),
    intr: { fx: r(intr.fx * k, 2), fy: r(intr.fy * k, 2), cx: r(intr.cx * k, 2), cy: r(intr.cy * k, 2), w: Math.round(intr.w * k), h: Math.round(intr.h * k) },
    t: r(t, 2),
  };
}

/** The shape the club database accepts for photos.pose (the same rules as its check constraint). */
export function poseShapeOk(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (JSON.stringify(p).length > MAX_TEXT) return false;
  if (!SESSION.test(typeof p.session === 'string' ? p.session : '')) return false;
  if (!Array.isArray(p.m) || p.m.length !== 16 || !p.m.every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
  const i = p.intr;
  if (!i || typeof i !== 'object') return false;
  return ['fx', 'fy', 'w', 'h'].every((k) => typeof i[k] === 'number' && i[k] > 0) && ['cx', 'cy'].every((k) => typeof i[k] === 'number');
}

/**
 * A pose SplatStation can use: the right shape, a real rotation, and a lens that fits the photo. When the photo
 * on the PC is another size than the camera image the pose describes (the same shape, scaled), the lens is
 * scaled to it. Returns {session, m, intr} or null.
 * @param {object} p photos.pose
 * @param {{w: number, h: number}} [size] the photo's real size
 */
export function usablePose(p, size = null) {
  if (!poseShapeOk(p)) return null;
  const m = p.m;
  const col = (c) => [m[4 * c], m[4 * c + 1], m[4 * c + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [x, y, z] = [col(0), col(1), col(2)];
  if ([x, y, z].some((v) => Math.abs(dot(v, v) - 1) > 0.02) || Math.abs(dot(x, y)) > 0.02 || Math.abs(dot(x, z)) > 0.02 || Math.abs(dot(y, z)) > 0.02) return null;
  if (Math.abs(m[3]) > 1e-4 || Math.abs(m[7]) > 1e-4 || Math.abs(m[11]) > 1e-4 || Math.abs(m[15] - 1) > 1e-4) return null;
  if (Math.hypot(m[12], m[13], m[14]) > 10000) return null;
  let { fx, fy, cx, cy, w, h } = p.intr;
  if (size && size.w && size.h && (size.w !== w || size.h !== h)) {
    const k = size.w / w;
    if (Math.abs(size.h / h - k) > 0.01 * k) return null; // another shape: cropped or turned, the lens doesn't fit
    [fx, fy, cx, cy, w, h] = [fx * k, fy * k, cx * k, cy * k, size.w, size.h];
  }
  const long = Math.max(w, h);
  if (fx < 0.2 * long || fx > 5 * long || fy < 0.2 * long || fy > 5 * long) return null;
  return { session: p.session, m: m.slice(), intr: { fx, fy, cx, cy, w, h } };
}

// ------------------------------------------------------------------------------------ floors
/** A floor's label as a level (1 = the ground floor, 0 = "B", -1 = "B2"), or null when it isn't one. */
export function floorLevel(label) {
  const f = String(label == null ? '' : label).trim();
  if (/^-?\d{1,2}$/.test(f)) return +f;
  const b = /^(?:b|basement|ll|lower level)\s*(\d?)$/i.exec(f);
  if (b) return 1 - (+b[1] || 1);
  return null;
}

/** The label for a level, as the club writes floors: 1, 2, 3 … and B, B2 below the ground floor. */
export const floorLabel = (level) => (level >= 1 ? String(level) : level === 0 ? 'B' : `B${1 - level}`);

/**
 * Another floor than the one the phone started on? From the height change since then (AR metres, y up).
 * Returns {floor, storeys, dy} when it's been at least about half a storey and a bit (2.4 m), else null.
 * `floor` is null when the starting floor isn't a number (the change is still reported).
 * @param {{y: number, floor: string}} start the height and floor where the session (or the last answer) began
 * @param {number} y the phone's height now
 */
export function floorSuggestion(start, y, storey = STOREY) {
  if (!start || !Number.isFinite(start.y) || !Number.isFinite(y)) return null;
  const dy = y - start.y;
  if (Math.abs(dy) < storey * 0.6) return null;
  const storeys = Math.round(dy / storey) || Math.sign(dy);
  const level = floorLevel(start.floor);
  return { floor: level == null ? null : floorLabel(level + storeys), storeys, dy: r(dy, 1) };
}

/** Height that ignores a moment's jolt: the median of the last few readings. */
export class HeightFilter {
  constructor(n = 15) {
    this.n = n;
    this.v = [];
  }
  add(y) {
    this.v.push(y);
    if (this.v.length > this.n) this.v.shift();
    return this.value();
  }
  value() {
    if (!this.v.length) return null;
    const s = [...this.v].sort((a, b) => a - b);
    return s[s.length >> 1];
  }
  reset() {
    this.v = [];
  }
}
