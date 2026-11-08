// Club beta rules shared by the phone and SplatStation: the rules and consent wording, which scans can be
// sent, how an approved scan is scored, light slots and handles. Plain functions, no DOM, so the phone and
// the PC agree.
//
// The club takes full scans only: one member scanning one space in one go gives a splat with one lighting
// and one arrangement of the furniture. Single photos from many people and times don't (they were retired).

/** Bump when the rules or consent wording change (the version each member agreed to is kept). */
export const CONSENT_VERSION = 'beta-2';

export const DRAFT_NOTE = 'Draft wording for the closed beta. The club advisor should review it before the app is opened to everyone.';

export const RULES = [
  'Scan only shared, public parts of campus buildings: lobbies, hallways, atriums, study areas, courtyards.',
  'No people in the scan. If someone walks into view, pause until they’ve gone. Scans with people in them aren’t approved.',
  'Never in residence halls, restrooms, locker rooms, labs, health or counseling spaces, offices, or classrooms during a class. The app won’t let you pick restricted buildings.',
  'Keep screens, whiteboards, documents and ID cards out of view.',
  'Don’t go anywhere you wouldn’t normally be allowed, and don’t disturb anyone. Look up while you walk.',
  'Make the scan yourself, with this app.',
];

export const CONSENT = [
  'I’m 18 or older, and an ASU student, employee or club member who was invited to this beta.',
  'I make these scans myself. The SplatScout club may keep them, together with the building, room and GPS location and the phone model, build 3D models of campus from them, and show those models publicly.',
  'I can remove my scans and my profile at any time from the Club screen. 3D models already built from them may stay, and the club will take them out if I ask.',
  'I’ve read the rules above and will follow them.',
];

// ---------------------------------------------------------------------------------- scans
/** Grades a scan needs before it can be sent (the capture coach grades A to F; the database enforces this). */
export const UPLOAD_GRADES = ['A', 'B'];
export const canUpload = (grade) => UPLOAD_GRADES.includes(grade);

export const POINTS = {
  grade: { A: 30, B: 20 }, // an approved scan, by its grade
  per10m2: 1, // + this for every 10 m² of floor it adds to the campus map...
  areaMax: 30, // ...up to this
  rescan: 5, // a space the map already had as Good: a thank-you, unless a mission asked for it
};

export const POINTS_HELP = [
  'Scans need grade B or better to send. Points come when the club approves the splat made from it.',
  `An approved scan: ${POINTS.grade.A} points for grade A, ${POINTS.grade.B} for grade B`,
  `+${POINTS.per10m2} for every 10 m² of floor it adds to the campus map (up to ${POINTS.areaMax})`,
  'Missions add their bonus when a scan of that space is approved',
  `A space the map already has as Good earns ${POINTS.rescan} for a new scan, unless a mission asks for one`,
];

/**
 * Points for an approved scan.
 * @param {object} o
 * @param {string} o.grade the capture coach's grade
 * @param {number} [o.newArea] m² of floor the splat adds to the campus map (none if its space was covered already)
 * @param {boolean} [o.rescan] its space already had a Good splat
 * @param {{bonus: number, title?: string}|null} [o.mission] an open mission for that space
 * @returns {{points: number, parts: [string, number][]}}
 */
export function scoreScan({ grade = '', newArea = 0, rescan = false, mission = null }) {
  const parts = [];
  const asked = !!(mission && mission.bonus > 0);
  if (rescan && !asked) parts.push(['New scan of a space that was already Good', POINTS.rescan]);
  else parts.push([`Scan graded ${grade || '?'}`, POINTS.grade[grade] || 0]);
  const area = rescan ? 0 : Math.min(POINTS.areaMax, Math.floor(Math.max(0, newArea) / 10) * POINTS.per10m2);
  if (area) parts.push([`${Math.round(newArea)} m² new on the campus map`, area]);
  if (asked) parts.push([`Mission${mission.title ? `: ${mission.title}` : ''}`, mission.bonus]);
  return { points: Math.min(1000, parts.reduce((s, p) => s + p[1], 0)), parts };
}

// ---------------------------------------------------------------------------------- light
export const LIGHT_SLOTS = ['morning', 'afternoon', 'evening', 'night'];
export const LIGHT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night', any: 'Any light' };
const PHX = -7 * 3600e3; // Arizona doesn't change its clocks

/** Morning 6–11, afternoon 11–16, evening 16–20, night otherwise (Phoenix time). */
export function lightSlot(ms) {
  const hr = new Date(ms + PHX).getUTCHours();
  return hr >= 6 && hr < 11 ? 'morning' : hr >= 11 && hr < 16 ? 'afternoon' : hr >= 16 && hr < 20 ? 'evening' : 'night';
}

/** The Phoenix calendar day of a time, 'YYYY-MM-DD'. */
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
