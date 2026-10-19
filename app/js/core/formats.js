// Export formats for camera poses and depth points.
//  * transforms.json — Nerfstudio / Instant-NGP style (OpenGL camera-to-world).
//  * COLMAP text model — cameras.txt / images.txt / points3D.txt (OpenCV world-to-camera).
//  * points.ply — coloured point cloud from AR depth, useful to initialise splats.

import { quatFromRotation } from './math.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;

function intrKey(i) {
  return [i.w, i.h, i.fx.toFixed(2), i.fy.toFixed(2), i.cx.toFixed(2), i.cy.toFixed(2)].join('|');
}

/** frames: [{name, pose (Float32Array 16, GL c2w), intr}] */
export function transformsJson(frames, plyName) {
  const first = frames[0].intr;
  const uniform = frames.every((f) => intrKey(f.intr) === intrKey(first));
  const out = {
    camera_model: 'OPENCV',
    k1: 0, k2: 0, p1: 0, p2: 0,
  };
  if (uniform) {
    Object.assign(out, { fl_x: r6(first.fx), fl_y: r6(first.fy), cx: r6(first.cx), cy: r6(first.cy), w: first.w, h: first.h });
  }
  out.frames = frames.map((f) => {
    const m = f.pose;
    const fr = {
      file_path: f.name,
      transform_matrix: [
        [m[0], m[4], m[8], m[12]],
        [m[1], m[5], m[9], m[13]],
        [m[2], m[6], m[10], m[14]],
        [0, 0, 0, 1],
      ].map((row) => row.map(r6)),
    };
    if (!uniform) Object.assign(fr, { fl_x: r6(f.intr.fx), fl_y: r6(f.intr.fy), cx: r6(f.intr.cx), cy: r6(f.intr.cy), w: f.intr.w, h: f.intr.h });
    return fr;
  });
  if (plyName) out.ply_file_path = plyName;
  return JSON.stringify(out, null, 1);
}

/**
 * COLMAP text model. `name` is the image file name relative to the images folder.
 * Includes rigs.txt and frames.txt (required by COLMAP 3.12+/4.x; older readers ignore them):
 * one trivial single-camera rig per camera, one frame per image.
 */
export function colmapText(frames, points) {
  const camIds = new Map();
  let cams = '# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n';
  let rigs = '# Rig calib list with one line of data per calib:\n#   RIG_ID, NUM_SENSORS, REF_SENSOR_TYPE, REF_SENSOR_ID, SENSORS[] as (SENSOR_TYPE, SENSOR_ID, HAS_POSE, [QW, QX, QY, QZ, TX, TY, TZ])\n';
  for (const f of frames) {
    const k = intrKey(f.intr);
    if (camIds.has(k)) continue;
    const id = camIds.size + 1;
    camIds.set(k, id);
    const i = f.intr;
    cams += `${id} PINHOLE ${i.w} ${i.h} ${r6(i.fx)} ${r6(i.fy)} ${r6(i.cx)} ${r6(i.cy)}\n`;
    rigs += `${id} 1 CAMERA ${id}\n`;
  }
  let frs = '# Frame list with one line of data per frame:\n#   FRAME_ID, RIG_ID, RIG_FROM_WORLD[QW, QX, QY, QZ, TX, TY, TZ], NUM_DATA_IDS, DATA_IDS[] as (SENSOR_TYPE, SENSOR_ID, DATA_ID)\n';
  let imgs = '# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n';
  frames.forEach((f, idx) => {
    const m = f.pose;
    // OpenCV camera axes in world: x = right, y = -up, z = forward (= -back).
    const c0 = [m[0], m[1], m[2]];
    const c1 = [-m[4], -m[5], -m[6]];
    const c2 = [-m[8], -m[9], -m[10]];
    // World-to-camera rotation: rows are the camera axes.
    const q = quatFromRotation(c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
    const C = [m[12], m[13], m[14]];
    const t = [
      -(c0[0] * C[0] + c0[1] * C[1] + c0[2] * C[2]),
      -(c1[0] * C[0] + c1[1] * C[1] + c1[2] * C[2]),
      -(c2[0] * C[0] + c2[1] * C[1] + c2[2] * C[2]),
    ];
    const cam = camIds.get(intrKey(f.intr));
    const qt = `${q.map(r6).join(' ')} ${t.map(r6).join(' ')}`;
    imgs += `${idx + 1} ${qt} ${cam} ${f.name}\n\n`;
    frs += `${idx + 1} ${cam} ${qt} 1 CAMERA ${cam} ${idx + 1}\n`;
  });
  let pts = '# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n';
  if (points) {
    const { xyz, rgb } = points;
    const parts = [];
    for (let i = 0, n = xyz.length / 3; i < n; i++) {
      parts.push(`${i + 1} ${r6(xyz[3 * i])} ${r6(xyz[3 * i + 1])} ${r6(xyz[3 * i + 2])} ${rgb[3 * i]} ${rgb[3 * i + 1]} ${rgb[3 * i + 2]} 0`);
    }
    pts += parts.join('\n') + (parts.length ? '\n' : '');
  }
  return { cameras: cams, images: imgs, points3D: pts, rigs, frames: frs };
}

/** Merge per-keyframe depth points and thin them to one point per `cell` metres. */
export function mergePoints(frames, cell = 0.03) {
  const seen = new Map();
  const xyz = [], rgb = [];
  for (const f of frames) {
    if (!f.pts || !f.rgb) continue;
    for (let i = 0, n = f.pts.length / 3; i < n; i++) {
      const x = f.pts[3 * i], y = f.pts[3 * i + 1], z = f.pts[3 * i + 2];
      const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      if (seen.has(k)) continue;
      seen.set(k, 1);
      xyz.push(x, y, z);
      rgb.push(f.rgb[3 * i], f.rgb[3 * i + 1], f.rgb[3 * i + 2]);
    }
  }
  return { xyz: new Float32Array(xyz), rgb: new Uint8Array(rgb) };
}

/** Binary little-endian PLY with position, zero normals (for 3DGS loaders) and colour. */
export function plyBlob({ xyz, rgb }) {
  const n = xyz.length / 3;
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment SplatScout AR depth points\n' +
    `element vertex ${n}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property float nx\nproperty float ny\nproperty float nz\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const stride = 27;
  const buf = new ArrayBuffer(n * stride);
  const dv = new DataView(buf);
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    dv.setFloat32(o, xyz[3 * i], true);
    dv.setFloat32(o + 4, xyz[3 * i + 1], true);
    dv.setFloat32(o + 8, xyz[3 * i + 2], true);
    // normals stay 0
    dv.setUint8(o + 24, rgb[3 * i]);
    dv.setUint8(o + 25, rgb[3 * i + 1]);
    dv.setUint8(o + 26, rgb[3 * i + 2]);
  }
  return new Blob([header, buf], { type: 'application/octet-stream' });
}
