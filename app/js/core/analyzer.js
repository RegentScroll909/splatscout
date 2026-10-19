// Per-frame image quality analysis on small grayscale images.
// Everything here is plain typed-array math so it is fast on phones and has no DOM dependency.

/** RGBA (Uint8/Uint8Clamped) -> 8-bit luma. */
export function rgbaToGray(rgba, w, h, out) {
  const n = w * h;
  if (!out || out.length !== n) out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

/** 2x2 box downsample. */
export function downsample2(src, w, h) {
  const w2 = w >> 1, h2 = h >> 1;
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w, r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const i = 2 * x;
      out[y * w2 + x] = (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1] + 2) >> 2;
    }
  }
  return { data: out, w: w2, h: h2 };
}

const GRID_X = 4, GRID_Y = 3;

/**
 * Analyze a grayscale frame (~640 px wide).
 * Returns exposure stats, a texture-robust sharpness score and a texture (feature density) score.
 */
export function analyzeImage(gray, w, h) {
  // --- Exposure histogram (subsampled) ---
  const hist = new Uint32Array(256);
  let sum = 0, count = 0;
  for (let y = 0; y < h; y += 2) {
    const row = y * w;
    for (let x = 0; x < w; x += 2) {
      const v = gray[row + x];
      hist[v]++;
      sum += v;
      count++;
    }
  }
  const mean = sum / count;
  let clipHi = 0, clipLo = 0;
  for (let v = 250; v < 256; v++) clipHi += hist[v];
  for (let v = 0; v <= 8; v++) clipLo += hist[v];
  clipHi /= count;
  clipLo /= count;
  const p05 = histPercentile(hist, count, 0.05);
  const p95 = histPercentile(hist, count, 0.95);

  // --- Sharpness: variance of the Laplacian per grid cell ---
  const cells = GRID_X * GRID_Y;
  const cs = new Float64Array(cells), cq = new Float64Array(cells), cn = new Float64Array(cells);
  const cw = w / GRID_X, ch = h / GRID_Y;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    const cy = Math.min(GRID_Y - 1, (y / ch) | 0) * GRID_X;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const c = gray[i];
      // Skip clipped pixels: blown highlights look "flat" and would bias the score.
      if (c >= 250) continue;
      const lap = 4 * c - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      const k = cy + Math.min(GRID_X - 1, (x / cw) | 0);
      cs[k] += lap;
      cq[k] += lap * lap;
      cn[k]++;
    }
  }
  const cellVar = new Float64Array(cells);
  let globalS = 0, globalQ = 0, globalN = 0;
  for (let k = 0; k < cells; k++) {
    if (cn[k] < 16) continue;
    const m = cs[k] / cn[k];
    cellVar[k] = cq[k] / cn[k] - m * m;
    globalS += cs[k]; globalQ += cq[k]; globalN += cn[k];
  }
  const sortedVar = Array.from(cellVar).sort((a, b) => b - a);
  // Average of the 3 most detailed cells: robust to blank walls occupying part of the frame.
  const sharp = (sortedVar[0] + sortedVar[1] + sortedVar[2]) / 3;
  const gm = globalN ? globalS / globalN : 0;
  const sharpGlobal = globalN ? globalQ / globalN - gm * gm : 0;

  // --- Texture: Shi-Tomasi corner strength per 8x8 cell on a half-resolution image ---
  const half = downsample2(gray, w, h);
  const tex = textureScore(half.data, half.w, half.h);

  return {
    mean,
    clipHi,
    clipLo,
    p05,
    p95,
    contrast: p95 - p05,
    sharp,
    sharpGlobal,
    texture: tex.score,
    textureSpread: tex.spread,
    textureGrid: tex.grid,
  };
}

function histPercentile(hist, count, p) {
  const target = count * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/**
 * Fraction of 8x8 cells containing a strong corner (min eigenvalue of the structure tensor),
 * plus the fraction of a coarse 4x3 grid that has at least two such cells ("spread").
 */
export function textureScore(g, w, h) {
  const C = 8;
  const nx = Math.floor((w - 2) / C), ny = Math.floor((h - 2) / C);
  let strong = 0;
  const region = new Uint16Array(GRID_X * GRID_Y);
  const grid = new Uint8Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      let a = 0, b = 0, c = 0;
      const x0 = 1 + cx * C, y0 = 1 + cy * C;
      for (let y = y0; y < y0 + C; y++) {
        const row = y * w;
        for (let x = x0; x < x0 + C; x++) {
          const i = row + x;
          const ix = (g[i + 1] - g[i - 1]) * 0.5;
          const iy = (g[i + w] - g[i - w]) * 0.5;
          a += ix * ix;
          b += ix * iy;
          c += iy * iy;
        }
      }
      const n = C * C;
      a /= n; b /= n; c /= n;
      const minEig = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
      if (minEig > 12) {
        strong++;
        grid[cy * nx + cx] = 1;
        const rx = Math.min(GRID_X - 1, Math.floor((cx / nx) * GRID_X));
        const ry = Math.min(GRID_Y - 1, Math.floor((cy / ny) * GRID_Y));
        region[ry * GRID_X + rx]++;
      }
    }
  }
  let filled = 0;
  for (let k = 0; k < region.length; k++) if (region[k] >= 2) filled++;
  return { score: strong / (nx * ny), spread: filled / region.length, grid, nx, ny };
}

/**
 * Global image-motion estimator using block matching on ~160 px wide frames.
 * Fits a similarity transform (translation, rotation, scale) to block motion vectors.
 * The residual of that fit is an indicator of parallax (depth variation) or moving objects.
 */
export class FlowTracker {
  constructor() {
    this.prev = null;
    this.pw = 0;
    this.ph = 0;
  }

  reset() {
    this.prev = null;
  }

  /** @returns {null | {tx, ty, rot, scale, resid, n, vectors}} motion in pixels of this image scale. */
  update(gray, w, h) {
    const prev = this.prev;
    const same = prev && this.pw === w && this.ph === h;
    this.prev = gray.slice();
    this.pw = w;
    this.ph = h;
    if (!same) return null;

    // 1) Coarse global shift at half resolution.
    const pc = downsample2(prev, w, h), cc = downsample2(gray, w, h);
    const g = coarseShift(pc.data, cc.data, pc.w, pc.h, 9);
    const gx = g.dx * 2, gy = g.dy * 2;

    // 2) Per-block refinement.
    const BX = 6, BY = 4, B = 8; // block half-size 8 -> 16x16 block
    const R = 4;
    const vectors = [];
    const marginX = B + R + Math.abs(gx) + 1, marginY = B + R + Math.abs(gy) + 1;
    if (w - 2 * marginX < BX || h - 2 * marginY < BY) return { tx: gx, ty: gy, rot: 0, scale: 1, resid: 0, n: 0, vectors };
    for (let by = 0; by < BY; by++) {
      for (let bx = 0; bx < BX; bx++) {
        const cx = Math.round(marginX + ((bx + 0.5) / BX) * (w - 2 * marginX));
        const cy = Math.round(marginY + ((by + 0.5) / BY) * (h - 2 * marginY));
        const v = matchBlock(prev, gray, w, h, cx, cy, B, gx, gy, R);
        if (v) vectors.push(v);
      }
    }
    if (vectors.length < 5) {
      return { tx: gx, ty: gy, rot: 0, scale: 1, resid: 0, n: vectors.length, vectors };
    }

    // 3) Similarity fit, centred coordinates.
    const ox = w / 2, oy = h / 2;
    let fit = fitSimilarity(vectors, ox, oy);
    // One round of outlier rejection.
    const res = vectors.map((v) => residual(v, fit, ox, oy));
    const medRes = res.slice().sort((a, b) => a - b)[res.length >> 1];
    const inl = vectors.filter((_, i) => res[i] <= Math.max(1.0, 2.5 * medRes));
    if (inl.length >= 5) fit = fitSimilarity(inl, ox, oy);
    let rs = 0;
    for (const v of vectors) rs += residual(v, fit, ox, oy) ** 2;
    const resid = Math.sqrt(rs / vectors.length);
    return { ...fit, resid, n: vectors.length, outliers: vectors.length - inl.length, vectors };
  }
}

function coarseShift(prev, cur, w, h, R) {
  // Zero-mean SAD over the central region, sampled every other pixel.
  let mp = 0, mc = 0, n = 0;
  for (let y = R; y < h - R; y += 2) {
    for (let x = R; x < w - R; x += 2) {
      mp += prev[y * w + x];
      mc += cur[y * w + x];
      n++;
    }
  }
  const off = (mc - mp) / n;
  let best = Infinity, bdx = 0, bdy = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      for (let y = R; y < h - R; y += 2) {
        const rp = y * w, rc = (y + dy) * w + dx;
        for (let x = R; x < w - R; x += 2) {
          const d = cur[rc + x] - prev[rp + x] - off;
          s += d < 0 ? -d : d;
        }
        if (s >= best) break;
      }
      if (s < best) {
        best = s;
        bdx = dx;
        bdy = dy;
      }
    }
  }
  return { dx: bdx, dy: bdy };
}

function matchBlock(prev, cur, w, h, cx, cy, B, gx, gy, R) {
  // Reference block statistics.
  let m = 0, q = 0;
  const N = (2 * B) * (2 * B);
  for (let y = cy - B; y < cy + B; y++) {
    for (let x = cx - B; x < cx + B; x++) {
      const v = prev[y * w + x];
      m += v;
      q += v * v;
    }
  }
  m /= N;
  const std = Math.sqrt(Math.max(0, q / N - m * m));
  if (std < 5) return null; // textureless block: unreliable

  const S = 2 * R + 1;
  const sad = new Float64Array(S * S);
  let best = Infinity, bi = -1, total = 0;
  for (let j = 0; j < S; j++) {
    const dy = gy + j - R;
    for (let i = 0; i < S; i++) {
      const dx = gx + i - R;
      let mc = 0;
      for (let y = cy - B; y < cy + B; y += 2) {
        const r = (y + dy) * w + dx;
        for (let x = cx - B; x < cx + B; x += 2) mc += cur[r + x];
      }
      mc /= N / 4;
      const off = mc - m;
      let s = 0;
      for (let y = cy - B; y < cy + B; y++) {
        const rp = y * w, rc = (y + dy) * w + dx;
        for (let x = cx - B; x < cx + B; x++) {
          const d = cur[rc + x] - prev[rp + x] - off;
          s += d < 0 ? -d : d;
        }
      }
      sad[j * S + i] = s;
      total += s;
      if (s < best) {
        best = s;
        bi = j * S + i;
      }
    }
  }
  const avg = total / (S * S);
  if (avg <= 0 || (avg - best) / avg < 0.2) return null; // ambiguous match
  const bj = (bi / S) | 0, bii = bi % S;
  if (bii === 0 || bii === S - 1 || bj === 0 || bj === S - 1) return null; // at the search edge
  // Sub-pixel refinement with a parabola in each axis.
  const sx = parabola(sad[bj * S + bii - 1], best, sad[bj * S + bii + 1]);
  const sy = parabola(sad[(bj - 1) * S + bii], best, sad[(bj + 1) * S + bii]);
  return { x: cx, y: cy, dx: gx + bii - R + sx, dy: gy + bj - R + sy };
}

function parabola(a, b, c) {
  const d = a - 2 * b + c;
  if (d <= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
}

// Model: dx = a*x - b*y + tx ; dy = b*x + a*y + ty  (x, y centred). scale = |1 + a + ib|.
function fitSimilarity(vs, ox, oy) {
  // Normal equations for params p = [a, b, tx, ty].
  const A = new Float64Array(16), r = new Float64Array(4);
  for (const v of vs) {
    const x = v.x - ox, y = v.y - oy;
    const rows = [
      [x, -y, 1, 0, v.dx],
      [y, x, 0, 1, v.dy],
    ];
    for (const row of rows) {
      for (let i = 0; i < 4; i++) {
        r[i] += row[i] * row[4];
        for (let j = 0; j < 4; j++) A[i * 4 + j] += row[i] * row[j];
      }
    }
  }
  const p = solve4(A, r) || [0, 0, 0, 0];
  const [a, b, tx, ty] = p;
  return { tx, ty, rot: Math.atan2(b, 1 + a), scale: Math.hypot(1 + a, b), a, b };
}

function residual(v, f, ox, oy) {
  const x = v.x - ox, y = v.y - oy;
  const px = f.a * x - f.b * y + f.tx, py = f.b * x + f.a * y + f.ty;
  return Math.hypot(v.dx - px, v.dy - py);
}

function solve4(A, b) {
  // Gaussian elimination with partial pivoting.
  const M = [];
  for (let i = 0; i < 4; i++) M.push([A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-9) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[4] / row[i]);
}

/**
 * Rolling reference for "relative sharpness": the sharpness of a frame compared with the best
 * recent frames of (roughly) the same scene. A decaying maximum adapts when the scene changes.
 */
export class SharpnessReference {
  // Short memory: compare with what the camera saw in the last second or so, i.e. roughly the same
  // surfaces. Longer memories mistake plain surfaces for blur after looking at busy ones.
  constructor(halfLifeSec = 1.0) {
    this.ref = 0;
    this.t = 0;
    this.halfLife = halfLifeSec;
  }
  reset() {
    this.ref = 0;
  }
  /** Feed a new sharpness value; returns relative sharpness in [0, 1.2]. */
  update(s, tSec) {
    const dt = this.t ? Math.max(0, tSec - this.t) : 0;
    this.t = tSec;
    this.ref *= Math.pow(0.5, dt / this.halfLife);
    if (s > this.ref) this.ref = s;
    return this.ref > 0 ? Math.min(1.2, s / this.ref) : 1;
  }
  /** Relative sharpness of a value without updating the reference. */
  relative(s) {
    return this.ref > 0 ? Math.min(1.2, s / this.ref) : 1;
  }
}
