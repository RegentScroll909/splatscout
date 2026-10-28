// Keeps the AR camera lined up with the scan.
//
//  * Every frame's pose is moved into the scan's coordinates by `xf` (a turn about the vertical axis
//    plus a shift). It's the identity until something goes wrong.
//  * After tracking was lost, after an impossible jump in the pose, or when the AR reference space
//    resets, photos pause while the next second of depth is checked against the map. If it still
//    fits, capture carries on; if not, the scan is searched for where the phone really is.
//  * While capturing, recent depth is compared with older parts of the map every few seconds, so
//    slow drift is corrected before it smears the coverage map.
//  * A new AR session (resuming a capture) starts by searching the whole scan.
//  * Along a plain hallway depth can't tell one stretch from the next: the camera image is compared
//    with the photos taken there earlier (photomatch.js), which can.

import {
  XF_ID, xf as makeXf, xfPoints, xfInverse, xfPose, xfApply, xfApplyDir, xfDelta, xfBlend, xfFromPoses, xfIsIdentity,
  FloorPlan, solveAlignment, checkAlignment, icp, poolLive, poseHeading, photoScore, slideSearch,
} from '../core/align.js';
import { DEG, v3, posePosition, rotationDelta } from '../core/math.js';

const SEARCH_INTERVAL = 0.8; // s between solves while searching
const DRIFT_INTERVAL = 2.5; // s between drift checks
const OLD_MAP = 6; // s: drift is checked against map parts at least this old
const MIN_MAP = 150; // solid voxels: below this there's nothing worth protecting

export class Relocalizer {
  /** @param {import('./session.js').CaptureSession} session */
  constructor(session) {
    this.s = session;
    this.xf = { yaw: 0, t: [0, 0, 0] };
    this.mode = null; // null | 'check' (holding photos while verifying) | 'search'
    this.state = null; // search state for the UI
    this.recent = []; // latest depth frames (live coordinates) for drift checks
    this.images = []; // camera images since the check or search started (live coordinates)
    this.clock = []; // [t, voxel frame id] at each map update
    this.lossT = 0;
    this.prevRaw = null;
    this.lastGood = null; // last aligned pose while everything was fine
    this.lastDrift = 0;
    this.misses = 0;
    this.log = []; // corrections, for the capture record
  }

  get active() {
    return this.mode !== null;
  }

  /** Photos and map updates wait while this is true. */
  get holding() {
    return this.mode !== null;
  }

  /**
   * Called first thing per frame (6DoF sources). Moves the pose in place into scan coordinates, so
   * everything that shares the pose array (screen projection, depth points, overlay) follows.
   */
  apply(fi) {
    if (!fi.pose) return null;
    const raw = fi.pose.slice();
    if (!xfIsIdentity(this.xf)) {
      fi.pose.set(xfPose(this.xf, raw));
      if (fi.hit) fi.hit = { p: xfApply(this.xf, fi.hit.p), n: xfApplyDir(this.xf, fi.hit.n) };
    }
    return raw;
  }

  /** Per frame, after apply(). Watches for lost tracking and jumps. */
  frame(fi, raw, t, dt) {
    const s = this.s;
    const ok = fi.trackState === 'ok' && raw;
    if (!ok) {
      if (!this.lossT) this.lossT = t;
      this.prevRaw = null;
      return;
    }
    let reason = null;
    if (this.lossT && t - this.lossT > 0.6) reason = 'lost';
    this.lossT = 0;
    if (fi.reset) reason = 'reset';
    if (this.prevRaw && dt > 0) {
      const moved = v3.dist(posePosition(this.prevRaw), posePosition(raw));
      const turned = rotationDelta(this.prevRaw, raw) / DEG;
      if (moved > Math.max(0.3, 3 * dt) || turned > Math.max(20, 600 * dt)) reason = reason || 'jump';
    }
    this.prevRaw = raw;
    if (reason && !this.mode && this._mapSize() >= MIN_MAP) this._startCheck(reason, raw, t);
    if (!this.mode) this.lastGood = fi.pose.slice();
  }

  /** A depth grid was sampled (points in scan coordinates under the current xf). */
  addDepth(g, raw, intr, t) {
    if (!g || !g.xyz.length || !raw) return;
    const f = { pts: xfPoints(xfInverse(this.xf), g.xyz), pose: raw, intr, d: g.d, nx: g.nx, ny: g.ny, t };
    this.recent.push(f);
    if (this.recent.length > 8) this.recent.shift();
    const st = this.state;
    if (this.mode && st) {
      const last = st.frames[st.frames.length - 1];
      const moved = !last || v3.dist(posePosition(last.pose), posePosition(raw)) > 0.03 || rotationDelta(last.pose, raw) > 4 * DEG;
      if (moved) st.frames.push(f);
      else st.frames[st.frames.length - 1] = f;
      if (st.frames.length > 30) st.frames.shift();
    }
  }

  /** A camera image (photomatch.liveImage) while checking or searching. */
  addImage(img) {
    if (!this.mode || !img.raw) return;
    const last = this.images[this.images.length - 1];
    const moved = !last || v3.dist(posePosition(last.raw), posePosition(img.raw)) > 0.05 || rotationDelta(last.raw, img.raw) > 6 * DEG;
    if (moved) this.images.push(img);
    else this.images[this.images.length - 1] = img;
    if (this.images.length > 3) this.images.shift();
  }

  /** Earlier photos of this map and the latest camera images, or null without enough of either. */
  _photo() {
    const keys = this.s.photoKeys ? this.s.photoKeys.filter((k) => k.space === this.s.space) : [];
    return keys.length >= 3 && this.images.length ? { keys, imgs: this.images.slice() } : null;
  }

  /** The map was updated (for telling old map parts from new ones). */
  mapUpdated(t) {
    this.clock.push([t, this.s.voxels.frameId]);
    while (this.clock.length > 2 && this.clock[1][0] < t - OLD_MAP - 2) this.clock.shift();
  }

  /** Per frame: run checks and solves when they're due. Returns an event or null. */
  tick(t) {
    if (this.mode === 'check') return this._tickCheck(t);
    if (this.mode === 'search') return this._tickSearch(t);
    if (t - this.lastDrift > DRIFT_INTERVAL && this.s.recording && !this.s.paused) {
      this.lastDrift = t;
      return this._driftCheck(t);
    }
    return null;
  }

  _mapSize() {
    const st = this.s.voxels.stats();
    return st.solid + st.outside;
  }

  _scanFloor() {
    const b = this.s.bounds;
    if (b && b.poly) return b.floorY;
    return this.s.voxels.floorY();
  }

  // ---------------------------------------------------------------- after a loss or jump
  _startCheck(reason, raw, t) {
    this.mode = 'check';
    this.images = [];
    this.state = {
      reason, t0: t, frames: [], status: 'checking', confidence: 0, raw0: raw,
      // ARCore kept its coordinates (the alignment still holds), or it moved them while the phone
      // stayed put (the alignment that carries on from the last good pose).
      kept: { ...this.xf, t: this.xf.t.slice() },
      stayed: this.lastGood ? xfFromPoses(this.lastGood, raw) : null,
      priors: [
        { xf: { ...this.xf, t: this.xf.t.slice() }, radius: 1.5, yawRange: 30 },
        ...(this.lastGood ? [{ xf: xfFromPoses(this.lastGood, raw), radius: 2, yawRange: 40 }] : []),
      ],
    };
  }

  _tickCheck(t) {
    const st = this.state;
    if (st.frames.length < 4) {
      if (t - st.t0 > 6) return this._startSearch(st.reason, st.priors, t);
      return null;
    }
    if (st.lastTry && t - st.lastTry < 0.5) return null;
    st.lastTry = t;
    const frames = st.frames.slice(-8);
    const at = posePosition(frames[frames.length - 1].pose);
    const hyps = [st.kept];
    if (st.stayed && xfDelta(st.stayed, st.kept, at).dist > 0.1) hyps.push(st.stayed);
    if (st.reason === 'reset') hyps.reverse(); // a reset moves the coordinates for sure
    const photo = this._photo();
    const fits = [];
    for (const h of hyps) {
      // ICP held near the guess: along a plain hallway the walls fit anywhere, so depth alone mustn't move it.
      const r = checkAlignment(this.s.voxels, frames, h, null, h);
      if (!r.enough) continue;
      const fit = { r, kept: h === st.kept, ok: r.inlierFrac >= 0.6 && r.through <= 0.12 && r.delta.dist < 0.3 && r.delta.yaw < 3, x: r.xf, ph: null };
      if (fit.ok && photo) {
        fit.ph = photoScore(photo, fit.x, 2);
        if (r.weakDir) {
          // Depth can't check the position along the hallway: the photos look a couple of metres either way.
          const sl = slideSearch(photo, fit.x, r.weakDir, [-2, 2], { lift: r.weakHeight ? 0.2 : 0 });
          if (sl && sl.score >= 0.6 && sl.score - sl.second >= 0.15) {
            fit.x = sl.xf;
            fit.ph = sl.score;
            fit.placed = true;
            fit.slid = Math.abs(sl.s);
          }
        }
      }
      fits.push(fit);
    }
    const good = fits.filter((f) => f.ok);
    if (!good.length) {
      // Nothing fits: the live depth sees through mapped walls or lands off them. Search properly.
      if (fits.length && fits.every((f) => f.r.through0 > 0.2 || f.r.inlierFrac < 0.4)) return this._startSearch(st.reason, st.priors, t);
      if (t - st.t0 > 6) return this._startSearch(st.reason, st.priors, t);
      return null;
    }
    // Both fit (a hallway): when the photos clearly prefer the other one, the coordinates did move.
    let pick = good[0];
    const rated = good.filter((g) => g.ph != null);
    if (rated.length === good.length && good.length > 1) {
      const b = rated.reduce((a, c) => (c.ph > a.ph ? c : a));
      if (rated.every((g) => g === b || b.ph - g.ph >= 0.12)) pick = b;
    }
    // Only carry straight on when nothing moved: ARCore kept its coordinates and the view still fits
    // where it was, confirmed by the photos (along a hallway, the photo match peaks right there).
    // Anything that needs a correction gets the full search: a few seconds longer, but it compares far
    // more of the view, while over a narrow view a turn and a slide can pass for each other.
    const still = pick.kept && pick.r.delta.dist < 0.05 && pick.r.delta.yaw < 1;
    const sure = still && (!photo
      ? !good.some((g) => g !== pick && xfDelta(g.x, pick.x, at).dist > 0.15)
      : pick.r.weakDir ? pick.placed && pick.slid < 0.06 : pick.ph == null || pick.ph >= 0.5);
    if (!sure) return this._startSearch(st.reason, st.priors, t);
    const cm = Math.round(xfDelta(pick.x, st.kept, at).dist * 100);
    this.xf = pick.x;
    this._end();
    this.log.push({ t, kind: st.reason, cm, photo: pick.ph == null ? null : +pick.ph.toFixed(2), placed: !!pick.placed, weak: pick.r.weak, kept: pick.kept });
    return cm <= 15 ? { type: 'trackingBack', reason: st.reason } : { type: 'corrected', cm };
  }

  // ---------------------------------------------------------------- slow drift
  _driftCheck(t) {
    const vm = this.s.voxels;
    if (this.recent.length < 4 || this._mapSize() < 300) return null;
    // Only map parts older than a few seconds: the latest depth is already in the map.
    let cutoff = 0;
    for (const [ct, id] of this.clock) if (ct <= t - OLD_MAP) cutoff = id;
    if (!cutoff) return null;
    const frames = this.recent.slice(-4);
    const r = checkAlignment(vm, frames, this.xf, (v) => v.c <= cutoff);
    if (!r.enough) return null;
    if (r.through0 > 0.3) {
      // Badly off. Fix it outright when ICP finds a clean fit nearby, otherwise search.
      if (r.through <= 0.1 && r.inlierFrac >= 0.6 && r.delta.dist < 0.6 && !r.weak) {
        this.xf = r.xf;
        this.misses = 0;
        this.log.push({ t, kind: 'jump', cm: Math.round(r.delta.dist * 100) });
        return { type: 'corrected', cm: Math.round(r.delta.dist * 100) };
      }
      if (++this.misses >= 2) {
        this.misses = 0;
        const raw = frames[frames.length - 1].pose;
        return this._startSearch('drift', [{ xf: { ...this.xf, t: this.xf.t.slice() }, radius: 1.5, yawRange: 25 }], t, raw);
      }
      return null;
    }
    this.misses = 0;
    // A clear offset, measured the same way twice in a row: take it out. Matching against the map
    // is only good to about 3-4 cm, so smaller offsets are left alone (photo positions are refined
    // on the PC anyway).
    const d = r.delta;
    const real = (d.dist > 0.08 || d.yaw > 2) && d.dist < 0.3 && d.yaw < 6 && r.inlierFrac >= 0.6 && !r.weak;
    const prev = this.pendingDrift;
    this.pendingDrift = real ? r.xf : null;
    if (real && prev) {
      const agree = xfDelta(prev, r.xf, posePosition(frames[frames.length - 1].pose));
      if (agree.dist < 0.03 && agree.yaw < 0.8) {
        this.xf = xfBlend(this.xf, r.xf, 0.8);
        this.pendingDrift = null;
        this.log.push({ t, kind: 'drift', cm: Math.round(d.dist * 100) });
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- search
  /** Look for where the phone is in the scan. */
  begin(reason, t, { priors = [], global = true } = {}) {
    this.images = [];
    return this._startSearch(reason, priors, t, null, global);
  }

  _startSearch(reason, priors, t, _raw, global = true) {
    const prev = this.state;
    this.mode = 'search';
    this.state = {
      reason, t0: t, frames: prev && prev.frames ? prev.frames.slice(-12) : [], status: 'more', confidence: 0,
      priors: priors || [], global, plan: null, planVer: -1, lastSolve: 0, lastOk: null, preview: null, metrics: null,
    };
    return { type: 'searching', reason };
  }

  _tickSearch(t) {
    const st = this.state;
    if (!st.t0) st.t0 = t;
    if (st.frames.length < 5 || t - st.lastSolve < SEARCH_INTERVAL) return null;
    st.lastSolve = t;
    const vm = this.s.voxels;
    if (!st.plan || st.planVer !== vm.version) {
      st.plan = new FloorPlan(vm, this._scanFloor());
      st.planVer = vm.version;
    }
    const r = solveAlignment(vm, st.frames, { plan: st.plan, floorY: this._scanFloor(), priors: st.priors, global: st.global, photo: this._photo() });
    st.status = r.status;
    st.confidence = r.confidence;
    st.metrics = r.metrics;
    // Show the best guess while it's plausible, so the dots can be seen settling onto the walls.
    if (r.xf && r.confidence >= 0.3 && !st.manual) {
      st.preview = r.xf;
      this.xf = r.xf;
    }
    if (!r.ok) {
      st.lastOk = null;
      return null;
    }
    // Lock when two solves in a row agree.
    if (st.lastOk) {
      const d = xfDelta(st.lastOk, r.xf, this._liveCentre(st));
      if (d.dist < 0.08 && d.yaw < 2) return this._lock(r.xf, t, r.metrics);
    }
    st.lastOk = r.xf;
    return null;
  }

  _liveCentre(st) {
    const f = st.frames[st.frames.length - 1];
    return f ? posePosition(f.pose) : [0, 0, 0];
  }

  _lock(x, t, metrics) {
    const reason = this.state ? this.state.reason : 'manual';
    this.xf = x;
    const m = metrics || {};
    this.log.push({ t, kind: 'realigned', reason, rms: m.rms != null ? m.rms : null, photo: m.photo, peak: m.photoPeak, weak: m.weak, hint: !!(this.state && this.state.mapHint) });
    this._end();
    return { type: 'realigned', reason, rms: metrics ? metrics.rms : null };
  }

  _end() {
    this.mode = null;
    this.state = null;
    this.prevRaw = null;
    this.lastDrift = this.s.lastT;
  }

  /** "I'm standing where this photo was taken, facing the same way": a strong guess. */
  hintPhoto(photoPose, raw) {
    if (!this.state || !raw) return;
    this.state.priors = [{ xf: xfFromPoses(photoPose, raw), radius: 1.2, yawRange: 30 }, ...this.state.priors.slice(0, 2)];
    this.state.lastSolve = 0;
  }

  /**
   * "I'm standing here" (tapped on the map), optionally "facing this way": the search then looks
   * only around there, and the scan is shown at that spot until it locks.
   * @param {number[]} p [x, z] in scan coordinates
   * @param {number|null} heading poseHeading-style angle, or null when not given
   */
  hintMap(p, heading, raw) {
    const st = this.state;
    if (!st || !raw) return;
    const base = st.preview || this.xf;
    const h = heading != null ? heading : poseHeading(xfPose(base, raw));
    const yaw = wrapAngle(h - poseHeading(raw));
    const r = xfApplyDir({ yaw }, [raw[12], 0, raw[14]]);
    const x = { yaw, t: [p[0] - r[0], base.t[1], p[1] - r[2]] };
    // Without a heading the live points could lie any way round the spot: a wider window.
    st.priors = [{ xf: x, radius: heading != null ? 1.0 : 3.0, yawRange: heading != null ? 35 : 180 }];
    st.global = false;
    st.mapHint = { p, heading };
    st.preview = x;
    st.lastSolve = 0;
    st.lastOk = null;
    this.xf = x;
  }

  /** Manual adjustment while searching: slide (metres, relative to where the phone faces) and turn. */
  nudge(right, forward, turnDeg, rawPose) {
    const st = this.state;
    if (!st || !rawPose) return;
    st.manual = true;
    const base = st.preview || this.xf;
    const pose = xfPose(base, rawPose);
    const h = poseHeading(pose);
    const fx = Math.sin(h), fz = Math.cos(h);
    // Turning happens about the phone, so what's in front stays in front.
    const turned = turnDeg ? rotateAbout(base, turnDeg * DEG, posePosition(pose)) : base;
    // The phone's right on the floor is (-fz, fx).
    const t = turned.t.slice();
    t[0] += fx * forward - fz * right;
    t[2] += fz * forward + fx * right;
    st.preview = { yaw: turned.yaw, t };
    this.xf = st.preview;
  }

  /** Accept the current (manual or automatic) alignment, polished by ICP when that helps. */
  acceptPreview(t) {
    const st = this.state;
    if (!st) return null;
    const base = st.preview || this.xf;
    let x = base;
    // The depth seen while searching, or (phone held still) the latest few depth frames.
    const frames = st.frames.length >= 3 ? st.frames : this.recent;
    if (frames.length >= 3) {
      const live = poolLive(frames);
      // Held near the shown position where the surfaces leave it open (along a hallway).
      const fit = icp(this.s.voxels, live.pts, base, { iters: 8, maxDist: 0.3, minDist: 0.08, prior: base });
      if (fit.inlierFrac >= 0.5 && xfDelta(fit.xf, base, posePosition(frames[frames.length - 1].pose)).dist < 0.4) x = fit.xf;
    }
    return this._lock(x, t, null);
  }

  /** Give up on lining up: carry on in this session's own coordinates (a new map). */
  abandon() {
    this.xf = { yaw: 0, t: [0, 0, 0] };
    this._end();
  }

  /** Coordinates of the current alignment for the record. */
  toJSON() {
    return { yaw: +this.xf.yaw.toFixed(5), t: this.xf.t.map((v) => +v.toFixed(4)) };
  }
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function rotateAbout(x, ang, p) {
  // Turn the whole scan frame by `ang` about the vertical line through p (scan coordinates).
  const r = xfApplyDir({ yaw: ang }, [x.t[0] - p[0], 0, x.t[2] - p[2]]);
  return { yaw: Math.atan2(Math.sin(x.yaw + ang), Math.cos(x.yaw + ang)), t: [r[0] + p[0], x.t[1], r[2] + p[2]] };
}

export { XF_ID, makeXf };
