// The capture engine: consumes frames from a source (AR, camera or practice), analyses quality,
// tracks coverage, picks sharp keyframes, guides and coaches the user, and saves photos.

import { analyzeImage, downsample2, FlowTracker, SharpnessReference } from '../core/analyzer.js';
import { DirectionSphere, VoxelMap } from '../core/coverage.js';
import { Keyframer } from '../core/keyframer.js';
import { Coach } from '../core/coach.js';
import { MotionWindow, Parallax3DoF, blurRisk } from '../core/motion.js';
import { heightHint } from '../core/plans.js';
import { Bounds, polyArea, polyCentroid } from '../core/bounds.js';
import { Guide } from '../core/guide.js';
import { boundsGeometry, chevronTrail, standMarker, ghostPhone, cursorGeometry } from './guideDraw.js';
import { crc32 } from '../core/zip.js';
import {
  DEG, v3, angularVelocity, dirToAzEl, fovFromIntrinsics, posePosition, poseForward, rotationDelta, clamp, transformDir, percentile,
} from '../core/math.js';
import * as store from '../data/store.js';
import { uid } from '../data/store.js';

const ANALYSIS_INTERVAL = 0.1; // s
const DEPTH_SEEN_INTERVAL = 0.25; // s
const GUIDE_INTERVAL = 0.5; // s
const AREA_DONE = 0.85; // weighted surface coverage that counts as a complete scan area

export class CaptureSession {
  /**
   * @param {object} o
   * @param {object} o.capture capture record (from the store)
   * @param {object} o.template capture plan template
   * @param {object} o.source capture source (XRSource | CameraSource | DemoSource)
   * @param {object} o.settings user settings
   * @param {Array} o.existingFrames frames already saved for this capture
   * @param {function} [o.speak] voice output
   * @param {function} [o.onKeyframe] (meta, thumbBlob) per saved photo
   */
  constructor({ capture, template, source, settings, existingFrames = [], speak, onKeyframe, onSourceEnd }) {
    this.capture = capture;
    this.template = template;
    this.source = source;
    this.settings = settings;
    this.tracking = source.tracking;
    this.sixdof = source.tracking === '6dof';
    this.onKeyframe = onKeyframe;
    this.onSourceEnd = onSourceEnd;

    this.frames = existingFrames.map(stripBlobs);
    this.seq = this.frames.reduce((m, f) => Math.max(m, f.seq), 0);
    this.segment = (capture.segments || 0) + 1;
    this.passIndex = 0;

    this.sphere = new DirectionSphere();
    this.passSpheres = new Map();
    this.voxels = new VoxelMap(template.voxel, template.maxObsDist);
    this.keyframer = new Keyframer({ tracking: this.tracking, strictness: settings.strictness });
    this.coach = new Coach({ strictness: settings.strictness, speak: settings.voice ? speak : null });
    this.flow = new FlowTracker();
    this.sharpRef = new SharpnessReference();
    this.motionWin = new MotionWindow(3);
    this.par3 = null;

    // Scan area. A new AR session has its own coordinates, so an earlier area only carries over in
    // the practice room (its coordinates never change).
    this.bounds = null;
    if (this.sixdof && capture.bounds && (capture.bounds.segment === this.segment || String(capture.engine).startsWith('demo'))) {
      this.bounds = Bounds.from({ ...capture.bounds, segment: this.segment });
      if (this.bounds) this.voxels.setBounds(this.bounds);
    }
    this.guide = this.sixdof ? new Guide({ template, bounds: this.bounds, voxels: this.voxels }) : null;
    this.guidePending = true;
    this.boundsDraft = null; // {corners: [[x, z], ...]} while the user marks the scan area
    this.boundsCursor = null;
    this.floorHits = [];
    this.events = []; // {type, ...} for the UI: pass complete, next pass, area complete
    this.passCompleteAt = 0;
    this.areaDone = false;

    this.recording = false;
    this.paused = false;
    this.manualPending = false;
    this.analysisPending = false;
    this.candidatePending = false;
    this.saveChain = Promise.resolve();
    this.saving = 0;

    this.t0 = 0;
    this.lastT = 0;
    this.prevPose = null;
    this.lastPose = null;
    this.displayIntr = null;
    this.lastHit = null;
    this.rotSpeed = 0;
    this.linSpeed = this.sixdof ? 0 : null;
    this.lastAnalysis = null;
    this.lastDepthSeen = 0;
    this.lastGuide = 0;
    this.lastOverlay = 0;
    this.lastMed = 0;
    this.depthMed = 0;
    this.floorY = null;
    this.startY = null;
    this.orientation = null;
    this.orientationChanged = false;
    this.expJumps = [];
    this.gapUntil = 0;
    this.lensUntil = 0;
    this.prevMean = null;
    this.target = null; // {point | dir, title, detail, kind}
    this.stats = {
      activeSec: (capture.stats && capture.stats.activeSec) || 0,
      lostSec: (capture.stats && capture.stats.lostSec) || 0,
      gaps: (capture.stats && capture.stats.gaps) || 0,
      exposureJumps: (capture.stats && capture.stats.exposureJumps) || 0,
      warnings: {},
    };
    this.baseWarnings = { ...((capture.stats && capture.stats.warnings) || {}) };
    this.live = {
      t: 0, trackState: 'n/a', chips: {}, primary: null, passProgress: 0, coverage: 0, guide: null,
      targetScreen: null, height: null, camRes: '', depth: false, frames: this.frames.length,
    };
  }

  get pass() {
    return this.template.passes[this.passIndex];
  }

  async start() {
    this.capture.segments = this.segment;
    await this.source.start({
      onFrame: (fi) => this._onFrame(fi),
      onEnd: () => {
        this.recording = false;
        if (this.onSourceEnd) this.onSourceEnd();
      },
    });
    this.live.depth = !!this.source.info.depth;
    this.recording = true;
    this.paused = false;
    this._boundsDirty = true;
  }

  pause() {
    this.paused = true;
    this.keyframer.cancel();
  }

  resume() {
    this.paused = false;
    this.flow.reset();
  }

  setPass(i) {
    this.passIndex = clamp(i, 0, this.template.passes.length - 1);
    this._resetPassGuide();
  }

  nextPass() {
    if (this.passIndex < this.template.passes.length - 1) {
      this.passIndex++;
      this._resetPassGuide();
    }
  }

  _resetPassGuide() {
    this.guidePending = true;
    this.passCompleteAt = 0;
    this.lastGuide = 0;
  }

  shoot() {
    this.manualPending = true;
  }

  async stop() {
    this.recording = false;
    this.keyframer.cancel();
    try {
      this.source.stop();
    } catch {}
    await this.saveChain;
    await this.saveCaptureRecord();
  }

  async saveCaptureRecord() {
    this.stats.warnings = mergeCounts(this.baseWarnings, this.coach.counts);
    this.capture.frameCount = this.frames.length;
    this.capture.stats = { ...this.stats };
    this.capture.device = {
      ua: navigator.userAgent,
      camera: this.source.info.label,
      camW: this.source.info.camW,
      camH: this.source.info.camH,
      depth: !!this.source.info.depth,
    };
    await store.putCapture(this.capture);
  }

  // ------------------------------------------------------------------ scan area

  /** Start marking the scan area. Photos pause until it's done or skipped. */
  beginBounds() {
    this.boundsDraft = { corners: [] };
    this.pause();
  }

  /** The floor point under a screen point (CSS pixels), or null. */
  floorPoint(sx, sy) {
    const pose = this.lastPose, di = this.displayIntr;
    if (!pose || !di) return null;
    const fy = this.floorHeight();
    const d = v3.norm(transformDir(pose, [(sx - di.cx) / di.fx, -(sy - di.cy) / di.fy, -1]));
    const o = posePosition(pose);
    if (d[1] > -0.03) return null;
    const t = (fy - o[1]) / d[1];
    if (!(t > 0.2 && t < 20)) return null;
    return [o[0] + d[0] * t, fy, o[2] + d[2] * t];
  }

  /** True once there's evidence where the floor is (AR floor hits, mapped floor, or a scan area). */
  floorKnown() {
    return !!(this.bounds && this.bounds.poly) || this.floorHits.length >= 3 || this.voxels.floorY() != null;
  }

  /** The floor point under the centre dot (AR hit test when it lands on the floor). */
  centerFloorPoint() {
    const di = this.displayIntr;
    if (!di || !this.floorKnown()) return null;
    const fy = this.floorHeight();
    const h = this.lastHit;
    if (h && Math.abs(h.p[1] - fy) < 0.15) return [h.p[0], fy, h.p[2]];
    return this.floorPoint(di.w / 2, di.h / 2);
  }

  /** The surface under a screen point (from the coverage map), or null. */
  surfacePoint(sx, sy) {
    const pose = this.lastPose, di = this.displayIntr;
    if (!pose || !di) return null;
    const d = v3.norm(transformDir(pose, [(sx - di.cx) / di.fx, -(sy - di.cy) / di.fy, -1]));
    const hit = this.voxels.raycast(posePosition(pose), d, 10, 0.2);
    return hit ? hit.point : null;
  }

  addCorner(p) {
    if (!this.boundsDraft || !p) return false;
    this.boundsDraft.corners.push([p[0], p[2]]);
    return true;
  }

  undoCorner() {
    if (this.boundsDraft) this.boundsDraft.corners.pop();
  }

  draftArea() {
    const c = this.boundsDraft ? this.boundsDraft.corners : [];
    return c.length >= 3 ? Math.abs(polyArea(c)) : 0;
  }

  finishBounds() {
    const c = this.boundsDraft && this.boundsDraft.corners;
    if (!c || c.length < 3) return false;
    const skips = this.bounds ? this.bounds.skips : [];
    this.setBounds(new Bounds({ poly: c, floorY: this.floorHeight(), margin: this.template.boundsMargin || 0.35, skips, segment: this.segment }));
    this.boundsDraft = null;
    this.boundsCursor = null;
    this.resume();
    return true;
  }

  cancelBounds() {
    this.boundsDraft = null;
    this.boundsCursor = null;
    this._boundsDirty = true;
    this.resume();
  }

  setBounds(b) {
    this.bounds = b;
    this.voxels.setBounds(b);
    if (this.guide) this.guide.setBounds(b);
    this.capture.bounds = b ? b.toJSON() : null;
    this._boundsDirty = true;
    this.areaDone = false;
    this._resetPassGuide();
  }

  /** Stop counting the surface around p (windows, mirrors, places you can't reach). */
  skipSpot(p, r = 0.5) {
    if (!p) return false;
    if (!this.bounds) {
      this.bounds = new Bounds({ poly: null, floorY: null, segment: this.segment });
      this.voxels.setBounds(this.bounds);
      if (this.guide) this.guide.bounds = this.bounds;
    }
    this.bounds.addSkip(p, r);
    this.voxels.boundsChanged();
    this.capture.bounds = this.bounds.toJSON();
    if (this.guide) this.guide.gap = null;
    return true;
  }

  undoSkip() {
    if (!this.bounds || !this.bounds.skips.length) return false;
    this.bounds.removeLastSkip();
    this.voxels.boundsChanged();
    this.capture.bounds = this.bounds.toJSON();
    return true;
  }

  /** Skip the spot the guide is currently pointing at. */
  skipGuideSpot() {
    if (this.guide) this.guide.skipGap(this.lastT);
    this.lastGuide = 0;
  }

  /** Best floor height estimate: the scan area's, else AR floor hits, else the coverage map. */
  floorHeight() {
    if (this.bounds && this.bounds.poly) return this.bounds.floorY;
    if (this.floorHits.length >= 3) return percentile(this.floorHits, 0.2);
    const fy = this.voxels.floorY();
    if (fy != null) return fy;
    if (this.startY != null) return this.startY - 1.35;
    return this.lastPose ? this.lastPose[13] - 1.35 : 0;
  }

  /** Where the practice room's autopilot should walk and aim next. */
  autopilotTarget() {
    if (!this.guide || !this.lastPose || this.boundsDraft) return null;
    return this.guide.autopilot(posePosition(this.lastPose));
  }

  // ------------------------------------------------------------------ per frame
  _onFrame(fi) {
    const t = fi.t;
    if (!this.t0) this.t0 = t;
    const dt = this.lastT ? clamp(t - this.lastT, 0, 0.25) : 0;
    this.lastT = t;
    if (this.recording && !this.paused) this.stats.activeSec += dt;
    const L = this.live;
    L.t = t;
    L.trackState = fi.trackState;
    if (fi.intr) L.camRes = `${fi.intr.w}×${fi.intr.h}`;
    if (fi.displayIntr) this.displayIntr = fi.displayIntr;
    this.lastHit = fi.hit || null;

    // Photo spacing when turning follows the real field of view (the Pixel's AR camera is 70° x 35°).
    if (fi.intr && !this.fovSet) {
      const fov = fovFromIntrinsics(fi.intr);
      this.keyframer.setFov((fov.h + fov.v) / 2);
      this.fovSet = true;
    }
    // Orientation lock: portrait/landscape must not change mid-capture.
    if (fi.intr) {
      const portrait = fi.intr.h > fi.intr.w;
      if (this.orientation === null) this.orientation = portrait;
      this.orientationChanged = portrait !== this.orientation;
    }
    if (fi.trackState === 'lost' && this.recording && !this.paused) this.stats.lostSec += dt;
    if (!fi.pose) {
      this.prevPose = null;
      L.primary = { id: 'lost', level: 'bad', title: 'Tracking lost', detail: 'Hold still and aim at a detailed, well-lit area until tracking comes back.' };
      L.targetScreen = null;
      return;
    }
    const pose = fi.pose;
    this.lastPose = pose;
    const pos = posePosition(pose);
    const fwd = poseForward(pose);
    const tracked6 = this.sixdof && fi.trackState === 'ok';

    // Speeds (smoothed).
    if (this.prevPose && dt > 0) {
      const rs = rotationDelta(this.prevPose, pose) / DEG / dt;
      this.rotSpeed += (Math.min(rs, 400) - this.rotSpeed) * 0.25;
      if (this.sixdof) {
        const ls = v3.dist(posePosition(this.prevPose), pos) / dt;
        this.linSpeed += (Math.min(ls, 5) - this.linSpeed) * 0.25;
      }
    }
    this.prevPose = pose;
    if (this.startY === null && tracked6) this.startY = pos[1];

    // Floor: horizontal AR hits well below the phone (the lowest ones, so tabletops don't count).
    if (fi.hit && fi.hit.n && fi.hit.n[1] > 0.9 && fi.hit.p[1] < pos[1] - 0.5 && fi.hit.p[1] > pos[1] - 2.3) {
      this.floorHits.push(fi.hit.p[1]);
      if (this.floorHits.length > 60) this.floorHits.shift();
    }

    // Depth: median distance, and the coverage map (surfaces seen, empty space carved).
    if (fi.depth && tracked6) {
      if (t - this.lastMed > 0.25) {
        this.lastMed = t;
        this.depthMed = fi.depth.median() || this.depthMed;
      }
      if (t - this.lastDepthSeen > DEPTH_SEEN_INTERVAL && this.recording) {
        this.lastDepthSeen = t;
        const g = fi.depth.grid(24, 18);
        if (g.xyz.length) this.voxels.integrate(g.xyz, pos);
      }
    }

    // Marking the scan area: the floor cursor follows the centre dot.
    if (this.boundsDraft) {
      this.boundsCursor = this.centerFloorPoint();
      this._drawBoundsDraft();
    }

    // Image analysis at ~10 Hz.
    if (fi.requestAnalysis && !this.analysisPending && t - (this.lastAnalysis ? this.lastAnalysis.t : 0) >= ANALYSIS_INTERVAL) {
      this.analysisPending = true;
      const snap = { t, pose: pose.slice(), intr: fi.intr };
      fi.requestAnalysis()
        .then((a) => this._onAnalysis(a, snap))
        .catch((e) => console.warn('analysis', e))
        .finally(() => (this.analysisPending = false));
    }

    // Keyframe selection. Candidates are evaluated whenever a photo is (nearly) due, also while
    // moving: the keyframer keeps the sharpest one instead of waiting for the user to stop.
    const canShoot = this.recording && !this.paused && !this.orientationChanged && fi.requestCandidate &&
      !(this.sixdof && fi.trackState === 'lost');
    // Standing on a gap marker, aimed at the ring: that's the photo the guide asked for.
    const gs = this.live.guide;
    if (canShoot && gs && gs.mode === 'gaps' && gs.next && this.guide.gap === gs.next && !this.keyframer.forced) {
      const at = Math.hypot(gs.next.pos[0] - pos[0], gs.next.pos[2] - pos[2]) < 0.6;
      const aimed = v3.dot(fwd, gs.next.aim) > Math.cos(22 * DEG);
      const last = this.frames.length ? this.frames[this.frames.length - 1] : null;
      const recent = last && last.segment === this.segment && this.t0 + last.t > t - 1;
      if (at && aimed && !recent && this.rotSpeed < 25) this.keyframer.request();
    }
    if (canShoot && !this.candidatePending && this.saving < 4) {
      const kstate = { t, pose, odo: this.par3 ? this.par3.odo : 0, depthMed: this.depthMed };
      const novelty = this.keyframer.novelty(kstate);
      const want = this.manualPending || novelty >= 0.6 || this.keyframer.seeking;
      if (want && t - (this.lastCand || 0) >= 0.12) {
        const risk = blurRisk(this.rotSpeed, this.linSpeed, this.depthMed || 2.5, fi.intr);
        const snap = {
          t, pose: pose.slice(), intr: { ...fi.intr }, novelty, risk, tracked: tracked6,
          rotSpeed: this.rotSpeed, linSpeed: this.linSpeed, depthMed: this.depthMed,
          odo: this.par3 ? this.par3.odo : 0, height: this.live.height,
          depth: fi.depth && tracked6 ? fi.depth.grid(40, 30) : null,
          manual: this.manualPending, pass: this.pass.id,
        };
        this.manualPending = false;
        this.candidatePending = true;
        this.lastCand = t;
        fi.requestCandidate()
          .then((c) => this._onCandidate(c, snap))
          .catch((e) => console.warn('candidate', e))
          .finally(() => (this.candidatePending = false));
      }
      // Nothing usable for a long time while a photo is due: that's an overlap gap.
      if (this.keyframer.seeking && !this.keyframer.best && t - this.keyframer.seekStart > 3) {
        this.keyframer.cancel();
        this.stats.gaps++;
        this.gapUntil = t + 3;
      }
    }

    // Guidance target and overlay data.
    if (t - this.lastGuide > GUIDE_INTERVAL) {
      this.lastGuide = t;
      this._updateGuidance(pos, fwd, tracked6, t);
    }
    if (t - this.lastOverlay > 0.2) {
      this.lastOverlay = t;
      this._updateOverlay(pos, fwd);
    }
    const tp = this.target && (this.target.point || this.target.dir);
    L.targetScreen = tp && fi.toScreen ? fi.toScreen(tp, !this.target.point) : null;
    L.aimOk = !!(this.target && this.target.point && v3.dot(fwd, v3.norm(v3.sub(this.target.point, pos))) > Math.cos(12 * DEG));
    L.walk = this._walkHint(pos, pose);
    L.pose = pose;
  }

  /** Which way to walk to the guide's next point, relative to where the phone faces: {angle (deg, 0 = ahead, 90 = right), dist}. */
  _walkHint(pos, pose) {
    const gs = this.live.guide;
    if (!gs || !gs.next || this.paused || this.boundsDraft) return null;
    let goal = gs.next.pos;
    const S = gs.mode === 'path' && this.guide.stations;
    if (S && gs.distTo < 1.2) goal = S[Math.min(S.length - 1, S.indexOf(gs.next) + 1)].pos;
    const vx = goal[0] - pos[0], vz = goal[2] - pos[2];
    const dist = Math.hypot(vx, vz);
    if (dist < 0.25) return null;
    // Heading = where the phone points, or the top of the screen when it points straight down.
    let f = poseForward(pose);
    if (Math.abs(f[1]) > 0.95) f = [pose[4], 0, pose[6]];
    const l = Math.hypot(f[0], f[2]) || 1;
    const fx = f[0] / l, fz = f[2] / l;
    const angle = Math.atan2(vx * -fz + vz * fx, vx * fx + vz * fz) / DEG;
    return { angle, dist };
  }

  // ------------------------------------------------------------------ analysis tick
  _onAnalysis(a, snap) {
    const A = analyzeImage(a.gray, a.w, a.h);
    const relSharp = this.sharpRef.update(A.sharp, snap.t);
    const q = downsample2(a.gray, a.w, a.h);
    const s = downsample2(q.data, q.w, q.h);
    const flow = this.flow.update(s.data, s.w, s.h);
    const prev = this.lastAnalysis;
    this.lastAnalysis = { t: snap.t, pose: snap.pose };
    const dtA = prev ? snap.t - prev.t : 0;
    const rotDeg = prev ? rotationDelta(prev.pose, snap.pose) / DEG : 0;

    let flowSpeed = 0;
    if (flow && dtA > 0) {
      const disp = (Math.hypot(flow.tx, flow.ty) + Math.abs(flow.scale - 1) * (s.w / 2)) / s.w;
      flowSpeed = Math.hypot(flow.tx, flow.ty) / s.w / dtA;
      if (!this.sixdof) this.keyframer.addDisplacement(disp);
    }
    if (this.sixdof) {
      const trans = prev ? v3.dist(posePosition(prev.pose), posePosition(snap.pose)) : 0;
      this.motionWin.push(snap.t, rotDeg, trans);
    } else if (prev && dtA > 0) {
      if (!this.par3) this.par3 = new Parallax3DoF(s.w, snap.intr ? fovFromIntrinsics(snap.intr).h : 68);
      const omega = angularVelocity(prev.pose, snap.pose, dtA);
      const r = this.par3.update(flow, omega, dtA);
      flowSpeed = r.flowSpeed;
      this.motionWin.push(snap.t, rotDeg, r.transWidths);
      // A sudden zoom without movement = the phone switched lenses.
      if (flow && Math.abs(Math.log(flow.scale)) > 0.18 && this.rotSpeed < 10) this.lensUntil = snap.t + 4;
    }

    // Exposure jumps: big brightness change while the view is steady.
    if (this.prevMean != null && Math.abs(A.mean - this.prevMean) / Math.max(25, this.prevMean) > 0.15 && this.rotSpeed < 6 &&
      (this.linSpeed || 0) < 0.15 && flowSpeed < 0.06) {
      this.expJumps.push(snap.t);
      this.stats.exposureJumps++;
    }
    this.prevMean = A.mean;
    this.expJumps = this.expJumps.filter((x) => snap.t - x < 10);

    // Camera height above the floor (AR).
    let height = null;
    if (this.sixdof) {
      const y = snap.pose[13];
      const fy = this.bounds && this.bounds.poly ? this.bounds.floorY : this.floorY;
      if (fy !== null && y - fy > 0.15 && y - fy < 3) height = y - fy;
      else if (this.startY !== null) height = 1.35 + (y - this.startY);
    }
    this.live.height = height;

    const marking = !!this.boundsDraft;
    const signals = {
      t: snap.t,
      trackState: this.live.trackState,
      rotSpeed: this.rotSpeed,
      linSpeed: this.sixdof ? this.linSpeed : null,
      flowSpeed,
      relSharp,
      blurRisk: blurRisk(this.rotSpeed, this.linSpeed, this.depthMed || 2.5, snap.intr),
      mean: A.mean,
      clipHi: A.clipHi,
      clipLo: A.clipLo,
      texture: A.texture,
      rotInPlace: this.recording && !this.paused && this.motionWin.rotatingInPlace(this.sixdof),
      depthMed: this.depthMed,
      orientationChanged: this.orientationChanged,
      recentGap: snap.t < this.gapUntil,
      lensSwitch: snap.t < this.lensUntil,
      exposureJumps: this.expJumps.length,
      heightHint: this.recording && !this.paused ? heightHint(this.pass, height) : null,
      guidance: marking
        ? this._boundsGuidance()
        : this.paused
          ? { title: 'Paused', detail: 'Tap ▶ to continue capturing.' }
          : this.target
            ? { title: this.target.title, detail: this.target.detail }
            : null,
      goodTitle: 'Looking good — keep going',
      goodDetail: this.pass.short,
    };
    const res = this.coach.update(signals);
    // While marking the scan area, the instructions matter more than capture tips.
    if (marking && res.primary && res.primary.level !== 'bad') res.primary = { id: 'bounds', level: 'info', ...signals.guidance };
    Object.assign(this.live, {
      primary: res.primary,
      active: res.active,
      chips: res.chips,
      metrics: { ...A, relSharp, flowSpeed, rotSpeed: this.rotSpeed, linSpeed: this.linSpeed, depthMed: this.depthMed },
    });
  }

  _boundsGuidance() {
    const n = this.boundsDraft.corners.length;
    if (!this.floorKnown()) return { title: 'Finding the floor…', detail: 'Point the phone at the floor and move it slowly from side to side.' };
    if (!this.boundsCursor) return { title: 'Aim lower, at the floor', detail: 'Point the centre dot at the floor where a corner of the area is.' };
    if (n === 0) return { title: 'Mark the scan area', detail: this.template.boundsHint || 'Aim the centre dot at the floor in each corner and tap ＋ Corner.' };
    if (n < 3) return { title: `Corner ${n + 1}`, detail: 'Aim at the next corner on the floor and tap ＋ Corner (or tap the spot on screen).' };
    return { title: `${n} corners · ${this.draftArea().toFixed(0)} m²`, detail: 'Add more corners, or tap Done when the outline matches the area.' };
  }

  // ------------------------------------------------------------------ candidates & keyframes
  _onCandidate(c, snap) {
    const A = analyzeImage(c.gray, c.w, c.h);
    const relSharp = this.sharpRef.update(A.sharp, snap.t);
    const data = { c, snap, A, relSharp, release: () => c.image.release() };
    if (!this.recording || this.paused) {
      data.release();
      return;
    }
    if (snap.manual) {
      this._commit(data, false, 'manual');
      return;
    }
    const ok = A.mean > 20 && A.texture > 0.004 && relSharp > 0.25;
    const decision = this.keyframer.offer({ t: snap.t, relSharp, blurRisk: snap.risk, ok, novelty: snap.novelty, data });
    if (decision) this._commit(decision.commit.data, decision.rushed);
  }

  _commit(data, rushed, forcedTrigger) {
    const { c, snap, A, relSharp } = data;
    this.keyframer.committed({ t: snap.t, pose: snap.pose, odo: snap.odo });
    const pos = posePosition(snap.pose);
    const prev = lastOfSegment(this.frames, this.segment);
    const baseline = this.sixdof && prev && prev.tracked && snap.tracked ? v3.dist(posePosition(prev.pose), pos) : null;
    const rotFromPrev = prev ? rotationDelta(prev.pose, snap.pose) / DEG : 0;
    const odoFromPrev = prev ? Math.abs((snap.odo || 0) - (prev.odo || 0)) : 0;

    const flags = [];
    if (rushed) flags.push('rushed');
    if (relSharp < 0.5) flags.push('blurry');
    if (A.mean < 45) flags.push('dark');
    if (A.clipHi > 0.1) flags.push('highlights');
    if (A.texture < 0.02) flags.push('lowtex');
    if (this.sixdof && !snap.tracked) flags.push('untracked');
    if (prev && rotFromPrev > 3 && (this.sixdof ? baseline != null && baseline < 0.04 : odoFromPrev < 0.02)) flags.push('rotonly');

    const trigger = forcedTrigger || (!prev ? 'first' : this.sixdof ? (baseline != null && baseline >= 0.08 ? 'trans' : 'rot') : odoFromPrev > 0.04 ? 'trans' : 'rot');
    this.seq++;
    const [az, el] = dirToAzEl(poseForward(snap.pose));
    const meta = {
      id: uid(),
      captureId: this.capture.id,
      seq: this.seq,
      segment: this.segment,
      pass: snap.pass,
      t: Math.round((snap.t - this.t0) * 1000) / 1000,
      createdAt: Date.now(),
      tracking: this.tracking,
      tracked: this.sixdof ? snap.tracked : false,
      pose: Array.from(snap.pose),
      intr: snap.intr,
      odo: snap.odo || 0,
      az, el,
      height: snap.height,
      m: {
        relSharp: round3(relSharp), sharp: round3(A.sharp), mean: round3(A.mean), clipHi: round3(A.clipHi),
        clipLo: round3(A.clipLo), texture: round3(A.texture), rotSpeed: round3(snap.rotSpeed),
        linSpeed: snap.linSpeed == null ? null : round3(snap.linSpeed), depthMed: round3(snap.depthMed), blurRisk: round3(snap.risk),
      },
      flags,
      trigger,
      baseline: baseline == null ? null : round3(baseline),
      rotFromPrev: round3(rotFromPrev),
    };

    // Depth points (flying pixels already removed) with their colours, and the photo's coarse depth
    // image, which lets coverage be rebuilt later exactly as it was measured live.
    const dg = snap.depth;
    meta.pts = dg && dg.xyz.length ? dg.xyz : null;
    meta.rgb = meta.pts ? c.image.sampleColors(dg.uv) : null;
    meta.dimg = dg ? Uint16Array.from(dg.d, (v) => Math.round(v * 1000)) : null;
    meta.dnx = dg ? dg.nx : 0;
    meta.dny = dg ? dg.ny : 0;

    // Coverage.
    const vp = { pos: this.sixdof && snap.tracked ? pos : null, odo: snap.odo || 0 };
    this.sphere.addView(snap.pose, snap.intr, vp, this.frames.length);
    let ps = this.passSpheres.get(snap.pass);
    if (!ps) this.passSpheres.set(snap.pass, (ps = { sphere: new DirectionSphere(), sectors: new Set() }));
    ps.sphere.addView(snap.pose, snap.intr, vp, this.frames.length);
    if (vp.pos) {
      const center = this._roomCenter();
      if (center) ps.sectors.add(Math.floor(((Math.atan2(pos[0] - center[0], -(pos[2] - center[2])) / DEG + 360) % 360) / 30));
      if (meta.pts) this.voxels.integrate(meta.pts, pos);
      if (dg) this.voxels.observeView(snap.pose, snap.intr, dg);
      if (this.guide) this.guide.onPhoto(snap.pose);
    }
    this.frames.push(meta);
    this.live.frames = this.frames.length;
    this._overlayKeyframesDirty = true;

    // Encode and save in the background, one at a time.
    this.saving++;
    this.saveChain = this.saveChain
      .then(async () => {
        const { jpeg, thumb } = await c.image.encodeBoth(this.settings.jpegQuality || 0.92, 320);
        c.image.release();
        const crc = crc32(new Uint8Array(await jpeg.arrayBuffer()));
        await store.putFrame({ ...meta, jpeg, thumb, crc, size: jpeg.size });
        if (this.onKeyframe) this.onKeyframe(meta, thumb);
        if (this.frames.length % 10 === 0) await this.saveCaptureRecord();
      })
      .catch((e) => {
        console.error('save failed', e);
        this.live.saveError = e.message || String(e);
      })
      .finally(() => this.saving--);
  }

  _roomCenter() {
    if (this.bounds && this.bounds.poly) {
      const [x, z] = polyCentroid(this.bounds.poly);
      return [x, 0, z];
    }
    if (this._center && this.lastT - this._centerT < 2) return this._center;
    let sx = 0, sz = 0, n = 0;
    for (const v of this.voxels.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      sx += v.sx / v.n; sz += v.sz / v.n; n++;
    }
    let c = null;
    if (n > 50) c = [sx / n, 0, sz / n];
    else {
      const ps = this.frames.filter((f) => f.segment === this.segment && f.tracked).map((f) => posePosition(f.pose));
      if (ps.length > 5) c = [ps.reduce((s, p) => s + p[0], 0) / ps.length, 0, ps.reduce((s, p) => s + p[2], 0) / ps.length];
    }
    this._center = c;
    this._centerT = this.lastT;
    return c;
  }

  /** Progress of the current pass (0..1). */
  passProgress() {
    if (this.guide && this.guide.hasPath) return this.guide.progress();
    const pass = this.pass;
    const ps = this.passSpheres.get(pass.id);
    if (!ps) return 0;
    const bands = ps.sphere.bandCoverage(pass.bands, 1).fraction;
    if (this.sixdof && pass.loop) return 0.5 * (ps.sectors.size / 12) + 0.5 * bands;
    return bands;
  }

  /** Live coverage figure (0..1) for the HUD. */
  coverage() {
    const vs = this.voxels.stats();
    if (this.sixdof && vs.solid > 50) return { value: vs.coverage, kind: 'surfaces', stats: vs };
    const bc = this.sphere.bandCoverage(['low', 'mid', 'high'], 2);
    return { value: bc.fraction, kind: 'directions', stats: bc };
  }

  _emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  _updateGuidance(pos, fwd, tracked6, t) {
    if (this.sixdof && tracked6) {
      const fy = this.voxels.floorY();
      if (fy !== null) this.floorY = fy;
    }
    this.target = null;
    this.live.guide = null;
    this.live.coverage = this.coverage();
    if (this.boundsDraft) {
      this.live.passProgress = 0;
      return;
    }
    const vs = this.voxels.stats();
    const g = this.guide;
    if (g && tracked6) {
      if (this.guidePending) {
        g.setPass(this.pass, pos);
        this.guidePending = false;
      }
      let gs = null;
      if (g.hasPath) {
        gs = g.update({ pos, fwd, t });
        this.live.passProgress = gs.progress;
      } else {
        this.live.passProgress = this.passProgress();
        // Without a path, point at gaps in the free-form passes, or once a lap is nearly done
        // (during a lap everything is still red, so the lap instruction stays the main message).
        const hintGaps = !this.pass.loop || this.live.passProgress >= 0.85;
        if (hintGaps && vs.solid > 30) gs = g.update({ pos, fwd, t });
      }
      this.live.guide = gs;
      if (gs && gs.next && gs.instruction && !this.paused) {
        this.target = { point: gs.aimPoint, title: gs.instruction.title, detail: gs.instruction.detail, kind: gs.mode };
      }
      // A walked path is done: say so, then move on to the next pass by itself.
      if (gs && gs.complete && g.hasPath) {
        if (!this.passCompleteAt) {
          this.passCompleteAt = t;
          this._emit('passComplete', { pass: this.pass, last: this.passIndex >= this.template.passes.length - 1 });
        } else if (t - this.passCompleteAt > 2.5 && this.passIndex < this.template.passes.length - 1 && this.settings.autoAdvance !== false) {
          this.nextPass();
          this._emit('passStart', { pass: this.pass, index: this.passIndex });
        }
      }
    } else if (this.sixdof) {
      this.live.passProgress = this.passProgress();
    } else {
      this.live.passProgress = this.passProgress();
      const hintGaps = !this.pass.loop || this.live.passProgress >= 0.85;
      const tgt = hintGaps ? this.sphere.nextTarget(fwd, this.pass.bands, 2) : null;
      if (tgt) {
        this.target = { dir: tgt.bin.dir, binIndex: tgt.index, title: `Next: aim ${describeDir(fwd, tgt.bin.dir, false)}`, detail: 'Fill the white dots. Move a step between photos so each dot is seen from two spots.' };
      }
    }
    // The whole scan area is covered well enough to train.
    if (this.sixdof && this.bounds && this.bounds.poly && vs.solid > 50) {
      if (!this.areaDone && vs.coverage >= AREA_DONE) {
        this.areaDone = true;
        this._emit('areaComplete', { coverage: vs.coverage });
      } else if (this.areaDone && vs.coverage < AREA_DONE - 0.08) {
        this.areaDone = false;
      }
    }
  }

  _drawBoundsDraft() {
    const ov = this.source.overlay;
    if (!ov) return;
    const c = this.boundsDraft.corners;
    ov.setTris('bounds', new Float32Array(boundsGeometry(c, this.floorHeight(), { closed: false, cursor: this.boundsCursor, posts: true })));
    ov.setTris('cursor', this.boundsCursor ? new Float32Array(cursorGeometry(this.boundsCursor, true)) : null);
  }

  _updateOverlay(pos) {
    const ov = this.source.overlay;
    if (!ov) return;
    if (this.sixdof && this.voxels.version !== this._voxVersion) {
      this._voxVersion = this.voxels.version;
      const r = this.voxels.renderArrays();
      ov.setVoxels(r.pos, r.qual, this.voxels.size);
    }
    ov.visible.voxels = this.settings.overlayVoxels !== false;
    ov.visible.guide = true;
    if (this._overlayKeyframesDirty) {
      this._overlayKeyframesDirty = false;
      if (this.sixdof) {
        ov.setKeyframes(
          this.frames
            .filter((f) => f.segment === this.segment && f.tracked)
            .map((f) => ({ pos: posePosition(f.pose), fwd: poseForward(f.pose), flagged: f.flags.includes('blurry') || f.flags.includes('rushed') })),
        );
      }
    }
    if (!this.sixdof || (this.voxels.stats().solid <= 50 && !(this.bounds && this.bounds.poly))) {
      const counts = this.sphere.counts();
      ov.setDirectionDots(this.sphere.bins.map((b) => b.dir), counts, pos, this.target && this.target.binIndex != null ? this.target.binIndex : -1, 2);
    } else {
      ov.clearDirectionDots();
    }
    if (!this.sixdof) return;

    // Scan-area outline.
    if (!this.boundsDraft && this._boundsDirty) {
      this._boundsDirty = false;
      const b = this.bounds;
      ov.setTris('bounds', b && b.poly ? new Float32Array(boundsGeometry(b.poly, b.floorY)) : null);
      ov.setTris('cursor', null);
    }
    // Guide: floor trail, "stand here" ring and ghost phone.
    const gs = this.live.guide;
    const fy = this.floorHeight();
    if (gs && gs.next && !this.paused && this.settings.guide !== false) {
      const out = gs.trail.length ? chevronTrail([[pos[0], fy, pos[2]], ...gs.trail.slice(1)]) : [];
      if (gs.stand) standMarker(out, gs.stand);
      if (gs.ghost) ghostPhone(out, gs.ghost.pos, gs.ghost.aim, fy, this.orientation !== false);
      ov.setTris('guide', new Float32Array(out));
    } else {
      ov.setTris('guide', null);
    }
    // Beacon on the surface to fill (gap mode); paths use the on-screen ring only.
    ov.setTarget(this.target && this.target.point && this.target.kind !== 'path' ? this.target.point : null);
  }
}

/** "to your left, higher up (2.3 m away)" — where `to` is relative to the camera. */
function describeDir(fwd, to, isPoint) {
  const [fa, fe] = dirToAzEl(fwd);
  const [ta, te] = dirToAzEl(v3.norm(to));
  const d = ((ta - fa + 540) % 360) - 180;
  const h = Math.abs(d) < 25 ? 'ahead' : Math.abs(d) > 135 ? 'behind you' : d > 0 ? 'to your right' : 'to your left';
  const v = te - fe > 30 ? ', higher up' : te - fe < -30 ? ', lower down' : '';
  return isPoint ? `${h}${v} (${v3.len(to).toFixed(1)} m away)` : `${h}${v}`;
}

function lastOfSegment(frames, seg) {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].segment === seg) return frames[i];
  return null;
}

function stripBlobs(f) {
  const { jpeg, thumb, ...rest } = f;
  return rest;
}

function mergeCounts(a = {}, b = {}) {
  const out = { ...a };
  for (const k in b) out[k] = (out[k] || 0) + b[k];
  return out;
}

const round3 = (x) => (x == null || !isFinite(x) ? x : Math.round(x * 1000) / 1000);
