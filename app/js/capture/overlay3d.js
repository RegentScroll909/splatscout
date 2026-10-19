// 3D overlay drawn on top of the camera view: coverage voxels painted onto real surfaces,
// markers where photos were taken, direction targets (camera mode) and the "go here" beacon.

import { compileProgram } from '../sources/gpu.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in float aSize;
uniform mat4 uView, uProj;
uniform float uScale;
uniform float uPulse;
out vec4 vCol;
out float vRing;
void main() {
  vec4 vp = uView * vec4(aPos, 1.0);
  gl_Position = uProj * vp;
  float s = abs(aSize);
  float px = s * uScale / max(0.05, -vp.z);
  if (aSize < 0.0) px *= 1.0 + 0.25 * uPulse;
  gl_PointSize = clamp(px, 2.0, 96.0);
  vRing = aSize < 0.0 ? 1.0 : 0.0;
  // Fade far points so the near surroundings dominate.
  float fade = clamp(1.4 - (-vp.z) / 9.0, 0.25, 1.0);
  vCol = vec4(aCol.rgb, aCol.a * fade);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 vCol;
in float vRing;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float a = vCol.a;
  if (vRing > 0.5) a *= smoothstep(0.55, 0.7, r) * (1.0 - smoothstep(0.9, 1.0, r));
  else a *= 1.0 - smoothstep(0.75, 1.0, r);
  outColor = vec4(vCol.rgb * a, a);
}`;

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
uniform mat4 uView, uProj;
out vec4 vCol;
void main() { vCol = aCol; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 outColor;
void main() { outColor = vec4(vCol.rgb * vCol.a, vCol.a); }`;

export const QUALITY_COLORS = [
  [0.45, 0.6, 1.0, 0.18], // seen, never photographed
  [1.0, 0.27, 0.27, 0.7], // 1 angle
  [1.0, 0.74, 0.16, 0.5], // 2 angles
  [0.24, 0.86, 0.47, 0.28], // 3+ angles
];
// Dot size as a fraction of the voxel size: problems are big, finished areas recede.
const QUALITY_SIZE = [0.22, 0.42, 0.34, 0.24];

class Batch {
  constructor(gl, withSize) {
    this.gl = gl;
    this.withSize = withSize;
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    this.count = 0;
    this.stride = withSize ? 8 : 7;
  }
  set(data) {
    const gl = this.gl;
    this.count = data.length / this.stride;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const s = this.stride * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, s, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, s, 12);
    if (this.withSize) {
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, s, 28);
    } else {
      gl.disableVertexAttribArray(2);
    }
    gl.bindVertexArray(null);
  }
}

export class Overlay3D {
  constructor(gl) {
    this.gl = gl;
    this.pointProg = compileProgram(gl, VS, FS);
    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS);
    this.pu = {
      view: gl.getUniformLocation(this.pointProg, 'uView'),
      proj: gl.getUniformLocation(this.pointProg, 'uProj'),
      scale: gl.getUniformLocation(this.pointProg, 'uScale'),
      pulse: gl.getUniformLocation(this.pointProg, 'uPulse'),
    };
    this.lu = {
      view: gl.getUniformLocation(this.lineProg, 'uView'),
      proj: gl.getUniformLocation(this.lineProg, 'uProj'),
    };
    this.voxels = new Batch(gl, true);
    this.markers = new Batch(gl, true);
    this.dots = new Batch(gl, true);
    this.target = new Batch(gl, true);
    this.lines = new Batch(gl, false);
    this.visible = { voxels: true, markers: true, dots: true };
  }

  /** Coverage voxels: positions (xyz) and quality 0..3. */
  setVoxels(pos, qual, voxelSize) {
    const n = qual.length;
    const d = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const c = QUALITY_COLORS[qual[i]];
      d.set([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], c[0], c[1], c[2], c[3], voxelSize * QUALITY_SIZE[qual[i]]], i * 8);
    }
    this.voxels.set(d);
  }

  /** Photo positions with short view-direction ticks. */
  setKeyframes(list) {
    const pts = new Float32Array(list.length * 8);
    const ln = new Float32Array(list.length * 14);
    list.forEach((k, i) => {
      const c = k.flagged ? [1, 0.55, 0.2, 0.9] : [0.35, 0.85, 1.0, 0.9];
      pts.set([k.pos[0], k.pos[1], k.pos[2], ...c, 0.045], i * 8);
      ln.set([k.pos[0], k.pos[1], k.pos[2], ...c, k.pos[0] + k.fwd[0] * 0.18, k.pos[1] + k.fwd[1] * 0.18, k.pos[2] + k.fwd[2] * 0.18, c[0], c[1], c[2], 0.5], i * 14);
    });
    this.markers.set(pts);
    this.lines.set(ln);
  }

  /** Direction targets around the viewer (camera mode): dirs (unit vectors), counts, centre. */
  setDirectionDots(dirs, counts, center, targetIndex, need = 2) {
    const R = 2.5;
    const d = new Float32Array(dirs.length * 8);
    dirs.forEach((v, i) => {
      const n = counts[i];
      const c = n >= need ? [0.24, 0.86, 0.47, 0.55] : n > 0 ? [1.0, 0.74, 0.16, 0.75] : [1, 1, 1, 0.55];
      const size = i === targetIndex ? -0.16 : n === 0 ? -0.07 : 0.07;
      d.set([center[0] + v[0] * R, center[1] + v[1] * R, center[2] + v[2] * R, ...c, size], i * 8);
    });
    this.dots.set(d);
  }

  clearDirectionDots() {
    this.dots.set(new Float32Array(0));
  }

  /** Pulsing beacon at a world point (or null). */
  setTarget(p, size = 0.45) {
    if (!p) return this.target.set(new Float32Array(0));
    this.target.set(new Float32Array([p[0], p[1], p[2], 0.2, 0.9, 1.0, 0.95, -size, p[0], p[1], p[2], 0.2, 0.9, 1.0, 0.9, size * 0.18]));
  }

  draw(view, proj, viewportH, t) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const scale = (proj[5] * viewportH) / 2;

    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lu.view, false, view);
    gl.uniformMatrix4fv(this.lu.proj, false, proj);
    if (this.visible.markers && this.lines.count) {
      gl.bindVertexArray(this.lines.vao);
      gl.drawArrays(gl.LINES, 0, this.lines.count);
    }

    gl.useProgram(this.pointProg);
    gl.uniformMatrix4fv(this.pu.view, false, view);
    gl.uniformMatrix4fv(this.pu.proj, false, proj);
    gl.uniform1f(this.pu.scale, scale);
    gl.uniform1f(this.pu.pulse, 0.5 + 0.5 * Math.sin(t * 5));
    const batches = [];
    if (this.visible.voxels) batches.push(this.voxels);
    if (this.visible.markers) batches.push(this.markers);
    if (this.visible.dots) batches.push(this.dots);
    batches.push(this.target);
    for (const b of batches) {
      if (!b.count) continue;
      gl.bindVertexArray(b.vao);
      gl.drawArrays(gl.POINTS, 0, b.count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}
