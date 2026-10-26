// Camera source: getUserMedia + device orientation. Works on iPhone and any phone without AR.
// Full camera resolution; tracking is orientation-only, so parallax is estimated from image motion.

import { OrientationTracker } from './orientation.js';
import { analysisSize, coverMapping } from './common.js';
import { BitmapImage } from './frameImage.js';
import { rgbaToGray } from '../core/analyzer.js';
import { Overlay3D } from '../capture/overlay3d.js';
import { DEG, mat4InvertRigid, poseLookDir } from '../core/math.js';

export const RESOLUTIONS = {
  max: { label: 'Max (4:3 full sensor)', video: { width: { ideal: 4032 }, height: { ideal: 3024 } } },
  '4k': { label: '4K 16:9', video: { width: { ideal: 3840 }, height: { ideal: 2160 } } },
  '1080p': { label: '1080p (light on storage)', video: { width: { ideal: 1920 }, height: { ideal: 1080 } } },
};

/** Horizontal field of view (degrees, long image side) by lens type. */
export const LENS_FOV = { main: 68, ultrawide: 106, tele: 32, multi: 68, unknown: 68, front: 72 };

export function classifyLens(label = '') {
  const l = label.toLowerCase();
  if (/front|user|facetime|selfie/.test(l)) return 'front';
  if (/ultra ?wide/.test(l)) return 'ultrawide';
  if (/tele/.test(l)) return 'tele';
  if (/dual|triple/.test(l)) return 'multi';
  if (/back|rear|environment/.test(l)) return 'main';
  return 'unknown';
}

/** Video inputs with a lens guess. Labels appear only after camera permission was granted once. */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera', lens: classifyLens(d.label) }))
    .filter((c) => c.lens !== 'front');
}

export class CameraSource {
  constructor({ container, deviceId = '', resolution = '4k', lens = 'main' }) {
    this.kind = 'camera';
    this.tracking = '3dof';
    this.container = container;
    this.deviceId = deviceId;
    this.resolution = resolution;
    this.lens = lens;
    this.info = { label: 'Camera', camW: 0, camH: 0, depth: false, sensors: false, controls: null };
    this.running = false;
    this._tick = this._tick.bind(this);
  }

  async start({ onFrame, onEnd }) {
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    const video = { ...(RESOLUTIONS[this.resolution] || RESOLUTIONS['4k']).video, frameRate: { ideal: 30 } };
    if (this.deviceId) video.deviceId = { exact: this.deviceId };
    else video.facingMode = { ideal: 'environment' };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.track = this.stream.getVideoTracks()[0];
    this.info.label = this.track.label || 'Camera';
    if (this.lens === 'auto') this.lens = classifyLens(this.track.label);
    this.track.addEventListener('ended', () => this.onEnd && this.onEnd());

    this.orient = new OrientationTracker();
    this.orient.start();

    const v = document.createElement('video');
    v.className = 'source-video';
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    v.srcObject = this.stream;
    this.container.appendChild(v);
    this.video = v;
    await v.play().catch(() => {});

    const c = document.createElement('canvas');
    c.className = 'source-overlay';
    this.container.appendChild(c);
    this.canvas = c;
    const gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
    this.gl = gl;
    this.overlay = gl ? new Overlay3D(gl) : null;

    this.acanvas = document.createElement('canvas');
    this.actx = this.acanvas.getContext('2d', { willReadFrequently: true });
    this.info.controls = this.controls();
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.orient) this.orient.stop();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) this.video.remove();
    if (this.canvas) this.canvas.remove();
  }

  _schedule() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(this._tick);
    else requestAnimationFrame(this._tick);
  }

  _intrinsics(w, h) {
    const fov = (LENS_FOV[this.lens] || 68) * DEG;
    const f = Math.max(w, h) / 2 / Math.tan(fov / 2);
    return { fx: f, fy: f, cx: w / 2, cy: h / 2, w, h };
  }

  _tick() {
    if (!this.running) return;
    this._schedule();
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    this.info.camW = vw;
    this.info.camH = vh;
    const t = performance.now() / 1000;
    const intr = this._intrinsics(vw, vh);
    const sensors = this.orient.available;
    this.info.sensors = sensors;
    // Without orientation sensors (desktop webcams) the pose is fixed; coverage then can't be tracked.
    const pose = sensors ? this.orient.pose() : poseLookDir([0, 0, 0], [0, 0, -1]);

    const rect = this.container.getBoundingClientRect();
    const map = coverMapping(intr, rect.width || 1, rect.height || 1);
    const as = analysisSize(vw, vh);
    const grabSmall = () => {
      if (this.acanvas.width !== as.w || this.acanvas.height !== as.h) {
        this.acanvas.width = as.w;
        this.acanvas.height = as.h;
      }
      this.actx.drawImage(v, 0, 0, as.w, as.h);
      return this.actx.getImageData(0, 0, as.w, as.h).data;
    };

    const fi = {
      t,
      pose,
      trackState: sensors ? (this.orient.fresh ? 'n/a' : 'lost') : 'n/a',
      noSensors: !sensors,
      intr,
      depth: null,
      displayIntr: map.displayIntr,
      toScreen: (p, isDir) => map.toScreen(pose, p, isDir),
      requestAnalysis: () => {
        const rgba = grabSmall();
        return Promise.resolve({ gray: rgbaToGray(rgba, as.w, as.h), w: as.w, h: as.h });
      },
      requestCandidate: () => {
        const bmp = createImageBitmap(v);
        const rgba = grabSmall().slice();
        return bmp.then((bitmap) => ({
          gray: rgbaToGray(rgba, as.w, as.h),
          w: as.w,
          h: as.h,
          image: new BitmapImage(bitmap, vw, vh, rgba, as.w, as.h),
        }));
      },
    };

    try {
      this.onFrame(fi);
    } catch (e) {
      console.error(e);
    }

    if (this.overlay) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.round(rect.width * dpr), ch = Math.round(rect.height * dpr);
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      this.overlay.draw(mat4InvertRigid(pose), map.proj, [0, 0, cw, ch], t);
    }
  }

  /** Which manual camera controls the browser exposes (Android Chrome exposes several; iOS none). */
  controls() {
    const caps = (this.track.getCapabilities && this.track.getCapabilities()) || {};
    const has = (k, m) => Array.isArray(caps[k]) && caps[k].includes(m);
    return {
      exposureLock: has('exposureMode', 'manual'),
      whiteBalanceLock: has('whiteBalanceMode', 'manual'),
      focusLock: has('focusMode', 'manual'),
      exposureCompensation: caps.exposureCompensation || null,
    };
  }

  /** Lock (or release) exposure, white balance and focus at their current values. */
  async setLocks(on) {
    const ctl = this.controls();
    const st = this.track.getSettings();
    const adv = {};
    if (ctl.exposureLock) {
      adv.exposureMode = on ? 'manual' : 'continuous';
      if (on && st.exposureTime) adv.exposureTime = st.exposureTime;
      if (on && st.iso) adv.iso = st.iso;
    }
    if (ctl.whiteBalanceLock) {
      adv.whiteBalanceMode = on ? 'manual' : 'continuous';
      if (on && st.colorTemperature) adv.colorTemperature = st.colorTemperature;
    }
    if (ctl.focusLock) {
      adv.focusMode = on ? 'manual' : 'continuous';
      if (on && st.focusDistance) adv.focusDistance = st.focusDistance;
    }
    if (!Object.keys(adv).length) return false;
    await this.track.applyConstraints({ advanced: [adv] });
    return true;
  }

  async setExposureCompensation(value) {
    await this.track.applyConstraints({ advanced: [{ exposureCompensation: value }] });
  }
}
