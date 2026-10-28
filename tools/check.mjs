// Self-checks for the platform-independent core (run: node tools/check.mjs).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { poseFromEuler } from '../app/js/sources/orientation.js';
import { poseForward, poseUp, poseRight, poseLookDir, projectPoint, projectionFromIntrinsics, intrinsicsFromProjection, angularVelocity, transformDir, DEG } from '../app/js/core/math.js';
import { analyzeImage, FlowTracker } from '../app/js/core/analyzer.js';
import { DirectionSphere, VoxelMap } from '../app/js/core/coverage.js';
import { Keyframer } from '../app/js/core/keyframer.js';
import { colmapText, transformsJson } from '../app/js/core/formats.js';
import { ZipWriter, crc32 } from '../app/js/core/zip.js';
import { Coach } from '../app/js/core/coach.js';
import { analyzeCapture } from '../app/js/core/score.js';
import { Bounds } from '../app/js/core/bounds.js';
import { planPass, Guide } from '../app/js/core/guide.js';
import { getTemplate } from '../app/js/core/plans.js';
import { depthToPoints, unprojectIntr } from '../app/js/core/depth.js';
import { depthGrid, setScene, raycast, surfaceNormal, walkable } from '../app/js/sources/demoScene.js';
import { xf, xfInverse, xfPoints, xfPose, xfDelta, solveAlignment, checkAlignment, slideSearch, XF_ID } from '../app/js/core/align.js';
import { makeKey, liveImage } from '../app/js/core/photomatch.js';
import { spaceOf, mainSpace } from '../app/js/core/spaces.js';
import { rebuildCoverage } from '../app/js/core/score.js';

// The simulated depth noise uses Math.random: seed it so every run (and CI) sees the same noise.
let seed = 20261027;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

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

/** A flat wall at z = -3 (x -1..1, y 0.5..2) as world points. */
function wallPoints() {
  const w = [];
  for (let x = -1; x <= 1; x += 0.05) for (let y = 0.5; y <= 2; y += 0.05) w.push(x, y, -3);
  return new Float32Array(w);
}

test('voxel map: depth noise in mid-air is carved away, real surfaces stay', () => {
  const v = new VoxelMap(0.2, 7);
  const wall = wallPoints();
  for (let i = 0; i < 3; i++) v.integrate(wall, [0, 1.4, 0]);
  // A blob of noise between the camera and the wall, seen in two frames...
  v.integrate(new Float32Array([0.1, 1.3, -1.5]), [0, 1.4, 0]);
  v.integrate(new Float32Array([0.1, 1.3, -1.5]), [0.05, 1.4, 0]);
  assert.ok(v.isSolidAt(0.1, 1.3, -1.5), 'noise first looks solid');
  // ...then the wall behind it is seen straight through it a few more times.
  for (let i = 0; i < 6; i++) v.integrate(wall, [0, 1.4, 0]);
  assert.ok(!v.isSolidAt(0.1, 1.3, -1.5), 'noise carved');
  assert.ok(v.isSolidAt(0.1, 1.3, -2.99), 'wall kept');
});

test('voxel map counts the angles each surface was photographed from', () => {
  const v = new VoxelMap(0.2, 7);
  const wall = wallPoints();
  const intr = { fx: 900, fy: 900, cx: 640, cy: 360, w: 1280, h: 720 };
  const shots = [[0, 1.4, 0], [1, 1.4, 0], [-1, 1.4, 0]];
  for (const p of shots) v.integrate(wall, p);
  for (const p of shots) {
    const pose = poseLookDir(p, [-p[0] / 3, 0, -1]);
    // Depth image of the wall as this camera sees it.
    const nx = 40, ny = 30, d = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const dc = [((i + 0.5) / nx * intr.w - intr.cx) / intr.fx, -((j + 0.5) / ny * intr.h - intr.cy) / intr.fy, -1];
      const dw = [pose[0] * dc[0] + pose[4] * dc[1] + pose[8] * dc[2], pose[1] * dc[0] + pose[5] * dc[1] + pose[9] * dc[2], pose[2] * dc[0] + pose[6] * dc[1] + pose[10] * dc[2]];
      const t = (-3 - p[2]) / dw[2];
      const hit = [p[0] + dw[0] * t, p[1] + dw[1] * t];
      if (t > 0 && Math.abs(hit[0]) <= 1 && hit[1] >= 0.5 && hit[1] <= 2) d[j * nx + i] = t;
    }
    v.observeView(pose, intr, { d, nx, ny });
  }
  const st = v.stats();
  assert.ok(st.solid > 50, 'wall mapped');
  assert.ok(st.q3 / st.solid > 0.5, `most of the wall seen from 3 angles: ${JSON.stringify(st)}`);
});

test('depth filter drops flying pixels between a near object and the wall behind it', () => {
  const intr = { fx: 500, fy: 500, cx: 320, cy: 240, w: 640, h: 480 };
  const nx = 40, ny = 30, D = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    // Near box on the left, wall on the right, and the sensor's smoothing in between.
    D[j * nx + i] = i < 18 ? 1.5 : i === 18 ? 2.2 : i === 19 ? 3.0 : 4;
  }
  const pose = poseLookDir([0, 0, 0], [0, 0, -1]);
  const r = depthToPoints(D, nx, ny, unprojectIntr(intr), pose);
  for (let j = 1; j < ny - 1; j++) {
    assert.equal(r.d[j * nx + 18], 0, 'smeared sample dropped');
    assert.equal(r.d[j * nx + 19], 0, 'smeared sample dropped');
    assert.ok(r.d[j * nx + 10] > 0 && r.d[j * nx + 30] > 0, 'surfaces kept');
  }
});

test('scan area: outline with margin, floor, skipped spots', () => {
  const b = new Bounds({ poly: [[0, 0], [0, 4], [6, 4], [6, 0]], floorY: 0 });
  assert.ok(b.contains(3, 1, 2), 'inside');
  assert.ok(b.contains(6.2, 1, 2), 'wall on the outline counts');
  assert.ok(!b.contains(8, 1, 2), 'seen through a window');
  assert.ok(!b.contains(3, -1, 2), 'below the floor');
  b.addSkip([3, 1, 2], 0.5);
  assert.ok(!b.contains(3.2, 1, 2), 'skipped spot');
  assert.ok(Math.abs(b.area - 24) < 1e-9);
});

test('guide: a room lap faces into the room and sidesteps to the right', () => {
  const room = getTemplate('room');
  const b = new Bounds({ poly: [[-4, -3.5], [4, -3.5], [4, 3.5], [-4, 3.5]], floorY: 0 });
  const st = planPass(room.passes[0].guide, b, room.passes[0], [0, 1.4, 2.4]);
  assert.ok(st.length > 40);
  const s0 = st[0], s1 = st[1];
  assert.ok(Math.abs(s0.pos[2] - 2.5) < 0.05 && Math.abs(s0.pos[1] - 1.4) < 1e-6, 'starts on the near side, 1 m from the wall');
  assert.ok(s0.aim[2] < -0.8, 'aims across the room');
  const walk = [s1.pos[0] - s0.pos[0], s1.pos[2] - s0.pos[2]];
  const right = [-s0.aim[2], s0.aim[0]]; // right of a horizontal heading (x, z)
  assert.ok(walk[0] * right[0] + walk[1] * right[1] > 0, 'walks to the right');
});

test('guide: photos along the path complete the pass', () => {
  const room = getTemplate('room');
  const b = new Bounds({ poly: [[0, 0], [5, 0], [5, 4], [0, 4]], floorY: 0 });
  const g = new Guide({ template: room, bounds: b, voxels: new VoxelMap(0.2, 7) });
  g.setPass(room.passes[0], [2.5, 1.4, 3]);
  let state = g.update({ pos: [2.5, 1.4, 3], fwd: [0, 0, -1], t: 0 });
  assert.ok(state.next && state.instruction, 'has a target');
  for (const st of g.stations) g.onPhoto(poseLookDir(st.pos, st.aim));
  state = g.update({ pos: g.stations[g.stations.length - 1].pos, fwd: [0, 0, -1], t: 1 });
  assert.equal(g.progress(), 1);
  assert.ok(state.complete, 'pass complete');
});

test('guide: never sends you back to a spot you just walked past', () => {
  const room = getTemplate('room');
  const b = new Bounds({ poly: [[0, 0], [6, 0], [6, 5], [0, 5]], floorY: 0 });
  const g = new Guide({ template: room, bounds: b, voxels: new VoxelMap(0.2, 7) });
  g.setPass(room.passes[0], [3, 1.4, 4]);
  g.update({ pos: g.stations[0].pos, fwd: g.stations[0].aim, t: 0 });
  // Walk along the path without any photo landing, then stand a little past station 4.
  for (let i = 1; i <= 4; i++) g.update({ pos: g.stations[i].pos, fwd: g.stations[i].aim, t: i * 0.5 });
  const a = g.stations[4].pos, c = g.stations[5].pos;
  const L = Math.hypot(c[0] - a[0], c[2] - a[2]);
  const past = [a[0] + ((c[0] - a[0]) / L) * 0.2, 1.4, a[2] + ((c[2] - a[2]) / L) * 0.2];
  const st = g.update({ pos: past, fwd: g.stations[4].aim, t: 3 });
  assert.ok(g.stations.indexOf(st.next) >= 5, `next is ahead (got ${g.stations.indexOf(st.next)})`);
  assert.notEqual(st.phase, 'walk', 'close enough to just carry on');
});

test('guide: standing on a spot completes it; a spot that can\'t be reached is skipped', () => {
  const room = getTemplate('room');
  const b = new Bounds({ poly: [[0, 0], [6, 0], [6, 5], [0, 5]], floorY: 0 });
  const g = new Guide({ template: room, bounds: b, voxels: new VoxelMap(0.2, 7) });
  g.setPass(room.passes[0], [3, 1.4, 4]);
  const s0 = g.stations[0];
  let st = g.update({ pos: s0.pos, fwd: s0.aim, t: 0 });
  assert.equal(st.next, s0);
  assert.ok(st.wantPhoto, 'asks for a photo here');
  g.update({ pos: s0.pos, fwd: s0.aim, t: 1 });
  g.update({ pos: s0.pos, fwd: s0.aim, t: 3.6 });
  assert.ok(s0.done, 'done after standing there, aimed, for a moment');
  // Next spot: the user hovers 1.5 m away and never gets there.
  st = g.update({ pos: [s0.pos[0], 1.4, s0.pos[2] - 1.5], fwd: [0, 0, 1], t: 4 });
  const target = st.next;
  let skipped = false;
  for (let t = 4.5; t < 22 && !skipped; t += 0.5) skipped = g.update({ pos: [s0.pos[0], 1.4, s0.pos[2] - 1.5], fwd: [0, 0, 1], t }).skipped;
  assert.ok(skipped && target.transit, 'skipped after ~15 s');
});

// The practice room's geometry, scanned with a lap: the map new sessions are lined up with.
const W_AR = 1280, H_AR = 576, F_AR = W_AR / 2 / Math.tan(35 * DEG);
const INTR_AR = { fx: F_AR, fy: F_AR, cx: W_AR / 2, cy: H_AR / 2, w: W_AR, h: H_AR };
function practiceMap() {
  const vm = new VoxelMap(0.2, 7);
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * Math.PI * 2;
    const pos = [Math.cos(a) * 2.6, 1.4, Math.sin(a) * 2.2];
    const pose = poseLookDir(pos, [-Math.cos(a) + 0.3 * Math.sin(a * 3), -0.15, -Math.sin(a)]);
    vm.integrate(depthGrid(pose, INTR_AR, 24, 18, 0.25, 8).xyz, pos);
  }
  return vm;
}
/** A few seconds of looking around from p, reported in an AR session whose coordinates are S⁻¹. */
function lookAround(S, p, look, n = 10, step = 9, mirror = false) {
  const Si = xfInverse(S);
  return Array.from({ length: n }, (_, k) => {
    const h = (look + k * step) * DEG;
    const pose = poseLookDir([p[0] + 0.03 * k, 1.35, p[1]], [Math.sin(h), -0.25 + 0.05 * (k % 3), -Math.cos(h)]);
    const g = depthGrid(pose, INTR_AR, 32, 24, 0.25, 8);
    let xyz = g.xyz, pp = pose;
    if (mirror) {
      xyz = g.xyz.slice();
      for (let i = 0; i < xyz.length; i += 3) xyz[i] = -xyz[i] + 0.3;
      pp = pose.slice();
      pp[12] = -pp[12] + 0.3;
      pp[0] = -pp[0];
      pp[4] = -pp[4];
      pp[8] = -pp[8];
    }
    return { pts: xfPoints(Si, xyz), pose: xfPose(Si, pp), intr: INTR_AR, d: g.d, nx: g.nx, ny: g.ny };
  });
}

test('re-alignment: a new AR session is found in the scan at any heading', () => {
  const vm = practiceMap();
  for (const [yaw, t, p, look] of [[40, [1.2, 0.1, -0.7], [0.5, 0.8], 30], [170, [-2, 0, 1], [-1.5, -1], 200], [-95, [0.3, -0.2, 2.5], [2, -0.5], 100]]) {
    const S = xf(yaw * DEG, t);
    const r = solveAlignment(vm, lookAround(S, p, look), { floorY: 0 });
    const d = xfDelta(r.xf, S, [p[0], 1.3, p[1]]);
    assert.ok(r.ok, `locked (${r.status}, ${JSON.stringify(r.metrics)})`);
    assert.ok(d.dist < 0.1 && d.yaw < 2, `within 10 cm / 2° (got ${d.dist.toFixed(3)} m, ${d.yaw.toFixed(2)}°)`);
  }
});

test('re-alignment: refuses a look-alike room and a plain wall', () => {
  const vm = practiceMap();
  const S = xf(0.7, [0.4, 0, -0.3]);
  const mirrored = solveAlignment(vm, lookAround(S, [0.5, 0.8], 30, 10, 18, true), { floorY: 0 });
  assert.ok(!mirrored.ok, 'mirrored furniture layout is not accepted');
  const Si = xfInverse(S);
  const wall = Array.from({ length: 8 }, (_, k) => {
    const pose = poseLookDir([3.0, 1.4, -0.5 + k * 0.05], [1, -0.05 + 0.02 * (k % 3), 0.05 * (k - 4)]);
    const g = depthGrid(pose, INTR_AR, 32, 24, 0.25, 8);
    return { pts: xfPoints(Si, g.xyz), pose: xfPose(Si, pose), intr: INTR_AR, d: g.d, nx: g.nx, ny: g.ny };
  });
  const r = solveAlignment(vm, wall, { floorY: 0 });
  assert.ok(!r.ok && ['flat', 'ambiguous'].includes(r.status), `a plain wall could be anywhere (${r.status} ${JSON.stringify(r.metrics)} err ${xfDelta(r.xf, S, [3, 1.4, -0.3]).dist.toFixed(2)})`);
});

test('re-alignment: drift check finds a 12 cm offset and leaves a good alignment alone', () => {
  const vm = practiceMap();
  const S = xf(1.5 * DEG, [0.09, 0, -0.08]);
  const r = checkAlignment(vm, lookAround(S, [-2, -1.5], 200, 6, 15), XF_ID, null);
  assert.ok(r.enough, 'enough overlap');
  const d = xfDelta(r.xf, S, [-2, 1.3, -1.5]);
  assert.ok(r.delta.dist > 0.08 && d.dist < 0.05 && d.yaw < 0.8, `found the offset (${r.delta.dist.toFixed(3)} m, error ${d.dist.toFixed(3)} m)`);
  const ok = checkAlignment(vm, lookAround(XF_ID, [-2, -1.5], 200, 6, 15), XF_ID, null);
  assert.ok(ok.delta.dist < 0.08 && ok.through0 < 0.05, `no correction needed (${ok.delta.dist.toFixed(3)} m)`);
});

// ---- The practice hallway: 2.5 m wide, 18 m long, door recesses on both sides.
// A small CPU renderer gives the photos and camera images something hallway-like to match: mostly
// plain walls, some posters with their own block layouts, numbered doors.
const W_IMG = 640, H_IMG = 288;
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
}
function hallShade(p, n) {
  if (Math.abs(n[1]) > 0.5) return 90 + 60 * vnoise(p[0] * 3, p[2] * 3) + 20 * vnoise(p[0] * 20, p[2] * 20);
  const u = Math.abs(n[0]) > 0.5 ? p[2] : p[0];
  let g = 170 + 12 * vnoise(u * 3, p[1] * 3) + 6 * vnoise(u * 18, p[1] * 18);
  if (Math.abs(p[0]) > 1.7 && p[1] < 2.1) {
    const id = Math.floor((p[2] + 30) / 1.2);
    g = 70 + 60 * hash(id, n[0]) + 25 * vnoise(u * 3 + 9, p[1] * 40);
    const px = (p[2] + 30) / 1.2 - id - 0.5, py = p[1] - 1.6;
    if (Math.abs(px) < 0.12 && Math.abs(py) < 0.07) g = 40 + 200 * hash(Math.floor(px * 25), Math.floor(py * 40) + id);
  }
  const cell = Math.floor((u + 0.3) / 1.7), f = (u + 0.3) / 1.7 - cell, h = hash(cell, n[0] * 7 + n[2] * 3);
  if (Math.abs(p[0]) < 1.7 && h > 0.62 && p[1] > 1.15 && p[1] < 2.35 && f > 0.12 && f < 0.88) {
    g = 30 + 200 * hash(Math.floor(f * (5 + Math.floor(h * 4))) + h * 31, Math.floor(p[1] * 7) + h * 13);
    if (p[1] > 1.9 && (p[1] * 28) % 1 > 0.55) g *= 0.4;
  }
  return p[1] < 0.12 ? 60 : g;
}
function hallImage(pose, half = false) {
  const gray = new Uint8Array(W_IMG * H_IMG), o = [pose[12], pose[13], pose[14]];
  for (let j = 0; j < H_IMG; j++) {
    for (let i = 0; i < W_IMG; i++) {
      const d = transformDir(pose, [(i + 0.5 - INTR_AR.cx / 2) / (INTR_AR.fx / 2), -(j + 0.5 - INTR_AR.cy / 2) / (INTR_AR.fy / 2), -1]);
      const L = Math.hypot(d[0], d[1], d[2]), t = raycast(o, [d[0] / L, d[1] / L, d[2] / L]);
      const p = [o[0] + (d[0] / L) * t, o[1] + (d[1] / L) * t, o[2] + (d[2] / L) * t];
      gray[j * W_IMG + i] = Math.max(0, Math.min(255, hallShade(p, surfaceNormal(p))));
    }
  }
  if (!half) return gray;
  // Thumbnails are scaled down from the full photo.
  const small = new Uint8Array((W_IMG / 2) * (H_IMG / 2));
  for (let y = 0; y < H_IMG / 2; y++) {
    for (let x = 0; x < W_IMG / 2; x++) {
      const k = 2 * y * W_IMG + 2 * x;
      small[y * (W_IMG / 2) + x] = (gray[k] + gray[k + 1] + gray[k + W_IMG] + gray[k + W_IMG + 1]) / 4;
    }
  }
  return small;
}
/** A crab-walk scan of the hallway: coverage map and photo keys (from thumbnails, as when resuming). */
function hallScan() {
  setScene('hallway');
  const vm = new VoxelMap(0.2, 7), keys = [];
  for (const side of [1, -1]) {
    for (let z = 8; z >= -8; z -= 0.4) {
      const pos = [-side * 0.55, 1.4, side > 0 ? z : -z];
      const pose = poseLookDir(pos, [side * Math.cos(25 * DEG), -0.1, -side * Math.sin(25 * DEG)]);
      const g = depthGrid(pose, INTR_AR, 40, 30, 0.25, 6);
      vm.integrate(g.xyz, pos);
      if (Math.round(z * 10) % 8 === 0) {
        const k = makeKey(hallImage(pose, true), W_IMG / 2, H_IMG / 2, pose, INTR_AR, g);
        if (k) keys.push(k);
      }
    }
  }
  return { vm, keys };
}
/** Sweeping the phone across one wall at p, in an AR session whose coordinates are S⁻¹. */
function hallLook(S, p, look) {
  const Si = xfInverse(S), frames = [], imgs = [];
  for (let k = 0; k < 12; k++) {
    const h = (look - 30 + k * 6) * DEG;
    const pose = poseLookDir([p[0], 1.35, p[1] - 0.04 * k], [Math.sin(h), -0.15 - 0.25 * Math.abs(Math.sin(k * 0.7)), -Math.cos(h)]);
    const g = depthGrid(pose, INTR_AR, 32, 24, 0.25, 6);
    const raw = xfPose(Si, pose);
    frames.push({ pts: xfPoints(Si, g.xyz), pose: raw, intr: INTR_AR, d: g.d, nx: g.nx, ny: g.ny });
    if (k >= 10) imgs.push(liveImage(hallImage(pose), W_IMG, H_IMG, INTR_AR, raw));
  }
  return { frames, imgs };
}

test('photo match: one spot along a plain hallway stands out', () => {
  const { keys } = hallScan();
  const S = xf(40 * DEG, [1.2, 0.1, -0.7]);
  const L = hallLook(S, [0.3, 3.2], -100);
  // Start 1.5 m off along the hallway (where depth alone can't tell).
  const r = slideSearch({ keys, imgs: L.imgs }, xf(S.yaw, [S.t[0], S.t[1], S.t[2] + 1.5]), [0, 1]);
  setScene('room');
  assert.ok(r && Math.abs(r.s + 1.5) < 0.06, `found the spot (${r && r.s.toFixed(2)} m)`);
  assert.ok(r.score > 0.6 && r.score - r.second > 0.15, `clearly (${r.score.toFixed(2)} vs ${r.second.toFixed(2)} elsewhere)`);
});

test('re-alignment in a hallway: depth alone can\'t say where along it, the photos can', () => {
  const { vm, keys } = hallScan();
  const S = xf(-95 * DEG, [0.3, -0.2, 2.5]), at = [0.2, 1.3, 3.2];
  // The app tries again every 0.8 s with new views: a few tries, and never a wrong lock.
  let placed = null;
  for (let attempt = 0; attempt < 3 && !placed; attempt++) {
    const L = hallLook(S, [0.2, 3.2], 60);
    const depthOnly = solveAlignment(vm, L.frames, { floorY: 0 });
    assert.ok(!depthOnly.ok || xfDelta(depthOnly.xf, S, at).dist < 0.12, `depth alone never locks in the wrong place (${depthOnly.status})`);
    const r = solveAlignment(vm, L.frames, { floorY: 0, photo: { keys, imgs: L.imgs } });
    const d = xfDelta(r.xf, S, at);
    assert.ok(!r.ok || (d.dist < 0.1 && d.yaw < 1.5), `photos never lock in the wrong place (${d.dist.toFixed(2)} m, ${JSON.stringify(r.metrics)})`);
    if (r.ok) placed = d;
  }
  setScene('room');
  assert.ok(placed, 'photos place it within a few tries');
});

test('guide: a hallway outline drawn around its door recesses gets a path off the walls', () => {
  setScene('hallway');
  const vm = new VoxelMap(0.2, 7);
  for (let z = 8; z >= -8; z -= 0.25) {
    for (const h of [50, 90, 130, -50, -90, -130]) {
      const pose = poseLookDir([0, 1.4, z], [Math.sin(h * DEG), -0.2, -Math.cos(h * DEG)]);
      vm.integrate(depthGrid(pose, INTR_AR, 32, 24, 0.25, 6).xyz, [0, 1.4, z]);
    }
  }
  const tpl = getTemplate('hallway');
  // A plain rectangle out to the back of the recesses: its corners are inside the walls.
  const b = new Bounds({ poly: [[-1.75, -8.5], [1.75, -8.5], [1.75, 8.5], [-1.75, 8.5]], floorY: 0 });
  const g = new Guide({ template: tpl, bounds: b, voxels: vm });
  g.setPass(tpl.passes[0], [0, 1.4, 7]);
  const planned = g.stations.filter((s) => !walkable(s.pos[0], s.pos[2])).length;
  g.update({ pos: [0, 1.4, 7], fwd: [0, 0, -1], t: 0 });
  const live = g.stations.filter((s) => !s.off);
  const stuck = live.filter((s) => !walkable(s.pos[0], s.pos[2])).length;
  const close = Math.min(...live.map((s) => g.grid.nearestWall(s.pos[0], s.pos[2]).d));
  setScene('room');
  assert.ok(planned > 20, `the outline alone puts spots against the walls (${planned})`);
  assert.equal(stuck, 0, 'every spot can be stood on');
  assert.ok(close >= 0.45 && live.length > 0.9 * g.stations.length, `spots keep ${close.toFixed(2)} m from walls, ${live.length}/${g.stations.length} kept`);
});

test('spaces: sessions lined up into one map share coverage; others stay apart', () => {
  const cap = { engine: 'xr', tracking: '6dof', template: 'room' };
  const pts = new Float32Array([1, 1, -2, 1.05, 1, -2, 1, 1.05, -2]);
  const mk = (segment, space) => ({ segment, space, tracked: true, tracking: '6dof', pose: poseLookDir([0, 1.4, 0], [0, 0, -1]), intr: INTR_AR, pts });
  const frames = [mk(1, 100), mk(1, 100), mk(2, 100), mk(3, 300), { ...mk(1), space: undefined }];
  assert.equal(spaceOf(frames[4], cap), 100, 'old photos: their own session\'s space');
  assert.deepEqual(mainSpace(frames, cap), { space: 100, count: 4 });
  assert.equal(rebuildCoverage(frames, getTemplate('room'), cap).segments, 2, 'two separate maps');
});

test('keyframer takes sharp photos while walking (no need to stop)', () => {
  const k = new Keyframer({ hfovDeg: 65, tracking: '6dof' });
  let photos = 0, rushed = 0, t = 0;
  k.committed({ t: 0, pose: poseLookDir([0, 1.4, 0], [0, 0, -1]), odo: 0 });
  // Crab walk at 0.3 m/s, 2 m from the wall; candidates at ~8 Hz with ordinary sharpness.
  for (let i = 0; i < 80; i++) {
    t += 0.125;
    const pose = poseLookDir([0.3 * t, 1.4, 0], [0, 0, -1]);
    const novelty = k.novelty({ t, pose, depthMed: 2 });
    if (novelty < 0.6 && !k.seeking) continue;
    const d = k.offer({ t, relSharp: 0.7 + 0.25 * Math.sin(i * 1.7), blurRisk: 0.45, ok: true, novelty, data: null });
    if (d) {
      photos++;
      if (d.rushed) rushed++;
      k.committed({ t, pose, odo: 0 });
    }
  }
  assert.ok(photos >= 10, `photos ${photos}`);
  assert.equal(rushed, 0);
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

// ---- SplatStation
const { listZip, extractZip, readZipText } = await import('../station/lib/zipread.mjs');
const { posePairs } = await import('../station/lib/colmap.mjs');
const stationZip = async () => {
  const z = new ZipWriter();
  await z.add('Hall_Room_20261019/images/0001.jpg', new Uint8Array([9, 8, 7]));
  await z.add('Hall_Room_20261019/splatscout.json', JSON.stringify({ capture: { building: 'Hall' } }));
  const dir = mkdtempSync(join(tmpdir(), 'ssz-'));
  const file = join(dir, 'c.zip');
  writeFileSync(file, Buffer.from(await z.finish().arrayBuffer()));
  assert.equal((await listZip(file)).length, 2);
  assert.equal(JSON.parse(await readZipText(file, 'splatscout.json')).capture.building, 'Hall');
  await extractZip(file, join(dir, 'out'));
  assert.deepEqual([...readFileSync(join(dir, 'out', 'images', '0001.jpg'))], [9, 8, 7]);
  passed++;
  console.log('  ok station unpacks SplatScout ZIPs (top folder stripped)');
};
await stationZip();

test('station picks matching pairs from AR poses (neighbours + loop closures)', () => {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    frames.push({ name: `${String(i + 1).padStart(4, '0')}.jpg`, pose: Array.from(poseLookDir([Math.cos(a) * 2, 1.5, Math.sin(a) * 2], [-Math.cos(a), 0, -Math.sin(a)])) });
  }
  // A second lap repeats the first: frame 60+k sits where frame k was.
  for (let i = 0; i < 20; i++) frames.push({ name: `${String(61 + i).padStart(4, '0')}.jpg`, pose: frames[i].pose });
  const pairs = posePairs(frames, { temporal: 5, spatial: 10 });
  assert.ok(pairs.includes('0001.jpg 0002.jpg'), 'temporal neighbour');
  assert.ok(pairs.includes('0005.jpg 0065.jpg'), 'loop closure between laps');
  assert.ok(pairs.length < (80 * 79) / 2 / 3, 'far fewer pairs than exhaustive');
});

const { cropPly } = await import('../station/lib/crop.mjs');
test('station crops a splat to the scan area', () => {
  // Tiny 3DGS-style PLY: x, y, z, opacity per splat.
  const pts = [[1, 1, 1], [5, 1, 1], [1, -2, 1], [2.9, 0.5, 2.9], [3.4, 0.5, 1]]; // the last one is within the 0.5 m margin
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\nproperty float x\nproperty float y\nproperty float z\nproperty float opacity\nend_header\n`;
  const body = Buffer.alloc(pts.length * 16);
  pts.forEach((p, i) => { body.writeFloatLE(p[0], i * 16); body.writeFloatLE(p[1], i * 16 + 4); body.writeFloatLE(p[2], i * 16 + 8); body.writeFloatLE(i, i * 16 + 12); });
  const dir = mkdtempSync(join(tmpdir(), 'ssc-'));
  writeFileSync(join(dir, 'in.ply'), Buffer.concat([Buffer.from(header, 'latin1'), body]));
  const r = cropPly(join(dir, 'in.ply'), join(dir, 'out.ply'), { poly: [[0, 0], [3, 0], [3, 3], [0, 3]], floorY: 0 });
  assert.deepEqual(r, { kept: 3, removed: 2 }); // outside x, below the floor
  const out = readFileSync(join(dir, 'out.ply'));
  const txt = out.toString('latin1');
  assert.match(txt, /element vertex 3\n/);
  const start = txt.indexOf('end_header\n') + 11;
  assert.deepEqual([0, 1, 2].map((i) => out.readFloatLE(start + i * 16 + 12)), [0, 3, 4]);
});

console.log(`\n${passed} checks passed`);
