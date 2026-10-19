// WebGL2 helpers: shader compilation and asynchronous texture readback (PBO + fence),
// used to pull AR camera frames off the GPU without stalling the XR render loop.

export function compileProgram(gl, vsSrc, fsSrc) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + log);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

const COPY_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform float uFlip;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlip));
  outColor = vec4(texture(uTex, uv).rgb, 1.0);
}`;

/**
 * Copies a texture into an offscreen framebuffer at a chosen size and reads it back asynchronously.
 * With flip = 1 the result rows are top-down (image convention) for a GL-upright source texture.
 */
export class TextureReader {
  constructor(gl) {
    this.gl = gl;
    this.prog = compileProgram(gl, COPY_VS, COPY_FS);
    this.uTex = gl.getUniformLocation(this.prog, 'uTex');
    this.uFlip = gl.getUniformLocation(this.prog, 'uFlip');
    this.targets = new Map(); // "w x h" -> {fbo, tex}
    this.pending = [];
    this.vao = gl.createVertexArray();
  }

  _target(w, h) {
    const key = w + 'x' + h;
    let t = this.targets.get(key);
    if (t) return t;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { fbo, tex };
    this.targets.set(key, t);
    return t;
  }

  /**
   * Queue a readback of `srcTex` resized to w x h. Must be called while srcTex is valid
   * (for XR camera images: inside the XR animation frame). Resolves with RGBA bytes.
   */
  read(srcTex, w, h, flip = true) {
    const gl = this.gl;
    const target = this._target(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uTex, 0);
    gl.uniform1f(this.uFlip, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return new Promise((resolve, reject) => {
      this.pending.push({ pbo, sync, w, h, resolve, reject, age: 0 });
    });
  }

  /** Call once per frame: completes finished readbacks. */
  poll() {
    const gl = this.gl;
    if (!this.pending.length) return;
    const still = [];
    for (const p of this.pending) {
      const st = gl.clientWaitSync(p.sync, 0, 0);
      p.age++;
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED || p.age > 30) {
        const out = new Uint8Array(p.w * p.h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(p.sync);
        gl.deleteBuffer(p.pbo);
        p.resolve({ rgba: out, w: p.w, h: p.h });
      } else {
        still.push(p);
      }
    }
    this.pending = still;
  }

  dispose() {
    const gl = this.gl;
    for (const p of this.pending) {
      gl.deleteSync(p.sync);
      gl.deleteBuffer(p.pbo);
      p.reject(new Error('disposed'));
    }
    this.pending = [];
    for (const t of this.targets.values()) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.targets.clear();
  }
}
