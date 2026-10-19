// "Splat readiness" score: rebuilds coverage from the saved keyframes and grades the capture,
// with concrete fixes for anything weak.

import { DirectionSphere, VoxelMap, BANDS } from './coverage.js';
import { posePosition, clamp } from './math.js';
import { getTemplate } from './plans.js';

/**
 * Rebuild coverage structures from saved frames (poses + depth points).
 * Each AR session ("segment") has its own coordinate frame, so surface coverage is rebuilt
 * from the largest segment only.
 */
export function rebuildCoverage(frames, template) {
  const sphere = new DirectionSphere();
  const voxels = new VoxelMap(template.voxel, template.maxObsDist);
  const segCounts = new Map();
  for (const f of frames) segCounts.set(f.segment || 0, (segCounts.get(f.segment || 0) || 0) + 1);
  let mainSeg = 0, best = -1;
  for (const [s, n] of segCounts) if (n > best) [mainSeg, best] = [s, n];
  frames.forEach((f, i) => {
    if (!f.pose || !f.intr) return;
    const pos = f.tracking === '6dof' && f.tracked ? posePosition(f.pose) : null;
    sphere.addView(f.pose, f.intr, { pos, odo: f.odo || 0 }, i);
    if (pos && (f.segment || 0) === mainSeg && f.pts && f.pts.length) voxels.observe(f.pts, pos, true);
  });
  return { sphere, voxels, segments: segCounts.size, mainSegment: mainSeg };
}

/** Rough floor-plan area (m²) from the voxel footprint. */
export function footprintArea(voxels) {
  const cols = new Set();
  for (const v of voxels.vox.values()) if (VoxelMap.isSolid(v)) cols.add(v.ix * 4096 + v.iz);
  return cols.size * voxels.size * voxels.size;
}

const GRADES = [
  [88, 'A', 'Ready to train'],
  [74, 'B', 'Good, small fixes would help'],
  [60, 'C', 'Usable, expect soft spots and floaters'],
  [45, 'D', 'Weak, capture more before training'],
  [0, 'F', 'Not ready, recapture recommended'],
];

export function analyzeCapture(frames, capture) {
  const template = getTemplate(capture.template);
  const { sphere, voxels, segments } = rebuildCoverage(frames, template);
  const vstats = voxels.stats();
  const n = frames.length;
  const sixdof = capture.tracking === '6dof';
  const hasDepth = vstats.solid >= 80;

  const parts = [];
  const fixes = [];

  // --- Coverage ---
  let coverage;
  const mid = sphere.bandCoverage(['low', 'mid', 'high'], 2);
  const poles = sphere.bandCoverage(['floor', 'ceil'], 1);
  if (hasDepth) {
    // 20% weighted coverage is what a single quick lap gives; 80% is a thorough capture.
    coverage = clamp((vstats.coverage - 0.2) / 0.6, 0, 1);
    const weak = vstats.q0 + vstats.q1;
    parts.push({ id: 'coverage', label: 'Surface coverage', weight: 0.35, value: coverage,
      detail: `${Math.round((vstats.q3 / vstats.solid) * 100)}% of surfaces from 3+ angles, ${Math.round((weak / vstats.solid) * 100)}% from 0–1 angles` });
    if (coverage < 0.8) fixes.push({ level: coverage < 0.5 ? 'bad' : 'warn',
      text: `${Math.round((weak / vstats.solid) * 100)}% of surfaces were seen from one angle or fewer. Tap "Capture more" and walk until the red areas turn green, viewing each from a different spot.` });
  } else {
    coverage = clamp((mid.fraction * 0.8 + poles.fraction * 0.2) / 0.85, 0, 1);
    parts.push({ id: 'coverage', label: 'View coverage', weight: 0.35, value: coverage,
      detail: `${Math.round(mid.fraction * 100)}% of directions seen from 2+ spots; floor/ceiling ${Math.round(poles.fraction * 100)}%` });
  }
  for (const band of BANDS) {
    const bc = sphere.bandCoverage([band.id], band.id === 'floor' || band.id === 'ceil' ? 1 : 2);
    if (bc.fraction < 0.5 && n > 20) {
      const hint = {
        floor: 'Do a slow pass aiming at the floor (overhead pass, tilted down).',
        ceil: 'Do a low pass tilted up at the ceiling.',
        low: 'Do the overhead lap: phone above your head, tilted down.',
        high: 'Do the low lap: phone at waist height, tilted up.',
        mid: 'Do an eye-level lap around the space.',
      }[band.id];
      fixes.push({ level: 'warn', text: `"${band.label}" views are thin (${Math.round(bc.fraction * 100)}%). ${hint}` });
    }
  }

  // --- Sharpness ---
  const sharpOk = frames.filter((f) => f.m && f.m.relSharp >= 0.7 && !hasFlag(f, 'blurry')).length;
  const blurry = frames.filter((f) => hasFlag(f, 'blurry')).length;
  const sharpFrac = n ? sharpOk / n : 0;
  parts.push({ id: 'sharp', label: 'Sharpness', weight: 0.2, value: clamp((sharpFrac - 0.5) / 0.45, 0, 1),
    detail: `${Math.round(sharpFrac * 100)}% of photos are crisp` });
  if (blurry > 0) fixes.push({ level: blurry / n > 0.15 ? 'bad' : 'warn',
    text: `${blurry} photo${blurry === 1 ? ' is' : 's are'} soft. Use "Remove blurry" in the gallery, then capture those areas again more slowly.` });

  // --- Parallax ---
  let parallax;
  if (sixdof) {
    const moved = frames.filter((f) => f.trigger === 'trans' || (f.baseline || 0) >= 0.08).length;
    const rotOnly = frames.filter((f) => hasFlag(f, 'rotonly')).length;
    parallax = clamp((n ? moved / n : 0) / 0.55, 0, 1) * (1 - clamp(rotOnly / Math.max(1, n) - 0.15, 0, 0.5));
    parts.push({ id: 'parallax', label: 'Parallax (moving, not turning)', weight: 0.15, value: parallax,
      detail: `${n ? Math.round((moved / n) * 100) : 0}% of photos taken after moving` });
    if (rotOnly / Math.max(1, n) > 0.25) fixes.push({ level: 'warn',
      text: `${rotOnly} photos were taken while turning in place. Re-cover those areas with sidesteps: the moving is what creates 3D.` });
  } else {
    const rotOnly = frames.filter((f) => hasFlag(f, 'rotonly')).length;
    parallax = clamp(1 - rotOnly / Math.max(1, n) / 0.5, 0, 1);
    parts.push({ id: 'parallax', label: 'Parallax (moving, not turning)', weight: 0.15, value: parallax,
      detail: `${Math.round((1 - rotOnly / Math.max(1, n)) * 100)}% of photos had sideways movement` });
    if (rotOnly / Math.max(1, n) > 0.25) fixes.push({ level: 'warn', text: 'Many photos were taken while turning on the spot. Walk sideways while capturing.' });
  }

  // --- Continuity (overlap gaps, tracking) ---
  const rushed = frames.filter((f) => hasFlag(f, 'rushed')).length;
  const untracked = sixdof ? frames.filter((f) => !f.tracked).length : 0;
  const gaps = (capture.stats && capture.stats.gaps) || 0;
  const continuity = clamp(1 - (rushed + 2 * gaps) / Math.max(1, n) * 4 - (untracked / Math.max(1, n)) * 2, 0, 1);
  parts.push({ id: 'continuity', label: 'Overlap & tracking', weight: 0.1, value: continuity,
    detail: `${gaps} overlap gap${gaps === 1 ? '' : 's'}, ${rushed} rushed photo${rushed === 1 ? '' : 's'}${sixdof ? `, ${untracked} without tracking` : ''}` });
  if (gaps + rushed > 3) fixes.push({ level: 'warn', text: 'You moved on before sharp photos were taken in a few places. Slow down and sweep back over those spots.' });
  if (sixdof && untracked > 5) fixes.push({ level: 'warn', text: `${untracked} photos were taken while AR tracking was lost. They have no pose, but your pipeline can still use them.` });

  // --- Exposure ---
  const dark = frames.filter((f) => hasFlag(f, 'dark')).length;
  const hl = frames.filter((f) => hasFlag(f, 'highlights')).length;
  const exposure = clamp(1 - (dark + hl) / Math.max(1, n) * 2, 0, 1);
  parts.push({ id: 'exposure', label: 'Lighting', weight: 0.05, value: exposure,
    detail: `${dark} dark, ${hl} with blown highlights` });
  if (dark / Math.max(1, n) > 0.1) fixes.push({ level: 'warn', text: 'Many photos are dark. Add light (never a flashlight) and recapture those areas.' });
  if (hl / Math.max(1, n) > 0.15) fixes.push({ level: 'info', text: 'Many photos have blown-out windows or lights. Expect floaters near them, or recapture with the blinds closed.' });

  // --- Texture ---
  const lowtex = frames.filter((f) => hasFlag(f, 'lowtex')).length;
  const texture = clamp(1 - lowtex / Math.max(1, n) * 3, 0, 1);
  parts.push({ id: 'texture', label: 'Matchable detail', weight: 0.05, value: texture, detail: `${lowtex} mostly-blank photos` });
  if (lowtex / Math.max(1, n) > 0.1) fixes.push({ level: 'info', text: 'Some photos show mostly blank wall. Next time, step back so corners and furniture stay in frame.' });

  // --- Quantity ---
  const area = hasDepth ? footprintArea(voxels) : 0;
  const target = Math.round(clamp(Math.max(template.minFrames, template.framesPerM2 * area), template.minFrames, 1500));
  const quantity = clamp(n / target, 0, 1);
  parts.push({ id: 'quantity', label: 'Photo count', weight: 0.1, value: quantity,
    detail: `${n} of about ${target} recommended${area ? ` for ~${Math.round(area)} m²` : ''}` });
  if (n < target * 0.7) fixes.push({ level: 'warn', text: `About ${target - n} more photos are recommended for this space. Finish the remaining passes.` });

  const score = Math.round(parts.reduce((s, p) => s + p.weight * p.value, 0) / parts.reduce((s, p) => s + p.weight, 0) * 100);
  const [, grade, verdict] = GRADES.find(([min]) => score >= min);
  const order = { bad: 0, warn: 1, info: 2 };
  fixes.sort((a, b) => order[a.level] - order[b.level]);
  if (sixdof && segments > 1) {
    fixes.push({ level: 'info', text: `This capture has ${segments} AR sessions. Each has its own coordinate frame, so surface coverage is shown for the largest one. All photos are still exported.` });
  }
  if (!fixes.length) fixes.push({ level: 'good', text: 'No problems found. This capture is ready for your splat pipeline.' });

  return { score, grade, verdict, parts, fixes, target, area, vstats, sphere, voxels, segments };
}

function hasFlag(f, flag) {
  return f.flags && f.flags.includes(flag);
}
