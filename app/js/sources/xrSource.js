// AR source: WebXR 'immersive-ar' (ARCore on Android Chrome).
// Provides 6DoF camera poses, the camera image (raw camera access), and ARCore depth.

import { TextureReader } from './gpu.js';
import { analysisSize, screenProject } from './common.js';
import { RgbaImage } from './frameImage.js';
import { rgbaToGray } from '../core/analyzer.js';
import { intrinsicsFromProjection, mat4InvertRigid } from '../core/math.js';
import { depthToPoints, unprojectGL } from '../core/depth.js';
import { Overlay3D } from '../capture/overlay3d.js';

export async function xrSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'AR needs HTTPS (or localhost).' };
  if (!navigator.xr) return { ok: false, reason: 'This browser has no WebXR. On Android, use Chrome.' };
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    return ok ? { ok: true } : { ok: false, reason: 'This device/browser does not support AR sessions (ARCore).' };
  } catch (e) {
    return { ok: false, reason: 'AR check failed: ' + e.message };
  }
}

export class XRSource {
  /**
   * @param {object} o
   * @param {HTMLElement} o.overlayRoot element shown on top of the AR view (DOM overlay)
   * @param {boolean} [o.flipY] flip camera frames vertically (settings fallback)
   * @param {number} [o.maxDepth] max depth to trust (m)
   */
  constructor({ overlayRoot, flipY = true, maxDepth = 6 }) {
    this.kind = 'xr';
    this.tracking = '6dof';
    this.overlayRoot = overlayRoot;
    this.flip = flipY;
    this.maxDepth = maxDepth;
    this.info = { label: 'AR camera (ARCore)', camW: 0, camH: 0, depth: false, domOverlay: false };
    this.session = null;
    this._loop = this._loop.bind(this);
  }

  async start({ onFrame, onEnd }) {
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    // requestSession must be the first await so it still counts as a user gesture.
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local', 'camera-access'],
      optionalFeatures: ['dom-overlay', 'depth-sensing', 'hit-test'],
      domOverlay: { root: this.overlayRoot },
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
    });
    this.session = session;
    const feats = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
    this.info.depth = feats ? feats.includes('depth-sensing') : !!session.depthUsage;
    this.info.domOverlay = !!session.domOverlayState;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { alpha: true, antialias: false }) });
    this.refSpace = await session.requestReferenceSpace('local');
    // ARCore may move the origin after losing tracking; the app then re-checks its alignment.
    this.resetPending = false;
    if (this.refSpace.addEventListener) this.refSpace.addEventListener('reset', () => (this.resetPending = true));
    // Hit testing against ARCore's planes: used to find the floor when marking the scan area.
    this.hitSource = null;
    if (!feats || feats.includes('hit-test')) {
      try {
        const viewer = await session.requestReferenceSpace('viewer');
        this.hitSource = await session.requestHitTestSource({ space: viewer });
      } catch {
        this.hitSource = null;
      }
    }
    this.frameNo = 0;
    this.binding = new XRWebGLBinding(session, gl);
    this.reader = new TextureReader(gl);
    this.overlay = new Overlay3D(gl);

    // Taps on our HUD must not also count as AR "select" events.
    this._beforeSelect = (e) => e.preventDefault();
    this.overlayRoot.addEventListener('beforexrselect', this._beforeSelect);

    session.addEventListener('end', () => {
      this.session = null;
      this.overlayRoot.removeEventListener('beforexrselect', this._beforeSelect);
      try {
        this.reader.dispose();
      } catch {}
      if (this.onEnd) this.onEnd();
    });
    session.requestAnimationFrame(this._loop);
  }

  stop() {
    if (this.session) this.session.end().catch(() => {});
  }

  setFlip(f) {
    this.flip = f;
  }

  _loop(time, frame) {
    const session = frame.session;
    session.requestAnimationFrame(this._loop);
    const gl = this.gl;
    this.reader.poll();

    const t = time / 1000;
    const viewerPose = frame.getViewerPose(this.refSpace);
    const fi = {
      t,
      pose: null,
      trackState: 'lost',
      intr: null,
      depth: null,
      hit: null,
      reset: false,
      requestAnalysis: null,
      requestCandidate: null,
      toScreen: null,
    };
    this.frameNo++;

    let view = null;
    if (viewerPose && viewerPose.views.length) {
      view = viewerPose.views[0];
      const pose = new Float32Array(view.transform.matrix);
      fi.pose = pose;
      fi.trackState = viewerPose.emulatedPosition ? 'limited' : 'ok';
      if (this.resetPending) {
        fi.reset = true;
        this.resetPending = false;
      }
      const P = view.projectionMatrix;
      const cam = view.camera;
      let camTex = null;
      if (cam) {
        try {
          camTex = this.binding.getCameraImage(cam);
        } catch {
          camTex = null;
        }
      }
      if (camTex && cam.width > 0) {
        const cw = cam.width, ch = cam.height;
        this.info.camW = cw;
        this.info.camH = ch;
        fi.intr = intrinsicsFromProjection(P, cw, ch);
        const as = analysisSize(cw, ch);
        const flip = this.flip;
        const grayOf = (r) => {
          const gray = rgbaToGray(r.rgba, r.w, r.h);
          r.recycle();
          return gray;
        };
        fi.requestAnalysis = () => this.reader.read(camTex, as.w, as.h, flip).then((r) => ({ gray: grayOf(r), w: r.w, h: r.h }));
        fi.requestCandidate = () => {
          const small = this.reader.read(camTex, as.w, as.h, flip);
          const full = this.reader.read(camTex, cw, ch, flip);
          return Promise.all([small, full]).then(([s, f]) => ({
            gray: grayOf(s),
            w: s.w,
            h: s.h,
            image: new RgbaImage(f.rgba, f.w, f.h, f.recycle),
          }));
        };
      }

      // Depth (ARCore depth-from-motion), valid only inside this callback.
      if (this.info.depth) {
        let depthInfo = null;
        try {
          depthInfo = frame.getDepthInformation(view);
        } catch {
          depthInfo = null;
        }
        if (depthInfo) fi.depth = makeDepthSampler(depthInfo, view, pose, this.maxDepth);
      }
      // Coarse depth image for hiding overlay markers behind real surfaces.
      if (this.frameNo % 4 === 0) this.overlay.setOcclusion(fi.depth ? fi.depth.raw(32, 24, 0.1, 20) : null, 32, 24);

      if (this.hitSource) {
        try {
          const hits = frame.getHitTestResults(this.hitSource);
          const hp = hits.length ? hits[0].getPose(this.refSpace) : null;
          if (hp) {
            const m = hp.transform.matrix;
            fi.hit = { p: [m[12], m[13], m[14]], n: [m[4], m[5], m[6]] }; // pose y axis = surface normal
          }
        } catch {}
      }

      // Screen projection for HUD arrows (DOM overlay covers the whole screen).
      const sw = window.innerWidth, sh = window.innerHeight;
      const di = intrinsicsFromProjection(P, sw, sh);
      fi.toScreen = (p, isDir) => screenProject(pose, di, p, isDir);
      fi.displayIntr = di;
    }

    try {
      this.onFrame(fi);
    } catch (e) {
      console.error(e);
    }

    // Draw the 3D overlay into the AR layer (the camera feed is composited by the browser).
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (view && fi.pose) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      this.overlay.draw(mat4InvertRigid(fi.pose), view.projectionMatrix, [vp.x, vp.y, vp.width, vp.height], t);
    }
  }
}

/** Samples ARCore depth on grids and turns it into world points (flying pixels removed). */
function makeDepthSampler(depthInfo, view, pose, maxDepth) {
  const P = view.projectionMatrix;
  const get =
    typeof depthInfo.getDepthInMeters === 'function'
      ? (u, v) => depthInfo.getDepthInMeters(u, v)
      : typeof depthInfo.getDepth === 'function'
        ? (u, v) => depthInfo.getDepth(u, v)
        : null;
  if (!get) return null;
  const sample = (u, v) => {
    try {
      return get(u, v) || 0;
    } catch {
      return 0;
    }
  };
  return {
    /** Median depth over a coarse grid (metres), or 0. */
    median(nx = 9, ny = 7) {
      const ds = [];
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const d = sample((i + 0.5) / nx, (j + 0.5) / ny);
          if (d > 0.1 && d < 15) ds.push(d);
        }
      }
      if (ds.length < 6) return 0;
      ds.sort((a, b) => a - b);
      return ds[ds.length >> 1];
    },
    /** Planar depth on an nx x ny grid (top-left origin), 0 outside [minD, maxD]. */
    raw(nx, ny, minD = 0.25, maxD = maxDepth) {
      const D = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const d = sample((i + 0.5) / nx, (j + 0.5) / ny);
          if (d > minD && d < maxD) D[j * nx + i] = d;
        }
      }
      return D;
    },
    /** World points on an nx x ny grid with their image uv and the filtered depth image. */
    grid(nx, ny, minD = 0.25, maxD = maxDepth) {
      return depthToPoints(this.raw(nx, ny, minD, maxD), nx, ny, unprojectGL(P), pose);
    },
  };
}
