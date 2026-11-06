// How far along each space and building is, and how good a splat to expect from the photos and scans so
// far. Rules of thumb from photogrammetry practice, checked against the club's own finished splats;
// SplatStation's Campus page shows how every number was reached. Plain functions, no DOM, so SplatStation
// and the phone can share them.
//
// A space is one room or area of a building (building + floor + room, as members tag their photos).
// Its expected quality (0–100) comes from whichever evidence is strongest:
//   photos   accepted single photos: more photos in one kind of light help, mixed light hurts
//   scan     a full AR scan's grade from the capture coach
//   built    a finished splat: measured when SplatStation held photos back from its training (PSNR on
//            them), otherwise what its photos promised, discounted for photos COLMAP couldn't place,
//            a poor reprojection error, or the quick training preset
// A building's completion counts its spaces against a plan (how many spaces it should have), with a
// space counting fully once it reaches Good.

import { LIGHT_SLOTS } from './clubrules.js';

/** Quality bands and what a splat at that level looks like. `status` is the colour family used to show it. */
export const BANDS = [
  { id: 'none', min: 0, label: 'Not enough yet', status: 'critical', means: 'Too little to build from: COLMAP can’t place the photos, or the splat is a cloud of fragments.' },
  { id: 'rough', min: 25, label: 'Rough', status: 'serious', means: 'Recognisable from where the photos were taken; holes, smears and see-through walls elsewhere.' },
  { id: 'fair', min: 50, label: 'Fair', status: 'warning', means: 'Reads well from the middle of the space; edges, floor and ceiling soft, some floaters.' },
  { id: 'good', min: 75, label: 'Good', status: 'good', means: 'Walk-through quality: solid walls and sharp detail in most places.' },
  { id: 'excellent', min: 90, label: 'Excellent', status: 'good', means: 'Sharp from almost anywhere in the space, with few artifacts.' },
];
export const GOOD = 75;
export const EXCELLENT = 90;
/** Below this many photos COLMAP rarely places a set at all. */
export const MIN_PHOTOS = 20;

export const bandOf = (score) => BANDS.reduce((best, b) => (score >= b.min ? b : best), BANDS[0]);
const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));

/**
 * Kinds of space, by how many photos they need: `n0` is the photo count at which a space of that kind
 * reaches 63% of the way to perfect (the curve's scale). Bigger, more open spaces need more.
 */
export const KINDS = {
  room: { label: 'Room', n0: 90 },
  hallway: { label: 'Hallway', n0: 120 },
  large: { label: 'Large open space', n0: 150 },
};

/** Guess the kind of space from its name ("Main lobby" is large, "2nd floor hallway" a hallway). */
export function kindOf(room = '') {
  if (/hall ?way|corridor|walkway|passage|stair/i.test(room)) return 'hallway';
  if (/lobby|atrium|commons|concourse|reading room|library|gallery|court ?yard|ballroom|auditorium|\bgym|\bhall\b/i.test(room)) return 'large';
  return 'room';
}

/** Expected quality from `n` photos taken in one kind of light, in a space of this kind. */
export function photoCurve(n, kind = 'room') {
  const raw = 100 * (1 - Math.exp(-Math.max(0, n) / KINDS[kind].n0));
  return n < MIN_PHOTOS ? Math.min(15, raw) : raw;
}

/** How many photos (in one light) a space of this kind needs to reach a score. */
export function photosFor(score, kind = 'room') {
  if (score >= 100) return Infinity;
  return Math.max(MIN_PHOTOS, Math.ceil(-KINDS[kind].n0 * Math.log(1 - score / 100)));
}

/** Points on the curve for a chart: [[photos, score], ...] from 10 to `max` photos, spaced evenly on a log scale. */
export function curvePoints(kind = 'room', max = 1500, steps = 60) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const n = 10 * Math.pow(max / 10, i / steps);
    out.push([+n.toFixed(1), +photoCurve(n, kind).toFixed(1)]);
  }
  return out;
}

/**
 * From accepted photos of one space.
 * @param {{byLight?: object, devices?: number}} p photos counted by light slot, and how many phones took them
 * @returns {{score, n, dominant, share, effective, parts: [string, number][]}}
 */
export function photoEstimate({ byLight = {}, devices = 1 } = {}, kind = 'room') {
  const n = LIGHT_SLOTS.reduce((s, k) => s + (byLight[k] || 0), 0);
  if (!n) return { score: 0, n: 0, dominant: null, share: 0, effective: 0, parts: [] };
  const dominant = LIGHT_SLOTS.reduce((a, k) => ((byLight[k] || 0) > (byLight[a] || 0) ? k : a), LIGHT_SLOTS[0]);
  const dom = byLight[dominant] || 0, share = dom / n;
  // Photos in other light add a little coverage, but a splat can't agree with two lightings at once.
  const effective = dom + 0.25 * (n - dom);
  const base = photoCurve(effective, kind);
  const parts = [[n === dom ? `${n} photos, all in ${dominant} light` : `${dom} photos in ${dominant} light, plus ${n - dom} in other light (counting a quarter)`, Math.round(base)]];
  let score = base;
  if (share < 0.7) {
    const p = Math.round((20 * (0.7 - share)) / 0.7);
    score -= p;
    parts.push([`Light is mixed: only ${Math.round(share * 100)}% in ${dominant} light`, -p]);
  }
  if (devices > 2) {
    score -= 3;
    parts.push([`${devices} different phones (different lenses)`, -3]);
  }
  return { score: Math.round(clamp(score)), n, dominant, share, effective, parts };
}

/** What a scan's grade promises (the coach scores coverage, sharpness and light as it goes). */
const GRADE_SCORE = { A: 92, B: 80, C: 62, D: 42, F: 20 };
export function scanEstimate(scans = []) {
  let best = null;
  for (const s of scans) {
    const promised = s.score != null ? s.score : GRADE_SCORE[s.grade] ?? 50;
    const score = Math.round(clamp(promised * 0.95)); // a good scan can still fail to process
    if (!best || score > best.score) best = { score, grade: s.grade || null, photos: s.photos || 0, parts: [[`Scan graded ${s.grade || '?'}${s.photos ? ` (${s.photos} photos)` : ''}`, score]] };
  }
  return best || { score: 0, grade: null, photos: 0, parts: [] };
}

const PRESET = { quick: 0.85, standard: 1, high: 1.05 };

/**
 * Measured quality. With *Measure quality* on, SplatStation holds every 12th photo back from training and
 * Brush scores the finished splat on them: the PSNR, in dB, of the splat's render of each held-back view
 * against the photo, averaged. The score runs in straight lines between these stops, so each band starts at
 * a round number of dB (checked against the club's own captures: README, *Measure quality*):
 *   under 20 dB   Not enough yet
 *   20 dB         Rough       (25)
 *   23 dB         Fair        (50)
 *   26 dB         Good        (75)
 *   29 dB         Excellent   (90), and 100 at 32 dB
 */
export const PSNR_STOPS = [[14, 0], [20, 25], [23, 50], [26, 75], [29, 90], [32, 100]];
export function psnrScore(psnr) {
  if (!Number.isFinite(psnr) || psnr <= PSNR_STOPS[0][0]) return 0;
  for (let i = 1; i < PSNR_STOPS.length; i++) {
    const [x1, y1] = PSNR_STOPS[i];
    if (psnr <= x1) {
      const [x0, y0] = PSNR_STOPS[i - 1];
      return y0 + ((psnr - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 100;
}

/**
 * From a finished splat: measured when it has a score from held-back photos (`eval`), otherwise what its
 * photos promised, discounted for how the build went.
 * @param {{photos, placed, reprojError, preset, gradeScore?, eval?: {psnr, ssim, views}}} b
 * @returns {{score, measured: boolean, placedRatio, parts: [string, number][]}}
 */
export function builtEstimate(b, kind = 'room') {
  const placed = b.placed || 0;
  const promised = b.gradeScore != null ? b.gradeScore : photoCurve(placed, kind);
  const ratio = b.photos ? placed / b.photos : 0;
  const placedF = clamp((ratio - 0.5) / 0.45, 0, 1); // 95%+ placed counts fully; half placed counts 60%
  const ev = b.eval;
  if (ev && Number.isFinite(ev.psnr)) {
    // The held-back photos show how the splat came out, camera solve and training preset included. Photos
    // COLMAP couldn't place are missing from the splat and from the measurement alike, so they still count.
    const measured = psnrScore(ev.psnr);
    const score = Math.round(clamp(measured * (0.6 + 0.4 * placedF)));
    const parts = [[`Measured: PSNR ${ev.psnr.toFixed(1)} dB on ${ev.views ? `${ev.views} ` : ''}photos held back from training`, Math.round(measured)]];
    if (placedF < 1) parts.push([`${Math.round(ratio * 100)}% of photos placed by COLMAP`, score - Math.round(measured)]);
    return { score, measured: true, placedRatio: ratio, parts };
  }
  const e = b.reprojError || 0;
  const reprojF = e <= 1 ? 1 : e >= 2.5 ? 0.6 : 1 - (0.4 * (e - 1)) / 1.5;
  const presetF = PRESET[b.preset] ?? 1;
  const score = Math.round(clamp(promised * (0.6 + 0.4 * placedF) * reprojF * presetF));
  const parts = [[b.gradeScore != null ? `Its scan promised` : `${placed} photos promised`, Math.round(promised)]];
  if (placedF < 1) parts.push([`${Math.round(ratio * 100)}% of photos placed by COLMAP`, Math.round(promised * (0.6 + 0.4 * placedF)) - Math.round(promised)]);
  if (reprojF < 1) parts.push([`Reprojection error ${e.toFixed(2)} px`, Math.round(promised * (reprojF - 1))]);
  if (presetF !== 1) parts.push([`${b.preset} training`, Math.round(promised * (presetF - 1))]);
  return { score, measured: false, placedRatio: ratio, parts };
}

/**
 * A space's expected quality from everything known about it, with what would improve it.
 * @param {object} s {room, photos: {byLight, devices, pending, sinceBuild}, scans: [], builds: []}
 * @param {{advice?: boolean}} [o] advice: false skips the advice (photosNeeded tries many photo counts)
 */
export function spaceEstimate(s, { advice = true } = {}) {
  const kind = kindOf(s.room);
  const ph = photoEstimate(s.photos || {}, kind);
  const sc = scanEstimate(s.scans || []);
  const builds = (s.builds || []).map((b) => ({ ...b, ...builtEstimate(b, kind) }));
  const built = builds.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
  // Photos and a scan of the same space back each other up a little.
  const predicted = Math.round(clamp(Math.max(ph.score, sc.score) + (ph.score && sc.score ? 0.1 * Math.min(ph.score, sc.score) : 0)));
  const score = Math.max(predicted, built ? built.score : 0);
  const source = built && built.score >= predicted ? 'built' : !ph.score && !sc.score ? 'none' : sc.score > ph.score ? 'scan' : 'photos';
  const pending = (s.photos && s.photos.pending) || 0;
  return { kind, score, band: bandOf(score), source, predicted, built, photos: ph, scan: sc, advice: advice ? advise(s, { score, ph, sc, built, predicted, pending, sinceBuild: (s.photos && s.photos.sinceBuild) || 0 }) : [] };
}

/**
 * About how many more accepted photos would bring a space to `target` (Good unless told otherwise), counted
 * with spaceEstimate itself, so mixed light, a scan or a build all count and the band shown afterwards agrees:
 * {n, light}. The photos go in the light most of its photos are already in, since a splat is cleanest from one
 * light; light is null when it has none yet (any one kind of light will do). n is 0 once it is there.
 */
export function photosNeeded(s, target = GOOD) {
  const byLight = (s.photos && s.photos.byLight) || {};
  const light = photoEstimate(s.photos || {}, kindOf(s.room)).dominant;
  const slot = light || LIGHT_SLOTS[0];
  const scoreWith = (extra) => spaceEstimate({ ...s, photos: { ...(s.photos || {}), byLight: { ...byLight, [slot]: (byLight[slot] || 0) + extra } } }, { advice: false }).score;
  if (scoreWith(0) >= target) return { n: 0, light };
  // More photos in that light never lower the score, so double until it's enough, then halve the gap.
  let lo = 0, hi = 16;
  for (; scoreWith(hi) < target; hi *= 2) {
    if (hi > 1e5) return { n: Infinity, light };
    lo = hi;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (scoreWith(mid) >= target) hi = mid;
    else lo = mid;
  }
  return { n: hi, light };
}

function advise(s, { score, ph, sc, built, predicted, pending, sinceBuild }) {
  const out = [];
  if (!ph.n && !sc.score && !built) {
    out.push(`Nothing yet. About ${photosNeeded(s, GOOD).n} photos in one kind of light, or one full scan with the AR coach (10–20 minutes), would make a good splat.`);
  } else if (ph.n && score < EXCELLENT && !built) {
    const need = photosNeeded(s, score < GOOD ? GOOD : EXCELLENT).n;
    if (need > 0) out.push(`About ${need} more photos in ${ph.dominant} light would make it ${score < GOOD ? 'Good' : 'Excellent'}.`);
  }
  if (ph.n && ph.share < 0.7) out.push(`Photos are spread over several kinds of light. Build from the ${ph.dominant} ones, or add more in that light.`);
  if (sc.score && sc.grade && /[CDF]/.test(sc.grade)) out.push(`The scan graded ${sc.grade}: fill the gaps the coach flagged, or add photos.`);
  if (pending) out.push(`${pending} photo${pending === 1 ? ' is' : 's are'} waiting for review on the Club page.`);
  if (built && sinceBuild) out.push(`${sinceBuild} photo${sinceBuild === 1 ? '' : 's'} accepted since the last build: build it again.`);
  if (built && built.score < predicted - 10) out.push('The last build came out below what the photos promise: check it in the viewer and build again.');
  if (!ph.n && !built && sc.score && sc.score >= GOOD) out.push('The scan looks good: process it on the dashboard to get the splat.');
  return out;
}

// ------------------------------------------------------------------------------------ buildings
/**
 * A building's plan: how many spaces it should have before it counts as complete. Without a plan set by
 * the club: the entrance plus 2 spaces per floor (3 in a big building), with floors from OpenStreetMap
 * where it knows them and 2 otherwise.
 */
export function defaultPlan(b) {
  const floors = b.levels || 2;
  const perFloor = (b.area || 0) >= 4000 ? 3 : 2;
  return { spaces: 1 + perFloor * floors, floors, perFloor, guessed: !b.levels };
}

/** How complete a building is, from its spaces' scores and its planned number of spaces. */
export function buildingProgress(scores, planned) {
  const credit = scores.reduce((s, q) => s + Math.min(1, q / GOOD), 0);
  return {
    completion: planned > 0 ? Math.min(1, credit / planned) : 0,
    credit: Math.min(credit, planned),
    good: scores.filter((q) => q >= GOOD).length,
    started: scores.filter((q) => q > 0).length,
  };
}
