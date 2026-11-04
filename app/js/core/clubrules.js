// Club beta rules shared by the phone and SplatStation: the rules and consent wording, how photos are
// checked and scored, light slots, handles and duplicate detection. Plain functions, no DOM, so the
// phone's instant feedback and the PC's review agree.

/** Bump when the rules or consent wording change; people are asked again. */
export const CONSENT_VERSION = 'beta-1';

export const DRAFT_NOTE = 'Draft wording for the closed beta. The club advisor should review it before the app is opened to everyone.';

export const RULES = [
  'Photograph only shared, public parts of campus buildings: lobbies, hallways, atriums, study areas, courtyards.',
  'No people in the shot. If someone walks into view, wait or retake. Photos with people are rejected.',
  'Never in residence halls, restrooms, locker rooms, labs, health or counseling spaces, offices, or classrooms during a class. The app won’t let you pick restricted buildings.',
  'Keep screens, whiteboards, documents and ID cards out of frame.',
  'Don’t go anywhere you wouldn’t normally be allowed, and don’t disturb anyone. Look up while you walk.',
  'Take the photos yourself, with this app. No gallery uploads, no pictures from the internet.',
];

export const CONSENT = [
  'I’m 18 or older, and an ASU student, employee or club member who was invited to this beta.',
  'I take these photos myself. The SplatScout club may keep them, together with the building, room and GPS location and the phone model, build 3D models of campus from them, and show those models publicly.',
  'I can remove my photos and my profile at any time from the Club screen. 3D models already built from them may stay, and the club will take them out if I ask.',
  'I’ve read the rules above and will follow them.',
];

export const POINTS = {
  photo: 1, // each photo that passes review...
  dailyBase: 100, // ...up to this many points a day (more photos are still welcome, they just don't score)
  firstInRoom: 5, // the first accepted photo of a room
  newLight: 3, // the first accepted photo of a room in a lighting slot
  scan: 30, // a full scan that is imported
  scanPer10Photos: 1, // + this per 10 photos...
  scanPhotosMax: 70, // ...up to this
  scanGrade: { A: 30, B: 15, C: 5 },
};

export const POINTS_HELP = [
  `+${POINTS.photo} for each photo that passes review (up to ${POINTS.dailyBase} a day)`,
  `+${POINTS.firstInRoom} for the first photo of a room`,
  `+${POINTS.newLight} for the first photo of a room in morning, afternoon, evening or night light`,
  'Missions add a bonus to each accepted photo (evening missions need an evening photo)',
  `A full scan: ${POINTS.scan} points, plus more for photo count and grade`,
];

// ---------------------------------------------------------------------------------- light
export const LIGHT_SLOTS = ['morning', 'afternoon', 'evening', 'night'];
export const LIGHT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night', any: 'Any light' };
const PHX = -7 * 3600e3; // Arizona doesn't change its clocks

/** Morning 6–11, afternoon 11–16, evening 16–20, night otherwise (Phoenix time). */
export function lightSlot(ms) {
  const hr = new Date(ms + PHX).getUTCHours();
  return hr >= 6 && hr < 11 ? 'morning' : hr >= 11 && hr < 16 ? 'afternoon' : hr >= 16 && hr < 20 ? 'evening' : 'night';
}

/** The Phoenix calendar day of a time, 'YYYY-MM-DD' (daily limits count by this). */
export const phoenixDay = (ms) => new Date(ms + PHX).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------- handles
export const validHandle = (h) => /^[A-Za-z0-9_]{3,20}$/.test(h || '');

const ADJ = ['Sunny', 'Desert', 'Quick', 'Bright', 'Cactus', 'Copper', 'Golden', 'Maroon', 'Mesa', 'Palm', 'Solar', 'Steady', 'Sharp', 'Keen'];
const NOUN = ['Fox', 'Owl', 'Gecko', 'Coyote', 'Hawk', 'Dove', 'Lizard', 'Quail', 'Bobcat', 'Scout', 'Javelina', 'Finch'];
export function suggestHandles(n = 3, rand = Math.random) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const out = new Set();
  while (out.size < n) out.add(pick(ADJ) + pick(NOUN) + String(10 + Math.floor(rand() * 90)));
  return [...out];
}

// ---------------------------------------------------------------------------------- duplicates
/**
 * 64-bit difference hash of a grayscale image (9 x 8 block averages, left vs right neighbour) as 16 hex
 * digits. Near-identical photos differ in a few bits; different views in 20 or more.
 */
export function dhash(gray, w, h) {
  const cols = 9, rows = 8, cell = new Float64Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / rows));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / cols));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += gray[y * w + x];
      cell[cy * cols + cx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  let hex = '';
  for (let cy = 0; cy < rows; cy++) {
    for (let g = 0; g < 2; g++) {
      let nib = 0;
      for (let b = 0; b < 4; b++) {
        const x = g * 4 + b;
        nib = (nib << 1) | (cell[cy * cols + x] > cell[cy * cols + x + 1] ? 1 : 0);
      }
      hex += nib.toString(16);
    }
  }
  return hex;
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
/** Number of differing bits between two hashes. */
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}
export const NEAR_DUPLICATE = 3; // bits

// ---------------------------------------------------------------------------------- checks
/**
 * Is this photo usable? m: {w, h, mean (0–255 brightness), clipHi (share of blown-out pixels), rel
 * (sharpness relative to comparable photos, 1 = as sharp as the best)}.
 * @param {{blurReject?: number, blurReview?: number}} t on the phone a photo blurrier than blurReject is
 *   not kept at all; on the PC blur only ever flags a photo for a human to look at.
 * @returns {{level: 'ok'|'review'|'reject', reasons: string[]}}
 */
export function photoChecks(m, { blurReject = 0, blurReview = 0.45 } = {}) {
  const bad = [], maybe = [];
  if (Math.max(m.w, m.h) < 1000) bad.push('too small');
  if (m.mean < 22) bad.push('too dark');
  else if (m.mean < 45) maybe.push('dark');
  if (m.mean > 238) bad.push('washed out');
  else if (m.mean > 222 || (m.clipHi || 0) > 0.3) maybe.push('very bright');
  if (m.rel != null && m.rel < blurReject) bad.push('blurry');
  else if (m.rel != null && m.rel < blurReview) maybe.push('maybe blurry');
  return { level: bad.length ? 'reject' : maybe.length ? 'review' : 'ok', reasons: [...bad, ...maybe] };
}

// ---------------------------------------------------------------------------------- points
/**
 * Points for one accepted photo.
 * @param {object} o
 * @param {boolean} [o.firstInRoom] nobody has an accepted photo of this room yet
 * @param {boolean} [o.newLight] ...none in this light slot yet
 * @param {{bonus:number, light:string}|null} [o.mission] the mission it was taken for
 * @param {string} [o.light] the photo's light slot
 * @param {number} [o.baseLeft] base points still available today
 * @returns {{points: number, parts: [string, number][]}}
 */
export function scorePhoto({ firstInRoom = false, newLight = false, mission = null, light = null, baseLeft = Infinity }) {
  const parts = [];
  const base = Math.max(0, Math.min(POINTS.photo, baseLeft));
  parts.push([base ? 'Photo' : 'Photo (daily limit reached)', base]);
  if (firstInRoom) parts.push(['First photo of this room', POINTS.firstInRoom]);
  else if (newLight) parts.push([`First ${light || 'new'} light here`, POINTS.newLight]);
  if (mission && mission.bonus > 0) {
    if (mission.light === 'any' || mission.light === light) parts.push(['Mission', mission.bonus]);
    else parts.push([`Mission needs ${mission.light} light`, 0]);
  }
  return { points: parts.reduce((s, p) => s + p[1], 0), parts };
}

/** Points for an imported full scan. */
export function scoreScan({ photos = 0, grade = '' }) {
  return POINTS.scan + Math.min(POINTS.scanPhotosMax, Math.floor(photos / 10) * POINTS.scanPer10Photos) + (POINTS.scanGrade[grade] || 0);
}
