// Motion analysis: speed, "turning in place" detection, and (for orientation-only tracking)
// separating image motion caused by rotation from motion caused by moving (parallax).

import { DEG, clamp } from './math.js';

/**
 * Sliding window over recent motion: how much the view rotated vs how much the camera moved.
 * `trans` is metres in AR mode or the parallax odometer (frame widths) in camera mode.
 */
export class MotionWindow {
  constructor(seconds = 3) {
    this.seconds = seconds;
    this.samples = [];
  }
  push(t, rotDeg, trans) {
    this.samples.push({ t, rotDeg, trans });
    while (this.samples.length && t - this.samples[0].t > this.seconds) this.samples.shift();
  }
  totals() {
    let rot = 0, trans = 0;
    for (const s of this.samples) {
      rot += s.rotDeg;
      trans += s.trans;
    }
    return { rot, trans };
  }
  /** True when the user has been turning a lot without moving. */
  rotatingInPlace(sixdof) {
    const { rot, trans } = this.totals();
    return sixdof ? rot > 25 && trans < 0.12 : rot > 25 && trans < 0.05;
  }
}

/**
 * Orientation-only (camera mode) parallax estimator.
 * Gyro rotation predicts how the image should move; whatever image motion is left over
 * (plus zoom and non-rigid flow) must come from the camera physically moving.
 */
export class Parallax3DoF {
  constructor(flowWidth, hfovDeg) {
    this.w = flowWidth;
    this.f = this.w / 2 / Math.tan((hfovDeg * DEG) / 2);
    this.gain = 1; // learned correction of the focal length estimate
    this.odo = 0;
  }

  /**
   * @param flow FlowTracker result (pixels at flow scale) for the interval
   * @param omega angular velocity in the camera frame (rad/s) [x right, y up, z back]
   * @param dt seconds
   */
  update(flow, omega, dt) {
    if (!flow || dt <= 0) return { flowSpeed: 0, transRate: 0, transWidths: 0 };
    const px = this.f * this.gain * omega[1] * dt;
    const py = this.f * this.gain * omega[0] * dt;
    const pmag2 = px * px + py * py;
    // Learn the gain during clear rotations with a rigid-looking image motion.
    if (pmag2 > 4 && flow.resid < 1.2 && Math.abs(flow.scale - 1) < 0.02) {
      const r = (flow.tx * px + flow.ty * py) / pmag2;
      if (r > 0.5 && r < 1.8) this.gain = clamp(this.gain * (0.9 + 0.1 * r), 0.6, 1.6);
    }
    const ex = flow.tx - px, ey = flow.ty - py;
    const residualPx = Math.hypot(ex, ey) + Math.abs(flow.scale - 1) * (this.w / 2) + 0.5 * flow.resid;
    // Ignore sub-pixel noise.
    const transWidths = Math.max(0, residualPx - 0.6) / this.w;
    this.odo += transWidths;
    return {
      flowSpeed: Math.hypot(flow.tx, flow.ty) / this.w / dt,
      transRate: transWidths / dt,
      transWidths,
    };
  }
}

/**
 * Expected motion blur risk (0..1) from rotation and translation speed: the image motion in pixels
 * during a typical indoor exposure (~1/60 s), measured at a 1920 px long side (the resolution splats
 * are trained at). ~1.5 px is invisible, ~8 px is clearly smeared. Using the camera's real focal
 * length matters: the Pixel's AR camera is only ~35° wide in portrait, so a frame-width measure would
 * call gentle motion blurry.
 * @param {number} rotSpeedDeg rotation speed (°/s)
 * @param {number|null} linSpeed translation speed (m/s), null when unknown
 * @param {number} depthM distance to the surfaces (m)
 * @param {{fx:number, w:number, h:number}} [intr] camera intrinsics
 */
export function blurRisk(rotSpeedDeg, linSpeed, depthM, intr) {
  const f = intr && intr.fx ? (intr.fx * 1920) / Math.max(intr.w, intr.h) : 1500;
  const ang = rotSpeedDeg * DEG + (linSpeed != null && depthM > 0 ? linSpeed / depthM : 0);
  const px = (ang * f) / 60;
  return clamp((px - 1.5) / 6.5, 0, 1);
}
