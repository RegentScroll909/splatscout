// Device orientation -> camera rotation (orientation-only tracking for camera mode).

import { DEG } from '../core/math.js';

/** iOS needs an explicit permission prompt from a user gesture. */
export async function requestOrientationPermission() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      if ((await DOE.requestPermission()) !== 'granted') return false;
    }
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') await DME.requestPermission().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Counter-clockwise rotation of the screen content relative to the device's natural orientation.
 * window.orientation uses this convention on both iOS and Android; screen.orientation.angle
 * differs between them (WebKit reports clockwise), so it is only a fallback.
 */
export function screenAngleCCW() {
  if (typeof window.orientation === 'number') return window.orientation;
  const a = (screen.orientation && screen.orientation.angle) || 0;
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  return isApple ? -a : a;
}

export class OrientationTracker {
  constructor() {
    this.last = null;
    this._h = (e) => {
      if (e.alpha == null && e.beta == null) return;
      this.last = { alpha: e.alpha || 0, beta: e.beta || 0, gamma: e.gamma || 0, t: performance.now() / 1000 };
    };
  }
  start() {
    window.addEventListener('deviceorientation', this._h);
  }
  stop() {
    window.removeEventListener('deviceorientation', this._h);
  }
  get available() {
    return !!this.last;
  }
  get fresh() {
    return this.last && performance.now() / 1000 - this.last.t < 0.5;
  }

  /** Camera-to-world pose (rotation only), world Y-up, rear camera, current screen rotation. */
  pose() {
    if (!this.last) return null;
    return poseFromEuler(this.last.alpha, this.last.beta, this.last.gamma, screenAngleCCW());
  }
}

/**
 * W3C deviceorientation (Z-X'-Y'' intrinsic Euler, device -> East/North/Up) to a camera pose.
 * World is Y-up: X = east, Y = up, Z = south.
 */
export function poseFromEuler(alphaDeg, betaDeg, gammaDeg, screenCCWDeg) {
  const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG;
  const cX = Math.cos(b), sX = Math.sin(b), cY = Math.cos(g), sY = Math.sin(g), cZ = Math.cos(a), sZ = Math.sin(a);
  // Device -> ENU, row-major.
  const r00 = cZ * cY - sZ * sX * sY, r01 = -cX * sZ, r02 = cY * sZ * sX + cZ * sY;
  const r10 = cY * sZ + cZ * sX * sY, r11 = cZ * cX, r12 = sZ * sY - cZ * cY * sX;
  const r20 = -cX * sY, r21 = sX, r22 = cX * cY;
  // ENU -> Y-up world: rows (E, U, -N).
  const W = [r00, r01, r02, r20, r21, r22, -r10, -r11, -r12];
  // Camera axes in device coordinates for the current screen rotation.
  const th = screenCCWDeg * DEG, c = Math.cos(th), s = Math.sin(th);
  const D = [
    [c, -s, 0], // camera x (image right)
    [s, c, 0], // camera y (image up)
    [0, 0, 1], // camera z (towards the user; camera looks along -z)
  ];
  const m = new Float32Array(16);
  for (let col = 0; col < 3; col++) {
    const d = D[col];
    for (let row = 0; row < 3; row++) {
      m[col * 4 + row] = W[row * 3] * d[0] + W[row * 3 + 1] * d[1] + W[row * 3 + 2] * d[2];
    }
  }
  m[15] = 1;
  return m;
}
