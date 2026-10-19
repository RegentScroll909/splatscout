// Full-resolution candidate images from the different sources, with a common interface:
//   encode(quality) -> JPEG Blob, thumb(maxW) -> JPEG Blob, sampleColors(uv) -> RGB bytes, release().

let scratch = null;
function canvasOf(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch;
}

let thumbCanvas = null;
function toBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', quality),
  );
}

async function thumbFrom(source, sw, sh, maxW) {
  const s = Math.min(1, maxW / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  if (!thumbCanvas) thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = w;
  thumbCanvas.height = h;
  const ctx = thumbCanvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return toBlob(thumbCanvas, 0.8);
}

/** Top-down RGBA pixels (from the AR camera readback). */
export class RgbaImage {
  constructor(rgba, w, h) {
    this.rgba = rgba;
    this.w = w;
    this.h = h;
  }
  _canvas() {
    const c = canvasOf(this.w, this.h);
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(this.rgba.buffer, this.rgba.byteOffset, this.w * this.h * 4), this.w, this.h), 0, 0);
    return c;
  }
  async encode(quality = 0.92) {
    return toBlob(this._canvas(), quality);
  }
  async thumb(maxW = 320) {
    return thumbFrom(this._canvas(), this.w, this.h, maxW);
  }
  /** Encode JPEG and thumbnail with a single upload of the pixels. */
  async encodeBoth(quality = 0.92, maxW = 320) {
    const c = this._canvas();
    const jpeg = await toBlob(c, quality);
    const thumb = await thumbFrom(c, this.w, this.h, maxW);
    return { jpeg, thumb };
  }
  sampleColors(uv) {
    const n = uv.length / 2;
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = Math.min(this.w - 1, Math.max(0, Math.floor(uv[2 * i] * this.w)));
      const y = Math.min(this.h - 1, Math.max(0, Math.floor(uv[2 * i + 1] * this.h)));
      const o = (y * this.w + x) * 4;
      out[3 * i] = this.rgba[o];
      out[3 * i + 1] = this.rgba[o + 1];
      out[3 * i + 2] = this.rgba[o + 2];
    }
    return out;
  }
  release() {
    this.rgba = null;
  }
}

/** An ImageBitmap snapshot of a video or canvas (camera and demo sources). */
export class BitmapImage {
  constructor(bitmap, w, h, smallRgba, sw, sh) {
    this.bitmap = bitmap;
    this.w = w;
    this.h = h;
    this.small = smallRgba; // low-res RGBA for colour sampling
    this.sw = sw;
    this.sh = sh;
  }
  _canvas() {
    const c = canvasOf(this.w, this.h);
    c.getContext('2d').drawImage(this.bitmap, 0, 0, this.w, this.h);
    return c;
  }
  async encode(quality = 0.92) {
    return toBlob(this._canvas(), quality);
  }
  async thumb(maxW = 320) {
    return thumbFrom(this.bitmap, this.w, this.h, maxW);
  }
  async encodeBoth(quality = 0.92, maxW = 320) {
    const jpeg = await toBlob(this._canvas(), quality);
    const thumb = await thumbFrom(this.bitmap, this.w, this.h, maxW);
    return { jpeg, thumb };
  }
  sampleColors(uv) {
    const n = uv.length / 2;
    const out = new Uint8Array(n * 3);
    if (!this.small) return out.fill(128);
    for (let i = 0; i < n; i++) {
      const x = Math.min(this.sw - 1, Math.max(0, Math.floor(uv[2 * i] * this.sw)));
      const y = Math.min(this.sh - 1, Math.max(0, Math.floor(uv[2 * i + 1] * this.sh)));
      const o = (y * this.sw + x) * 4;
      out[3 * i] = this.small[o];
      out[3 * i + 1] = this.small[o + 1];
      out[3 * i + 2] = this.small[o + 2];
    }
    return out;
  }
  release() {
    if (this.bitmap && this.bitmap.close) this.bitmap.close();
    this.bitmap = null;
    this.small = null;
  }
}
