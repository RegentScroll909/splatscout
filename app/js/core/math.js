// Small linear-algebra helpers.
//
// Conventions used across SplatScout:
//  * World space is Y-up, right-handed (same as WebXR 'local' space).
//  * A pose is a column-major 4x4 camera-to-world matrix using the OpenGL camera
//    convention: camera +X = image right, +Y = image up, camera looks down -Z.
//  * Intrinsics {fx, fy, cx, cy, w, h} are in pixels with a top-left image origin
//    (OpenCV/COLMAP convention).

export const DEG = Math.PI / 180;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** Angle in radians between two unit vectors. */
export function angleBetween(a, b) {
  return Math.acos(clamp(v3.dot(a, b), -1, 1));
}

export function mat4Identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mat4Mul(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Inverse of a rigid transform (rotation + translation). */
export function mat4InvertRigid(m, out = new Float32Array(16)) {
  // R^T
  out[0] = m[0]; out[1] = m[4]; out[2] = m[8]; out[3] = 0;
  out[4] = m[1]; out[5] = m[5]; out[6] = m[9]; out[7] = 0;
  out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
  return out;
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDir(m, d) {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

export const poseRight = (m) => [m[0], m[1], m[2]];
export const poseUp = (m) => [m[4], m[5], m[6]];
export const poseForward = (m) => [-m[8], -m[9], -m[10]];
export const posePosition = (m) => [m[12], m[13], m[14]];

/** Build a camera-to-world pose from position, forward and an approximate up vector. */
export function poseLookDir(pos, fwd, upHint = [0, 1, 0]) {
  const f = v3.norm(fwd);
  let r = v3.cross(f, upHint);
  if (v3.len(r) < 1e-6) r = v3.cross(f, [0, 0, 1]);
  r = v3.norm(r);
  const u = v3.cross(r, f);
  const m = new Float32Array(16);
  m[0] = r[0]; m[1] = r[1]; m[2] = r[2];
  m[4] = u[0]; m[5] = u[1]; m[6] = u[2];
  m[8] = -f[0]; m[9] = -f[1]; m[10] = -f[2];
  m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2]; m[15] = 1;
  return m;
}

/** Relative rotation angle (radians) between the rotation parts of two poses. */
export function rotationDelta(a, b) {
  // trace(Ra^T Rb)
  let tr = 0;
  for (let c = 0; c < 3; c++) {
    tr += a[c * 4] * b[c * 4] + a[c * 4 + 1] * b[c * 4 + 1] + a[c * 4 + 2] * b[c * 4 + 2];
  }
  return Math.acos(clamp((tr - 1) / 2, -1, 1));
}

/**
 * Angular velocity (rad/s) expressed in the camera frame of pose `a`, from pose a to pose b over dt.
 * Returns [wx, wy, wz] (camera right, up, back axes).
 */
export function angularVelocity(a, b, dt) {
  // R_rel = Ra^T * Rb  (3x3), vee(log) ~ 0.5*(R32-R23, R13-R31, R21-R12) for small angles.
  const r = new Float64Array(9); // row-major R_rel
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      // Ra^T[i][k] = Ra[k][i] = a[i*4 + k] (column-major: element (row k, col i) is a[i*4+k])
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 4 + k] * b[j * 4 + k];
      r[i * 3 + j] = s;
    }
  }
  const ang = Math.acos(clamp((r[0] + r[4] + r[8] - 1) / 2, -1, 1));
  let x = r[7] - r[5], y = r[2] - r[6], z = r[3] - r[1];
  const s = Math.hypot(x, y, z);
  if (s < 1e-9 || dt <= 0) return [0, 0, 0];
  const k = ang / s / dt;
  return [x * k, y * k, z * k];
}

/** OpenGL projection matrix from pinhole intrinsics (top-left pixel origin). */
export function projectionFromIntrinsics({ fx, fy, cx, cy, w, h }, near = 0.05, far = 100) {
  const m = new Float32Array(16);
  m[0] = (2 * fx) / w;
  m[5] = (2 * fy) / h;
  m[8] = 1 - (2 * cx) / w;
  m[9] = (2 * cy) / h - 1;
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

/** Pinhole intrinsics for an image of size w x h from an OpenGL projection matrix. */
export function intrinsicsFromProjection(P, w, h) {
  return {
    fx: (P[0] * w) / 2,
    fy: (P[5] * h) / 2,
    cx: ((1 - P[8]) * w) / 2,
    cy: ((1 + P[9]) * h) / 2,
    w,
    h,
  };
}

/** Horizontal / vertical field of view in degrees from intrinsics. */
export function fovFromIntrinsics({ fx, fy, w, h }) {
  return { h: (2 * Math.atan(w / 2 / fx)) / DEG, v: (2 * Math.atan(h / 2 / fy)) / DEG };
}

/**
 * Project a world point into pixel coordinates using a pose and intrinsics.
 * Returns null when the point is behind the camera.
 */
export function projectPoint(pose, intr, p) {
  const vx = p[0] - pose[12], vy = p[1] - pose[13], vz = p[2] - pose[14];
  const x = pose[0] * vx + pose[1] * vy + pose[2] * vz;
  const y = pose[4] * vx + pose[5] * vy + pose[6] * vz;
  const z = pose[8] * vx + pose[9] * vy + pose[10] * vz;
  if (z > -1e-4) return null;
  return [intr.cx + (intr.fx * x) / -z, intr.cy - (intr.fy * y) / -z, -z];
}

/** Project a world direction (point at infinity). */
export function projectDir(pose, intr, d) {
  const x = pose[0] * d[0] + pose[1] * d[1] + pose[2] * d[2];
  const y = pose[4] * d[0] + pose[5] * d[1] + pose[6] * d[2];
  const z = pose[8] * d[0] + pose[9] * d[1] + pose[10] * d[2];
  if (z > -1e-4) return null;
  return [intr.cx + (intr.fx * x) / -z, intr.cy - (intr.fy * y) / -z];
}

/** Camera-space direction (OpenGL) of a world direction. */
export function worldDirToCamera(pose, d) {
  return [
    pose[0] * d[0] + pose[1] * d[1] + pose[2] * d[2],
    pose[4] * d[0] + pose[5] * d[1] + pose[6] * d[2],
    pose[8] * d[0] + pose[9] * d[1] + pose[10] * d[2],
  ];
}

/** Rotation matrix (column-major 3x3 inside a 4x4 pose) to quaternion [w, x, y, z]. */
export function quatFromRotation(m00, m01, m02, m10, m11, m12, m20, m21, m22) {
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  if (w < 0) return [-w / n, -x / n, -y / n, -z / n];
  return [w / n, x / n, y / n, z / n];
}

/** Azimuth (deg, 0 = initial forward -Z, +90 = right/+X) and elevation (deg) of a direction. */
export function dirToAzEl(d) {
  const az = Math.atan2(d[0], -d[2]) / DEG;
  const el = Math.asin(clamp(d[1], -1, 1)) / DEG;
  return [(az + 360) % 360, el];
}

export function azElToDir(azDeg, elDeg) {
  const a = azDeg * DEG, e = elDeg * DEG;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** Signed smallest difference between two angles in degrees, in (-180, 180]. */
export function angleDiffDeg(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const i = clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
  return s[i];
}
