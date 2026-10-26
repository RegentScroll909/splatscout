// 3D overlay drawn on top of the camera view: coverage painted onto real surfaces, markers where
// photos were taken, direction targets (camera mode), the scan-area fence, and the guide (floor path,
// "stand here" rings, ghost phone). Anything behind a real surface is faded using live depth.

import { compileProgram } from '../sources/gpu.js';

// Fades fragments that lie behind the surface the depth sensor sees at that pixel.
const OCCLUSION = `
uniform highp sampler2D uOcc;
uniform float uOccOn;
uniform vec4 uViewport;
float occlusion(float depth) {
  if (uOccOn < 0.5) return 1.0;
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  float m = texture(uOcc, vec2(uv.x, 1.0 - uv.y)).r;
  if (m <= 0.0) return 1.0;
  return depth > m + 0.12 + 0.06 * m ? 0.1 : 1.0;
}`;

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in float aSize;
uniform mat4 uView, uProj;
uniform float uScale;
uniform float uPulse;
out vec4 vCol;
out float vRing;
out float vDepth;
void main() {
  vec4 vp = uView * vec4(aPos, 1.0);
  gl_Position = uProj * vp;
  vDepth = -vp.z;
  float s = abs(aSize);
  float px = s * uScale / max(0.05, -vp.z);
  if (aSize < 0.0) px *= 1.0 + 0.25 * uPulse;
  vRing = aSize < 0.0 ? 1.0 : 0.0;
  gl_PointSize = clamp(px, 2.0, vRing > 0.5 ? 96.0 : 40.0);
  // Fade far points so the near surroundings dominate, and points right in front of the lens.
  float fade = clamp(1.4 - (-vp.z) / 9.0, 0.25, 1.0) * clamp((-vp.z - 0.25) / 0.5, 0.0, 1.0);
  vCol = vec4(aCol.rgb, aCol.a * fade);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 vCol;
in float vRing;
in float vDepth;
out vec4 outColor;
${OCCLUSION}
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float a = vCol.a * occlusion(vDepth);
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

// Triangles with an animation parameter: >= 0 is a distance along a path (a light pulse travels
// along it in the walking direction), -2 breathes, anything else is static.
const TRI_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in float aWave;
uniform mat4 uView, uProj;
out vec4 vCol;
out float vWave;
out float vDepth;
void main() {
  vec4 vp = uView * vec4(aPos, 1.0);
  gl_Position = uProj * vp;
  vDepth = -vp.z;
  vCol = aCol;
  vWave = aWave;
}`;

const TRI_FS = `#version 300 es
precision highp float;
in vec4 vCol;
in float vWave;
in float vDepth;
uniform float uTime;
out vec4 outColor;
${OCCLUSION}
void main() {
  float a = vCol.a;
  if (vWave >= 0.0) {
    float ph = fract((vWave - uTime * 0.9) / 1.6);
    a *= 0.35 + 0.65 * smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.3, 0.55, ph));
  } else if (vWave < -1.5) {
    a *= 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 4.0));
  }
  a *= occlusion(vDepth);
  outColor = vec4(vCol.rgb * a, a);
}`;

export const QUALITY_COLORS = [
  [0.47, 0.59, 0.75, 0.2], // seen, never photographed
  [0.95, 0.38, 0.38, 0.72], // 1 angle
  [0.96, 0.72, 0.26, 0.52], // 2 angles
  [0.2, 0.83, 0.6, 0.3], // 3+ angles
  [0.6, 0.62, 0.66, 0.1], // outside the scan area / skipped
];
// Dot size as a fraction of the voxel size: problems are big, finished areas recede.
const QUALITY_SIZE = [0.22, 0.42, 0.34, 0.24, 0.16];

class Batch {
  constructor(gl, floats, attribs) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    this.count = 0;
    this.stride = floats;
    this.attribs = attribs; // [[location, size, offsetFloats]]
  }
  set(data) {
    const gl = this.gl;
    this.count = data.length / this.stride;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    for (let loc = 0; loc < 3; loc++) gl.disableVertexAttribArray(loc);
    for (const [loc, size, off] of this.attribs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.stride * 4, off * 4);
    }
    gl.bindVertexArray(null);
  }
}

const POINT_ATTRIBS = [[0, 3, 0], [1, 4, 3], [2, 1, 7]];
const LINE_ATTRIBS = [[0, 3, 0], [1, 4, 3]];

export class Overlay3D {
  constructor(gl) {
    this.gl = gl;
    this.pointProg = compileProgram(gl, VS, FS);
    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS);
    this.triProg = compileProgram(gl, TRI_VS, TRI_FS);
    const loc = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
    this.pu = loc(this.pointProg, ['uView', 'uProj', 'uScale', 'uPulse', 'uOcc', 'uOccOn', 'uViewport']);
    this.lu = loc(this.lineProg, ['uView', 'uProj']);
    this.tu = loc(this.triProg, ['uView', 'uProj', 'uTime', 'uOcc', 'uOccOn', 'uViewport']);
    this.voxels = new Batch(gl, 8, POINT_ATTRIBS);
    this.markers = new Batch(gl, 8, POINT_ATTRIBS);
    this.dots = new Batch(gl, 8, POINT_ATTRIBS);
    this.target = new Batch(gl, 8, POINT_ATTRIBS);
    this.lines = new Batch(gl, 7, LINE_ATTRIBS);
    this.tris = new Map(); // name -> Batch (triangles)
    this.visible = { voxels: true, markers: true, dots: true, guide: true };
    this.occTex = gl.createTexture();
    this.occOn = false;
  }

  /** Coverage voxels: surface positions (xyz) and quality 0..3 (4 = outside the scan area). */
  setVoxels(pos, qual, voxelSize) {
    const n = qual.length;
    const d = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const q = Math.min(4, qual[i]);
      const c = QUALITY_COLORS[q];
      d.set([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], c[0], c[1], c[2], c[3], voxelSize * QUALITY_SIZE[q]], i * 8);
    }
    this.voxels.set(d);
  }

  /** Photo positions with short view-direction ticks. */
  setKeyframes(list) {
    const pts = new Float32Array(list.length * 8);
    const ln = new Float32Array(list.length * 14);
    list.forEach((k, i) => {
      const c = k.flagged ? [0.96, 0.6, 0.3, 0.9] : [0.24, 0.86, 1.0, 0.9];
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
    this.target.set(new Float32Array([p[0], p[1], p[2], 0.24, 0.86, 1.0, 0.95, -size, p[0], p[1], p[2], 0.24, 0.86, 1.0, 0.9, size * 0.18]));
  }

  /** Named triangle layer (8 floats per vertex: xyz, rgba, wave). Empty array or null clears it. */
  setTris(name, data) {
    let b = this.tris.get(name);
    if (!b) this.tris.set(name, (b = new Batch(this.gl, 8, POINT_ATTRIBS)));
    b.set(data || new Float32Array(0));
  }

  /** Coarse depth image (planar metres, rows from the top, 0 = unknown) of the current view, or null. */
  setOcclusion(D, nx, ny) {
    const gl = this.gl;
    if (!D) {
      this.occOn = false;
      return;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.occOn = true;
  }

  /**
   * @param view world-to-camera 4x4
   * @param proj projection 4x4
   * @param viewport [x, y, width, height] in framebuffer pixels
   * @param t time in seconds (animations)
   */
  draw(view, proj, viewport, t) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const scale = (proj[5] * viewport[3]) / 2;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex);
    gl.activeTexture(gl.TEXTURE0);

    if (this.visible.guide) {
      gl.useProgram(this.triProg);
      gl.uniformMatrix4fv(this.tu.uView, false, view);
      gl.uniformMatrix4fv(this.tu.uProj, false, proj);
      gl.uniform1f(this.tu.uTime, t);
      gl.uniform1i(this.tu.uOcc, 1);
      gl.uniform1f(this.tu.uOccOn, this.occOn ? 1 : 0);
      gl.uniform4f(this.tu.uViewport, viewport[0], viewport[1], viewport[2], viewport[3]);
      for (const b of this.tris.values()) {
        if (!b.count) continue;
        gl.bindVertexArray(b.vao);
        gl.drawArrays(gl.TRIANGLES, 0, b.count);
      }
    }

    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lu.uView, false, view);
    gl.uniformMatrix4fv(this.lu.uProj, false, proj);
    if (this.visible.markers && this.lines.count) {
      gl.bindVertexArray(this.lines.vao);
      gl.drawArrays(gl.LINES, 0, this.lines.count);
    }

    gl.useProgram(this.pointProg);
    gl.uniformMatrix4fv(this.pu.uView, false, view);
    gl.uniformMatrix4fv(this.pu.uProj, false, proj);
    gl.uniform1f(this.pu.uScale, scale);
    gl.uniform1f(this.pu.uPulse, 0.5 + 0.5 * Math.sin(t * 5));
    gl.uniform1i(this.pu.uOcc, 1);
    gl.uniform1f(this.pu.uOccOn, this.occOn ? 1 : 0);
    gl.uniform4f(this.pu.uViewport, viewport[0], viewport[1], viewport[2], viewport[3]);
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
