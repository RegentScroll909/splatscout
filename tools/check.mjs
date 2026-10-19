// Self-checks for the platform-independent core (run: node tools/check.mjs).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { poseFromEuler } from '../app/js/sources/orientation.js';
import { poseForward, poseUp, poseRight, poseLookDir, projectPoint, projectionFromIntrinsics, intrinsicsFromProjection, angularVelocity, DEG } from '../app/js/core/math.js';
import { analyzeImage, FlowTracker } from '../app/js/core/analyzer.js';
import { DirectionSphere, VoxelMap } from '../app/js/core/coverage.js';
import { Keyframer } from '../app/js/core/keyframer.js';
import { colmapText, transformsJson } from '../app/js/core/formats.js';
import { ZipWriter, crc32 } from '../app/js/core/zip.js';
import { Coach } from '../app/js/core/coach.js';
import { analyzeCapture } from '../app/js/core/score.js';

let passed = 0;
const near = (a, b, eps = 1e-4, msg = '') => {
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < eps, `${msg} expected ${b} got ${a.map((x) => x.toFixed(4))}`);
};
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ok', name);
};

console.log('SplatScout core checks');

test('device orientation: upright portrait facing north', () => {
  const p = poseFromEuler(0, 90, 0, 0);
  near(poseForward(p), [0, 0, -1], 1e-6, 'forward');
  near(poseUp(p), [0, 1, 0], 1e-6, 'up');
  near(poseRight(p), [1, 0, 0], 1e-6, 'right');
});
test('device orientation: turned 90° left faces west', () => {
  near(poseForward(poseFromEuler(90, 90, 0, 0)), [-1, 0, 0], 1e-6);
});
test('device orientation: lying flat looks down', () => {
  near(poseForward(poseFromEuler(0, 0, 0, 0)), [0, -1, 0], 1e-6);
});
test('device orientation: landscape keeps image-up pointing up', () => {
  // Upright facing north, then rolled 90° counter-clockwise (device z axis): gamma = -90 at beta = 0 is
  // the classic landscape pose for a phone held vertically... compose directly instead:
  const p0 = poseFromEuler(0, 90, 0, 0);
  // In landscape with screen angle 90, the camera's up axis must equal device +X. Rebuild the device
  // rotation R0*Rz(90) and check the screen-compensated pose stays upright.
  const c = Math.cos(90 * DEG), s = Math.sin(90 * DEG);
  // device x/y axes after rolling CCW: x' = R0*(c, s, 0), y' = R0*(-s, c, 0)
  const R0x = poseRight(p0), R0y = poseUp(p0);
  const xr = [R0x[0] * c + R0y[0] * s, R0x[1] * c + R0y[1] * s, R0x[2] * c + R0y[2] * s];
  const yr = [-R0x[0] * s + R0y[0] * c, -R0x[1] * s + R0y[1] * c, -R0x[2] * s + R0y[2] * c];
  // Camera up for screen angle 90 is +X_dev (rolled), camera right is -Y_dev (rolled).
  near(xr, [0, 1, 0], 1e-6, 'camera up = device x after CCW roll');
  near(yr.map((v) => -v), [1, 0, 0], 1e-6, 'camera right = -device y after CCW roll');
});

test('projection round trip', () => {
  const intr = { fx: 1500, fy: 1500, cx: 960, cy: 540, w: 1920, h: 1080 };
  const P = projectionFromIntrinsics(intr);
  const back = intrinsicsFromProjection(P, 1920, 1080);
  near([back.fx, back.fy, back.cx, back.cy], [1500, 1500, 960, 540], 1e-3);
  const pose = poseLookDir([0, 1.5, 0], [0, 0, -1]);
  const px = projectPoint(pose, intr, [0.5, 1.5 + 0.25, -2]);
  near(px.slice(0, 2), [960 + (1500 * 0.5) / 2, 540 - (1500 * 0.25) / 2], 1e-3);
});

test('angular velocity sign: yaw left is +y', () => {
  const a = poseLookDir([0, 0, 0], [0, 0, -1]);
  const b = poseLookDir([0, 0, 0], [-Math.sin(0.1), 0, -Math.cos(0.1)]);
  const w = angularVelocity(a, b, 1);
  near(w, [0, 0.1, 0], 1e-5);
});

test('COLMAP export recovers camera centres', () => {
  const pose = poseLookDir([1, 1.6, -2], [0.3, -0.2, -1]);
  const intr = { fx: 1400, fy: 1400, cx: 960, cy: 540, w: 1920, h: 1080 };
  const txt = colmapText([{ name: '0001.jpg', pose, intr }], null);
  const line = txt.images.split('\n').find((l) => l.startsWith('1 '));
  const [, qw, qx, qy, qz, tx, ty, tz] = line.split(' ').map(Number);
  // R from quaternion (world-to-camera), centre = -R^T t
  const R = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ];
  const C = [0, 1, 2].map((j) => -(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz));
  near(C, [1, 1.6, -2], 1e-4, 'centre');
  // Camera +Z (row 2 of R) must be the viewing direction.
  near(R[2], poseForward(pose), 1e-4, 'forward');
  assert.match(txt.cameras, /1 PINHOLE 1920 1080 1400 1400 960 540/);
  const tj = JSON.parse(transformsJson([{ name: 'images/0001.jpg', pose, intr }]));
  assert.equal(tj.frames[0].transform_matrix[0][3], 1);
});

function texture(w, h, seed = 1) {
  const g = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const x0 = (rnd() * w) | 0, y0 = (rnd() * h) | 0, rw = 4 + ((rnd() * 40) | 0), rh = 4 + ((rnd() * 30) | 0), v = (rnd() * 255) | 0;
    for (let y = y0; y < Math.min(h, y0 + rh); y++) for (let x = x0; x < Math.min(w, x0 + rw); x++) g[y * w + x] = v;
  }
  return g;
}
function boxBlur(g, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dx = -r; dx <= r; dx++) { const xx = Math.min(w - 1, Math.max(0, x + dx)); s += g[y * w + xx]; n++; }
    o[y * w + x] = s / n;
  }
  return o;
}

test('sharpness drops with motion blur; texture detects blank frames', () => {
  const w = 640, h = 360, g = texture(w, h);
  const a = analyzeImage(g, w, h), b = analyzeImage(boxBlur(g, w, h, 4), w, h);
  assert.ok(b.sharp < a.sharp * 0.5, `blurred ${b.sharp} vs sharp ${a.sharp}`);
  const blank = analyzeImage(new Uint8Array(w * h).fill(180), w, h);
  assert.ok(blank.texture < 0.01 && a.texture > 0.05, `texture ${a.texture} blank ${blank.texture}`);
});

test('flow tracker measures image shift', () => {
  const W = 200, H = 120, big = texture(W, H, 7);
  const crop = (ox, oy) => {
    const w = 160, h = 90, o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = big[(y + oy) * W + x + ox];
    return o;
  };
  const f = new FlowTracker();
  f.update(crop(20, 15), 160, 90);
  const r = f.update(crop(14, 18), 160, 90); // camera moved: content shifts +6 x, -3 y
  near([r.tx, r.ty], [6, -3], 0.6, 'shift');
  assert.ok(Math.abs(r.scale - 1) < 0.02);
});

test('direction sphere counts distinct viewpoints', () => {
  const s = new DirectionSphere();
  const intr = { fx: 800, fy: 800, cx: 640, cy: 360, w: 1280, h: 720 };
  const pose = poseLookDir([0, 1.5, 0], [0, 0, -1]);
  const hit = s.addView(pose, intr, { pos: [0, 1.5, 0], odo: 0 }, 0);
  assert.ok(hit.length > 0);
  s.addView(pose, intr, { pos: [0, 1.5, 0], odo: 0 }, 1); // same spot: not distinct
  assert.equal(s.bins[hit[0]].distinct, 1);
  s.addView(poseLookDir([0.6, 1.5, 0], [0, 0, -1]), intr, { pos: [0.6, 1.5, 0], odo: 0 }, 2);
  assert.equal(s.bins[hit[0]].distinct, 2);
});

test('voxel map counts observation angles', () => {
  const v = new VoxelMap(0.2, 5);
  const pts = new Float32Array([0.1, 1, -2, 0.1, 1, -2]);
  v.observe(pts, [0, 1.5, 0], true);
  v.observe(pts, [1.5, 1.5, -0.5], true);
  v.observe(pts, [-1.5, 1.2, -0.5], true);
  const st = v.stats();
  assert.equal(st.solid, 1);
  assert.equal(st.q3, 1);
});

test('keyframer novelty grows with rotation and translation', () => {
  const k = new Keyframer({ hfovDeg: 65, tracking: '6dof' });
  const p0 = poseLookDir([0, 1.5, 0], [0, 0, -1]);
  k.committed({ t: 0, pose: p0, odo: 0 });
  assert.ok(k.novelty({ t: 0.1, pose: p0, depthMed: 2 }) < 0.1);
  assert.ok(k.novelty({ t: 0.5, pose: poseLookDir([0, 1.5, 0], [Math.sin(10 * DEG), 0, -Math.cos(10 * DEG)]), depthMed: 2 }) >= 1);
  assert.ok(k.novelty({ t: 0.5, pose: poseLookDir([0.3, 1.5, 0], [0, 0, -1]), depthMed: 2 }) >= 1);
});

test('coach prioritises critical issues and has hysteresis', () => {
  const c = new Coach();
  const base = { trackState: 'ok', rotSpeed: 5, linSpeed: 0.1, flowSpeed: 0.05, relSharp: 0.9, blurRisk: 0, mean: 120, clipHi: 0, clipLo: 0, texture: 0.2, depthMed: 1.5 };
  let r = c.update({ ...base, t: 0 });
  assert.equal(r.primary.level, 'good');
  r = c.update({ ...base, t: 1, rotSpeed: 60 });
  r = c.update({ ...base, t: 1.4, rotSpeed: 60 });
  assert.equal(r.primary.id, 'fast');
  r = c.update({ ...base, t: 1.6 });
  assert.equal(r.primary.id, 'fast', 'still shown during hysteresis');
  r = c.update({ ...base, t: 3 });
  assert.equal(r.primary.level, 'good');
});

test('score: well-covered posed capture grades well', () => {
  const frames = [];
  const intr = { fx: 900, fy: 900, cx: 640, cy: 360, w: 1280, h: 720 };
  let seq = 0;
  for (const [y, pitch] of [[1.4, -5], [1.9, -30], [0.9, 25]]) {
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * Math.PI * 2;
      const pos = [Math.cos(a) * 2.5, y, Math.sin(a) * 2];
      const fwd = [-Math.cos(a) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.sin(a) * Math.cos(pitch * DEG)];
      const pose = poseLookDir(pos, fwd);
      const pts = [];
      for (let k = 0; k < 40; k++) {
        const t = 1.5 + (k % 5) * 0.4;
        const off = ((k / 5) | 0) * 0.15 - 0.5;
        pts.push(pos[0] + fwd[0] * t + off * Math.sin(a), pos[1] + fwd[1] * t, pos[2] + fwd[2] * t - off * Math.cos(a));
      }
      frames.push({ seq: ++seq, segment: 1, tracking: '6dof', tracked: true, pose: Array.from(pose), intr, m: { relSharp: 0.9 }, flags: [], trigger: 'trans', baseline: 0.2, pts: new Float32Array(pts) });
    }
  }
  const r = analyzeCapture(frames, { template: 'room', tracking: '6dof', stats: { gaps: 0 } });
  assert.ok(r.score >= 60, `score ${r.score} ${JSON.stringify(r.parts.map((p) => [p.id, +p.value.toFixed(2)]))}`);
});

const zipTest = async () => {
  const z = new ZipWriter();
  const a = new TextEncoder().encode('hello splat');
  await z.add('cap/a.txt', a);
  const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
  await z.add('cap/images/0001.jpg', blob, crc32(new Uint8Array([1, 2, 3, 4, 5])));
  const out = Buffer.from(await z.finish().arrayBuffer());
  const dir = mkdtempSync(join(tmpdir(), 'ssz-'));
  writeFileSync(join(dir, 't.zip'), out);
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const extractors = process.platform === 'win32'
    ? [[join(sys, 'System32', 'tar.exe'), ['-xf', join(dir, 't.zip'), '-C', dir]],
       [join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${join(dir, 't.zip')}' -DestinationPath '${dir}' -Force`]]]
    : [['unzip', ['-o', join(dir, 't.zip'), '-d', dir]], ['tar', ['-xf', join(dir, 't.zip'), '-C', dir]]];
  let extracted = false;
  for (const [cmd, args] of extractors) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      extracted = true;
      break;
    } catch {}
  }
  assert.ok(extracted, 'no zip extractor available');
  assert.equal(readFileSync(join(dir, 'cap', 'a.txt'), 'utf8'), 'hello splat');
  assert.deepEqual([...readFileSync(join(dir, 'cap', 'images', '0001.jpg'))], [1, 2, 3, 4, 5]);
  passed++;
  console.log('  ok zip archive extracts with the system unzip tool');
};
await zipTest();

console.log(`\n${passed} checks passed`);
