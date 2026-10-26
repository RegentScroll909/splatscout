// Practice room: a procedurally textured classroom rendered with WebGL2, plus CPU ray casting
// for simulated depth. Used by Practice mode (desktop/phone) and for testing the capture pipeline.

import { compileProgram } from './gpu.js';
import { projectionFromIntrinsics, mat4InvertRigid, transformDir } from '../core/math.js';
import { depthToPoints, unprojectIntr } from '../core/depth.js';

export const ROOM = { min: [-4, 0, -3.5], max: [4, 3, 3.5] };

const FURNITURE = [
  { min: [-1.2, 0, -0.6], max: [1.2, 0.75, 0.6], color: [0.55, 0.38, 0.24] }, // table
  { min: [-3.98, 0, -2.6], max: [-3.5, 2.0, -0.6], color: [0.32, 0.36, 0.42] }, // shelf
  { min: [2.3, 0, -3.48], max: [3.6, 1.0, -2.95], color: [0.62, 0.6, 0.55] }, // cabinet
  { min: [1.8, 0, 1.4], max: [2.2, 3.0, 1.8], color: [0.74, 0.72, 0.7] }, // pillar
  { min: [-2.6, 0, 2.5], max: [-0.6, 0.8, 3.45], color: [0.18, 0.3, 0.52] }, // sofa
  { min: [-0.9, 0.75, -0.35], max: [-0.3, 1.05, 0.05], color: [0.8, 0.25, 0.2] }, // box on table
];

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in float aMat;
uniform mat4 uView, uProj;
out vec3 vPos; out vec3 vNrm; out vec3 vCol; flat out int vMat;
void main() {
  vPos = aPos; vNrm = aNrm; vCol = aCol; vMat = int(aMat + 0.5);
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNrm; in vec3 vCol; flat in int vMat;
uniform float uExposure;
out vec4 outColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash(i), b = hash(i + vec2(1, 0)), c = hash(i + vec2(0, 1)), d = hash(i + vec2(1, 1));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }

vec3 poster(vec2 f, float h) {
  // Each poster: coloured blocks, text-like stripes and noise: lots of matchable detail.
  vec3 c1 = vec3(hash(vec2(h, 1.0)), hash(vec2(h, 2.0)), hash(vec2(h, 3.0)));
  vec3 c2 = vec3(hash(vec2(h, 4.0)), hash(vec2(h, 5.0)), hash(vec2(h, 6.0)));
  vec2 g = floor(f * vec2(5.0 + floor(h * 4.0), 7.0));
  vec3 c = mix(c1, c2, step(0.5, hash(g + h * 13.0)));
  float stripes = step(0.55, fract(f.y * 28.0)) * step(0.35, hash(floor(f * vec2(9.0, 28.0)) + h));
  c = mix(c, vec3(0.08), stripes * step(0.62, f.y));
  c *= 0.8 + 0.4 * noise(f * 60.0 + h * 9.0);
  return c;
}

void main() {
  vec3 p = vPos, n = normalize(vNrm);
  vec3 col;
  bool emissive = false;
  if (vMat == 0) {
    // Walls
    vec2 uv = abs(n.x) > 0.5 ? p.zy : p.xy;
    vec3 base = n.x < -0.5 ? vec3(0.78, 0.74, 0.66) : n.x > 0.5 ? vec3(0.70, 0.75, 0.79)
              : n.z < -0.5 ? vec3(0.83, 0.81, 0.77) : vec3(0.77, 0.71, 0.68);
    bool blank = n.z < -0.5 && p.x > 0.4 && p.x < 3.9; // a plain painted wall section
    col = base * (blank ? 1.0 : 0.9 + fbm(uv * 18.0) * 0.12 + fbm(uv * 3.0) * 0.1);
    if (!blank) {
      vec2 cell = floor((uv + vec2(0.3, 0.0)) / vec2(1.7, 1.0));
      vec2 f = fract((uv + vec2(0.3, 0.0)) / vec2(1.7, 1.0));
      float h = hash(cell + n.xz * 7.0 + 3.0);
      if (p.y > 1.15 && p.y < 2.35 && h > 0.3 && f.x > 0.12 && f.x < 0.88) {
        vec2 pf = vec2((f.x - 0.12) / 0.76, (p.y - 1.15) / 1.2);
        col = (pf.x < 0.03 || pf.x > 0.97 || pf.y < 0.03 || pf.y > 0.97) ? vec3(0.12) : poster(pf, h);
      }
    }
    if (p.y < 0.12) col = vec3(0.25, 0.2, 0.18) * (0.85 + 0.3 * noise(uv * 40.0));
    if (abs(p.y - 0.95) < 0.025) col = vec3(0.45, 0.32, 0.22);
    // Window on the +X wall (faces -X)
    if (n.x < -0.5 && p.z > -1.5 && p.z < 1.0 && p.y > 0.9 && p.y < 2.3) {
      bool mullion = abs(p.z + 0.25) < 0.03 || abs(p.y - 1.6) < 0.03 || p.z < -1.46 || p.z > 0.96 || p.y < 0.94 || p.y > 2.26;
      col = mullion ? vec3(0.9) : vec3(1.6, 1.7, 1.85) * (0.95 + 0.1 * noise(p.zy * 3.0));
      emissive = !mullion;
    }
    // Door on the -X wall
    if (n.x > 0.5 && p.z > 1.0 && p.z < 2.0 && p.y < 2.1) {
      col = vec3(0.45, 0.3, 0.18) * (0.8 + 0.4 * fbm(vec2(p.z * 3.0, p.y * 40.0)));
      if (abs(p.z - 1.85) < 0.04 && abs(p.y - 1.0) < 0.04) col = vec3(0.85, 0.75, 0.3);
    }
  } else if (vMat == 1) {
    // Floor: wooden planks with a rug
    float plank = floor(p.z / 0.18);
    float off = hash(vec2(plank, 2.0)) * 2.0;
    float seg = floor((p.x + off) / 1.2);
    float tone = hash(vec2(plank, seg));
    col = mix(vec3(0.42, 0.28, 0.17), vec3(0.62, 0.45, 0.3), tone);
    col *= 0.8 + 0.35 * noise(vec2((p.x + off) * 3.0, p.z * 60.0));
    if (fract(p.z / 0.18) < 0.04 || fract((p.x + off) / 1.2) < 0.008) col *= 0.5;
    vec2 r = abs(p.xz - vec2(0.0, 0.0));
    if (r.x < 2.0 && r.y < 1.4) {
      vec2 g = floor(p.xz * 6.0);
      col = mix(vec3(0.5, 0.12, 0.15), vec3(0.85, 0.7, 0.35), step(0.5, hash(g))) * (0.8 + 0.3 * noise(p.xz * 30.0));
      if (r.x > 1.85 || r.y > 1.25) col = vec3(0.2, 0.15, 0.1);
    }
  } else if (vMat == 2) {
    // Ceiling tiles with light panels
    vec2 t = p.xz / 0.6;
    vec2 g = floor(t), f = fract(t);
    col = vec3(0.86) * (0.9 + 0.15 * noise(p.xz * 25.0));
    if (f.x < 0.03 || f.y < 0.03) col = vec3(0.55);
    if (mod(g.x, 3.0) == 1.0 && mod(g.y, 4.0) == 1.0) { col = vec3(1.25); emissive = true; }
  } else {
    // Furniture
    col = vCol * (0.8 + 0.4 * fbm(p.xz * 9.0 + p.y * 7.0));
    col *= 0.85 + 0.25 * step(0.5, fract((p.x + p.z) * 4.0 + p.y * 3.0)) * step(0.7, hash(floor(p.xz * 8.0 + p.y)));
  }
  if (!emissive) {
    vec3 L = vec3(0.0, 2.9, 0.0) - p;
    float d = length(L);
    float diff = max(dot(n, L / d), 0.0);
    float light = 0.5 + 0.65 * diff / (1.0 + 0.04 * d * d);
    // Soft darkening near floor-wall corners.
    float ao = clamp(min(p.y, 3.0 - p.y) * 2.5 + 0.55, 0.55, 1.0);
    col *= light * ao;
  }
  outColor = vec4(col * uExposure, 1.0);
}`;

function pushBox(out, min, max, mat, color, inward) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    // normal (outward), 4 corners
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [nrm, c] of faces) {
    const n = inward ? nrm.map((v) => -v) : nrm;
    let m = mat;
    if (inward) m = nrm[1] === -1 ? 1 : nrm[1] === 1 ? 2 : 0; // room: floor/ceiling/walls
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...c[i], ...n, ...color, m);
  }
}

export class DemoScene {
  constructor(gl) {
    this.gl = gl;
    this.prog = compileProgram(gl, VS, FS);
    this.uView = gl.getUniformLocation(this.prog, 'uView');
    this.uProj = gl.getUniformLocation(this.prog, 'uProj');
    this.uExposure = gl.getUniformLocation(this.prog, 'uExposure');
    const data = [];
    pushBox(data, ROOM.min, ROOM.max, 0, [1, 1, 1], true);
    for (const f of FURNITURE) pushBox(data, f.min, f.max, 3, f.color, false);
    const arr = new Float32Array(data);
    this.count = arr.length / 10;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    const stride = 40;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
    gl.bindVertexArray(null);
  }

  render(pose, intr, exposure = 1) {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uView, false, mat4InvertRigid(pose));
    gl.uniformMatrix4fv(this.uProj, false, projectionFromIntrinsics(intr, 0.05, 50));
    gl.uniform1f(this.uExposure, exposure);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
  }
}

/** Distance along a ray to the first surface of the room (or furniture). */
export function raycast(o, d) {
  // Inside the room: exit distance.
  let t = Infinity;
  for (let a = 0; a < 3; a++) {
    if (d[a] > 1e-9) t = Math.min(t, (ROOM.max[a] - o[a]) / d[a]);
    else if (d[a] < -1e-9) t = Math.min(t, (ROOM.min[a] - o[a]) / d[a]);
  }
  for (const f of FURNITURE) {
    let t0 = -Infinity, t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < f.min[a] || o[a] > f.max[a]) {
          t0 = Infinity;
          break;
        }
        continue;
      }
      let ta = (f.min[a] - o[a]) / d[a], tb = (f.max[a] - o[a]) / d[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
    }
    if (t0 <= t1 && t0 > 0 && t0 < t) t = t0;
  }
  return t;
}

/** Surface normal at a point on the room or furniture (for simulated AR hit tests). */
export function surfaceNormal(p) {
  const e = 1e-3;
  if (Math.abs(p[1] - ROOM.min[1]) < e) return [0, 1, 0];
  if (Math.abs(p[1] - ROOM.max[1]) < e) return [0, -1, 0];
  for (const f of FURNITURE) {
    if (p[0] < f.min[0] - e || p[0] > f.max[0] + e || p[1] < f.min[1] - e || p[1] > f.max[1] + e || p[2] < f.min[2] - e || p[2] > f.max[2] + e) continue;
    if (Math.abs(p[1] - f.max[1]) < e) return [0, 1, 0];
    if (Math.abs(p[0] - f.min[0]) < e) return [-1, 0, 0];
    if (Math.abs(p[0] - f.max[0]) < e) return [1, 0, 0];
    if (Math.abs(p[2] - f.min[2]) < e) return [0, 0, -1];
    if (Math.abs(p[2] - f.max[2]) < e) return [0, 0, 1];
  }
  if (Math.abs(p[0] - ROOM.min[0]) < e) return [1, 0, 0];
  if (Math.abs(p[0] - ROOM.max[0]) < e) return [-1, 0, 0];
  if (Math.abs(p[2] - ROOM.min[2]) < e) return [0, 0, 1];
  return [0, 0, -1];
}

/**
 * Simulated phone depth: planar depth per grid cell (0 = none). Like ARCore's smoothed depth it
 * has ~1% noise and blends depths across object edges (each sample averages two nearby rays), which
 * creates the "flying pixels" the real filter has to remove.
 */
export function depthImage(pose, intr, nx, ny, minD = 0.25, maxD = 6, smear = true) {
  const D = new Float32Array(nx * ny);
  const o = [pose[12], pose[13], pose[14]];
  const ray = (u, v) => {
    const dc = [(u * intr.w - intr.cx) / intr.fx, -(v * intr.h - intr.cy) / intr.fy, -1];
    return raycast(o, transformDir(pose, dc)); // dc has z = -1, so the ray parameter is planar depth
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = (i + 0.5) / nx, v = (j + 0.5) / ny;
      let d = ray(u, v);
      if (smear) d = 0.5 * (d + ray(u + (0.45 * ((i + j) % 2 ? 1 : -1)) / nx, v + (0.45 * (j % 2 ? 1 : -1)) / ny));
      d *= 1 + (Math.random() - 0.5) * 0.02;
      if (d > minD && d < maxD) D[j * nx + i] = d;
    }
  }
  return D;
}

/** Simulated depth grid: world points (flying pixels filtered like on the phone), image uv, depth image. */
export function depthGrid(pose, intr, nx, ny, minD = 0.25, maxD = 6) {
  return depthToPoints(depthImage(pose, intr, nx, ny, minD, maxD), nx, ny, unprojectIntr(intr), pose);
}
