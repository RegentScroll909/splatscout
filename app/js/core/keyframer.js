// Keyframe selection: decides WHEN a new photo is needed (novelty) and WHICH frame to keep
// (the sharpest steady frame inside a short search window).

import { DEG, clamp, poseForward, posePosition, angleBetween, v3 } from './math.js';

export const STRICTNESS = {
  relaxed: { overlap: 1.25, minRelSharp: 0.5, window: 0.9 },
  standard: { overlap: 1.0, minRelSharp: 0.6, window: 0.7 },
  strict: { overlap: 0.8, minRelSharp: 0.72, window: 0.6 },
};

export class Keyframer {
  /**
   * @param {object} o
   * @param {number} o.hfovDeg horizontal field of view of the capture camera
   * @param {'6dof'|'3dof'} o.tracking
   * @param {keyof STRICTNESS} [o.strictness]
   */
  constructor({ hfovDeg = 65, tracking = '6dof', strictness = 'standard' } = {}) {
    this.tracking = tracking;
    this.cfg = STRICTNESS[strictness] || STRICTNESS.standard;
    this.setFov(hfovDeg);
    this.reset();
  }

  setFov(hfovDeg) {
    // ~12% of the field of view per keyframe keeps ~85% overlap between neighbours.
    this.rotTrigger = clamp(0.12 * hfovDeg, 6, 14) * this.cfg.overlap;
  }

  reset() {
    this.last = null; // {t, fwd, pos, odo}
    this.disp = 0; // accumulated image displacement since last keyframe (frame widths, camera mode)
    this.seeking = false;
    this.seekStart = 0;
    this.best = null;
  }

  /** Accumulate image motion between analysis ticks (camera mode). */
  addDisplacement(widths) {
    this.disp += widths;
  }

  /**
   * How "new" the current view is compared with the last keyframe. >= 1 means a keyframe is due.
   * @param s {t, pose, odo, depthMed}
   */
  novelty(s) {
    if (!this.last) return 10;
    const fwd = poseForward(s.pose);
    const rot = angleBetween(fwd, this.last.fwd) / DEG / this.rotTrigger;
    let trans = 0;
    if (this.tracking === '6dof' && this.last.pos) {
      const depth = s.depthMed > 0 ? s.depthMed : 2.5;
      const trig = clamp(0.08 * depth, 0.1, 0.45) * this.cfg.overlap;
      trans = v3.dist(posePosition(s.pose), this.last.pos) / trig;
    } else {
      trans = Math.max(this.disp / (0.12 * this.cfg.overlap), Math.abs(s.odo - this.last.odo) / (0.09 * this.cfg.overlap));
    }
    let n = Math.max(rot, trans);
    // Don't let a slowly drifting user go too long without a photo.
    if (s.t - this.last.t > 3.5 && n > 0.35) n = Math.max(n, 1);
    return n;
  }

  /**
   * Feed one evaluated candidate frame while a keyframe is due.
   * @param c {t, relSharp, blurRisk (0..1), ok (exposure/texture acceptable), novelty, data}
   * @returns {null | {commit: candidate, rushed: boolean}} when a frame should be committed now.
   */
  offer(c) {
    // The user turned back towards the last photo: nothing new to capture after all.
    if (c.novelty < 0.6 && !c.manual) {
      if (c.data && c.data.release) c.data.release();
      this.cancel();
      return null;
    }
    if (!this.seeking) {
      this.seeking = true;
      this.seekStart = c.t;
      this.best = null;
    }
    const q = quality(c);
    if (c.ok && (!this.best || q > this.best.q)) {
      if (this.best && this.best.data && this.best.data.release) this.best.data.release();
      this.best = { ...c, q };
    } else if (c.data && c.data.release) {
      c.data.release();
    }
    const waited = c.t - this.seekStart;
    const b = this.best;
    if (!b) return null;
    // "Acceptable": sharp relative to recent frames, or taken while the camera was nearly still
    // (then a low score just means a plain surface, not blur).
    const good = b.relSharp >= this.cfg.minRelSharp || b.blurRisk < 0.15;
    // Searching starts a little before a photo is due (novelty ~0.75), so the chosen frame lands
    // close to the intended spacing.
    if (c.novelty >= 0.9 && b.relSharp >= 0.9 && b.blurRisk < 0.35) return this._take(false);
    if (c.novelty >= 1 && waited >= this.cfg.window && good) return this._take(false);
    // The user is moving on: take the best we have so overlap has no hole. "Rushed" = it isn't sharp.
    if (c.novelty >= 1.8 || waited > 2.5) return this._take(!good);
    return null;
  }

  _take(rushed) {
    const commit = this.best;
    this.seeking = false;
    this.best = null;
    return { commit, rushed };
  }

  /** Abort a pending search (e.g. capture paused). */
  cancel() {
    if (this.best && this.best.data && this.best.data.release) this.best.data.release();
    this.seeking = false;
    this.best = null;
  }

  /** Mark a keyframe as captured at state s. */
  committed(s) {
    this.last = {
      t: s.t,
      fwd: poseForward(s.pose),
      pos: this.tracking === '6dof' ? posePosition(s.pose) : null,
      odo: s.odo || 0,
    };
    this.disp = 0;
  }
}

function quality(c) {
  return c.relSharp - 0.5 * c.blurRisk;
}
