// Practice source: walk through a virtual classroom with mouse/keyboard or touch (or an automatic
// tour). It behaves like the AR source (6DoF + depth) or like camera mode (orientation only).

import { DemoScene, depthGrid, depthImage, raycast, surfaceNormal, ROOM } from './demoScene.js';
import { analysisSize, coverMapping } from './common.js';
import { BitmapImage } from './frameImage.js';
import { rgbaToGray } from '../core/analyzer.js';
import { Overlay3D } from '../capture/overlay3d.js';
import { DEG, clamp, poseLookDir, mat4InvertRigid, mat4Mul, rotationDelta, transformPoint, v3 } from '../core/math.js';
import { xfPose, xfCompose, xfApply, xfApplyDir } from '../core/align.js';

// Same geometry as the Pixel's ARCore camera image: 860 x 1920, 70° along the long side (35° across).
const HFOV = 70;

export class DemoSource {
  /**
   * @param {object} o
   * @param {HTMLElement} o.container
   * @param {'6dof'|'3dof'} [o.tracking]
   * @param {number} [o.tourSpeed] 0 = manual control; >0 starts the automatic tour at that speed
   * @param {{yaw, t}|null} [o.sessionXf] like a real AR session: report poses in coordinates that are
   *   turned and shifted from the room's (a resumed capture starts somewhere else in "AR space")
   */
  constructor({ container, tracking = '6dof', tourSpeed = 0, sessionXf = null }) {
    this.kind = 'demo';
    this.tracking = tracking;
    this.container = container;
    this.tourSpeed = tourSpeed;
    this.info = { label: 'Practice room', camW: 0, camH: 0, depth: tracking === '6dof', sensors: true };
    this.pos = [0, 1.45, 2.4];
    this.yaw = 0; // 0 = looking towards -Z
    this.pitch = -5;
    this.keys = new Set();
    this.running = false;
    this.autopilot = null; // () => {pos, aim} | null: the auto-tour follows the guide when set
    this.frameNo = 0;
    this.sessionXf = sessionXf;
    this.lostUntil = 0;
    this._loop = this._loop.bind(this);
  }

  /** Simulate ARCore shifting its coordinates (what a tracking glitch looks like to the app). */
  simulateJump(dist = 0.6, yawDeg = 12) {
    const a = Math.random() * Math.PI * 2;
    const j = { yaw: (Math.random() < 0.5 ? -1 : 1) * yawDeg * DEG, t: [Math.cos(a) * dist, 0, Math.sin(a) * dist] };
    this.sessionXf = this.sessionXf ? xfCompose(j, this.sessionXf) : j;
  }

  /** Simulate losing tracking for a while (then coming back shifted, as ARCore often does). */
  simulateLoss(sec = 2, dist = 0.5, yawDeg = 10) {
    this.lostUntil = (this.simT || performance.now() / 1000) + sec;
    this.simulateJump(dist, yawDeg);
  }

  async start({ onFrame, onEnd }) {
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    const rect = this.container.getBoundingClientRect();
    const portrait = rect.height > rect.width * 1.1;
    const W = portrait ? 576 : 1280, H = portrait ? 1280 : 576;
    const f = Math.max(W, H) / 2 / Math.tan((HFOV / 2) * DEG);
    this.intr = { fx: f, fy: f, cx: W / 2, cy: H / 2, w: W, h: H };
    this.info.camW = W;
    this.info.camH = H;

    this.glCanvas = document.createElement('canvas');
    this.glCanvas.width = W;
    this.glCanvas.height = H;
    const gl = this.glCanvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is required for practice mode.');
    this.scene = new DemoScene(gl);

    // What the "camera" sees (with simulated motion blur) is drawn to a 2D canvas.
    this.out = document.createElement('canvas');
    this.out.width = W;
    this.out.height = H;
    this.out.className = 'source-video';
    this.octx = this.out.getContext('2d');
    this.container.appendChild(this.out);

    this.ocanvas = document.createElement('canvas');
    this.ocanvas.className = 'source-overlay';
    this.container.appendChild(this.ocanvas);
    const ogl = this.ocanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    this.ogl = ogl;
    this.overlay = new Overlay3D(ogl);

    this.acanvas = document.createElement('canvas');
    this.actx = this.acanvas.getContext('2d', { willReadFrequently: true });

    this._bindInput();
    this.running = true;
    this.lastT = performance.now() / 1000;
    this.tourT = 0;
    this.prevPose = null;
    requestAnimationFrame(this._loop);
  }

  stop() {
    this.running = false;
    this._unbindInput();
    this.out?.remove();
    this.ocanvas?.remove();
  }

  setTour(speed) {
    this.tourSpeed = speed;
  }

  // ---------------------------------------------------------------- input
  _bindInput() {
    const el = this.container;
    this._kd = (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 't') this.tourSpeed = this.tourSpeed ? 0 : 1;
      if (e.key.toLowerCase() === 'j' && this.tracking === '6dof') this.simulateJump();
      if (e.key.toLowerCase() === 'l' && this.tracking === '6dof') this.simulateLoss();
    };
    this._ku = (e) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', this._kd);
    window.addEventListener('keyup', this._ku);
    this.pointers = new Map();
    this._pd = (e) => {
      if (e.target.closest && e.target.closest('.hud-interactive')) return;
      const r = el.getBoundingClientRect();
      const mode = e.pointerType === 'mouse' ? (e.button === 2 ? 'move' : 'look') : e.clientX - r.left < r.width / 2 ? 'move' : 'look';
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, mode });
    };
    this._pm = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (p.mode === 'look') {
        this.yaw += (e.clientX - p.x) * 0.2;
        this.pitch = clamp(this.pitch - (e.clientY - p.y) * 0.2, -85, 85);
      }
      p.x = e.clientX;
      p.y = e.clientY;
    };
    this._pu = (e) => this.pointers.delete(e.pointerId);
    this._cm = (e) => e.preventDefault();
    el.addEventListener('pointerdown', this._pd);
    window.addEventListener('pointermove', this._pm);
    window.addEventListener('pointerup', this._pu);
    window.addEventListener('pointercancel', this._pu);
    el.addEventListener('contextmenu', this._cm);
  }

  _unbindInput() {
    window.removeEventListener('keydown', this._kd);
    window.removeEventListener('keyup', this._ku);
    this.container.removeEventListener('pointerdown', this._pd);
    window.removeEventListener('pointermove', this._pm);
    window.removeEventListener('pointerup', this._pu);
    window.removeEventListener('pointercancel', this._pu);
    this.container.removeEventListener('contextmenu', this._cm);
  }

  _manual(dt) {
    const k = this.keys;
    const sp = (k.has('shift') ? 1.2 : 0.45) * dt;
    const fwd = [Math.sin(this.yaw * DEG), 0, -Math.cos(this.yaw * DEG)];
    const right = [Math.cos(this.yaw * DEG), 0, Math.sin(this.yaw * DEG)];
    let mv = [0, 0, 0];
    if (k.has('w') || k.has('arrowup')) mv = v3.add(mv, fwd);
    if (k.has('s') || k.has('arrowdown')) mv = v3.sub(mv, fwd);
    if (k.has('d')) mv = v3.add(mv, right);
    if (k.has('a')) mv = v3.sub(mv, right);
    if (k.has('arrowleft')) this.yaw -= 40 * dt;
    if (k.has('arrowright')) this.yaw += 40 * dt;
    if (k.has('e') || k.has('r')) this.pos[1] += sp;
    if (k.has('q') || k.has('f')) this.pos[1] -= sp;
    // Touch joystick (left half): drag distance = speed.
    for (const p of this.pointers.values()) {
      if (p.mode !== 'move') continue;
      const dx = clamp((p.x - p.x0) / 80, -1, 1), dy = clamp((p.y - p.y0) / 80, -1, 1);
      mv = v3.add(mv, v3.add(v3.scale(right, dx), v3.scale(fwd, -dy)));
    }
    if (v3.len(mv) > 0) this.pos = v3.add(this.pos, v3.scale(v3.norm(mv), sp * Math.min(1, v3.len(mv))));
    this.pos[0] = clamp(this.pos[0], ROOM.min[0] + 0.3, ROOM.max[0] - 0.3);
    this.pos[1] = clamp(this.pos[1], 0.3, 2.6);
    this.pos[2] = clamp(this.pos[2], ROOM.min[2] + 0.3, ROOM.max[2] - 0.3);
  }

  // ---------------------------------------------------------------- automatic tour
  _tour(dt) {
    this.tourT += dt * this.tourSpeed;
    const segs = TOUR;
    let t = this.tourT % segs.reduce((s, x) => s + x.dur, 0);
    let seg = segs[0];
    for (const s of segs) {
      if (t < s.dur) {
        seg = s;
        break;
      }
      t -= s.dur;
    }
    const u = t / seg.dur;
    let pos, look;
    if (seg.type === 'lap') {
      pos = rectPoint(u, 2.85, 2.3);
      const toC = [-pos[0], 0, -pos[2]];
      const baseYaw = Math.atan2(toC[0], -toC[2]) / DEG;
      look = baseYaw + 15 * Math.sin(u * Math.PI * 2 * 3);
    } else {
      const legs = [[[-2.8, -2.2], [2.8, 2.2]], [[2.8, -2.2], [-2.8, 2.2]]];
      const leg = legs[u < 0.5 ? 0 : 1];
      const lu = (u % 0.5) * 2;
      pos = [leg[0][0] + (leg[1][0] - leg[0][0]) * lu, 0, leg[0][1] + (leg[1][1] - leg[0][1]) * lu];
      const dir = [leg[1][0] - leg[0][0], leg[1][1] - leg[0][1]];
      look = Math.atan2(dir[0], -dir[1]) / DEG + 90 * (lu < 0.5 ? 1 : -1) * 0.8;
    }
    pos[1] = seg.y;
    // Smoothly approach the target pose (no teleports between segments).
    const a = 1 - Math.exp(-dt * 2.5);
    this.pos = v3.add(this.pos, v3.scale(v3.sub(pos, this.pos), a));
    let dy = ((look - this.yaw + 540) % 360) - 180;
    this.yaw += dy * a;
    this.pitch += (seg.pitch - this.pitch) * a;
  }

  // ---------------------------------------------------------------- frame loop
  _loop() {
    if (!this.running) return;
    requestAnimationFrame(this._loop);
    if (this.manualClock) return;
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - this.lastT);
    this.lastT = now;
    this._frame(now, dt);
  }

  /** Advance the simulation by exactly dt seconds (deterministic testing, independent of rAF). */
  step(dt) {
    this.manualClock = true;
    this.simT = (this.simT || performance.now() / 1000) + dt;
    this._frame(this.simT, dt);
  }

  /** Auto-tour that follows the capture guide: walk towards its target and aim where it says. */
  _follow(dt, tgt) {
    // Like a person: walk slower while turning a lot.
    const want = Math.atan2(tgt.aim[0], -tgt.aim[2]) / DEG;
    const err = Math.abs(((want - this.yaw + 540) % 360) - 180);
    const sp = 0.32 * clamp(1 - err / 60, 0.3, 1) * dt;
    const tx = tgt.pos[0] - this.pos[0], tz = tgt.pos[2] - this.pos[2];
    const d = Math.hypot(tx, tz);
    if (d > 1e-3) {
      const k = Math.min(d, sp) / d;
      this.pos[0] += tx * k;
      this.pos[2] += tz * k;
    }
    this.pos[1] += clamp(tgt.pos[1] - this.pos[1], -0.5 * dt, 0.5 * dt);
    this.pos[0] = clamp(this.pos[0], ROOM.min[0] + 0.3, ROOM.max[0] - 0.3);
    this.pos[2] = clamp(this.pos[2], ROOM.min[2] + 0.3, ROOM.max[2] - 0.3);
    const a = tgt.aim;
    const yaw = Math.atan2(a[0], -a[2]) / DEG, pitch = Math.asin(clamp(a[1], -1, 1)) / DEG;
    // Smooth, proportional turning capped at 12°/s (a person following the ring, not a robot).
    const dyaw = ((yaw - this.yaw + 540) % 360) - 180;
    this.yaw += clamp(dyaw * 1.5, -12, 12) * dt;
    this.pitch += clamp((pitch - this.pitch) * 1.5, -12, 12) * dt;
  }

  _frame(now, dt) {
    const tgt = this.tourSpeed > 0 && this.autopilot ? this.autopilot() : null;
    if (tgt) this._follow(dt * this.tourSpeed, tgt);
    else if (this.tourSpeed > 0) this._tour(dt);
    else this._manual(dt);
    this.frameNo++;

    const fwd = [Math.sin(this.yaw * DEG) * Math.cos(this.pitch * DEG), Math.sin(this.pitch * DEG), -Math.cos(this.yaw * DEG) * Math.cos(this.pitch * DEG)];
    const truePose = poseLookDir(this.pos, fwd);
    this.scene.render(truePose, this.intr, 1);

    // Simulated motion blur from the camera's speed.
    let blur = 0;
    if (this.prevPose && dt > 0) {
      const rot = rotationDelta(this.prevPose, truePose) / DEG / dt;
      const lin = v3.dist([this.prevPose[12], this.prevPose[13], this.prevPose[14]], this.pos) / dt;
      // Image motion during a 1/60 s exposure; a box blur of length L ~ Gaussian sigma 0.29 L.
      const pxPerSec = (rot * DEG + lin / 2) * this.intr.fx;
      blur = Math.max(0, (0.29 * pxPerSec) / 60 - 0.3);
    }
    this.prevPose = truePose;
    this.octx.filter = blur > 0.4 ? `blur(${Math.min(12, blur).toFixed(1)}px)` : 'none';
    this.octx.drawImage(this.glCanvas, 0, 0);
    this.octx.filter = 'none';

    const S = this.tracking === '6dof' ? this.sessionXf : null;
    const lost = now < this.lostUntil;
    const pose = this.tracking === '6dof' ? (S ? xfPose(S, truePose) : truePose.slice()) : poseLookDir([0, 0, 0], fwd);
    // Depth is ray cast in the room's coordinates, then moved into the reported pose's coordinates at
    // the moment it's asked for (the app may have moved the pose to line it up with the scan).
    const toReported = () => mat4Mul(pose, mat4InvertRigid(truePose));
    const reportGrid = (g) => {
      const M = toReported(), xyz = new Float32Array(g.xyz.length);
      for (let i = 0; i < xyz.length; i += 3) xyz.set(transformPoint(M, [g.xyz[i], g.xyz[i + 1], g.xyz[i + 2]]), i);
      return { ...g, xyz };
    };
    const rect = this.container.getBoundingClientRect();
    const map = coverMapping(this.intr, rect.width || 1, rect.height || 1);
    const intr = this.intr;
    const as = analysisSize(intr.w, intr.h);
    const grabSmall = () => {
      if (this.acanvas.width !== as.w || this.acanvas.height !== as.h) {
        this.acanvas.width = as.w;
        this.acanvas.height = as.h;
      }
      this.actx.drawImage(this.out, 0, 0, as.w, as.h);
      return this.actx.getImageData(0, 0, as.w, as.h).data;
    };
    // Simulated AR hit test at the screen centre (where the reticle is).
    let hit = null;
    if (this.tracking === '6dof') {
      const t = raycast(this.pos, fwd);
      if (isFinite(t)) {
        const p = [this.pos[0] + fwd[0] * t, this.pos[1] + fwd[1] * t, this.pos[2] + fwd[2] * t];
        hit = S ? { p: xfApply(S, p), n: xfApplyDir(S, surfaceNormal(p)) } : { p, n: surfaceNormal(p) };
      }
    }
    const fi = {
      t: now,
      pose: lost ? null : pose,
      hit: lost ? null : hit,
      trackState: this.tracking === '6dof' ? (lost ? 'lost' : 'ok') : 'n/a',
      intr,
      displayIntr: map.displayIntr,
      toScreen: (p, isDir) => map.toScreen(pose, p, isDir),
      depth:
        this.tracking === '6dof' && !lost
          ? {
              median: () => {
                const g = depthGrid(truePose, intr, 9, 7, 0.1, 15);
                const ds = [];
                for (let i = 0; i < g.xyz.length; i += 3) {
                  const d = [g.xyz[i] - this.pos[0], g.xyz[i + 1] - this.pos[1], g.xyz[i + 2] - this.pos[2]];
                  ds.push(-(d[0] * truePose[8] + d[1] * truePose[9] + d[2] * truePose[10]));
                }
                ds.sort((a, b) => a - b);
                return ds.length ? ds[ds.length >> 1] : 0;
              },
              grid: (nx, ny, minD = 0.25, maxD = 8) => reportGrid(depthGrid(truePose, intr, nx, ny, minD, maxD)),
            }
          : null,
      requestAnalysis: () => {
        const rgba = grabSmall();
        return Promise.resolve({ gray: rgbaToGray(rgba, as.w, as.h), w: as.w, h: as.h });
      },
      requestCandidate: () => {
        const rgba = grabSmall().slice();
        return createImageBitmap(this.out).then((bitmap) => ({
          gray: rgbaToGray(rgba, as.w, as.h),
          w: as.w,
          h: as.h,
          image: new BitmapImage(bitmap, intr.w, intr.h, rgba, as.w, as.h),
        }));
      },
    };
    try {
      this.onFrame(fi);
    } catch (e) {
      console.error(e);
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(rect.width * dpr), ch = Math.round(rect.height * dpr);
    if (this.ocanvas.width !== cw || this.ocanvas.height !== ch) {
      this.ocanvas.width = cw;
      this.ocanvas.height = ch;
    }
    const gl = this.ogl;
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.frameNo % 4 === 0) {
      this.overlay.setOcclusion(this.tracking === '6dof' ? depthImage(truePose, map.displayIntr, 32, 24, 0.1, 20, false) : null, 32, 24);
    }
    this.overlay.draw(mat4InvertRigid(pose), map.proj, [0, 0, cw, ch], now);
  }
}

const TOUR = [
  { type: 'lap', y: 1.4, pitch: -8, dur: 80 },
  { type: 'lap', y: 1.95, pitch: -32, dur: 80 },
  { type: 'lap', y: 0.85, pitch: 26, dur: 80 },
  { type: 'cross', y: 1.4, pitch: -15, dur: 50 },
];

/** Point on a rectangle perimeter (half-sizes rx, rz) at parameter u in [0, 1). */
function rectPoint(u, rx, rz) {
  const per = 4 * (rx + rz);
  let d = u * per;
  const pts = [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz], [-rx, -rz]];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= L) {
      const s = d / L;
      return [a[0] + (b[0] - a[0]) * s, 0, a[1] + (b[1] - a[1]) * s];
    }
    d -= L;
  }
  return [-rx, 0, -rz];
}
