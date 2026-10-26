// Builds the export ZIP for a capture:
//   images/0001.jpg ...           sharp keyframes in capture order (feed these to your splat pipeline)
//   splatscout.json               capture metadata, per-photo quality metrics and poses
//   poses/transforms.json         AR camera poses (Nerfstudio / Instant-NGP format)
//   poses/colmap/sparse/0/*.txt   the same poses as a COLMAP text model (PINHOLE)
//   poses/points.ply              coloured AR depth points (splat initialisation), mid-air noise removed
//   coverage.png                  coverage map snapshot
//   README.txt

import { ZipWriter } from '../core/zip.js';
import { transformsJson, colmapText, mergePoints, plyBlob } from '../core/formats.js';
import { analyzeCapture } from '../core/score.js';
import { drawTopDown, drawPanorama } from '../capture/minimap.js';

export const APP_VERSION = '2.0.0';

export function slugify(s) {
  return (s || '').trim().replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'capture';
}

export function exportName(capture) {
  const d = new Date(capture.createdAt);
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${slugify(capture.building)}_${slugify(capture.room)}_${date}`;
}

/**
 * @param capture capture record
 * @param frames full frame records (with jpeg blobs) in order
 * @param onProgress (fraction, label)
 */
export async function buildExport(capture, frames, { includePoses = true } = {}, onProgress = () => {}) {
  const base = exportName(capture);
  const zip = new ZipWriter();
  const names = frames.map((_, i) => `${String(i + 1).padStart(4, '0')}.jpg`);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    await zip.add(`${base}/images/${names[i]}`, f.jpeg, f.crc);
    if (i % 10 === 0) onProgress((i / frames.length) * 0.85, `Adding photos ${i + 1}/${frames.length}`);
  }

  onProgress(0.86, 'Writing metadata');
  const analysis = analyzeCapture(frames, capture);
  const manifest = {
    app: 'SplatScout',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    capture: {
      id: capture.id,
      building: capture.building,
      room: capture.room,
      floor: capture.floor,
      notes: capture.notes,
      author: capture.author,
      template: capture.template,
      engine: capture.engine,
      tracking: capture.tracking,
      createdAt: new Date(capture.createdAt).toISOString(),
      segments: capture.segments,
      device: capture.device,
      stats: capture.stats,
    },
    // Scan area in the AR session's coordinates (same frame as the poses below): a floor-plan
    // polygon [[x, z], ...] at floorY, plus skipped spots [x, y, z, radius]. Useful to crop splats.
    bounds: analysis.bounds ? { ...analysis.bounds.toJSON(), poseFrame: 'poses/transforms.json' } : null,
    score: { score: analysis.score, grade: analysis.grade, verdict: analysis.verdict, parts: analysis.parts.map(({ id, label, value, detail }) => ({ id, label, value: +value.toFixed(3), detail })), fixes: analysis.fixes },
    conventions: {
      pose: 'camera-to-world 4x4, column-major, OpenGL camera (x right, y up, looks down -z), world y-up, metres',
      intrinsics: 'pixels, top-left origin',
    },
    frames: frames.map((f, i) => ({
      file: `images/${names[i]}`,
      seq: f.seq,
      segment: f.segment,
      pass: f.pass,
      t: f.t,
      tracked: f.tracked,
      pose: f.pose,
      intrinsics: f.intr,
      metrics: f.m,
      flags: f.flags,
      trigger: f.trigger,
      baselineM: f.baseline,
    })),
  };
  await zip.add(`${base}/splatscout.json`, JSON.stringify(manifest, null, 1));

  // Poses from the largest AR session (each session has its own coordinate frame).
  let posedNote = 'No AR poses (camera mode or tracking unavailable).';
  if (includePoses && capture.tracking === '6dof') {
    const bySeg = new Map();
    frames.forEach((f, i) => {
      if (!f.tracked || !f.pose || !f.intr) return;
      if (!bySeg.has(f.segment)) bySeg.set(f.segment, []);
      bySeg.get(f.segment).push({ ...f, name: names[i] });
    });
    let main = [];
    for (const list of bySeg.values()) if (list.length > main.length) main = list;
    if (main.length >= 3) {
      onProgress(0.9, 'Writing poses');
      // Keep only points on confirmed surfaces (seen by several depth frames, never seen through)
      // and inside the scan area: no floaters to seed the splat with.
      const vm = analysis.voxels, b = analysis.bounds;
      const pts = mergePoints(main, 0.03, (x, y, z) => vm.isSolidAt(x, y, z) && (!b || b.contains(x, y, z)));
      const hasPts = pts.xyz.length > 0;
      await zip.add(`${base}/poses/transforms.json`, transformsJson(main.map((f) => ({ name: `images/${f.name}`, pose: f.pose, intr: f.intr })), hasPts ? 'points.ply' : null));
      const col = colmapText(main.map((f) => ({ name: f.name, pose: f.pose, intr: f.intr })), hasPts ? pts : null);
      await zip.add(`${base}/poses/colmap/sparse/0/cameras.txt`, col.cameras);
      await zip.add(`${base}/poses/colmap/sparse/0/images.txt`, col.images);
      await zip.add(`${base}/poses/colmap/sparse/0/points3D.txt`, col.points3D);
      await zip.add(`${base}/poses/colmap/sparse/0/rigs.txt`, col.rigs);
      await zip.add(`${base}/poses/colmap/sparse/0/frames.txt`, col.frames);
      if (hasPts) await zip.add(`${base}/poses/points.ply`, new Uint8Array(await plyBlob(pts).arrayBuffer()));
      posedNote = `AR poses for ${main.length} of ${frames.length} photos (largest AR session)` + (bySeg.size > 1 ? `; ${bySeg.size - 1} other session(s) not included because their coordinates are not aligned.` : '.');
    }
  }

  onProgress(0.95, 'Rendering coverage map');
  const png = await coveragePng(analysis, frames, capture);
  if (png) await zip.add(`${base}/coverage.png`, new Uint8Array(await png.arrayBuffer()));
  await zip.add(`${base}/README.txt`, readme(capture, frames.length, analysis, posedNote));

  onProgress(1, 'Done');
  return { blob: zip.finish(), filename: `${base}.zip` };
}

async function coveragePng(analysis, frames, capture) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, 1024, 1024);
    if (capture.tracking === '6dof' && analysis.vstats.solid > 50) {
      drawTopDown(c, { voxels: analysis.voxels, frames, pose: null, target: null, segment: null, bounds: analysis.bounds });
    } else {
      c.height = 512;
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, 1024, 512);
      drawPanorama(c, { sphere: analysis.sphere, pose: null });
    }
    return await new Promise((r) => c.toBlob(r, 'image/png'));
  } catch {
    return null;
  }
}

function readme(capture, n, a, posedNote) {
  return `SplatScout capture
==================
Building : ${capture.building}
Room     : ${capture.room}${capture.floor ? `  (floor ${capture.floor})` : ''}
Captured : ${new Date(capture.createdAt).toLocaleString()}
By       : ${capture.author || '-'}
Plan     : ${capture.template}   Mode: ${capture.engine}
Photos   : ${n}
Grade    : ${a.grade} (${a.score}/100), ${a.verdict}

images/
  Sharp keyframes in capture order. Use this folder as the image input of your
  Gaussian splat pipeline (COLMAP, Postshot, Nerfstudio, Brush, gsplat, LichtFeld ...).
  All photos come from one camera with fixed settings, so treat them as a single camera
  ("single_camera" in COLMAP).
  If your pipeline only accepts video:
    ffmpeg -framerate 4 -i images/%04d.jpg -c:v libx264 -crf 14 -pix_fmt yuv420p capture.mp4

poses/   (${posedNote})
  transforms.json        Nerfstudio/Instant-NGP format (OpenGL camera-to-world, metres)
  colmap/sparse/0/       COLMAP text model with the AR poses (PINHOLE cameras) + depth points
  points.ply             coloured AR depth points, for splat initialisation (only points on
                         confirmed surfaces inside the scan area)
  The AR poses are approximate (phone tracking drifts by centimetres). Use them as a starting
  point, e.g. COLMAP point_triangulator + bundle_adjuster, or simply ignore them and run
  normal structure-from-motion on images/.

splatscout.json
  "bounds" holds the scan area (floor polygon in the pose coordinates) if one was marked:
  crop the trained splat to it to drop anything seen through windows or past the area.
  Per-photo metrics (relative sharpness, brightness, clipped highlights, texture, speeds),
  quality flags and poses.

Fixes suggested at export:
${a.fixes.map((f) => '  - ' + f.text).join('\n')}
`;
}

/** Hand the file to the user: share sheet when available (iOS), otherwise a download. */
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: 'application/zip' });
  if (navigator.canShare && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
