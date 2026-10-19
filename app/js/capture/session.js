// The capture engine: consumes frames from a source (AR, camera or practice), analyses quality,
// tracks coverage, picks sharp keyframes, coaches the user and saves photos.

import { analyzeImage, downsample2, FlowTracker, SharpnessReference } from '../core/analyzer.js';
import { DirectionSphere, VoxelMap } from '../core/coverage.js';
import { Keyframer } from '../core/keyframer.js';
import { Coach } from '../core/coach.js';
import { MotionWindow, Parallax3DoF, blurRisk } from '../core/motion.js';
import { heightHint } from '../core/plans.js';
import { crc32 } from '../core/zip.js';
import {
  DEG, v3, angularVelocity, dirToAzEl, fovFromIntrinsics, posePosition, poseForward, rotationDelta, clamp,
} from '../core/math.js';
import * as store from '../data/store.js';
import { uid } from '../data/store.js';

const ANALYSIS_INTERVAL = 0.1; // s
const DEPTH_SEEN_INTERVAL = 0.5; // s
const GUIDE_INTERVAL = 1.0; // s

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
    this.target = null; // {point | dir, text}
    this.stats = {
      activeSec: (capture.stats && capture.stats.activeSec) || 0,
      lostSec: (capture.stats && capture.stats.lostSec) || 0,
      gaps: (capture.stats && capture.stats.gaps) || 0,
      exposureJumps: (capture.stats && capture.stats.exposureJumps) || 0,
      warnings: {},
    };
    this.baseWarnings = { ...((capture.stats && capture.stats.warnings) || {}) };
    this.live = {
      t: 0, trackState: 'n/a', chips: {}, primary: null, passProgress: 0, coverage: 0,
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
  }

  nextPass() {
    if (this.passIndex < this.template.passes.length - 1) this.passIndex++;
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

    // Depth: median distance, and "seen geometry" integration.
    if (fi.depth && tracked6) {
      if (t - this.lastMed > 0.25) {
        this.lastMed = t;
        this.depthMed = fi.depth.median() || this.depthMed;
      }
      if (t - this.lastDepthSeen > DEPTH_SEEN_INTERVAL && this.recording) {
        this.lastDepthSeen = t;
        const g = fi.depth.grid(16, 12);
        if (g.xyz.length) this.voxels.observe(g.xyz, pos, false);
      }
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

    // Keyframe selection.
    const canShoot = this.recording && !this.paused && !this.orientationChanged && fi.requestCandidate &&
      !(this.sixdof && fi.trackState === 'lost');
    if (canShoot && !this.candidatePending && this.saving < 4) {
      const kstate = { t, pose, odo: this.par3 ? this.par3.odo : 0, depthMed: this.depthMed };
      const novelty = this.keyframer.novelty(kstate);
      const want = this.manualPending || novelty >= 0.75 || this.keyframer.seeking;
      if (want && t - (this.lastCand || 0) >= 0.12) {
        const hfov = fi.intr ? fovFromIntrinsics(fi.intr).h : 65;
        const risk = blurRisk(this.rotSpeed, this.linSpeed, this.depthMed || 2.5, hfov);
        const waited = this.keyframer.seeking ? t - this.keyframer.seekStart : 0;
        if (this.manualPending || risk < 0.55 || waited > 0.6) {
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
      this._updateGuidance(pos, fwd, tracked6);
    }
    if (t - this.lastOverlay > 0.25) {
      this.lastOverlay = t;
      this._updateOverlay(pos, fwd);
    }
    L.targetScreen = this.target && fi.toScreen ? fi.toScreen(this.target.point || this.target.dir, !this.target.point) : null;
    L.pose = pose;
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
      if (this.floorY !== null && y - this.floorY > 0.15 && y - this.floorY < 3) height = y - this.floorY;
      else if (this.startY !== null) height = 1.35 + (y - this.startY);
    }
    this.live.height = height;

    const signals = {
      t: snap.t,
      trackState: this.live.trackState,
      rotSpeed: this.rotSpeed,
      linSpeed: this.sixdof ? this.linSpeed : null,
      flowSpeed,
      relSharp,
      blurRisk: blurRisk(this.rotSpeed, this.linSpeed, this.depthMed || 2.5, snap.intr ? fovFromIntrinsics(snap.intr).h : 65),
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
      guidance: this.paused
        ? { title: 'Paused', detail: 'Tap ▶ to continue capturing.' }
        : this.target
          ? { title: this.target.title, detail: this.target.detail }
          : null,
      goodTitle: 'Looking good — keep going',
      goodDetail: this.pass.short,
    };
    const res = this.coach.update(signals);
    Object.assign(this.live, {
      primary: res.primary,
      active: res.active,
      chips: res.chips,
      metrics: { ...A, relSharp, flowSpeed, rotSpeed: this.rotSpeed, linSpeed: this.linSpeed, depthMed: this.depthMed },
    });
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
    if (relSharp < 0.6) flags.push('blurry');
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

    let pts = null, rgb = null;
    if (snap.depth && snap.depth.xyz.length) {
      pts = snap.depth.xyz;
      rgb = c.image.sampleColors(snap.depth.uv);
    }
    meta.pts = pts;
    meta.rgb = rgb;

    // Coverage.
    const vp = { pos: this.sixdof && snap.tracked ? pos : null, odo: snap.odo || 0 };
    this.sphere.addView(snap.pose, snap.intr, vp, this.frames.length);
    let ps = this.passSpheres.get(snap.pass);
    if (!ps) this.passSpheres.set(snap.pass, (ps = { sphere: new DirectionSphere(), sectors: new Set() }));
    ps.sphere.addView(snap.pose, snap.intr, vp, this.frames.length);
    if (vp.pos) {
      const center = this._roomCenter();
      if (center) ps.sectors.add(Math.floor(((Math.atan2(pos[0] - center[0], -(pos[2] - center[2])) / DEG + 360) % 360) / 30));
      if (pts) this.voxels.observe(pts, pos, true);
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
    if (this._center && this.lastT - this._centerT < 2) return this._center;
    let sx = 0, sz = 0, n = 0;
    for (const v of this.voxels.vox.values()) {
      if (!VoxelMap.isSolid(v)) continue;
      sx += v.ix; sz += v.iz; n++;
    }
    let c = null;
    if (n > 50) c = [((sx / n) + 0.5) * this.voxels.size, 0, ((sz / n) + 0.5) * this.voxels.size];
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

  _updateGuidance(pos, fwd, tracked6) {
    if (this.sixdof && tracked6) {
      const fy = this.voxels.floorY();
      if (fy !== null) this.floorY = fy;
    }
    const vs = this.voxels.stats();
    this.target = null;
    this.live.passProgress = this.passProgress();
    // During a lap everything is still red, so gap hints only make sense once the lap is nearly
    // done or in the free-form passes; until then the pass instruction stays the main message.
    const hintGaps = !this.pass.loop || this.live.passProgress >= 0.85;
    if (hintGaps && this.sixdof && tracked6 && vs.solid > 50) {
      const gap = this.voxels.findGap(pos, fwd, this.template.maxObsDist);
      if (gap) {
        const to = v3.sub(gap.center, pos);
        this.target = { point: gap.center, title: `Capture the red area ${describeDir(fwd, to, true)}`, detail: 'Photograph it from a new spot. Step sideways, don\'t just aim.' };
      }
    } else if (hintGaps) {
      const tgt = this.sphere.nextTarget(fwd, this.pass.bands, 2);
      if (tgt) {
        this.target = { dir: tgt.bin.dir, binIndex: tgt.index, title: `Next: aim ${describeDir(fwd, tgt.bin.dir, false)}`, detail: 'Fill the white dots. Move a step between photos so each dot is seen from two spots.' };
      }
    }
    this.live.coverage = this.coverage();
  }

  _updateOverlay(pos, fwd) {
    const ov = this.source.overlay;
    if (!ov) return;
    if (this.sixdof && this.voxels.version !== this._voxVersion) {
      this._voxVersion = this.voxels.version;
      const r = this.voxels.renderArrays();
      ov.setVoxels(r.pos, r.qual, this.voxels.size);
    }
    ov.visible.voxels = this.settings.overlayVoxels !== false;
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
    if (!this.sixdof || this.voxels.stats().solid <= 50) {
      const counts = this.sphere.counts();
      ov.setDirectionDots(this.sphere.bins.map((b) => b.dir), counts, pos, this.target && this.target.binIndex != null ? this.target.binIndex : -1, 2);
    } else {
      ov.clearDirectionDots();
    }
    ov.setTarget(this.target && this.target.point ? this.target.point : null);
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
