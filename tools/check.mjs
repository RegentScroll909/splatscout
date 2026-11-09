// Self-checks for the platform-independent core (run: node tools/check.mjs).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { poseFromEuler } from '../app/js/sources/orientation.js';
import { poseForward, poseUp, poseRight, poseLookDir, projectPoint, projectionFromIntrinsics, intrinsicsFromProjection, angularVelocity, transformDir, DEG, v3 } from '../app/js/core/math.js';
import { analyzeImage, FlowTracker } from '../app/js/core/analyzer.js';
import { DirectionSphere, VoxelMap } from '../app/js/core/coverage.js';
import { Keyframer } from '../app/js/core/keyframer.js';
import { colmapText, transformsJson } from '../app/js/core/formats.js';
import { ZipWriter, crc32 } from '../app/js/core/zip.js';
import { Coach } from '../app/js/core/coach.js';
import { analyzeCapture } from '../app/js/core/score.js';
import { Bounds } from '../app/js/core/bounds.js';
import { planPass, Guide } from '../app/js/core/guide.js';
import { FloorGrid } from '../app/js/core/floorgrid.js';
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

test('guide: the gap pass plans reachable spots and a skipped spot never comes back', () => {
  setScene('room');
  const vm = practiceMap();
  const tpl = getTemplate('room');
  const b = new Bounds({ poly: [[-3.8, -3.3], [3.8, -3.3], [3.8, 3.3], [-3.8, 3.3]], floorY: 0 });
  vm.setBounds(b);
  const g = new Guide({ template: tpl, bounds: b, voxels: vm });
  const pos = [0, 1.3, 1.6], fwd = [0, 0, -1];
  g.setPass(tpl.passes[0], pos);
  g.update({ pos, fwd, t: 0 }); // builds the wall map
  g.setPass(tpl.passes.find((p) => p.guide.kind === 'gaps'), pos); // used to throw once the wall map existed
  let st = g.update({ pos, fwd, t: 1 });
  assert.ok(st.next && !st.complete, 'a gap to fill');
  assert.ok(Math.abs(st.next.pos[1] - 1.3) < 1e-6, 'from the height the phone is held, not one you\'d have to reach');
  assert.ok(g.grid.standable(st.next.pos[0], st.next.pos[2]), 'a spot that can be stood on');
  // Standing on the marker and aimed: the photo is due (the same distance the session uses).
  const on = g.update({ pos: [st.next.pos[0] + 0.3, 1.3, st.next.pos[2]], fwd: st.next.aim, t: 2 });
  assert.ok(on.wantPhoto && on.phase === 'hold', `photo wanted when on the marker (${on.phase})`);
  // Skip it: neither it nor the patch next to it is suggested again, however long it takes.
  const skipped = st.next.target;
  g.skip(3);
  for (const t of [4, 300, 5000]) {
    const p = g.planGap(pos, fwd, t, 0);
    assert.ok(p && v3.dist(p.target, skipped) >= 0.9, `skipped spot stays skipped at t=${t}`);
  }
  setScene('room');
});

test('guide: everywhere you have walked counts as reachable, even past a gap in the depth map', () => {
  // A closed ring of wall around the spot you stand on (a depth speck can close a gap like this).
  const vm = new VoxelMap(0.2, 7);
  const ring = [];
  for (let a = 0; a < 360; a += 4) for (let y = 0.35; y < 1.9; y += 0.15) ring.push(Math.cos(a * DEG) * 0.7, y, Math.sin(a * DEG) * 0.7);
  for (let i = 0; i < 3; i++) vm.integrate(new Float32Array(ring), [0, 1.4, 0], false);
  const box = [-4, 4, -4, 4];
  assert.ok(!new FloorGrid(vm, 0, box).reachFrom([[0, 0]]).reachable(2.5, 2), 'cut off from where you stand alone');
  assert.ok(new FloorGrid(vm, 0, box).reachFrom([[0, 0], [2, 0], [2.5, 1]]).reachable(2.5, 2), 'reachable from where you walked');
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

test('coach: in front of a plain wall it asks for slower turns, and slipping tracking comes first', () => {
  const base = { trackState: 'ok', rotSpeed: 5, linSpeed: 0.1, flowSpeed: 0.05, relSharp: 0.9, blurRisk: 0, mean: 120, clipHi: 0, clipLo: 0, texture: 0.2, depthMed: 2 };
  // 20°/s: fine with detail in view, too fast at a plain wall.
  let c = new Coach();
  c.update({ ...base, t: 0, rotSpeed: 20 });
  assert.notEqual(c.update({ ...base, t: 0.5, rotSpeed: 20 }).primary.id, 'fast');
  c = new Coach();
  c.update({ ...base, t: 0, rotSpeed: 20, texture: 0.04 });
  const r = c.update({ ...base, t: 0.5, rotSpeed: 20, texture: 0.04 });
  assert.equal(r.primary.id, 'fast');
  assert.match(r.primary.title, /slowly/);
  // A plain wall up close warns before it gets blank.
  c = new Coach();
  c.update({ ...base, t: 0, texture: 0.04, depthMed: 0.8 });
  assert.equal(c.update({ ...base, t: 1, texture: 0.04, depthMed: 0.8 }).primary.id, 'lowtex');
  // Tracking slipping outranks everything but a lost one.
  c = new Coach();
  c.update({ ...base, t: 0, trackState: 'limited', relSharp: 0.3, blurRisk: 0.8 });
  assert.equal(c.update({ ...base, t: 1, trackState: 'limited', relSharp: 0.3, blurRisk: 0.8 }).primary.id, 'limited');
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
const { posePairs, posedPairs, renumberModel, strayedFromAR, imagesFromText } = await import('../station/lib/colmap.mjs');
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

test('station: AR poses for only some photos (club photos) are matched and numbered the way COLMAP needs', () => {
  const lens = { w: 860, h: 1920, fx: 1374.1, fy: 1374.76, cx: 430, cy: 960 };
  const frames = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return { name: `${String(i + 1).padStart(4, '0')}.jpg`, pose: Array.from(poseLookDir([Math.cos(a) * 2, 1.5, Math.sin(a) * 2], [-Math.cos(a), 0, -Math.sin(a)])), intr: lens };
  });
  const names = [...frames.map((f) => f.name), ...Array.from({ length: 30 }, (_, i) => `${String(41 + i).padStart(4, '0')}.jpg`)];
  assert.deepEqual(posedPairs(frames.slice(0, 38), frames.map((f) => f.name)), posePairs(frames.slice(0, 38)), 'nearly all posed: the pose pairs alone');
  const mixed = posedPairs(frames, names), posed = new Set(frames.map((f) => f.name));
  assert.ok(mixed.includes('0041.jpg 0042.jpg'), 'photos without a pose are matched along their own order');
  assert.ok(mixed.some((p) => posed.has(p.split(' ')[0]) !== posed.has(p.split(' ')[1])), 'and against the posed ones');
  // The phone's model numbers the posed photos 1, 2, 3 (here 0003.jpg has no pose); COLMAP's database gave
  // each photo its own camera, frame and rig. point_triangulator needs the database's numbers.
  const model = colmapText([frames[0], frames[1], frames[3]], null);
  const rows = [1, 2, 3, 4].map((k) => ({ image_id: k, name: `${String(k).padStart(4, '0')}.jpg`, camera_id: 10 + k, frame_id: 20 + k, rig_id: 30 + k }));
  const r = renumberModel(model, rows);
  const data = (txt) => txt.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' '));
  assert.deepEqual([r.kept, r.dropped], [3, 0]);
  assert.deepEqual(data(r.images).map((p) => [p[0], p[8], p[9]]), [['1', '11', '0001.jpg'], ['2', '12', '0002.jpg'], ['4', '14', '0004.jpg']]);
  assert.deepEqual(data(r.images).map((p) => p.slice(1, 8)), data(model.images).map((p) => p.slice(1, 8)), 'the poses themselves are untouched');
  assert.deepEqual(data(r.frames).map((p) => [p[0], p[1], p.slice(9).join(' ')]), [['21', '31', '1 CAMERA 11 1'], ['22', '32', '1 CAMERA 12 2'], ['24', '34', '1 CAMERA 14 4']]);
  assert.deepEqual(data(r.cameras).map((p) => p.join(' ')), [11, 12, 14].map((id) => `${id} PINHOLE 860 1920 1374.1 1374.76 430 960`), 'each photo’s own camera, with the AR lens');
  assert.deepEqual(data(r.rigs).map((p) => p.join(' ')), ['31 1 CAMERA 11', '32 1 CAMERA 12', '34 1 CAMERA 14']);
  assert.deepEqual([renumberModel(model, rows.filter((x) => x.name !== '0002.jpg')).dropped], [1], 'a photo the database doesn’t have is left out');
  // Each camera must be the database's kind: with different lenses each photo has its own SIMPLE_RADIAL one.
  const kind = (model_, w = 860, h = 1920) => rows.map((x) => ({ ...x, camera_model: model_, width: w, height: h }));
  assert.deepEqual(data(renumberModel(model, kind(2)).cameras).map((p) => p.join(' ')), [11, 12, 14].map((id) => `${id} SIMPLE_RADIAL 860 1920 1374.43 430 960 0`), 'the AR lens, with no distortion');
  assert.equal(data(renumberModel(model, kind(1)).cameras)[0].join(' '), '11 PINHOLE 860 1920 1374.1 1374.76 430 960');
  assert.equal(renumberModel(model, kind(2, 430, 960)).kept, 0, 'a photo the database has at another size is left out');
  // After the adjustment: an AR photo moved far on few points is left out; moved far with plenty of points (the
  // tracking's drift corrected), or moved a little, it stays.
  const moved = (f, dx) => ({ ...f, pose: [...f.pose.slice(0, 12), f.pose[12] + dx, f.pose[13], f.pose[14], 1] });
  const counts = [12, 12, 80];
  let at = 0;
  const adjusted = colmapText([moved(frames[0], 0.3), moved(frames[1], 3), moved(frames[2], 3)], null).images
    .replace(/\n\n/g, () => `\n${Array.from({ length: counts[at++] }, (_, k) => `${k}.5 ${k}.5 ${k}`).join(' ')}\n`);
  assert.deepEqual(strayedFromAR(imagesFromText(adjusted), frames), ['0002.jpg']);
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

test('station crop keeps the big background splats and can be changed or undone later', () => {
  // x, y, z, opacity, log-scales; the id rides in opacity. Outside the 3 m square: a small floater
  // (id 1), a big faint blob 6 m out that paints a plain wall (id 2), and one under the floor (id 3).
  const props = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2'];
  const pts = [[1, 1, 1, 0.05], [5, 1, 1, 0.05], [9, 1, 1, 0.8], [1, -2, 1, 0.05], [2, 0.5, 2, 0.05]];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`;
  const body = Buffer.alloc(pts.length * 28);
  pts.forEach(([x, y, z, s], i) => [x, y, z, i, Math.log(s), Math.log(s / 2), Math.log(s / 4)].forEach((v, k) => body.writeFloatLE(v, i * 28 + k * 4)));
  const dir = mkdtempSync(join(tmpdir(), 'ssc-'));
  const scene = join(dir, 'scene.ply'), outside = join(dir, 'scene.outside.ply');
  writeFileSync(join(dir, 'trained.ply'), Buffer.concat([Buffer.from(header, 'latin1'), body]));
  const ids = (f) => {
    const b = readFileSync(f), s = b.toString('latin1').indexOf('end_header\n') + 11;
    return Array.from({ length: (b.length - s) / 28 }, (_, i) => b.readFloatLE(s + i * 28 + 12)).sort();
  };
  const area = { poly: [[0, 0], [3, 0], [3, 3], [0, 3]], floorY: 0 };
  assert.deepEqual(cropPly(join(dir, 'trained.ply'), scene, area, 0.5, { outside }), { kept: 3, removed: 2 });
  assert.deepEqual(ids(scene), [0, 2, 4], 'the big blob stays');
  assert.deepEqual(ids(outside), [1, 3], 'what was removed is kept beside it');
  // Undo it (keep everything), then crop again: the same result, nothing lost on the way.
  assert.deepEqual(cropPly([scene, outside], scene, null, 0, { outside }), { kept: 5, removed: 0 });
  assert.deepEqual(ids(scene), [0, 1, 2, 3, 4]);
  assert.ok(!existsSync(outside), 'nothing left outside');
  cropPly(scene, scene, area, 0.5, { outside });
  assert.deepEqual(ids(scene), [0, 2, 4]);
  // A wider outline brings the floater back.
  cropPly([scene, outside], scene, { ...area, poly: [[0, 0], [6, 0], [6, 3], [0, 3]] }, 0.5, { outside });
  assert.deepEqual(ids(scene), [0, 1, 2, 4]);
});

// ---- walk mode: a made-up splat of two rooms joined by a doorway, in the AR frame (phone at y≈0).
// Floor at y = -1.4 over x 0–6, z 0–4 with a shiny hole in it; textured walls at z = 0, x = 0 and
// x = 3 (doorway at z 1.5–2.5); a plain wall at x = 6 made of a few big flat splats; no wall at
// z = 4 (the floor just ends); a table in the second room; faint floaters in mid-air.
const { buildWalkMap, readCameras } = await import('../station/lib/walkmap.mjs');
const { decodeMap, Walker, FLOOR, BLOCK, toScene, toWalk } = await import('../station/web/walk.js');
function walkScene() {
  const s = [];
  const add = (x, y, z, a, sc, q = [1, 0, 0, 0]) => s.push({ x, y, z, a, sc, q });
  const F = -1.4;
  for (let x = 0.025; x < 6; x += 0.05) for (let z = 0.025; z < 4; z += 0.05) {
    if (x > 1.0 && x < 1.8 && z > 1.5 && z < 2.3) continue; // shiny patch: nothing reconstructed
    add(x, F, z, 0.6, [0.03, 0.005, 0.03]);
  }
  for (let y = F; y < 1; y += 0.05) {
    for (let x = 0.025; x < 6; x += 0.05) add(x, y, 0, 0.7, [0.03, 0.03, 0.005]);
    for (let z = 0.025; z < 4; z += 0.05) {
      add(0, y, z, 0.7, [0.005, 0.03, 0.03]);
      if (z < 1.5 || z > 2.5 || y > F + 2.1) add(3, y, z, 0.7, [0.005, 0.03, 0.03]);
    }
  }
  // Plain wall: big thin splats every 0.4 m, flat in their own x–y plane, turned 90° about y.
  for (let y = F + 0.2; y < 1; y += 0.4) for (let z = 0.2; z < 4; z += 0.4) add(6, y, z, 0.9, [0.25, 0.25, 0.01], [Math.SQRT1_2, 0, Math.SQRT1_2, 0]);
  for (let x = 4.0; x < 5.0; x += 0.05) for (let z = 0.7; z < 1.3; z += 0.05) add(x, F + 0.75, z, 0.8, [0.03, 0.005, 0.03]); // table top
  for (const [x, z] of [[1.5, 3], [4.5, 2.6], [2.2, 1]]) add(x, F + 1.2, z, 0.3, [0.04, 0.04, 0.04]); // floaters
  return s;
}
function writeWalkPly(file, splats, k = 1, flip = false) {
  const props = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`;
  const b = Buffer.alloc(splats.length * props.length * 4);
  splats.forEach((s, i) => {
    // flip = the scene turned upside down (180° about x), as an unposed solve can come out
    const v = [s.x * k, (flip ? -s.y : s.y) * k, (flip ? -s.z : s.z) * k, Math.log(s.a / (1 - s.a)), ...s.sc.map((g) => Math.log(g * k)),
      ...(flip ? [-s.q[1], s.q[0], -s.q[3], s.q[2]] : s.q)];
    v.forEach((x, j) => b.writeFloatLE(x, (i * props.length + j) * 4));
  });
  writeFileSync(file, Buffer.concat([Buffer.from(head, 'latin1'), b]));
}
const walkCams = (k = 1, flip = false) =>
  [[1.5, 0.6], [1.5, 1.4], [1.6, 2.0], [2.4, 2.0], [3.0, 2.0], [3.6, 2.0], [4.4, 2.2], [5.0, 2.8]].map(([x, z], i) => ({
    name: `${String(i + 1).padStart(4, '0')}.jpg`,
    C: [x * k, 0, (flip ? -z : z) * k],
    fwd: [1, 0, 0],
  }));
const walkDir = mkdtempSync(join(tmpdir(), 'ssw-'));
writeWalkPly(join(walkDir, 'scene.ply'), walkScene());
const walkMap = decodeMap(await buildWalkMap(join(walkDir, 'scene.ply'), { cams: walkCams(), up: [0, 1, 0], metric: true }));
// The same scene as an unposed (video) solve might give it: half size and upside down, so up is -y.
writeWalkPly(join(walkDir, 'flipped.ply'), walkScene(), 0.5, true);
const flippedMap = decodeMap(await buildWalkMap(join(walkDir, 'flipped.ply'), { cams: walkCams(0.5, true), up: [0, -1, 0], metric: false }));
// Walk from (x, z) straight towards (tx, tz) for up to `far` metres; returns where you end up.
const walkTo = (w, x, z, tx, tz, far = 8) => {
  w.place(x, z);
  const d = Math.hypot(tx - x, tz - z);
  for (let s = 0; s < far / 0.05 && Math.hypot(tx - w.x, tz - w.z) > 0.03; s++) {
    const r = Math.hypot(tx - w.x, tz - w.z);
    w.move(((tx - w.x) / r) * Math.min(0.05, r), ((tz - w.z) / r) * Math.min(0.05, r));
  }
  return [w.x, w.z, d];
};

test('walk map: floor found, plain wall, table and doorway sorted out, floor holes filled', () => {
  const m = walkMap;
  assert.ok(Math.abs(m.floorY + 1.4) < 0.05, `floor at ${m.floorY.toFixed(3)}`);
  assert.ok(Math.abs(m.eye - 1.4) < 0.06, `eye height ${m.eye.toFixed(2)}`);
  const w = new Walker(m);
  assert.equal(w.cellAt(4.5, 1.0), BLOCK, 'table blocks');
  assert.equal(w.cellAt(6.0, 2.0), BLOCK, 'plain wall of big flat splats blocks');
  assert.equal(w.cellAt(3.0, 1.0), BLOCK, 'partition wall');
  assert.equal(w.cellAt(3.0, 2.0), FLOOR, 'doorway is open');
  assert.equal(w.cellAt(1.4, 1.9), FLOOR, 'shiny hole in the floor is filled');
  for (const [x, z] of [[1.5, 3], [4.5, 2.6], [2.2, 1]]) assert.equal(w.cellAt(x, z), FLOOR, `floater at ${x},${z} doesn't block`);
  assert.ok(!w.canStand(4.5, 1.0) && w.canStand(1.5, 2.0));
});

// The floor of the space the photos were taken in (what the Campus page counts when a splat in metres has no
// scan outline): here both rooms, through the doorway; inside an outline around the first room, just that one.
const room1Map = await buildWalkMap(join(walkDir, 'scene.ply'), { cams: walkCams().slice(0, 3), up: [0, 1, 0], metric: true, polys: [[[0.1, 0.1], [2.9, 0.1], [2.9, 3.9], [0.1, 3.9]]] });
// A solve can put the odd barely-matched photo kilometres away: it mustn't stretch the map over nothing.
const strayMap = await buildWalkMap(join(walkDir, 'scene.ply'), { cams: [...walkCams(), { name: 'stray.jpg', C: [4800, 3, -1200], fwd: [1, 0, 0] }], up: [0, 1, 0], metric: true });
test('walk map: measures the floor of the space where the photos were taken', () => {
  const both = walkMap.stats.floorArea, one = room1Map.stats.floorArea;
  assert.ok(both > 20 && both < 24, `two rooms of 12 m², less their walls (the table in the second counts): ${both} m²`);
  assert.ok(one > 10 && one < 12.5, `the first room alone, inside its outline: ${one} m²`);
  assert.deepEqual([strayMap.cell, strayMap.W, strayMap.H, strayMap.stats.floorArea], [walkMap.cell, walkMap.W, walkMap.H, both], 'a camera put 5 km away changes nothing');
});

test('walker: through the doorway, but not through walls, furniture or off the floor', () => {
  const w = new Walker(walkMap);
  const R = w.radius;
  let [x, z] = walkTo(w, 1.5, 2.0, 4.5, 2.0);
  assert.ok(Math.hypot(x - 4.5, z - 2.0) < 0.05, `through the doorway (ended at ${x.toFixed(2)}, ${z.toFixed(2)})`);
  [x] = walkTo(w, 1.5, 0.8, 4.5, 0.8);
  assert.ok(x < 3 - R + 0.02, `stopped by the partition (x ${x.toFixed(2)})`);
  [x] = walkTo(w, 4.5, 3.0, 9, 3.0);
  assert.ok(x < 6 - R + 0.02 && x > 5.4, `stopped by the plain wall (x ${x.toFixed(2)})`);
  [, z] = walkTo(w, 1.5, 2.0, 1.5, 9);
  assert.ok(z < 4 - R + 0.02 && z > 3.5, `stopped where the floor ends (z ${z.toFixed(2)})`);
  [x, z] = walkTo(w, 4.5, 2.2, 4.5, 0.3);
  assert.ok(z > 1.3 + R - 0.02, `stopped by the table (z ${z.toFixed(2)})`);
  // Walking diagonally into a wall slides along it instead of sticking.
  w.place(1.5, 1.0);
  const z0 = w.z;
  for (let i = 0; i < 40; i++) w.move(0.035, -0.035);
  assert.ok(w.x > 2.0 && z0 - w.z < 1.0 && w.canStand(w.x, w.z), `slid along the wall to ${w.x.toFixed(2)}, ${w.z.toFixed(2)}`);
});

test('walk map: an upside-down splat at an unknown scale comes out the same', () => {
  const m = flippedMap;
  // The phone was 1.4 m up and the estimate assumes 1.5 m, so the scale comes out ~7 % large.
  assert.ok(Math.abs(m.scale - 2) < 0.2, `scale ${m.scale.toFixed(3)}`);
  const w = new Walker(m);
  const at = (x, z) => toWalk(m, [x * 0.5, 0, -z * 0.5]); // scene point of a metric (x, z) in the original
  const door = at(3, 2), table = at(4.5, 1.0), wall = at(3, 1.0);
  assert.equal(w.cellAt(door[0], door[2]), FLOOR);
  assert.equal(w.cellAt(table[0], table[2]), BLOCK);
  assert.equal(w.cellAt(wall[0], wall[2]), BLOCK);
  const plain = at(6, 2);
  assert.equal(w.cellAt(plain[0], plain[2]), BLOCK, 'plain wall of turned big splats');
  const back = toScene(m, toWalk(m, [1, 2, 3]));
  near(back, [1, 2, 3], 1e-5, 'walk frame round trip');
});

test('station reads camera centres from COLMAP text and binary models alike', () => {
  const cams = walkCams().slice(0, 3);
  // Camera looking along +x: rows of world→camera rotation are camera x, y, z axes in world terms.
  const Rw = [[0, 0, 1], [0, -1, 0], [1, 0, 0]];
  const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // the same rotation as a quaternion (w, x, y, z)
  const t = (C) => Rw.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
  const txtDir = join(walkDir, 'txt'), binDir = join(walkDir, 'bin');
  mkdirSync(txtDir);
  mkdirSync(binDir);
  // Text: one line per image plus its 2-D points line, which may be empty.
  writeFileSync(join(txtDir, 'images.txt'), '# Image list\n' + cams.map((c, i) => `${i + 1} ${q.join(' ')} ${t(c.C).join(' ')} 1 ${c.name}\n${i === 1 ? '' : '10 20 -1'}\n`).join(''));
  const parts = [Buffer.alloc(8)];
  parts[0].writeBigUInt64LE(BigInt(cams.length));
  cams.forEach((c, i) => {
    const h = Buffer.alloc(4 + 56 + 4);
    h.writeUInt32LE(i + 1, 0);
    [...q, ...t(c.C)].forEach((v, k) => h.writeDoubleLE(v, 4 + k * 8));
    h.writeUInt32LE(1, 60);
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(1n);
    parts.push(h, Buffer.from(c.name + '\0'), n, Buffer.alloc(24));
  });
  writeFileSync(join(binDir, 'images.bin'), Buffer.concat(parts));
  for (const dir of [txtDir, binDir]) {
    const got = readCameras(dir);
    assert.equal(got.length, 3, dir);
    got.forEach((g, i) => {
      near(g.C, cams[i].C, 1e-6, `${dir} centre ${i}`);
      near(g.fwd, [1, 0, 0], 1e-6, `${dir} forward ${i}`);
    });
  }
});

const { partAreas, lensGroups } = await import('../station/lib/pipeline.mjs');
const { mergePairs } = await import('../station/lib/colmap.mjs');
test('merging phones: pairs within and across captures; each scan area lands in the main phone\'s coordinates', () => {
  // Phone B's AR frame is phone A's turned 70° and moved; the solve put B's photos where A has them.
  const th = 70 * DEG, rot = (x, y, z) => [Math.cos(th) * x + Math.sin(th) * z, y, -Math.sin(th) * x + Math.cos(th) * z];
  const toB = (p) => { const r = rot(...p); return [r[0] + 3, r[1] + 0.2, r[2] - 5]; };
  const polyA = [[-1, 0], [2, 0], [2, 9], [-1, 9]];
  const real = Array.from({ length: 30 }, (_, i) => [0.5 + Math.sin(i), 0, i * 0.3]);
  const partB = {
    bounds: { poly: polyA.map(([x, z]) => { const q = toB([x, -1.5, z]); return [q[0], q[2]]; }), floorY: -1.3, top: null },
    frames: real.map((p, i) => {
      const q = toB(p);
      return { name: `p2/${i}.jpg`, pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, q[0], q[1], q[2], 1] };
    }),
  };
  const [area] = partAreas([partB], real.map((p, i) => ({ name: `p2/${i}.jpg`, C: p })));
  near(area.poly.flat(), polyA.flat(), 1e-6, 'B\'s outline back on A\'s');
  assert.ok(Math.abs(area.floorY + 1.5) < 1e-6, `floor ${area.floorY}`);
  const names = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}/${String(i + 1).padStart(4, '0')}.jpg`);
  const pairs = mergePairs([{ names: names('p1', 300) }, { names: names('p2', 250) }]);
  assert.equal(new Set(pairs).size, pairs.length, 'no pair twice');
  assert.ok(pairs.includes('p1/0001.jpg p1/0002.jpg') && pairs.includes('p2/0010.jpg p2/0026.jpg'), 'neighbours within each capture');
  const across = pairs.filter((p) => p.startsWith('p1/') && p.includes(' p2/')).length;
  assert.ok(across >= 100 * 100 && across <= 120 * 120, `${across} pairs across the captures`);
});

// ---- A scan in parts: tracking was lost, scanning carried on as a new part, SplatStation joins the parts.
// (These draw on the seeded Math.random; the seed is put back afterwards, so the checks below see the same noise.)
const seedBeforeParts = seed;
const { Relocalizer } = await import('../app/js/capture/relocalizer.js');
const { exportFiles } = await import('../app/js/data/exporter.js');
const { framesIn, boundsIn, partsOf } = await import('../app/js/core/spaces.js');
const { wallAngleFactor } = await import('../app/js/core/guide.js');
const { segmentPairs, fitPart, movePose, colmapQt, addToModel } = await import('../station/lib/colmap.mjs');
const { scanParts } = await import('../station/lib/pipeline.mjs');

test('scan in parts: a loss that doesn\'t line up offers a new part at once, and the earlier map is found in the background', () => {
  const vm = practiceMap();
  let photos = 30;
  const stub = { voxels: vm, bounds: null, recording: true, paused: false, photoKeys: [], space: 100, viewSpace: 100, lastT: 0, partPhotos: () => photos };
  const R = new Relocalizer(stub);
  let t = 0;
  const seen = [];
  const step = (f) => {
    const fi = { pose: f ? Float32Array.from(f.pose) : null, trackState: f ? 'ok' : 'lost' };
    const raw = f ? R.apply(fi) : null;
    R.frame(fi, raw, t, 0.25);
    if (f) R.addDepth({ xyz: xfPoints(R.xf, f.pts), d: f.d, nx: f.nx, ny: f.ny }, raw, INTR_AR, t);
    const ev = R.tick(t);
    if (ev) seen.push(ev.type);
    t += 0.25;
    stub.lastT = t;
    return ev;
  };
  for (const f of lookAround(XF_ID, [0.5, 0.8], 30, 8)) step(f);
  assert.equal(R.mode, null, 'tracking fine: nothing to do');
  for (let k = 0; k < 4; k++) step(null);
  // Back in other AR coordinates (ARCore started over): turned 40° and 1.4 m away.
  const S = xf(40 * DEG, [1.2, 0.1, -0.7]);
  const back = t;
  for (const f of lookAround(S, [0.5, 0.8], 30, 24)) if (R.mode !== 'offer') step(f);
  assert.equal(R.mode, 'offer', `a new part is offered (${seen.join(', ')})`);
  assert.ok(t - back <= 5 && !seen.includes('searching'), `at once, without searching first (${(t - back).toFixed(2)} s)`);
  assert.ok(R.holding, 'photos wait only while it is offered');
  // "Keep scanning (new part)": a fresh map, and the earlier one searched for in the background.
  R.newPart();
  photos = 0;
  stub.voxels = new VoxelMap(0.2, 7);
  R.watch({ voxels: vm, space: 100, floorY: 0 }, t);
  assert.ok(!R.holding, 'photos carry on meanwhile');
  let linked = null;
  for (const [p, look] of [[[0.5, 0.8], 60], [[-1.5, -1], 200], [[2, -0.5], 100], [[0.6, 0.6], 150], [[-1.2, 0.9], 300]]) {
    for (const f of lookAround(S, p, look, 10)) if (!linked) linked = step(f);
    assert.ok(!R.holding, 'never blocking');
  }
  assert.ok(linked && linked.type === 'partsLinked', `found the earlier map (${R.bg ? `${R.bg.status} ${R.bg.tries} tries` : seen.join(', ')})`);
  const d = xfDelta(linked.xf, S, [0.5, 1.3, 0.8]);
  assert.ok(d.dist < 0.1 && d.yaw < 2, `lined up within 10 cm / 2° (${d.dist.toFixed(3)} m, ${d.yaw.toFixed(2)}°)`);
});

test('re-alignment: a slow, steady sweep gathers views from different spots (it used to wait for ever)', () => {
  const R = new Relocalizer({ voxels: practiceMap(), bounds: null, recording: true, paused: false, photoKeys: [], space: 100, viewSpace: 100, lastT: 0, partPhotos: () => 0 });
  R.begin('manual', 0);
  // 1 cm and 1.5° between depth samples (5 a second): what "sweep slowly" looks like.
  for (let k = 0; k < 40; k++) {
    const h = (30 + k * 1.5) * DEG;
    const pose = poseLookDir([0.5 + 0.01 * k, 1.35, 0.8], [Math.sin(h), -0.25, -Math.cos(h)]);
    const g = depthGrid(pose, INTR_AR, 32, 24, 0.25, 8);
    R.addDepth({ xyz: g.xyz, d: g.d, nx: g.nx, ny: g.ny }, pose, INTR_AR, k * 0.2);
  }
  const kept = R.state.frames.filter((f) => !f.standIn).length;
  assert.ok(kept >= 10 && R.state.frames.length <= kept + 1, `${kept} views kept, plus the latest`);
});

// A recorded scan: a real one when this PC has SplatStation's jobs, else a lap of the practice room.
const fsx = await import('node:fs');
const { homedir } = await import('node:os');
const recorded = (() => {
  const jobs = process.env.SPLATSTATION_JOBS || join(homedir(), 'SplatStation', 'jobs');
  try {
    for (const id of fsx.readdirSync(jobs)) {
      const f = join(jobs, id, 'dataset', 'splatscout.json');
      if (!existsSync(f)) continue;
      const m = JSON.parse(readFileSync(f, 'utf8'));
      const fr = (m.frames || []).filter((x) => x.tracked && x.pose && x.intrinsics);
      if (m.capture && m.capture.tracking === '6dof' && fr.length >= 150 && m.bounds && m.bounds.poly) return { name: `${m.capture.room} (${id})`, frames: fr.slice(0, 300), bounds: m.bounds };
    }
  } catch {}
  const frames = Array.from({ length: 200 }, (_, i) => {
    const a = (i / 200) * Math.PI * 4;
    return { pose: Array.from(poseLookDir([Math.cos(a) * 2.4, 1.4, Math.sin(a) * 1.9], [-Math.cos(a), -0.1, -Math.sin(a)])), intrinsics: INTR_AR, metrics: { relSharp: 0.9 }, flags: [] };
  });
  // Counter-clockwise seen from above, the way the app stores every outline (bounds.js ccw), like a real scan's.
  return { name: 'practice lap', frames, bounds: { poly: [[-3, -2.5], [-3, 2.5], [3, 2.5], [3, -2.5]], floorY: 0, margin: 0.35, skips: [] } };
})();

await (async () => {
  const rec = recorded.frames;
  const cut = Math.round(rec.length * 0.55);
  // After the loss ARCore's coordinates are the old ones turned 70° and moved: part 2's poses are in those.
  const X = xf(70 * DEG, [3, 0.2, -2]);
  const frames = rec.map((f, i) => ({
    id: `f${i}`, seq: i + 1, segment: i < cut ? 1 : 2, space: i < cut ? 100 : 200, pass: 'mid', t: i, tracked: true,
    pose: i < cut ? f.pose : Array.from(xfPose(X, f.pose)), intr: f.intrinsics, m: f.metrics || { relSharp: 0.9 }, flags: f.flags || [],
    trigger: 'trans', baseline: 0.1, jpeg: new Blob([new Uint8Array([i & 255])]),
  }));
  const moveBounds = (b, x) => ({ ...b, poly: b.poly.map(([px, pz]) => { const q = xfPoints(x, new Float32Array([px, 0, pz])); return [q[0], q[2]]; }), floorY: b.floorY + x.t[1], skips: [] });
  const outline = { ...recorded.bounds, skips: [], space: 100, segment: 1 };
  // The outline was marked in part 1; the same outline marked again in part 2 (in its coordinates) is moved back.
  const capture = { id: 'c1', building: 'Hall', room: 'Room', template: 'room', engine: 'xr', tracking: '6dof', createdAt: Date.now(), segments: 2, stats: {},
    boundsBySpace: { 100: outline, 200: { ...moveBounds(outline, X), space: 200, segment: 2 } } };
  const { files } = await exportFiles(capture, frames);
  const file = (n) => files.find((f) => f.name === n);
  const man = JSON.parse(file('splatscout.json').data);
  assert.deepEqual(man.parts.map((p) => [p.part, p.space, p.main, p.photos, p.poses]), [[1, 100, true, cut, 'poses/colmap/sparse/0'], [2, 200, false, rec.length - cut, 'poses/parts/2/colmap/sparse/0']]);
  assert.ok(man.frames.every((f, i) => f.part === (i < cut ? 1 : 2) && f.segment === (i < cut ? 1 : 2)), 'each photo records its part and segment');
  near(man.bounds.poly.flat(), outline.poly.flat(), 1e-3, 'the crop outline stays in the main part\'s coordinates');
  const centres = (txt) => imagesFromText(txt).map((im) => {
    const [qw, qx, qy, qz, tx, ty, tz] = im.qt;
    const R = [[1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)], [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)], [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)]];
    return [im.name, [0, 1, 2].map((j) => -(R[0][j] * tx + R[1][j] * ty + R[2][j] * tz))];
  });
  const main = centres(file('poses/colmap/sparse/0/images.txt').data), other = centres(file('poses/parts/2/colmap/sparse/0/images.txt').data);
  assert.deepEqual([main.length, other.length], [cut, rec.length - cut], 'one COLMAP model per part');
  near(other[0][1], frames[cut].pose.slice(12, 15), 1e-3, 'part 2 in its own AR coordinates');
  assert.ok(JSON.parse(file('poses/transforms.json').data).frames.every((f) => f.segment === 1), 'transforms.json: the main part, segment by segment');

  // SplatStation: the parts, main first, each with its AR poses in its own coordinates.
  const mainNames = new Set(main.map(([n]) => n));
  const parts = scanParts(man, man.frames.filter((f) => mainNames.has(f.file.slice(7))).map((f) => ({ name: f.file.slice(7) })));
  assert.deepEqual(parts.map((p) => [p.part, p.main, p.names.length, p.frames.length]), [[1, true, cut, cut], [2, false, rec.length - cut, rec.length - cut]]);
  assert.ok(parts[1].bounds && !scanParts({ ...man, frames: man.frames.map((f) => ({ ...f, space: 100 })) }, null), 'a scan in one part has none');
  const pairs = segmentPairs(parts);
  const name = (i) => `${String(i + 1).padStart(4, '0')}.jpg`;
  assert.equal(new Set(pairs).size, pairs.length, 'no pair twice');
  assert.ok(pairs.includes(`${name(cut - 1)} ${name(cut)}`) && pairs.includes(`${name(cut - 30)} ${name(cut + 29)}`), 'where part 2 begins, every photo against the end of part 1');
  assert.ok(pairs.includes(`${name(0)} ${name(1)}`) && pairs.includes(`${name(cut + 1)} ${name(cut + 2)}`), 'neighbours within each part');
  // SplatStation matches these pairs only above 700 photos (below that, every photo against every other), and there
  // they are far fewer than every pair, since the parts meet through thinned sets. A small scan gets nearly all.
  const big = [0, 1].map((k) => ({ names: Array.from({ length: 400 }, (_, i) => name(k * 400 + i)) }));
  const bigPairs = segmentPairs(big).length, every = (800 * 799) / 2;
  assert.ok(bigPairs < every * 0.15, `far fewer than every pair at 800 photos (${bigPairs} of ${every})`);

  // The solve: COLMAP placed part 2's first 8 photos (its overlap with part 1) in the main part's coordinates, and
  // a ninth in the wrong place. The fit moves part 2 back, and the rest of its photos follow their AR poses.
  const images = new Map();
  for (let i = cut; i < cut + 8; i++) images.set(name(i), { qt: colmapQt(rec[i].pose) });
  const wrong = rec[cut + 40].pose.slice();
  wrong[12] += 2;
  images.set(name(cut + 40), { qt: colmapQt(wrong) });
  const fit = fitPart(parts[1].frames, images);
  assert.ok(fit && fit.inliers === 8 && fit.placed === 9, `the wrongly placed photo is left out (${fit && fit.inliers}/${fit && fit.placed})`);
  let worst = 0;
  for (const f of parts[1].frames) {
    const i = +f.name.slice(0, 4) - 1, p = movePose(fit, f.pose);
    worst = Math.max(worst, Math.hypot(p[12] - rec[i].pose[12], p[13] - rec[i].pose[13], p[14] - rec[i].pose[14]), Math.hypot(p[8] - rec[i].pose[8], p[9] - rec[i].pose[9], p[10] - rec[i].pose[10]));
  }
  assert.ok(worst < 0.01, `every photo of part 2 back where it was taken (worst ${worst.toFixed(4)})`);
  assert.equal(fitPart(parts[1].frames, new Map([...images].slice(0, 3))), null, 'three placed photos are too few to go on');
  // The outline marked in part 2 lands on part 1's.
  const cams = parts[1].frames.map((f) => ({ name: f.name, C: movePose(fit, f.pose).slice(12, 15) }));
  near(partAreas([parts[1]], cams)[0].poly.flat(), outline.poly.flat(), 0.02, 'part 2\'s outline in the main part\'s coordinates');
  // Its other photos go into the model under the database's ids; what's there already stays as it is.
  const model = colmapText(rec.slice(0, 3).map((f, i) => ({ name: name(i), pose: f.pose, intr: f.intrinsics })), null);
  const rows = new Map([0, 1, 2, cut + 20, cut + 21].map((i) => [name(i), { image_id: 100 + i, camera_id: 1, frame_id: 300 + i, rig_id: 1 }]));
  const out = addToModel(model, [{ name: name(cut + 20), qt: colmapQt(rec[cut + 20].pose) }, { name: name(1), qt: [1, 0, 0, 0, 0, 0, 0] }, { name: name(cut + 21), qt: colmapQt(rec[cut + 21].pose) }], rows);
  assert.equal(out.added, 2, 'a photo the model has is not added twice');
  assert.ok(out.images.includes(` 1 ${name(cut + 20)}\n`) && out.frames.includes(`\n${300 + cut + 21} 1 `), 'with its database image, camera, frame and rig ids');
  near(centres(out.images).find(([n]) => n === name(cut + 21))[1], rec[cut + 21].pose.slice(12, 15), 1e-4, 'at its pose');

  // On the phone, a part lined up in the background counts towards the coverage map (and only there).
  const linkCap = { ...capture, links: [{ from: 200, to: 100, xf: xfInverse(X) }], boundsBySpace: { 200: capture.boundsBySpace[200] } };
  const shown = framesIn(frames, linkCap, 100);
  assert.equal(shown.length, rec.length, 'both parts on one map');
  near(shown[cut + 5].pose.slice(12, 15), rec[cut + 5].pose.slice(12, 15), 1e-3, 'part 2 moved onto part 1');
  near(boundsIn(linkCap, 100).poly.flat(), outline.poly.flat(), 1e-3, 'and its outline');
  assert.deepEqual(partsOf(frames, linkCap).map((p) => p.space), [100, 200], 'still two parts for the export');
  passed++;
  console.log(`  ok scan in parts: a recorded scan (${recorded.name}) with tracking lost partway exports two parts; SplatStation joins them into one model`);
})();

test('plain wall: warned before tracking slips, turning fast at it too, and long walls are approached at an angle', () => {
  const base = { trackState: 'ok', rotSpeed: 5, linSpeed: 0.1, flowSpeed: 0.05, relSharp: 0.9, blurRisk: 0, mean: 120, clipHi: 0, clipLo: 0, texture: 0.2, spread: 0.9, depthMed: 2 };
  // A few corners bunched in one corner of the frame: plain, though not blank.
  let c = new Coach();
  c.update({ ...base, t: 0, texture: 0.07, spread: 0.25 });
  let r = c.update({ ...base, t: 0.6, texture: 0.07, spread: 0.25 });
  assert.equal(r.primary.title, 'Plain wall: get the corner or the floor in view');
  assert.equal(r.chips.detail.value, 'plain');
  c = new Coach();
  c.update({ ...base, t: 0, texture: 0.07, spread: 0.75 });
  assert.equal(c.update({ ...base, t: 0.6, texture: 0.07, spread: 0.75 }).primary.level, 'good', 'the same detail spread over the view is fine');
  c = new Coach();
  c.update({ ...base, t: 0, texture: 0.04, rotSpeed: 20 });
  assert.equal(c.update({ ...base, t: 0.4, texture: 0.04, rotSpeed: 20 }).primary.title, 'Plain wall: turn slowly');
  // A 6 m wall along x = 3.05 is long, a 0.8 m piece isn't; views of it are worth most at 30-70° off head-on.
  const wallMap = (z0, z1) => {
    const vm = new VoxelMap(0.2, 7), pts = [];
    for (let z = z0; z <= z1; z += 0.05) for (let y = 0.3; y <= 2.3; y += 0.05) pts.push(3.05, y, z);
    for (let i = 0; i < 3; i++) vm.integrate(new Float32Array(pts), [1, 1.4, (z0 + z1) / 2], false);
    return new Guide({ template: getTemplate('room'), bounds: null, voxels: vm });
  };
  const long = wallMap(-3, 3)._longWall([3.05, 1.3, 0.5]);
  assert.ok(long && Math.abs(Math.abs(long.n[0]) - 1) < 0.05, `found the long wall (${JSON.stringify(long)})`);
  assert.equal(wallMap(0.1, 0.9)._longWall([3.05, 1.3, 0.5]), null, 'a short piece is not one');
  const at = (deg) => wallAngleFactor([-Math.cos(deg * DEG), 0, Math.sin(deg * DEG)], long);
  assert.ok(at(0) < 0.5 && at(10) < 0.5 && at(45) === 1 && at(60) === 1, `head-on ${at(0)}, at 45° ${at(45)}`);
});
seed = seedBeforeParts;

const { rigConfig, VIEWS_360, isEquirect, viewSize } = await import('../station/lib/video.mjs');
test('360 video: views cut from each frame make a rig that turns the right way', () => {
  assert.ok(isEquirect({ width: 5760, height: 2880 }) && isEquirect({ width: 1600, height: 800, spherical: false }));
  assert.ok(!isEquirect({ width: 1920, height: 1080 }) && !isEquirect({ width: 1080, height: 1920 }));
  assert.ok(isEquirect({ width: 1920, height: 1080, spherical: true }), 'tagged as spherical');
  assert.equal(viewSize({ width: 5760 }), 1440);
  assert.equal(viewSize({ width: 7680 }), 1920);
  const cams = rigConfig()[0].cameras;
  assert.equal(cams.length, VIEWS_360.length);
  assert.ok(cams[0].ref_sensor && !VIEWS_360.some((v) => v.pitch < 0), 'reference view; nothing looks down at the holder');
  cams.slice(1).forEach((c, i) => {
    const v = VIEWS_360[i + 1];
    const [w, x, y, z] = c.cam_from_rig_rotation;
    assert.ok(Math.abs(Math.hypot(w, x, y, z) - 1) < 1e-6, `${v.name} unit quaternion`);
    // The view's forward axis (its third row of cam_from_rig) in reference-view coordinates, which
    // look along +z with y down: ffmpeg's v360 turns right for +yaw and up for +pitch.
    const fwd = [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    const a = (v.yaw * Math.PI) / 180, b = (v.pitch * Math.PI) / 180;
    near(fwd, [Math.sin(a) * Math.cos(b), -Math.sin(b), Math.cos(a) * Math.cos(b)], 1e-6, `${v.name} forward`);
    // Right stays level for the horizon views.
    if (!v.pitch) near([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [Math.cos(a), 0, -Math.sin(a)], 1e-6, `${v.name} right`);
    assert.deepEqual(c.cam_from_rig_translation, [0, 0, 0]);
  });
});

// Measured quality: Brush holds photos back and logs a score; these lines are copied from Brush 0.3.
const { brushEval, trainBrush, HOLD_OUT_EVERY } = await import('../station/lib/trainer.mjs');
test('measured quality: PSNR and SSIM read from Brush\'s log, the last eval counts', () => {
  const log = [
    '[2026-11-06T05:54:50Z INFO  brush_cli] Starting up',
    '[2026-11-06T05:54:51Z INFO  brush_cli] Loaded dataset with 213 training, 20 eval views',
    '[2026-11-06T05:54:54Z INFO  brush_cli] Refine iter 234, 142726 splats.',
    '[2026-11-06T05:54:57Z INFO  brush_cli] Eval iter 500: PSNR 15.215976, ssim 0.5729805',
    '[2026-11-06T05:55:01Z INFO  brush_cli] Eval iter 1000: PSNR 18.028294, ssim 0.64160347',
    '[2026-11-06T05:55:02Z INFO  brush_cli] Done training! Took FormattedDuration(7s).',
  ];
  assert.deepEqual(brushEval(log), { psnr: 18.03, ssim: 0.6416, views: 20, step: 1000 });
  assert.equal(brushEval(log.filter((l) => !/Eval iter/.test(l))), null, 'no eval, no score');
  assert.equal(brushEval([...log, '[2026-11-06T05:55:03Z INFO  brush_cli] Eval iter 1500: PSNR NaN, ssim NaN']).psnr, 18.03, 'a broken score is ignored');
  assert.equal(brushEval(['Eval iter 7000: PSNR 21.78, ssim 0.752']).views, null, 'a score without the split line still counts');
  assert.equal(brushEval(['Loaded dataset with 233 training, 0 eval views', 'Eval iter 7000: PSNR 30, ssim 0.9']), null, 'no photos held back, no score');
});
await (async () => {
  // trainBrush against a stand-in for brush_app.exe (a Node script) that answers the way Brush 0.3 does:
  // silent unless RUST_LOG asks, a score only with an eval split, the final .ply at the last step.
  const dir = mkdtempSync(join(tmpdir(), 'sse-'));
  const fake = join(dir, 'fake-brush.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2), opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
const steps = +opt('--total-steps'), split = +opt('--eval-split-every') || 0, out = opt('--export-path');
const say = (s) => /brush_cli=info/.test(process.env.RUST_LOG || '') && console.log('[2026-11-06T05:56:17Z INFO  brush_cli] ' + s);
writeFileSync(out + '/args.json', JSON.stringify({ args: a, log: process.env.RUST_LOG }));
say('Loaded dataset with ' + (split ? '213 training, 20' : '233 training, 0') + ' eval views');
if (split && +opt('--eval-every') <= steps) say('Eval iter ' + steps + ': PSNR 24.123456, ssim 0.8123456');
writeFileSync(out + '/splat_' + steps + '.ply', 'ply\\nformat binary_little_endian 1.0\\nelement vertex 1234\\nend_header\\n');
say('Done training! Took FormattedDuration(1s).');
`);
  const train = (holdOut, name) => trainBrush({
    brush: process.execPath, dataset: fake, outDir: join(dir, name), preset: { steps: 3000, maxResolution: 1920, maxSplats: 1e6 },
    progress: () => {}, nImages: 233, holdOut, cacheDir: dir, log: join(dir, name + '.log'),
  });
  const on = await train(HOLD_OUT_EVERY, 'on');
  assert.deepEqual(on.eval, { psnr: 24.12, ssim: 0.8123, views: 20, step: 3000, every: 12 });
  assert.equal(on.splats, 1234);
  const sent = JSON.parse(readFileSync(join(dir, 'on', 'args.json'), 'utf8'));
  const flag = (k) => sent.args[sent.args.indexOf(k) + 1];
  assert.deepEqual([flag('--eval-split-every'), flag('--eval-every')], ['12', '3000'], 'every 12th photo held back, one eval at the last step');
  assert.match(sent.log, /brush_cli=info/);
  assert.match(readFileSync(join(dir, 'on.log'), 'utf8'), /Eval iter 3000: PSNR 24\.123456/, 'the score is in the job log too');
  const off = await train(0, 'off');
  assert.equal(off.eval, null);
  const sentOff = JSON.parse(readFileSync(join(dir, 'off', 'args.json'), 'utf8'));
  assert.ok(!sentOff.args.includes('--eval-split-every') && sentOff.args[sentOff.args.indexOf('--eval-every') + 1] === '3001', 'off: every photo trains, no eval');
  passed++;
  console.log('  ok measured quality: trainBrush holds back every 12th photo, asks Brush to log, and returns its score');
})();

// ---------------------------------------------------------------- club (beta)
// An in-memory stand-in for the club's Supabase project (tools/fake-supabase.mjs) answers for both the
// phone code and the station code; the ASU building list is read from disk instead of over HTTP.
const realFetch = globalThis.fetch;
const fileFetch = async (u, o) => {
  const url = new URL(String(u));
  return url.protocol === 'file:' ? new Response(readFileSync(url)) : realFetch(u, o);
};
const { createFake, FAKE_URL } = await import('../tools/fake-supabase.mjs');
const fake = createFake();
fake.install(globalThis, fileFetch);

const R = await import('../app/js/core/clubrules.js');
test('club rules: light slots, handles, which scans can be sent, and points for an approved scan', () => {
  const at = (hr) => Date.UTC(2026, 10, 3, hr + 7, 30); // Phoenix is UTC-7 all year
  assert.deepEqual([5, 6, 10, 11, 15, 16, 19, 20, 23].map((hr) => R.lightSlot(at(hr))), ['night', 'morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night']);
  assert.equal(R.phoenixDay(Date.UTC(2026, 10, 4, 5, 0)), '2026-11-03', '10 pm in Phoenix is still the 3rd');

  assert.ok(R.validHandle('Desert_Fox1') && !R.validHandle('x') && !R.validHandle('has space') && !R.validHandle('a'.repeat(21)) && !R.validHandle(null));
  const names = R.suggestHandles(40);
  assert.equal(new Set(names).size, 40);
  assert.ok(names.every(R.validHandle), 'every suggested handle is allowed');

  // The club takes full scans graded B or better; points come when it approves the splat made from one.
  assert.deepEqual(['A', 'B', 'C', 'D', 'F', '', null].map(R.canUpload), [true, true, false, false, false, false, false]);
  const S = (o) => R.scoreScan(o).points;
  assert.equal(S({ grade: 'A' }), 30);
  assert.equal(S({ grade: 'B', newArea: 64 }), 20 + 6, '1 point for every 10 m² it adds to the campus map');
  assert.equal(S({ grade: 'A', newArea: 2000 }), 30 + 30, 'up to 30');
  assert.equal(S({ grade: 'A', newArea: 400, rescan: true }), 5, 'a space the map already had as Good: a thank-you');
  assert.equal(S({ grade: 'A', rescan: true, mission: { bonus: 15, title: 'Rescan the lobby' } }), 30 + 15, 'unless a mission asked for it');
  assert.deepEqual(R.scoreScan({ grade: 'B', newArea: 120, mission: { bonus: 10, title: 'Hayden study rooms' } }).parts,
    [['Scan graded B', 20], ['120 m² new on the campus map', 12], ['Mission: Hayden study rooms', 10]]);
  assert.equal(S({ grade: 'C' }), 0);
  assert.ok(R.POINTS_HELP.some((t) => /B or better/.test(t)));
});

const campus = await import('../app/js/data/campus.js');
const asuList = await campus.buildings();
await (async () => {
  const mu = asuList.find((b) => b.code === 'memorial-union');
  assert.ok(asuList.length > 150 && mu, 'ASU building list with the Memorial Union');
  const inside = { lat: mu.c[0], lon: mu.c[1], acc: 8 };
  assert.equal(campus.distanceTo(mu, inside.lat, inside.lon), 0);
  assert.equal((await campus.sureBuilding(inside)).code, 'memorial-union', 'a good fix inside picks the building');
  assert.equal(await campus.sureBuilding({ ...inside, acc: 45 }), null, 'a poor indoor fix only suggests');
  assert.equal((await campus.near({ ...inside, acc: 45 }))[0].b.code, 'memorial-union');
  // 0.001° of latitude is about 110 m: well outside, and too far for a 10 m fix to offer it.
  assert.ok(!(await campus.near({ lat: mu.c[0] + 0.004, lon: mu.c[1], acc: 10 })).some((x) => x.b.code === 'memorial-union'));
  assert.equal((await campus.matchName('Schwada Building')).name, 'Schwada Classroom Office Building');
  assert.equal((await campus.matchName('MU')).code, 'memorial-union', 'by its building code');
  assert.equal(await campus.matchName('Snall'), null);
  assert.equal(campus.placeSlug('2', 'Room 214 (east)'), 'floor-2-room-214-east');
  assert.equal(campus.placeSlug('', ''), 'unsorted');
  const restricted = asuList.filter((b) => b.restricted);
  assert.ok(restricted.length > 20 && restricted.some((b) => b.restricted === 'residence') && restricted.some((b) => b.restricted === 'health'), 'residence halls and health buildings are marked off limits');
  assert.ok(!restricted.some((b) => ['hayden-library', 'memorial-union'].includes(b.code)), 'libraries and unions are open');
  assert.ok(!asuList.find((b) => b.name === 'Flower Child')?.restricted, 'a restaurant is not a children’s centre');
  passed++;
  console.log('  ok campus: GPS picks the building only when sure, typed names match the ASU list, housing and health are off limits');
})();

const crowdApp = await import('../app/js/data/crowd.js');
const clubApp = await import('../app/js/data/club.js');
const crowdStation = await import('../station/lib/crowd.mjs');
crowdApp.CROWD.url = FAKE_URL;
fake.db.invites.set('CLUB-TEST', { code: 'CLUB-TEST', label: 'test', max_uses: 5, uses: 0, active: true });
fake.db.restricted_buildings.set('cereus-hall', { code: 'cereus-hall', reason: 'residence' });

await (async () => {
  // Without joining, nothing can be sent.
  assert.equal(await clubApp.myProfile(), null, 'not a member yet');
  assert.deepEqual(await clubApp.leaderboard('all'), [], 'a stranger sees no leaderboard');
  assert.deepEqual(await clubApp.missions(), [], 'and no missions');
  await assert.rejects(crowdApp.uploadCapture({ id: 'x', engine: 'xr', score: { grade: 'A' } }, [{ name: 'images/0001.jpg', data: 'x', type: 'image/jpeg' }, { name: 'splatscout.json', data: '{}', type: 'application/json' }],
    { buildingCode: 'hayden-library', buildingName: 'Hayden Library', floor: '1', room: 'x' }, { save: async () => {} }), /join the club first/);
  await assert.rejects(clubApp.join('Test_Fox', 'WRONG'), /invite code/);
  await assert.rejects(clubApp.join('x', 'CLUB-TEST'), /3 to 20/);
  const me = await clubApp.join('Test_Fox', ' club-test ');
  assert.equal(me.handle, 'Test_Fox');
  assert.equal(me.consent_version, R.CONSENT_VERSION);
  assert.equal((await clubApp.myProfile({ fresh: true })).handle, 'Test_Fox');
  assert.equal((await clubApp.restrictedCodes()).get('cereus-hall'), 'residence');
  assert.deepEqual((await clubApp.leaderboard('all')).map((r) => r.handle), ['Test_Fox']);
  assert.deepEqual(await clubApp.missions(), []);
  assert.deepEqual(await clubApp.myScans(), [], 'no scans yet');
  passed++;
  console.log('  ok club (phone): nothing is accepted before joining; invite code, handle rules, restricted list, leaderboard');
})();

let phoneScan = null; // the scan this phone sends; the club reviews it further down
await (async () => {
  const photo = (n) => new Blob([new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9])], { type: 'image/jpeg' });
  const files = [
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ name: `images/000${n}.jpg`, data: photo(n), type: 'image/jpeg' })),
    { name: 'splatscout.json', data: JSON.stringify({ capture: { building: 'Schwada Building', room: 'snall' }, frames: [] }), type: 'application/json' },
    { name: 'poses/colmap/sparse/0/cameras.txt', data: '# cameras\n', type: 'text/plain' },
  ];
  const capture = { id: 'c1', engine: 'xr', score: { grade: 'B' }, geo: { lat: 33.42, lon: -111.93, acc: 9 } };
  const tags = { buildingCode: 'schwada-classroom-office-building', buildingName: 'Schwada Classroom Office Building', floor: '1', room: 'Snall', contributor: 'Test_Fox' };
  const save = async () => {};
  // Graded C: the phone doesn't offer to send it, and the database refuses it too.
  await assert.rejects(crowdApp.uploadCapture({ id: 'c3', engine: 'xr', score: { grade: 'C' } }, files, tags, { save }), /refused this upload/, 'a scan graded C');
  // The connection drops part way: the upload stops, and a second try sends only what's missing.
  fake.db.failOnce.add('/images/0005.jpg');
  await assert.rejects(crowdApp.uploadCapture(capture, files, tags, { save }), /0005\.jpg.*simulated/);
  const firstId = capture.upload.id;
  assert.equal(capture.upload.status, 'uploading');
  assert.ok(capture.upload.prefix.startsWith('schwada-classroom-office-building/floor-1-snall/'), capture.upload.prefix);
  const up = await crowdApp.uploadCapture(capture, files, tags, { save });
  assert.equal(up.id, firstId, 'resumed, not started again');
  assert.equal(up.status, 'done');
  const row = fake.db.captures.get(up.id);
  assert.deepEqual([row.status, row.photo_count, row.grade, row.building_name], ['new', 6, 'B', 'Schwada Classroom Office Building']);
  for (const [k, n] of fake.db.posts) assert.equal(n, k.endsWith('0005.jpg') ? 2 : 1, `${k} sent ${n} times`);
  assert.ok(fake.db.files.has(`captures/${up.prefix}/upload.json`), 'file list sent last');
  await assert.rejects(crowdApp.uploadCapture({ id: 'c2', engine: 'xr', score: { grade: 'A' } }, files, { ...tags, buildingCode: 'cereus-hall', buildingName: 'Cereus Hall' }, { save }), /refused this upload/, 'a restricted building');
  // No single photos any more: the database refuses them.
  const single = await crowdApp.api('/rest/v1/photos', { method: 'POST', body: { id: crypto.randomUUID(), taken_at: new Date().toISOString(), building_code: 'hayden-library', building_name: 'Hayden Library', storage_path: 'x', status: 'uploading' } });
  assert.ok(!single.ok, 'a single photo is refused');

  // SplatStation brings it in as a normal SplatScout ZIP, filed under the shared building name. No points yet:
  // they come when the club approves the splat built from it.
  const dir = mkdtempSync(join(tmpdir(), 'crowd-'));
  const c = { url: FAKE_URL, key: 'sb_secret_test' };
  const zip = await crowdStation.importUpload(c, up.id, dir, () => {});
  assert.match(zip, /Schwada_Classroom_Office_Building_Snall_20\d{6}_club-/);
  assert.equal((await listZip(zip)).length, files.length);
  const m = JSON.parse(await readZipText(zip, 'splatscout.json'));
  assert.equal(m.capture.building, 'Schwada Classroom Office Building');
  assert.equal(m.capture.typedBuilding, 'Schwada Building');
  assert.deepEqual([m.club.id, m.club.buildingCode, m.club.contributor, m.club.grade], [up.id, 'schwada-classroom-office-building', 'Test_Fox', 'B']);
  assert.deepEqual([fake.db.captures.get(up.id).status, fake.db.captures.get(up.id).points], ['processed', 0]);
  assert.deepEqual((await clubApp.leaderboard('all'))[0], { handle: 'Test_Fox', points: 0, photos: 0, scans: 0 });
  assert.deepEqual((await clubApp.myScans()).map((s) => [s.status, s.grade, s.review_note]), [['processed', 'B', null]], 'the member sees it being built and reviewed');
  assert.match(crowdStation.crowdConfig(dir).error, /crowd\.json/);
  phoneScan = up.id;
  passed++;
  console.log('  ok club scans: members only, graded B or better, resume after a dropped connection, no single photos, SplatStation imports a normal ZIP (no points yet)');
})();

{
  // A big scan: its depth points outgrow the bucket's 20 MB a file as COLMAP text. SplatStation doesn't read
  // them there, so the club copy keeps only the header; points.ply goes when it fits; anything else too big stops it.
  const big = 'x'.repeat(crowdApp.FILE_LIMIT + 1);
  const head = '# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n';
  const pts = head + Array.from({ length: 500000 }, (_, i) => `${i + 1} 1.234567 -0.234567 2.345678 120 130 140 0`).join('\n') + '\n';
  assert.ok(pts.length > crowdApp.FILE_LIMIT, 'the test list is over the limit');
  const files = [
    { name: 'images/0001.jpg', data: new Blob([new Uint8Array(10)]), type: 'image/jpeg' },
    { name: 'poses/colmap/sparse/0/images.txt', data: '# images\n1 1 0 0 0 0 0 0 1 0001.jpg\n\n', type: 'text/plain' },
    { name: 'poses/colmap/sparse/0/points3D.txt', data: pts, type: 'text/plain' },
    { name: 'poses/parts/2/colmap/sparse/0/points3D.txt', data: head, type: 'text/plain' },
    { name: 'poses/points.ply', data: new Uint8Array(1000), type: 'application/octet-stream' },
  ];
  const out = crowdApp.forClub(files);
  assert.deepEqual(out.map((f) => f.name), files.map((f) => f.name), 'every file still goes');
  const p3 = out[2].data;
  assert.ok(p3.startsWith(head) && p3.split('\n').every((l) => !l || l.startsWith('#')), 'points3D.txt keeps its header, no points');
  assert.equal(out[1].data, files[1].data, 'the poses go as they are');
  assert.equal(out[4].data.length, 1000, 'points.ply goes when it fits');
  const tooBigPly = crowdApp.forClub([files[0], { name: 'poses/points.ply', data: { size: crowdApp.FILE_LIMIT + 1 } }]);
  assert.deepEqual(tooBigPly.map((f) => f.name), ['images/0001.jpg'], 'points.ply over the limit is left out');
  assert.throws(() => crowdApp.forClub([{ name: 'images/0002.jpg', data: big }]), /images\/0002\.jpg is 20\.0 MB; the club takes files up to 20\.0 MB/);
  passed++;
  console.log('  ok club uploads of a big scan: no depth points in points3D.txt (they are in points.ply), files over the limit named before sending');
}

const clubSt = await import('../station/lib/club.mjs');
const clubApi = await import('../station/lib/clubapi.mjs');
const campusLib = await import('../station/lib/campus.mjs');
await (async () => {
  // SplatStation's side: members' scans with what this PC made of them, and the review of their splats.
  const dir = mkdtempSync(join(tmpdir(), 'clubpc-'));
  const cfg = { workDir: dir, dirs: { library: join(dir, 'library'), inbox: join(dir, 'inbox'), jobs: join(dir, 'jobs') } };
  for (const d of Object.values(cfg.dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'crowd.json'), JSON.stringify({ url: FAKE_URL, secretKey: 'sb_secret_test' }));
  const c = { url: FAKE_URL, key: 'sb_secret_test' };
  const buildings = clubApi.buildings();
  const U = '00000000-0000-4000-8000-0000000000e1', U2 = '00000000-0000-4000-8000-0000000000e2';
  for (const [id, handle] of [[U, 'Scan_Hawk'], [U2, 'Scan_Owl']]) fake.db.profiles.set(id, { user_id: id, handle, banned: false, created_at: new Date().toISOString() });
  const S1 = 'ce000000-0000-4000-8000-000000000001', S2 = 'ce000000-0000-4000-8000-000000000002', S3 = 'ce000000-0000-4000-8000-000000000003';
  const scan = (id, o) => fake.db.captures.set(id, { id, user_id: U, created_at: new Date(Date.now() - 864e5).toISOString(), building_code: 'hayden-library', building_name: 'Hayden Library', floor: '2', room: 'Study room 3',
    storage_prefix: `hayden-library/floor-2-study-room-3/${id}`, photo_count: 240, grade: 'A', status: 'processed', points: 0, reviewed_at: null, review_note: null, contributor: 'Scan_Hawk', lat: 33.4189, lon: -111.9346, gps_accuracy_m: 9, ...o });
  scan(S1, {});
  scan(S2, { user_id: U2, contributor: 'Scan_Owl', room: 'Reading room', storage_prefix: `hayden-library/floor-2-reading-room/${S2}`, grade: 'B' });
  scan(S3, { status: 'new', floor: '1', room: 'Main lobby', storage_prefix: `hayden-library/floor-1-main-lobby/${S3}` });
  // The splats built from the first two: in metres (lined up with the phone's AR), with their scan outlines.
  const lib = [];
  const splat = (id, room, stamp, w, contributor) => {
    const path = `Hayden Library/${room}/${stamp}`;
    mkdirSync(join(cfg.dirs.library, path), { recursive: true });
    writeFileSync(join(cfg.dirs.library, path, 'info.json'), JSON.stringify({ building: 'Hayden Library', room, level: '2', created: new Date().toISOString(), photos: 240, placed: 240,
      colmap: { mode: 'sfm-ar', reprojError: 0.5 }, training: { preset: 'standard' }, capture: { grade: 'A', score: 92 }, club: { id, buildingCode: 'hayden-library', contributor, grade: 'A' },
      crop: { areas: [{ poly: [[0, 0], [w, 0], [w, 4], [0, 4]] }] } }));
    lib.push({ path, building: 'Hayden Library', room, stamp });
  };
  splat(S1, 'Study room 3', '2026-11-07_1000', 6, 'Scan_Hawk'); // 24 m²
  splat(S2, 'Reading room', '2026-11-07_1100', 100, 'Scan_Owl'); // 400 m²
  const library = () => lib.map((it) => ({ ...it, info: JSON.parse(readFileSync(join(cfg.dirs.library, it.path, 'info.json'), 'utf8')) }));
  let published = 0;
  const api = async (path, post) => {
    let out = null;
    await clubApi.handleClub({ req: { socket: { remoteAddress: '127.0.0.1' }, method: post ? 'POST' : 'GET' }, res: {}, path, cfg, readBody: async () => post || {},
      sendJson: (res, body, code = 200) => (out = { code, body }), say() {}, scanInbox() {},
      library, jobs: () => [], campus: (cc) => campusLib.campusData({ club: cc, library: library(), jobs: [], buildings, workDir: dir, jobsDir: cfg.dirs.jobs }), onCampusChanged: () => published++ });
    return out;
  };
  const studyMission = await clubSt.createMission(c, { title: 'Scan the Hayden study rooms', building_code: 'hayden-library', room: 'study room 3', bonus: 15 });
  fake.db.missions.get(studyMission.id).created_at = new Date(Date.now() - 2 * 864e5).toISOString();

  // The review list: each scan with what this PC made of it, and what approving it would earn.
  let r = await api('/api/club/scans');
  const by = (id) => r.body.scans.find((x) => x.id === id);
  assert.deepEqual([by(S1).handle, by(S1).splat.path, by(S3).splat, by(S3).award], ['Scan_Hawk', 'Hayden Library/Study room 3/2026-11-07_1000', null, null]);
  assert.equal(by(S1).award.points, 30 + 2 + 15, 'grade A, 24 m² new on the map, and the study-room mission');
  assert.deepEqual([by(S1).award.facts.newArea, by(S1).award.facts.rescan, by(S1).award.facts.score], [24, false, 92]);
  assert.equal(by(S2).award.points, 20 + 30, 'grade B, and 400 m² new (30 at most)');

  // Approve: the member gets the points, and the splat goes on the campus map.
  r = await api('/api/club/scan', { op: 'approve', id: S1 });
  assert.deepEqual([r.code, r.body.points], [200, 47]);
  assert.deepEqual([fake.db.captures.get(S1).status, fake.db.captures.get(S1).points], ['approved', 47]);
  assert.deepEqual([library()[0].info.review.status, library()[0].info.review.points], ['approved', 47]);
  assert.equal(published, 1, 'members’ phones follow');
  assert.equal((await api('/api/club/scan', { op: 'approve', id: S1 })).code, 409, 'approving twice awards nothing');
  assert.equal((await api('/api/club/scan', { op: 'approve', id: S3 })).code, 400, 'a scan whose splat isn’t built yet');
  assert.equal((await api('/api/club/scan', { op: 'approve', id: 'not-an-id' })).code, 400);
  // Not approved: no points, the member is told why, and the splat stays off the map.
  r = await api('/api/club/scan', { op: 'reject', id: S2, note: 'A person is in the scan' });
  assert.equal(r.code, 200);
  assert.deepEqual([fake.db.captures.get(S2).status, fake.db.captures.get(S2).review_note, fake.db.captures.get(S2).points], ['rejected', 'A person is in the scan', 0]);
  assert.equal(library()[1].info.review.status, 'rejected');
  // The phone's own scan from above, turned down before it was built: its owner reads why.
  await api('/api/club/scan', { op: 'reject', id: phoneScan, note: 'Too blurry or patchy' });
  assert.deepEqual((await clubApp.myScans()).map((s) => [s.status, s.review_note]), [['rejected', 'Too blurry or patchy']]);
  const board = await clubApp.leaderboard('all');
  assert.deepEqual(board.find((x) => x.handle === 'Scan_Hawk'), { handle: 'Scan_Hawk', points: 47, photos: 0, scans: 1 });
  assert.deepEqual(board.find((x) => x.handle === 'Scan_Owl'), { handle: 'Scan_Owl', points: 0, photos: 0, scans: 0 });
  assert.equal((await clubApp.missions()).find((m) => m.id === studyMission.id).done, 1, 'the mission counts the approved scan of its space');
  // Delete a scan from the cloud (its files and its row).
  assert.equal((await api('/api/club/scan', { op: 'delete', id: S3 })).code, 200);
  assert.ok(!fake.db.captures.has(S3));

  // The campus map counts the approved splat; the one not approved stays off it.
  const d = await campusLib.campusData({ club: c, library: library(), jobs: [], buildings, workDir: dir });
  const study = d.spaces.find((x) => x.room === 'Study room 3');
  assert.deepEqual([study.onMap, study.waiting, study.area, study.areaSource, study.score, study.contributors.map((x) => x.handle)], [1, 0, 24, 'measured', 92, ['Scan_Hawk']]);
  assert.ok(!d.spaces.some((x) => x.room === 'Reading room'), 'a splat not approved stays off the map');

  // -- missions, invites, members, restricted places
  await assert.rejects(clubSt.createMission(c, { title: 'x' }), /3 to 80/);
  const mission = await clubSt.createMission(c, { title: 'Hayden lobby at night', building_code: 'hayden-library', light: 'night', bonus: 99, wanted: -5 });
  assert.deepEqual([mission.bonus, mission.wanted, mission.light, mission.active], [50, 1, 'night', true], 'values are kept in range');
  await clubSt.updateMission(c, mission.id, { active: false });
  assert.equal(fake.db.missions.get(mission.id).active, false);
  await clubSt.deleteMission(c, mission.id);
  assert.ok(!fake.db.missions.has(mission.id));

  const inv = await clubSt.createInvite(c, { label: 'Robotics club', max_uses: 3 });
  assert.match(inv.code, /^CLUB-[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(fake.db.invites.get(inv.code).max_uses, 3);
  await clubSt.setInviteActive(c, inv.code, false);
  assert.equal(fake.db.invites.get(inv.code).active, false);

  const members = await clubSt.listMembers(c);
  assert.deepEqual(['points', 'scans'].map((k) => members.find((x) => x.handle === 'Scan_Hawk')[k]), [47, 1]);
  await assert.rejects(clubSt.setMember(c, U2, { handle: 'bad handle' }), /3 to 20/);
  await clubSt.setMember(c, U2, { handle: 'Solar_Hawk2', banned: true });
  assert.deepEqual([fake.db.profiles.get(U2).handle, fake.db.profiles.get(U2).banned], ['Solar_Hawk2', true]);
  const purged = await clubSt.purgeMember(c, cfg, U2);
  assert.ok(purged.scans === 1 && !fake.db.profiles.has(U2) && ![...fake.db.captures.values()].some((x) => x.user_id === U2), JSON.stringify(purged));

  const flagged = [...buildings.values()].filter((b) => b.restricted).length;
  fake.db.restricted_buildings.clear();
  assert.equal(await clubSt.syncRestricted(c, buildings), flagged);
  assert.equal(fake.db.restricted_buildings.size, flagged);
  assert.ok(fake.db.restricted_buildings.has('cereus-hall'));
  await clubSt.setRestricted(c, 'hayden-library', 'lab');
  assert.equal(fake.db.restricted_buildings.get('hayden-library').reason, 'lab');
  await clubSt.setRestricted(c, 'hayden-library', null);
  assert.ok(!fake.db.restricted_buildings.has('hayden-library'));

  // -- only this PC may use the club tools
  assert.ok(clubApi.isLocal({ socket: { remoteAddress: '::ffff:127.0.0.1' } }) && clubApi.isLocal({ socket: { remoteAddress: '::1' } }));
  assert.ok(!clubApi.isLocal({ socket: { remoteAddress: '203.0.113.7' } }), 'another device on the network');
  const own = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (own) assert.ok(clubApi.isLocal({ socket: { remoteAddress: own.address } }), 'this PC’s own network address (the dashboard opened by its Wi-Fi address)');
  let answer = null;
  await clubApi.handleClub({ req: { socket: { remoteAddress: '203.0.113.7' }, method: 'GET' }, res: {}, path: '/api/club/scans', cfg, readBody: async () => ({}), sendJson: (res, body, code) => (answer = [code, body]), say() {}, scanInbox() {} });
  assert.equal(answer[0], 403, 'a phone on the Wi-Fi is refused');
  passed++;
  console.log('  ok club (PC): scans with what this PC made of them, approve (points, mission bonus, campus map) or not (the member reads why), missions, invites, members, restricted places');
})();

// ---------------------------------------------------------------- campus view
const CM = await import('../app/js/core/campusmodel.js');
test('campus model: quality bands, the photo-count rule of thumb, scans, builds, sizes and floor area covered', () => {
  assert.deepEqual([0, 24, 25, 49, 50, 74, 75, 89, 90, 100].map((q) => CM.bandOf(q).id), ['none', 'none', 'rough', 'rough', 'fair', 'fair', 'good', 'good', 'excellent', 'excellent']);
  assert.deepEqual(['Main lobby', '2nd floor hallway', 'Room 214', 'Snall', 'Reading room', 'Stairwell B'].map(CM.kindOf), ['large', 'hallway', 'room', 'room', 'large', 'hallway']);
  // How many photos a scan needs: a room is Good at about 125 in one light and Excellent at about 208; bigger spaces need more.
  assert.equal(CM.photosFor(CM.GOOD, 'room'), 125);
  assert.equal(CM.photosFor(CM.EXCELLENT, 'room'), 208);
  assert.ok(CM.photosFor(CM.GOOD, 'large') > CM.photosFor(CM.GOOD, 'hallway') && CM.photosFor(CM.GOOD, 'hallway') > CM.photosFor(CM.GOOD, 'room'));
  assert.ok(CM.photoCurve(19, 'room') <= 15, 'too few photos to place');
  const curve = CM.curvePoints('room');
  assert.ok(curve.every((p, i) => !i || p[1] >= curve[i - 1][1]), 'more photos never hurt');
  const one = CM.photoEstimate({ byLight: { afternoon: 125 } }, 'room');
  assert.deepEqual([one.score, one.dominant, one.share], [75, 'afternoon', 1]);
  const mixed = CM.photoEstimate({ byLight: { afternoon: 60, evening: 60 } }, 'room');
  assert.equal(Math.round(mixed.effective), 75, 'photos in other light count a quarter');
  assert.ok(mixed.score < one.score - 15 && mixed.parts.some(([t, v]) => /mixed/.test(t) && v < 0), 'and mixed light costs points');
  assert.deepEqual(CM.photosNeeded({ room: 'Room 214', photos: { byLight: { evening: 90 } } }), { n: 33, light: 'evening' });

  assert.equal(CM.scanEstimate([{ grade: 'A' }]).score, 87);
  assert.equal(CM.scanEstimate([{ grade: 'C' }, { grade: 'B', score: 85 }]).score, 81, 'the best scan counts');
  const snall = { photos: 1052, placed: 1052, reprojError: 0.58, preset: 'standard', gradeScore: 99 };
  assert.equal(CM.builtEstimate(snall).score, 99, 'a clean build keeps what its scan promised');
  assert.equal(CM.builtEstimate({ ...snall, placed: 526 }).score, 59, 'half the photos placed');
  assert.equal(CM.builtEstimate({ ...snall, reprojError: 2.5 }).score, 59, 'a poor reprojection error');
  assert.equal(CM.builtEstimate({ ...snall, preset: 'quick' }).score, 84, 'quick training');
  assert.equal(CM.builtEstimate({ photos: 120, placed: 120, reprojError: 0.56, preset: 'quick' }).score, 63, 'no scan grade: judged by its photos');
  // Measured quality: PSNR on held-back photos replaces the estimate. Each band starts at a round number of dB.
  assert.deepEqual([13, 20, 23, 26, 29, 32, 40].map((db) => CM.bandOf(CM.psnrScore(db)).id), ['none', 'rough', 'fair', 'good', 'excellent', 'excellent', 'excellent']);
  assert.deepEqual([19.9, 22.9, 25.9, 28.9].map((db) => CM.bandOf(CM.psnrScore(db)).id), ['none', 'rough', 'fair', 'good'], 'just under each threshold');
  assert.deepEqual([CM.psnrScore(24.5), CM.psnrScore(NaN), CM.psnrScore(50)], [62.5, 0, 100]);
  const measuredBuild = CM.builtEstimate({ ...snall, preset: 'quick', reprojError: 2.5, eval: { psnr: 21.7, ssim: 0.7469, views: 20 } });
  assert.deepEqual([measuredBuild.score, measuredBuild.measured], [39, true], 'the measurement wins over the scan’s promise, the preset and the reprojection error');
  assert.match(measuredBuild.parts[0][0], /Measured: PSNR 21\.7 dB on 20 photos held back/);
  assert.equal(CM.builtEstimate({ ...snall, placed: 526, eval: { psnr: 26, ssim: 0.9, views: 44 } }).score, 45, 'photos COLMAP couldn’t place still count against it');
  assert.equal(CM.builtEstimate(snall).measured, false);

  // What would improve a space, now that the club takes full scans only.
  const fresh = CM.spaceEstimate({ room: 'Main lobby' });
  assert.deepEqual([fresh.score, fresh.source, fresh.kind], [0, 'none', 'large']);
  assert.match(fresh.advice[0], /^Not on the map yet: one scan graded B or better/);
  assert.match(CM.spaceEstimate({ room: 'Room 3', scans: [{ grade: 'A' }] }).advice[0], /The scan looks good: process it/);
  assert.match(CM.spaceEstimate({ room: 'Room 2', builds: [{ photos: 60, placed: 40, reprojError: 2, preset: 'quick' }] }).advice[0], /^On the map, but (none|rough|fair|not enough yet)/i);
  const built = CM.spaceEstimate({ room: 'Snall', builds: [snall] });
  assert.deepEqual([built.score, built.source, built.band.id, built.advice], [99, 'built', 'excellent', []]);
  assert.match(CM.spaceEstimate({ room: 'Snall', builds: [{ ...snall, gradeScore: 80 }] }).advice[0], /Good\. A new scan graded A could make it Excellent/);

  // Completion by floor area: footprint × floors (the club's count, else OpenStreetMap's, else 2).
  const hay = CM.floorArea({ levels: 4, area: 5476 });
  assert.deepEqual(hay, { area: 21904, footprint: 5476, floors: 4, set: false, guessed: false, footprintGuessed: false });
  assert.deepEqual(CM.floorArea({ area: 900 }), { area: 1800, footprint: 900, floors: 2, set: false, guessed: true, footprintGuessed: false });
  assert.deepEqual(CM.floorArea({ levels: 4, area: 5476 }, 6), { area: 32856, footprint: 5476, floors: 6, set: true, guessed: false, footprintGuessed: false }, 'the club’s count wins');
  assert.equal(CM.floorArea({}).area, 2 * CM.DEFAULT_FOOTPRINT);
  // One small room, Good, in Hayden Library is a fraction of a percent (it was 1 of 13 planned spaces, 8%).
  const tiny = CM.buildingCoverage([{ score: 80, area: CM.SIZES.small.area, floor: '1' }], hay);
  assert.ok(tiny.completion > 0 && tiny.completion < 0.001, String(tiny.completion));
  assert.equal(CM.pctText(tiny.completion), '<0.1%');
  const cov = CM.buildingCoverage([{ score: 75, area: 400, floor: '1' }, { score: 37.5, area: 60, floor: '1' }, { score: 90, area: 150, floor: '2' }, { score: 0, area: 60, floor: '' }], hay);
  assert.equal(cov.covered, 400 + 30 + 150, 'a space counts in proportion to how close it is to Good');
  assert.deepEqual([cov.good, cov.started], [2, 3]);
  assert.deepEqual(cov.byFloor.map((f) => [f.floor, f.spaces, +(f.share * 100).toFixed(2)]), [['1', 2, 7.85], ['2', 1, 2.74], ['', 1, 0]], 'floor by floor, as a share of the footprint; no floor given goes last');
  assert.equal(CM.buildingCoverage([{ score: 90, area: 5000 }], CM.floorArea({ area: 1000, levels: 1 })).completion, 1, 'never more than all of it');
  assert.deepEqual([0, 0.004, 0.01, 0.049, 0.05, 0.2, 0.5, 1].map((x) => CM.completionBin(x)), [0, 1, 2, 2, 3, 4, 5, 5]);
  assert.equal(CM.completionBin(0, true), 1, 'a scan waiting for review counts as started');
  assert.deepEqual([0, 0.0004, 0.0027, 0.024, 0.24, 1.2].map(CM.pctText), ['0%', '<0.1%', '0.3%', '2.4%', '24%', '100%']);
  assert.equal(CM.SIZES[CM.sizeOf('Main lobby')].area, 400);
  assert.deepEqual(['Main lobby', 'Room 214', 'Study room 3', 'Classroom 101', 'Reading room', 'Ballroom foyer', 'Arizona Ballroom', '2nd floor hallway'].map(CM.sizeOf),
    ['large', 'room', 'small', 'big', 'huge', 'large', 'huge', 'hallway'], 'sizes guessed from names');
  assert.ok(CM.spaceEstimate({ room: 'Room 12', kind: 'large', photos: { byLight: { morning: 125 } } }).score < CM.GOOD, 'a size the club sets changes the photo rule too');
});

await (async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'campus-'));
  const buildings = new Map(asuList.map((b) => [b.code, b]));
  for (const t of ['captures', 'missions']) fake.db[t].clear();
  const U = '00000000-0000-4000-8000-0000000000c1';
  fake.db.profiles.set(U, { user_id: U, handle: 'Map_Tester', banned: false });
  const hl = buildings.get('hayden-library');
  const day3 = Date.UTC(2026, 10, 3, 20, 0); // 1 pm on Nov 3 in Phoenix
  const scan = (id, o) => fake.db.captures.set(id, { id, user_id: U, created_at: new Date(day3).toISOString(), building_code: 'hayden-library', building_name: 'Hayden Library', floor: '1', room: 'Main Lobby',
    photo_count: 400, grade: 'A', status: 'new', points: 0, reviewed_at: null, lat: hl.c[0], lon: hl.c[1], gps_accuracy_m: 9, ...o });
  scan('cv-1', {}); // sent, not on this PC yet
  scan('cv-2', { building_code: 'memorial-union', building_name: 'Memorial Union', floor: '2', room: 'Ballroom foyer', status: 'approved', points: 40, reviewed_at: new Date(day3 + 864e5).toISOString(), lat: null, lon: null });
  scan('cv-3', { status: 'rejected', room: 'Reading room' }); // not approved: left out
  const library = [
    // Your own scan, built on this PC: on the map as it is.
    { path: 'Hayden Library/Main lobby/2026-11-01_1200', building: 'Hayden Library', room: 'Main lobby', stamp: '2026-11-01_1200',
      info: { building: 'Hayden Library', room: 'main lobby', created: new Date(Date.UTC(2026, 10, 1, 19)).toISOString(), photos: 300, placed: 290, colmap: { reprojError: 0.7, mode: 'sfm' }, training: { preset: 'standard', splats: 1e6 }, capture: null } },
    // A member's scan, approved.
    { path: 'Memorial Union/Ballroom foyer/2026-11-04_1000', building: 'Memorial Union', room: 'Ballroom foyer', stamp: '2026-11-04_1000',
      info: { building: 'Memorial Union', room: 'Ballroom foyer', level: '2', created: new Date(Date.UTC(2026, 10, 4, 17)).toISOString(), photos: 400, placed: 400, colmap: { reprojError: 0.6, mode: 'sfm' }, training: { preset: 'standard' }, capture: { grade: 'A', score: 92 }, club: { id: 'cv-2', buildingCode: 'memorial-union', contributor: 'Map_Tester' } } },
    // A member's scan, built and waiting for your review: shown, not counted.
    { path: 'Hayden Library/Study room 3/2026-11-05_1000', building: 'Hayden Library', room: 'Study room 3', stamp: '2026-11-05_1000',
      info: { building: 'Hayden Library', room: 'Study room 3', level: '2', created: new Date(Date.UTC(2026, 10, 5, 17)).toISOString(), photos: 240, placed: 240, colmap: { reprojError: 0.5, mode: 'sfm' }, training: { preset: 'standard' }, capture: { grade: 'A', score: 92 }, club: { id: 'cv-4', buildingCode: 'hayden-library', contributor: 'Map_Tester' } } },
    { path: 'Practice/Demo classroom/2026-10-19_1836', building: 'Practice', room: 'Demo classroom', stamp: '2026-10-19_1836', info: { building: 'Practice', room: 'Demo classroom', photos: 309, placed: 309 } },
  ];
  const jobs = [{ id: 'j1', status: 'waiting', building: 'Old Main', room: 'Main hall', summary: { photos: 140 }, source: { name: 'Old_Main_Main_hall.zip' } }];
  campusLib.saveFloors(workDir, 'hayden-library', 5);
  assert.deepEqual(campusLib.loadSettings(workDir), { since: null, floors: { 'hayden-library': 5 }, sizes: {} });
  assert.throws(() => campusLib.saveSize(workDir, 'x|1|y', 'enormous'), /Unknown size/);

  const club = { url: FAKE_URL, key: 'sb_secret_test' };
  const d = await campusLib.campusData({ club, library, jobs, buildings, workDir });
  assert.deepEqual(d.notes, []);
  assert.equal(d.spaces.filter((x) => x.code === 'hayden-library' && /lobby/i.test(x.room)).length, 1, 'a member’s scan of "Main Lobby" and your splat of "main lobby" are one space');
  const lobby = d.spaces.find((x) => x.code === 'hayden-library' && /lobby/i.test(x.room));
  assert.deepEqual([lobby.onMap, lobby.scans.length, lobby.waiting, lobby.source, lobby.kind], [1, 1, 0, 'built', 'large'], 'your own splat counts; the member’s scan waits');
  assert.ok(lobby.advice.some((a) => /1 scan from members isn’t built yet/.test(a)), lobby.advice.join(' / '));
  const study = d.spaces.find((x) => x.room === 'Study room 3');
  assert.deepEqual([study.onMap, study.waiting, study.score, study.covered], [0, 1, 0, 0], 'built, but waiting for your review: not counted');
  assert.match(study.advice[0], /^1 splat is waiting for your review/);
  const mu = d.spaces.find((x) => x.code === 'memorial-union');
  assert.deepEqual([mu.onMap, mu.score, mu.floor, mu.contributors.map((x) => x.handle)], [1, 92, '2', ['Map_Tester']], 'a member’s approved splat counts');
  assert.ok(!d.spaces.some((x) => x.room === 'Reading room'), 'a scan not approved is left out');
  const om = d.spaces.find((x) => x.code === 'old-main');
  assert.deepEqual([om.jobs.length, om.score], [1, 0], 'a capture waiting on the dashboard shows up, but counts once it’s built');
  assert.deepEqual([d.elsewhere.length, d.elsewhere[0].building], [1, 'Practice']);
  const hayden = d.buildings.find((b) => b.code === 'hayden-library');
  assert.deepEqual([hayden.floorArea.floors, hayden.floorArea.set, hayden.floorArea.area], [5, true, 5476 * 5], 'the club’s own floor count wins');
  assert.deepEqual([lobby.size, lobby.area, lobby.areaSource], ['large', 400, 'typical'], 'a lobby, by its name');
  assert.ok(Math.abs(hayden.completion - 400 / (5476 * 5)) < 1e-9, 'only splats on the map count');
  assert.deepEqual([hayden.onMap, hayden.waiting, hayden.builds], [1, 2, 2], 'the lobby’s scan and the study room’s splat wait for you');
  const tempe = d.campuses.find((x) => x.id === 'Tempe');
  assert.equal(tempe.started, 3);
  assert.ok(tempe.area > 1e6 && tempe.completion > 0 && tempe.completion < 0.001, `${tempe.area} m², ${tempe.completion}`);
  assert.ok(d.buildings.filter((b) => b.restricted).every((b) => b.completion === 0));
  assert.deepEqual(d.points.map((p) => [p.code, p.status]), [['hayden-library', 'new']], 'scans with a GPS reading');
  const day = d.days.find((x) => x.day === '2026-11-03');
  assert.deepEqual([day.scans, day.byLight.afternoon], [2, 2], 'days are Phoenix days');
  assert.equal(d.days.find((x) => x.day === '2026-11-04').approved, 1);
  assert.equal(d.days.find((x) => x.day === '2026-11-01').builds, 1);
  assert.deepEqual([d.totals.scans, d.totals.approved, d.totals.onMap, d.totals.waiting], [1, 1, 2, 1]);
  assert.equal(d.model.kinds.room.good, 125);
  assert.ok(d.model.kinds.room.curve.length > 20);
  // What approving the study room's splat would add: its typical 20 m² (a small room), it wasn't Good before.
  const facts = campusLib.approvalFacts(d, 'Hayden Library/Study room 3/2026-11-05_1000');
  assert.deepEqual([facts.newArea, facts.rescan, facts.build.score], [20, false, 92]);
  assert.equal(campusLib.approvalFacts(d, 'Hayden Library/Main lobby/2026-11-01_1200').rescan, true, 'the lobby is on the map as Good already');

  // A fresh start: only what arrives from then on counts (nothing is deleted), and it can be undone.
  campusLib.setSince(workDir, new Date(Date.UTC(2026, 10, 2)).toISOString());
  const fresh = await campusLib.campusData({ club, library, jobs, buildings, workDir });
  assert.equal(fresh.since, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(fresh.hidden, { scans: 0, builds: 2, jobs: 1 }, 'your Nov 1 splat, the practice one, and a capture with no date');
  const freshLobby = fresh.spaces.find((x) => x.code === 'hayden-library' && /lobby/i.test(x.room));
  assert.deepEqual([freshLobby.onMap, freshLobby.scans.length], [0, 1]);
  assert.equal(fresh.buildings.find((b) => b.code === 'hayden-library').completion, 0);
  campusLib.setSince(workDir, 'now');
  const blank = await campusLib.campusData({ club, library, jobs, buildings, workDir });
  assert.deepEqual([blank.spaces.length, blank.points.length, blank.hidden.scans], [0, 0, 2], 'from now on: a blank map');
  campusLib.setSince(workDir, null);
  assert.equal((await campusLib.campusData({ club: null, library, jobs: [], buildings, workDir })).hidden.builds, 0, 'and back');
  assert.throws(() => campusLib.setSince(workDir, 'not a time'), /isn’t a time/);

  // Sizes: the club's choice (the floor area it counts for, and its photo rule), or a scan's measured floor.
  campusLib.saveSize(workDir, lobby.key, 'huge');
  const sized = (await campusLib.campusData({ club, library, jobs, buildings, workDir })).spaces.find((x) => x.key === lobby.key);
  assert.deepEqual([sized.size, sized.sizeSet, sized.area, sized.areaSource, sized.kind], ['huge', true, 1000, 'set', 'large']);
  campusLib.saveSize(workDir, lobby.key, null);
  assert.deepEqual(campusLib.loadSettings(workDir).sizes, {});
  const rect = { areas: [{ poly: [[0, 0], [6, 0], [6, 4], [0, 4]] }] };
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'sfm-ar' }, crop: rect }), 24, 'lined up with the AR tracking: metres');
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'sfm' }, crop: rect }), null, 'a COLMAP-only solve has no scale');
  // With no outline, the floor measured on the splat (its walk map) counts.
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'ar-poses' }, floor: { area: 47.4, from: 'walk map' } }), 47, 'no outline: the floor measured on the splat');
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'ar-poses' }, crop: rect, floor: { area: 47 } }), 24, 'an outline comes first');
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'sfm' }, floor: { area: 47 } }), null, 'never without metres');
  assert.equal(campusLib.measuredArea({ colmap: { mode: 'ar-poses' }, floor: { area: 0.5 } }), null, 'nor from a speck of floor');
  const scanned = await campusLib.campusData({ club: null, jobs: [], buildings, workDir, library: [{ path: 'Hayden Library/Study room 3/2026-11-05_1200', building: 'Hayden Library', room: 'Study room 3', stamp: '2026-11-05_1200',
    info: { created: '2026-11-05T19:00:00.000Z', photos: 200, placed: 200, colmap: { mode: 'sfm-ar', reprojError: 0.5 }, training: { preset: 'standard' }, crop: rect } }] });
  assert.deepEqual([scanned.spaces[0].area, scanned.spaces[0].areaSource, scanned.spaces[0].size], [24, 'measured', 'small'], 'its scan’s floor, not the 20 m² a study room usually is');

  // Without the club database: this PC's splats only (members' splats wait until their approval can be read), and a note saying so.
  const local = await campusLib.campusData({ club: null, library, jobs: [], buildings, workDir });
  assert.match(local.notes[0], /isn’t set up/);
  assert.deepEqual(local.spaces.map((x) => x.onMap).sort(), [0, 0, 1]);
  assert.equal(local.totals.scans, 0);
  passed++;
  console.log('  ok campus view: approved and own splats on the map, members’ scans and splats waiting for review, floor area covered, a fresh start, sizes, campus totals, map points and daily activity');
})();

// ---------------------------------------------------------------- campus map on the phone
// SplatStation publishes the campus view's summary with the secret key; members' phones read it and colour
// the map with the same rules (app/js/data/campusmap.js).
const campusMap = await import('../app/js/data/campusmap.js');
await (async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'campusmap-'));
  const buildings = new Map(asuList.map((b) => [b.code, b]));
  const c = { url: FAKE_URL, key: 'sb_secret_test' };
  for (const t of ['captures', 'missions', 'campus_spaces', 'campus_plans']) fake.db[t].clear();
  const U = '00000000-0000-4000-8000-0000000000d1';
  fake.db.profiles.set(U, { user_id: U, handle: 'Light_Seeker', banned: false });
  const row = { user_id: U, created_at: new Date().toISOString(), floor: '2', photo_count: 180, grade: 'B', status: 'new', points: 0, reviewed_at: null, lat: null, lon: null };
  fake.db.captures.set('cm-1', { ...row, id: 'cm-1', building_code: 'hayden-library', building_name: 'Hayden Library', room: 'Room 214' }); // waiting for review
  fake.db.captures.set('cm-2', { ...row, id: 'cm-2', building_code: 'cereus-hall', building_name: 'Cereus Hall', room: 'Lounge' }); // a residence hall: never published
  const library = [
    { path: 'Memorial Union/Food court/2026-11-06_1200', building: 'Memorial Union', room: 'Food court', stamp: '2026-11-06_1200',
      info: { building: 'Memorial Union', room: 'Food court', level: '1', created: new Date().toISOString(), photos: 300, placed: 300, colmap: { mode: 'sfm', reprojError: 0.6 }, training: { preset: 'standard' }, capture: { grade: 'B', score: 80 } } },
    { path: 'Hayden Library/Main lobby/2026-11-06_1300', building: 'Hayden Library', room: 'Main lobby', stamp: '2026-11-06_1300',
      info: { building: 'Hayden Library', room: 'Main lobby', level: '1', created: new Date().toISOString(), photos: 150, placed: 150, colmap: { mode: 'sfm', reprojError: 1.8 }, training: { preset: 'quick' } } },
  ];
  campusLib.saveFloors(workDir, 'memorial-union', 1);
  const d = await campusLib.campusData({ club: c, library, jobs: [], buildings, workDir });
  assert.equal(d.clubError, null);

  // The rows members get: counts and sizes only (no handles, member ids or GPS points), nothing in off-limits buildings.
  const rows = campusLib.summaryRows(d, '2026-11-05T20:00:00.000Z');
  assert.deepEqual(rows.spaces.map((r) => r.building_code).sort(), ['hayden-library', 'hayden-library', 'memorial-union']);
  const r214 = rows.spaces.find((r) => r.room === 'Room 214'), food = rows.spaces.find((r) => r.room === 'Food court');
  assert.deepEqual([r214.builds, r214.scans, r214.score, r214.morning, r214.need_good, r214.need_light], [0, 1, 0, 0, 0, null], 'a scan waiting for review, nothing on the map yet');
  assert.deepEqual([food.builds, food.scans, food.score, food.band, food.area], [1, 0, 80, 'good', 60]);
  assert.ok(!JSON.stringify(rows).includes('Light_Seeker') && !JSON.stringify(rows).includes(U) && !/"lat"|"lon"/.test(JSON.stringify(rows)), 'no handles, ids or GPS');
  assert.deepEqual(rows.plans, [{ building_code: 'memorial-union', floors: 1, updated_at: '2026-11-05T20:00:00.000Z' }]);

  // A view built without the club database is never published (it would wipe the map).
  await assert.rejects(campusLib.publishSummary(c, { ...d, clubError: 'timeout' }), /couldn’t be read/);
  await assert.rejects(campusLib.publishSummary(c, { ...d, club: false }), /couldn’t be read/);
  let pub = await campusLib.publishSummary(c, d);
  assert.deepEqual([pub.spaces, pub.plans, fake.db.campus_spaces.size, fake.db.campus_plans.size], [3, 1, 3, 1]);

  // The phone: a stranger sees nothing; a member gets the summary and colours buildings as SplatStation does.
  const mem = {};
  campusMap.useCache({ get: () => mem.v || null, set: (v) => (mem.v = JSON.parse(JSON.stringify(v))) });
  await clubApp.leave();
  assert.equal(await clubApp.myProfile({ fresh: true }), null, 'this phone left the club');
  let sm = await campusMap.load();
  assert.deepEqual([sm.spaces.length, sm.plans.length], [0, 0], 'not a member: nothing');
  await clubApp.join('Map_Fox', 'CLUB-TEST');
  sm = await campusMap.load();
  assert.equal(sm.spaces.length, 3);
  assert.equal(sm.at, Date.parse(pub.at), 'when the club PC last published');
  const phone = campusMap.summarize(asuList, sm);
  for (const b of d.buildings.filter((x) => !x.restricted)) {
    const p = phone.find((x) => x.code === b.code);
    assert.ok(Math.abs(p.completion - b.completion) < 1e-9 && Math.abs(p.covered - b.covered) < 1e-9 && p.floorArea.area === b.floorArea.area && p.good === b.good, `${b.name}: phone ${p.completion}, station ${b.completion}`);
  }
  const mu = phone.find((x) => x.code === 'memorial-union'), hl = phone.find((x) => x.code === 'hayden-library');
  assert.deepEqual([mu.floorArea.floors, mu.floorArea.set, mu.completion, campusMap.completionBin(mu)], [1, true, 60 / 8061, 1], 'the club’s count of 1 floor; one Good room of 60 m² in 8,061 m²');
  assert.equal(campusMap.completionBin(phone.find((x) => x.code === 'old-main')), 0);
  assert.equal(campusMap.BIN_LABELS[0], 'Not on the map yet');
  assert.equal(campusMap.needText(hl.spaces.find((x) => x.room === 'Room 214')), 'A scan of it is waiting for the club’s review.');
  assert.match(campusMap.needText(hl.spaces.find((x) => x.room === 'Main lobby')), /^On the map, but rough: a new scan graded A or B/);
  assert.equal(campusMap.needText(mu.spaces[0]), 'Good. A new scan graded A could make it Excellent.');
  assert.equal(campusMap.needText({ score: 0, builds: 0, scans: 0 }), 'Not scanned yet.');
  assert.deepEqual(campusMap.notGoodYet(phone).map((p) => p.x.room), ['Main lobby'], 'spaces a better scan would improve');
  assert.equal(campusMap.scanUrl('hayden-library', '2', 'Room 214'), '#/setup?building=hayden-library&floor=2&room=Room+214');
  const near = campusMap.nearby(phone, { lat: mu.c[0], lon: mu.c[1], acc: 10 }, { within: 300 });
  assert.equal(near[0].b.code, 'memorial-union');
  assert.ok(near.every((p) => !p.b.restricted && p.dist <= 300));

  // Members can't write it.
  assert.equal((await crowdApp.api('/rest/v1/campus_spaces', { method: 'POST', body: { ...rows.spaces[0], score: 100 } })).status, 403);
  assert.equal((await crowdApp.api('/rest/v1/campus_spaces?space_key=not.is.null', { method: 'DELETE' })).status, 403);

  // A club database without supabase-campus-2.sql: the summary goes without sizes or floor counts, and the
  // phone falls back to typical sizes, which is what SplatStation used for these spaces too.
  fake.db.campusV1 = true;
  const old = await campusLib.publishSummary(c, d);
  fake.db.campusV1 = false;
  assert.deepEqual([old.legacy, old.spaces, old.plans, fake.db.campus_plans.size], [true, 3, 0, 0]);
  assert.ok([...fake.db.campus_spaces.values()].every((x) => x.area == null));
  const oldPhone = campusMap.summarize(asuList, await campusMap.load());
  assert.ok(Math.abs(oldPhone.find((x) => x.code === 'hayden-library').completion - d.buildings.find((x) => x.code === 'hayden-library').completion) < 1e-9);
  assert.equal((await campusLib.publishSummary(c, d)).legacy, false, 'once it has run, sizes go again');

  // Publishing again replaces it: a space whose only scan was turned down goes, and so does a floor count set back.
  fake.db.captures.get('cm-1').status = 'rejected';
  campusLib.saveFloors(workDir, 'memorial-union', null);
  pub = await campusLib.publishSummary(c, await campusLib.campusData({ club: c, library, jobs: [], buildings, workDir }));
  assert.deepEqual([pub.spaces, fake.db.campus_spaces.size, fake.db.campus_plans.size], [2, 2, 0]);
  assert.ok([...fake.db.campus_spaces.values()].every((x) => x.updated_at === pub.at));
  campusLib.savePublished(workDir, { ...pub, by: 'button' });
  assert.deepEqual(campusLib.loadSettings(workDir).floors, {}, 'campus.json keeps the club’s settings and the last publish side by side');
  assert.equal(campusLib.loadPublished(workDir).spaces, 2);
  // A fresh start empties the members' map too.
  campusLib.setSince(workDir, 'now');
  pub = await campusLib.publishSummary(c, await campusLib.campusData({ club: c, library, jobs: [], buildings, workDir }));
  assert.deepEqual([pub.spaces, fake.db.campus_spaces.size], [0, 0]);
  campusLib.setSince(workDir, null);

  // Offline, the phone keeps the copy it last saw.
  const online = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
  sm = await campusMap.load();
  globalThis.fetch = online;
  assert.ok(sm.offline && sm.spaces.length === 3, 'the earlier copy, marked offline');
  passed++;
  console.log('  ok campus map (phone): SplatStation publishes counts and sizes per space (approved splats, scans in review), members read them, floor area covered matches the Campus page (with or without campus-2.sql), stale rows go, offline keeps the last copy');
})();

// ---------------------------------------------------------------- building view: captures on a building's footprint
const CMOD = await import('../station/lib/colmapmodel.mjs');
const PLACE = await import('../station/web/place.js');
const PLACEMENT = await import('../station/lib/placement.mjs');

/** COLMAP's pose of a photo taken at C looking along fwd with the image's top along up: world-to-camera quaternion and translation. */
function colmapPose(C, fwd, up) {
  const nrm = (v) => v.map((x) => x / Math.hypot(...v));
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const z = nrm(fwd), x = nrm(cr(z, up)), y = cr(z, x); // camera axes in the world: right, down, forward
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = [x, y, z];
  let q;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  const t = [x, y, z].map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
  return { q, t, fwd: z, up: y.map((v) => -v) };
}

/** A small COLMAP model: two lenses, three photos (written out of name order; one with no 2-D points, one with 1,500), five points. */
function colmapScene() {
  const cams = [{ id: 1, model: 'PINHOLE', w: 1920, h: 860, params: [1374.76, 1374.1, 960, 430] }, { id: 2, model: 'SIMPLE_RADIAL', w: 860, h: 1920, params: [1374, 430, 960, 0.01] }];
  const shots = [
    { id: 3, cam: 1, name: '0003.jpg', C: [-1, 0.15, 0.5], fwd: [0, -1, 0], up: [0, 0, -1], n2: 3 }, // looking at the floor
    { id: 1, cam: 1, name: '0001.jpg', C: [0.5, 0.1, -0.3], fwd: [0, 0, -1], up: [0, 1, 0], n2: 1500 },
    { id: 2, cam: 2, name: 'p1/0002.jpg', C: [2, 0.2, -1], fwd: [1, -0.3, -1], up: [0, 1, 0], n2: 0 },
  ].map((s) => ({ ...s, ...colmapPose(s.C, s.fwd, s.up) }));
  const pts = [[0, -1.5, 0, 2, 0.5], [1, 0.8, -2, 3, 0.8], [2, 0, -2, 2, 9], [-1, -1.5, 1, 5, 0.3], [3, 1, -1.5, 2, 0.6]].map(([x, y, z, L, err], i) => ({ id: i + 1, xyz: [x, y, z], rgb: [10 * i, 200 - i, 7], err, track: Array.from({ length: L }, (_, k) => [1 + (k % 3), k]) }));
  return { cams, shots, pts };
}

function writeColmap(dir, m, format) {
  mkdirSync(dir, { recursive: true });
  const ids = { SIMPLE_PINHOLE: 0, PINHOLE: 1, SIMPLE_RADIAL: 2 };
  if (format === 'txt') {
    writeFileSync(join(dir, 'cameras.txt'), `# Camera list with one line of data per camera:\n#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n# Number of cameras: ${m.cams.length}\n` + m.cams.map((c) => `${c.id} ${c.model} ${c.w} ${c.h} ${c.params.join(' ')}`).join('\n') + '\n');
    writeFileSync(join(dir, 'images.txt'), `# Image list with two lines of data per image:\n#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n#   POINTS2D[] as (X, Y, POINT3D_ID)\n# Number of images: ${m.shots.length}\n`
      + m.shots.map((s) => `${s.id} ${s.q.join(' ')} ${s.t.join(' ')} ${s.cam} ${s.name}\n${Array.from({ length: s.n2 }, (_, k) => `${k} ${k + 0.5} -1`).join(' ')}`).join('\n') + '\n');
    writeFileSync(join(dir, 'points3D.txt'), `# 3D point list with one line of data per point:\n#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n# Number of points: ${m.pts.length}\n`
      + m.pts.map((p) => `${p.id} ${p.xyz.join(' ')} ${p.rgb.join(' ')} ${p.err} ${p.track.flat().join(' ')}`).join('\n') + '\n');
    return;
  }
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const f64 = (...v) => { const b = Buffer.alloc(8 * v.length); v.forEach((x, k) => b.writeDoubleLE(x, 8 * k)); return b; };
  writeFileSync(join(dir, 'cameras.bin'), Buffer.concat([u64(m.cams.length), ...m.cams.flatMap((c) => [u32(c.id), i32(ids[c.model]), u64(c.w), u64(c.h), f64(...c.params)])]));
  writeFileSync(join(dir, 'images.bin'), Buffer.concat([u64(m.shots.length), ...m.shots.flatMap((s) => [u32(s.id), f64(...s.q, ...s.t), u32(s.cam), Buffer.from(s.name + '\0'), u64(s.n2),
    ...Array.from({ length: s.n2 }, (_, k) => Buffer.concat([f64(k, k + 0.5), u64(k % 5)]))])]));
  writeFileSync(join(dir, 'points3D.bin'), Buffer.concat([u64(m.pts.length), ...m.pts.flatMap((p) => [u64(p.id), f64(...p.xyz), Buffer.from(p.rgb), f64(p.err), u64(p.track.length), ...p.track.flatMap(([a, b]) => [u32(a), u32(b)])])]));
}

await (async () => {
  const m = colmapScene(), dir = mkdtempSync(join(tmpdir(), 'ssm-'));
  writeColmap(join(dir, 'bin'), m, 'bin');
  writeColmap(join(dir, 'txt'), m, 'txt');
  const bin = await CMOD.readModel(join(dir, 'bin')), txt = await CMOD.readModel(join(dir, 'txt'));
  assert.deepEqual([bin.format, txt.format], ['bin', 'txt']);
  for (const md of [bin, txt]) {
    assert.deepEqual(md.images.map((i) => i.name), ['0001.jpg', '0003.jpg', 'p1/0002.jpg'], 'sorted by name, subfolders kept');
    for (const im of md.images) {
      const s = m.shots.find((x) => x.name === im.name);
      near(im.C, s.C, 1e-9, `${im.name} centre`);
      near(im.fwd, s.fwd, 1e-9, `${im.name} looks`);
      near(im.up, s.up, 1e-9, `${im.name} up`);
      assert.equal(im.cameraId, s.cam);
    }
    assert.equal(md.points.n, 5);
    assert.deepEqual([...md.points.track], [2, 3, 2, 5, 2]);
    near([...md.points.xyz.slice(9, 12)], [-1, -1.5, 1], 1e-6, 'a point');
    assert.deepEqual([...md.points.rgb.slice(3, 6)], [10, 199, 7]);
    assert.equal(md.cameras.get(2).model, 'SIMPLE_RADIAL');
  }
  assert.equal(bin.images.find((i) => i.name === '0001.jpg').points2D, 1500, 'a photo’s 2-D points are skipped, not lost track of');
  assert.deepEqual([...bin.points.err], [...txt.points.err], 'text and binary agree');
  const l1 = CMOD.lensOf(bin.cameras.get(1)), l2 = CMOD.lensOf(bin.cameras.get(2));
  near([l1.tanX, l1.tanY, l2.tanX, l2.tanY], [960 / 1374.76, 430 / 1374.1, 430 / 1374, 960 / 1374], 1e-12, 'lenses');
  assert.equal((await CMOD.readModel(join(dir, 'bin'), { points: false })).points, null);

  // Thinning: a room's floor and two walls, plus strays far off and badly seen points.
  const P = [], C = [], T = [], E = [];
  const add = (x, y, z, t = 2 + (P.length % 9), e = 0.5) => { P.push(x, y, z); C.push(100, 120, 140); T.push(t); E.push(e); };
  for (let i = 0; i < 40000; i++) add(Math.random() * 6, 0, Math.random() * 4);
  for (let i = 0; i < 10000; i++) add(Math.random() * 6, Math.random() * 2.6, 0);
  for (let i = 0; i < 8000; i++) add(0, Math.random() * 2.6, Math.random() * 4);
  for (let i = 0; i < 30; i++) add(400 + i, 50, -300);
  for (let i = 0; i < 50; i++) add(3, 1, 2, 9, 10); // in the room, but seen badly
  const raw = { n: T.length, xyz: Float32Array.from(P), rgb: Uint8Array.from(C), err: Float32Array.from(E), track: Uint32Array.from(T) };
  const th = CMOD.thinPoints(raw, { max: 3000 });
  assert.ok(th.n <= 3000 && th.n > 1500 && th.voxel > 0.02, `thinned to ${th.n} points with ${th.voxel.toFixed(3)} m voxels`);
  let x0 = Infinity, x1 = -Infinity, far = 0, bad = 0;
  for (let i = 0; i < th.n; i++) {
    x0 = Math.min(x0, th.xyz[i * 3]);
    x1 = Math.max(x1, th.xyz[i * 3]);
    if (Math.abs(th.xyz[i * 3]) > 20) far++;
    if (th.xyz[i * 3] === 3 && th.xyz[i * 3 + 1] === 1 && th.xyz[i * 3 + 2] === 2) bad++;
  }
  assert.deepEqual([far, bad], [0, 0], 'strays and badly seen points are left out');
  assert.ok(x0 < 0.15 && x1 > 5.85, 'and the room keeps its size');
  const two = CMOD.thinPoints({ n: 3, xyz: Float32Array.from([0, 0, 0, 0.001, 0, 0, 5, 0, 0]), rgb: new Uint8Array(9), track: Uint32Array.from([2, 9, 3]) }, { max: 2 });
  assert.deepEqual([...two.xyz.filter((_, i) => i % 3 === 0)].sort(), [0.0010000000474974513, 5], 'the best-seen point stands for its voxel');
  const packed = CMOD.unpackPoints(CMOD.packPoints(th));
  assert.equal(packed.n, th.n);
  assert.deepEqual([...packed.xyz.slice(0, 6)], [...th.xyz.slice(0, 6)]);
  assert.deepEqual([...packed.rgb.slice(-3)], [...th.rgb.slice(-3)]);
  assert.ok(CMOD.planSample(th, 500).length <= 1000, 'a floor-plan sample of at most 500 points');
  passed++;
  console.log('  ok building view: COLMAP models read the same as text or binary (lenses, photo centres and directions, points), thinned for the browser');
})();

test('building view: placing a capture on a footprint (frames, two-point fit, guesses, floors, coverage)', () => {
  // A frame around a point: metres east and north, and back.
  const f = PLACE.localFrame([33.419111, -111.930622]);
  const ll = f.toLatLon([25, -40]);
  near(f.toXY(ll), [25, -40], 1e-6, 'lat/lon round trip');
  // A 20 × 10 m building, given clockwise: its footprint comes back counter-clockwise, 200 m².
  const k = 111320 * Math.cos((33.419111 * Math.PI) / 180);
  const b = { c: [33.419111, -111.930622], poly: [[0, 0], [10, 0], [10, 20], [0, 20]].map(([n, e]) => [33.419111 + n / 110540, -111.930622 + e / k]) };
  const fp = PLACE.footprintOf(b);
  assert.ok(PLACE.signedArea(fp) > 0 && Math.abs(PLACE.polygonArea(fp) - 200) < 0.01, 'counter-clockwise, 200 m²');
  near([PLACE.footprintAngle(fp)], [0], 1e-9, 'walls run east–west and north–south');

  // Seen from above, a model is never mirrored: model x is east and −z is north before turning.
  const pl0 = { s: 1, theta: 0, e: 0, n: 0, floor: 1, floorY: 0 };
  near(PLACE.planOf(pl0, 1, 0), [1, 0], 1e-12, 'x → east');
  near(PLACE.planOf(pl0, 0, -1), [0, 1], 1e-12, '−z → north');
  near(PLACE.dirOf(pl0, [0, 0, -1]), [0, 1, 0], 1e-12, 'a photo looking along −z looks north');
  near(PLACE.planOf({ ...pl0, theta: Math.PI / 2 }, 1, 0), [0, 1], 1e-12, 'a quarter turn left takes east to north');
  const pl = { s: 1.7, theta: 0.65, e: 12, n: -5, floor: 3, floorY: -1.4 };
  for (const [x, z] of [[0, 0], [3.2, -1.1], [-7, 4]]) near(PLACE.modelOf(pl, ...PLACE.planOf(pl, x, z)), [x, z], 1e-9, 'there and back');
  near([PLACE.heightOf(pl, -1.4), PLACE.heightOf(pl, 0.6)], [8, 8 + 1.7 * 2], 1e-12, 'floor 3 starts 8 m up; the model is scaled');
  near(PLACE.toBuilding({ ...pl0, floor: 2, floorY: -1.5 }, [1, 0, -2]), [1, 2, 5.5], 1e-12);

  // Two clicked pairs give the placement back exactly; a model in metres keeps its scale.
  const a = [1, -2], c2 = [4, 3], to = (p) => PLACE.planOf(pl, ...p);
  const fit = PLACE.fitPoints([[a, to(a)], [c2, to(c2)]]);
  near([fit.s, fit.theta, fit.e, fit.n, fit.rms], [1.7, 0.65, 12, -5, 0], 1e-9, 'two pairs fit exactly');
  const truth = { s: 1, theta: -0.4, e: 3, n: 7 }, noisy = [[0, 0], [5, 0], [5, -3], [0, -3]].map((p, i) => [p, PLACE.planOf(truth, ...p).map((v, j) => v + (i + j) % 2 * 0.04 - 0.02)]);
  const fixed = PLACE.fitPoints(noisy, { scale: 1 });
  assert.ok(fixed.s === 1 && Math.abs(fixed.theta + 0.4) < 0.01 && fixed.rms < 0.05, 'scale held at 1, turn found from clicks a few cm off');
  assert.equal(PLACE.fitPoints([[a, [0, 0]]]), null, 'one pair can’t give a turn');
  assert.equal(PLACE.fitPoints([[a, [0, 0]], [a, [5, 5]]]), null, 'nor two clicks on the same spot');
  near(PLACE.planOf(PLACE.moveTo(pl, a, [50, 60]), ...a), [50, 60], 1e-9, 'one pair moves it');
  const about = [2, 2], turned = PLACE.turnAbout(pl, 0.3, about), sc = PLACE.scaleAbout(pl, 2, about);
  const fixedPt = PLACE.modelOf(pl, ...about);
  near(PLACE.planOf(turned, ...fixedPt), about, 1e-9, 'turning keeps its centre');
  near(PLACE.planOf(sc, ...fixedPt), about, 1e-9, 'and so does scaling');
  near([turned.theta, sc.s], [0.95, 3.4], 1e-12);

  // Which way walls run: the building's outline, and a room's points seen from above (both mod 90°).
  const rot = (p, t) => [p[0] * Math.cos(t) - p[1] * Math.sin(t), p[0] * Math.sin(t) + p[1] * Math.cos(t)];
  near([PLACE.footprintAngle(fp.map((p) => rot(p, -0.5)))], [-0.5], 1e-9);
  const room = [];
  for (let i = 0; i < 400; i++) {
    const t = i / 400;
    for (const p of [[t * 5, 0], [t * 5, 4], [0, t * 4], [5, t * 4]]) room.push(...rot([p[0] + (Math.random() - 0.5) * 0.02, p[1] + (Math.random() - 0.5) * 0.02], 0.4));
  }
  for (let i = 0; i < 300; i++) room.push(...rot([Math.random() * 5, Math.random() * 4], 0.4)); // clutter
  assert.ok(Math.abs(PLACE.wallAngle(room) - 0.4) < 0.01, `walls found at ${(PLACE.wallAngle(room) * 180 / Math.PI).toFixed(1)}°`);
  near([PLACE.wrap90(Math.PI / 2 + 0.1), PLACE.wrap90(-0.9)], [0.1, Math.PI / 2 - 0.9], 1e-12);

  // First guesses: a GPS fix 30 m outside lands just inside; captures without GPS are spread out; walls line up.
  const g = PLACE.guessPlacement({ footprint: fp, gps: [-30, 5], anchor: [0, 0], wall: 0.4, floor: 2 });
  assert.ok(PLACE.inside(fp, g.e, g.n) && g.from === 'gps' && g.floor === 2, 'GPS outside the outline → inside it');
  near([PLACE.wrap90(g.theta + 0.4 - PLACE.footprintAngle(fp))], [0], 1e-9, 'turned so its walls run with the building’s');
  const g0 = PLACE.guessPlacement({ footprint: fp, anchor: [1, 1], index: 0, count: 2 }), g1 = PLACE.guessPlacement({ footprint: fp, anchor: [1, 1], index: 1, count: 2 });
  assert.ok(g0.from === 'none' && Math.hypot(g0.e - g1.e, g0.n - g1.n) > 5, 'two captures without GPS don’t pile up');
  assert.ok([g0, g1].every((x) => PLACE.inside(fp, ...PLACE.planOf(x, 1, 1))), 'both inside');

  assert.deepEqual(['1', '2nd', 'Floor 3', 'G', 'Ground', 'B1', 'B2', 'Basement', 'L4', '', null, 'Roof'].map(PLACE.floorNumber), [1, 2, 3, 1, 1, 0, -1, 0, 4, null, null, null]);

  // How much of a floor was photographed: one photo in the middle covers a 1.5 m disc; an outline covers its area.
  const one = PLACE.floorCoverage(fp, [{ cams: [[10, 5]] }]); // the middle of the 20 m (east) × 10 m (north) footprint
  assert.ok(Math.abs(one.area - Math.PI * 1.5 * 1.5) < 1.2 && Math.abs(one.footprint - 200) < 1e-9, `${one.area} m² around one photo`);
  const half = PLACE.floorCoverage(fp, [{ cams: [], outlines: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }]);
  near([half.share], [0.5], 1e-9, 'an outline over half the floor');
  assert.equal(PLACE.floorCoverage(fp, [{ cams: [[100, 100]] }]).area, 0, 'photos outside the building don’t count');

  assert.equal(PLACE.cleanPlacement({ s: 0, theta: 0, e: 0, n: 0, floor: 1 }), null);
  assert.equal(PLACE.cleanPlacement({ s: 1, theta: 0, e: 'x', n: 0, floor: 1 }), null);
  near([PLACE.cleanPlacement({ s: 1, theta: 7, e: 1, n: 2, floor: '2' }).theta], [7 - 2 * Math.PI], 1e-12, 'turns kept within ±180°');
});

await (async () => {
  // A made-up library: one capture of Schwada with its job's COLMAP model, one whose job folder is gone.
  const ws = mkdtempSync(join(tmpdir(), 'ssb-')), lib = join(ws, 'library'), jobsDir = join(ws, 'jobs');
  const buildings = new Map(asuList.map((b) => [b.code, b]));
  const code = 'schwada-classroom-office-building', sb = buildings.get(code);
  const splats = [];
  for (let x = -2; x <= 3; x += 0.25) for (let z = -2; z <= 2; z += 0.25) splats.push({ x, y: -1.5, z, a: 0.8, sc: [0.05, 0.01, 0.05], q: [1, 0, 0, 0] });
  const item = (room, stamp, info) => {
    const folder = join(lib, 'Schwada Building', room, stamp);
    mkdirSync(folder, { recursive: true });
    writeWalkPly(join(folder, 'scene.ply'), splats);
    writeFileSync(join(folder, 'info.json'), JSON.stringify(info));
    return { building: 'Schwada Building', room, stamp, path: `Schwada Building/${room}/${stamp}`, info };
  };
  const view = { position: [0.5, 0.1, -0.3], lookAt: [0.5, 0.1, -1.8], up: [0, 1, 0] };
  const A = item('Room 101', '2026-11-01_1200', { building: 'Schwada Building', room: 'Room 101', jobId: 'job1', created: '2026-11-01T19:00:00Z', view, colmap: { mode: 'ar-poses' }, crop: { areas: [{ poly: [[-2, -2], [3, -2], [3, 2], [-2, 2]], floorY: -1.5 }] } });
  const B = item('Lobby', '2026-10-01_0900', { building: 'Schwada Building', room: 'Lobby', jobId: 'gone', created: '2026-10-01T16:00:00Z', view, colmap: { mode: 'ar-poses' } });
  const other = item('Practice', '2026-10-02_0900', { building: 'Practice', room: 'Practice', jobId: 'x', colmap: { mode: 'sfm' } });
  writeColmap(join(jobsDir, 'job1', 'train', 'sparse', '0'), colmapScene(), 'bin');
  // Its capture: on floor 2, with a GPS fix 30 m west of the building's middle (outside it).
  const gps = PLACE.localFrame(sb.c).toLatLon([-60, 0]);
  mkdirSync(join(jobsDir, 'job1', 'dataset'), { recursive: true });
  writeFileSync(join(jobsDir, 'job1', 'dataset', 'splatscout.json'), JSON.stringify({ capture: { buildingCode: code, floor: '2', geo: { lat: gps[0], lon: gps[1], acc: 12 } } }));
  campusLib.saveFloors(ws, code, 4);
  const library = [A, B, other];
  const look = () => PLACEMENT.buildingView({ code, buildings, library, libraryDir: lib, jobsDir, workDir: ws });

  let v = await look();
  assert.deepEqual([v.building.floors, v.building.floorsSet, v.captures.map((c) => c.room)], [4, true, ['Lobby', 'Room 101']], 'its captures, oldest first, and the club’s floor count');
  let a = v.captures[1];
  assert.deepEqual([a.source, a.cams.length, a.metric, a.floorY, a.floorFrom, a.floorGiven, a.outlines.length, a.slot], ['colmap', 3, true, -1.5, 'outline', 2, 1, 1]);
  near(a.cams[0].slice(0, 3), [0.5, 0.1, -0.3], 1e-3, 'photo centres in the model (AR: not turned)');
  assert.ok(a.lenses.length === 2 && a.cams.every((r) => r.length === 10), 'two lenses, so each photo says which');
  assert.ok(a.guess && a.guess.from === 'gps' && a.guess.floor === 2 && PLACE.inside(v.building.footprint, a.guess.e, a.guess.n), 'guessed at its GPS fix, inside the outline, on its floor');
  assert.ok(existsSync(join(lib, 'Schwada Building', 'Room 101', '2026-11-01_1200', PLACEMENT.CAMERAS_FILE)) && PLACEMENT.pointsFileOf(lib, A.path), 'cached beside the splat');
  const b = v.captures[0];
  assert.deepEqual([b.source, b.cams.length, b.guess.from], ['splat', 0, 'none'], 'no job folder: the splat’s own points, no cameras');
  assert.ok(b.points > 100 && b.start, 'its points and where its first photo was taken');
  near([b.floorY], [-1.5], 0.02, 'the floor from its lowest points');

  // The club places it; campus.json keeps its other settings.
  PLACEMENT.savePlacement(ws, A.path, { s: 1, theta: 0.3, e: 5, n: -3, floor: 3 });
  v = await look();
  a = v.captures[1];
  assert.deepEqual([a.placement.e, a.placement.floor, a.guess, campusLib.loadSettings(ws).floors[code]], [5, 3, undefined, 4], 'placed, and the floor count is still there');
  assert.throws(() => PLACEMENT.savePlacement(ws, A.path, { s: -1 }), /placement/);
  // Deleting its job folder keeps its cameras: they were cached.
  const { rmSync: removeDir } = await import('node:fs');
  removeDir(join(jobsDir, 'job1'), { recursive: true, force: true });
  v = await look();
  assert.deepEqual([v.captures[1].source, v.captures[1].cams.length], ['colmap', 3], 'camera positions outlive the job folder');
  PLACEMENT.savePlacement(ws, A.path, null);
  assert.ok(!(await look()).captures[1].placement, 'and a placement can be forgotten');
  mkdirSync(join(ws, 'outside'), { recursive: true });
  writeWalkPly(join(ws, 'outside', 'scene.ply'), splats.slice(0, 3));
  assert.equal(PLACEMENT.libraryFolderOf(lib, '../outside'), null, 'nothing outside the library');
  assert.ok(PLACEMENT.libraryFolderOf(lib, '../library/Schwada Building/Lobby/2026-10-01_0900'), 'a way round that stays inside is fine');
  assert.equal(PLACEMENT.libraryFolderOf(lib, 'Schwada Building/Lobby'), null, 'only splat folders');
  passed++;
  console.log('  ok building view: a building’s captures with their cameras, cached beside each splat (they outlive the job), guessed at GPS, placed by the club in campus.json, the splat’s points when the model is gone');
})();

await (async () => {
  // A cropped scan in the building view shows only its scan area: its points, floor plan and lighter splats (big ones
  // too). Snapping still gets every point. With the crop off, or a scan not in AR coordinates, everything shows.
  const { readSplat } = await import('../station/lib/splatlod.mjs');
  const { readdirSync } = await import('node:fs');
  const ws = mkdtempSync(join(tmpdir(), 'ssk-')), lib = join(ws, 'library'), jobsDir = join(ws, 'jobs');
  const buildings = new Map(asuList.map((b) => [b.code, b]));
  const dot = (x, y, z, sc = 0.05) => ({ x, y, z, a: 0.8, sc: [sc, sc / 5, sc], q: [1, 0, 0, 0] });
  const room = [], beyond = [];
  for (let x = -2; x <= 2; x += 0.25) for (let z = -1.5; z <= 1.5; z += 0.25) room.push(dot(x, -1.5, z)); // its floor
  for (let x = 4; x <= 6; x += 0.25) for (let z = -1; z <= 1; z += 0.25) beyond.push(dot(x, -1.5, z)); // the next room, through a doorway
  for (let x = -1; x <= 1; x += 0.5) for (let z = -1; z <= 1; z += 0.5) beyond.push(dot(x, -3, z)); // the street, through a window
  for (let z = -1.5; z <= 1.5; z += 0.5) for (const y of [-1, -0.5, 0]) beyond.push(dot(-4, y, z, 0.4)); // big faint blobs behind a wall
  const folder = join(lib, 'Schwada Building', 'Room 120', '2026-11-08_1000');
  mkdirSync(folder, { recursive: true });
  writeWalkPly(join(folder, 'scene.ply'), [...room, ...beyond]);
  writeFileSync(join(folder, 'scene.lod-far.splat'), Buffer.alloc(32)); // a copy made before crops were shown
  const crop = { removed: 0, margin: 0.5, areas: [{ poly: [[-2.2, -1.7], [2.2, -1.7], [2.2, 1.7], [-2.2, 1.7]], floorY: -1.5, top: null }] };
  const it = { building: 'Schwada Building', room: 'Room 120', stamp: '2026-11-08_1000', path: 'Schwada Building/Room 120/2026-11-08_1000' };
  const setCrop = (c) => {
    it.info = { building: 'Schwada Building', room: 'Room 120', jobId: 'gone', colmap: { mode: 'ar-poses' }, crop: c };
    writeFileSync(join(folder, 'info.json'), JSON.stringify(it.info));
  };
  const look = async () => (await PLACEMENT.buildingView({ code: 'schwada-classroom-office-building', buildings, library: [it], libraryDir: lib, jobsDir, workDir: ws })).captures[0];
  const inRoom = ([x, y, z]) => x >= -2.7 && x <= 2.7 && z >= -2.2 && z <= 2.2 && y >= -1.9; // the outline, 0.5 m around, from 0.4 m below the floor
  const sent = () => {
    const buf = PLACEMENT.viewPoints(lib, it.path), n = buf.readUInt32LE(0);
    const at = (i) => [0, 1, 2].map((k) => buf.readFloatLE(4 + (i * 3 + k) * 4));
    return { n, at, mask: buf.length === 4 + n * 16 ? [...buf.subarray(4 + n * 15)] : buf.length === 4 + n * 15 ? null : 'bad length' };
  };
  const plan = (c) => Array.from({ length: c.plan.length / 2 }, (_, i) => [c.plan[2 * i], c.plan[2 * i + 1]]);
  const lods = () => readdirSync(folder).filter((f) => f.startsWith('scene.lod-'));
  const lodRows = async () => readSplat(readFileSync(await PLACEMENT.splatPreview({ libraryDir: lib, jobsDir, key: it.path, detail: 'far' })));

  setCrop(crop);
  let c = await look();
  assert.ok(c.cropped && c.points === room.length + beyond.length, `cropped, and every point read (${c.points})`);
  let s = sent();
  assert.ok(Array.isArray(s.mask) && s.n === c.points, 'the points come with a byte each');
  assert.ok(s.mask.every((m, i) => m === (inRoom(s.at(i)) ? 1 : 0)), 'saying which are in its scan area');
  assert.equal(s.mask.filter((m) => m).length, room.length, 'the next room, the street and the blobs behind the wall are not');
  assert.ok(plan(c).length === room.length && plan(c).every(([x, z]) => inRoom([x, 0, z])), 'the floor plan only of what’s inside');
  let rows = await lodRows();
  assert.ok(rows.length === room.length && rows.every((r) => inRoom([r.x, r.y, r.z])), `its lighter splats only inside, big ones too (${rows.length})`);
  assert.ok(lods().length === 1 && /^scene\.lod-far-[0-9a-f]{8}\.splat$/.test(lods()[0]), `the copy made before is gone (${lods()})`);

  setCrop({ ...crop, off: true });
  c = await look();
  s = sent();
  assert.ok(!c.cropped && s.mask === null, 'crop turned off: no bytes, every point shows');
  assert.ok(plan(c).some(([x]) => x > 3), 'and the floor plan has the next room again');
  rows = await lodRows();
  assert.ok(rows.length === room.length + beyond.length && lods().length === 1, `a new lighter copy with everything (${rows.length}), the cropped one gone`);

  assert.equal(PLACEMENT.cropOf({ colmap: { mode: 'sfm' }, crop }), null, 'not in AR coordinates: an outline means nothing');
  assert.equal(typeof PLACEMENT.cropOf({ colmap: { mode: 'sfm-ar' }, crop }), 'function', 'aligned to AR: it does');
  assert.equal(PLACEMENT.cropOf({ colmap: { mode: 'ar-poses' }, crop: { areas: [{ poly: [[0, 0], [1, 0]], floorY: 0 }] } }), null, 'two corners aren’t an outline');
  assert.equal(PLACEMENT.cropOf({ colmap: { mode: 'ar-poses' } }), null, 'no crop');
  passed++;
  console.log('  ok building view: a cropped scan shows only its scan area (points, floor plan, lighter splats with the big ones), snapping still gets every point, and turning the crop off shows everything');
})();

// ---- review: snapping a new capture onto the ones already placed, like a jigsaw piece
/** Points on a corridor's surfaces (floor, both walls, and a short partition) between e0 and e1, in building metres. */
function corridorScan(e0, e1, perM2, stub = 5) {
  const pts = [], jit = () => (Math.random() - 0.5) * 0.02;
  const area = (a, b) => Math.round(a * b * perM2);
  for (let i = 0; i < area(e1 - e0, 3); i++) pts.push(e0 + Math.random() * (e1 - e0), Math.random() * 3, jit()); // floor (h = 0)
  for (const n of [0, 3]) for (let i = 0; i < area(e1 - e0, 2.6); i++) pts.push(e0 + Math.random() * (e1 - e0), n + jit(), Math.random() * 2.6); // side walls
  if (stub > e0 && stub < e1) for (let i = 0; i < area(1, 2.6); i++) pts.push(stub + jit(), Math.random(), Math.random() * 2.6); // a partition 1 m long
  return pts;
}

test('building view: snapping a capture onto its placed neighbours (a turn, a shift and a rise only)', () => {
  // A is placed (e 0–6 m); B, scanned on another day, runs on to e = 10 and overlaps A between 4 and 6 m, where the
  // partition at e = 5 pins it along the corridor. B is in the right place when its placement is the identity.
  const A = corridorScan(0, 6, 200), B = corridorScan(4, 10, 80);
  const model = []; // B's model points (x, y, z) = (e, h, −n): what its COLMAP model would hold
  for (let i = 0; i < B.length; i += 3) model.push([B[i], B[i + 2], -B[i + 1]]);
  const right = { s: 1, theta: 0, e: 0, n: 0, floor: 1, floorY: 0, dh: 0 };
  // Dropped in by hand: 3° out, 30 cm along, 20 cm across, 4 cm too high.
  const wrong = { ...PLACE.turnAbout(right, 0.052, [7, 1.5]), floor: 1, floorY: 0 };
  Object.assign(wrong, { e: wrong.e + 0.3, n: wrong.n - 0.2, dh: 0.04 });
  const at = (pl) => Float32Array.from(model.flatMap((p) => PLACE.toBuilding(pl, p)));
  const r = PLACE.snapPoints(at(wrong), Float32Array.from(A));
  assert.ok(r.ok, r.reason);
  const fixed = PLACE.applySnap(wrong, r);
  assert.ok(Math.abs(fixed.theta) < 0.004 && Math.hypot(fixed.e, fixed.n) < 0.03 && Math.abs(fixed.dh) < 0.015, `snapped to θ ${(fixed.theta * 180 / Math.PI).toFixed(2)}°, (${fixed.e.toFixed(3)}, ${fixed.n.toFixed(3)}), rise ${fixed.dh.toFixed(3)}`);
  // (Two scans never sample a wall at the same spots: at these densities about 3 cm apart is a perfect fit.)
  assert.ok(r.before.rms > r.rms && r.rms < 0.045 && r.overlap > 0.2 && r.overlap > r.before.overlap, `fit ${r.before.rms.toFixed(3)} → ${r.rms.toFixed(3)} m over ${(r.overlap * 100).toFixed(0)}% of its points`);
  const f = PLACE.fitOf(at(right), Float32Array.from(A));
  assert.ok(f.rms < 0.045 && f.overlap > 0.2 && Math.abs(f.rms - r.rms) < 0.005, 'where it belongs, it fits as well as the snap made it');
  // Nothing to snap to: too far from A, or asked for more than a nudge.
  const far = PLACE.snapPoints(at({ ...wrong, e: wrong.e + 25 }), Float32Array.from(A));
  assert.ok(!far.ok && /overlap/.test(far.reason), far.reason);
  const big = PLACE.snapPoints(at(wrong), Float32Array.from(A), { maxTurn: 0.001 });
  assert.ok(!big.ok && /nudge/.test(big.reason), 'more than a nudge is refused');
  assert.ok(!PLACE.snapPoints(at(wrong), new Float32Array(0)).ok, 'nothing placed: nothing to snap to');
  // The rise is kept in the placement (and saved), within half a metre.
  near([PLACE.heightOf({ ...right, dh: 0.2 }, 1)], [1.2], 1e-12);
  assert.deepEqual([PLACE.cleanPlacement({ s: 1, theta: 0, e: 0, n: 0, floor: 1, dh: 3 }).dh, PLACE.cleanPlacement({ s: 1, theta: 0, e: 0, n: 0, floor: 1 }).dh], [0.5, 0]);
});

await (async () => {
  // Lighter copies of a splat for the building view: the most important splats inside the capture's box, as .splat rows.
  const { splatLod, readSplat, quatOf } = await import('../station/lib/splatlod.mjs');
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const logit = (a) => Math.log(a / (1 - a));
  const splats = [ // [x, y, z, opacity, size]
    [0.2, 0.1, -0.3, 0.9, 0.08], // big and opaque: kept
    [0.5, 0.5, 0.5, 0.6, 0.01], // small: left out when only two fit
    [5, 0, 0, 0.95, 0.3], // outside the box
    [0, 0, 0.1, 0.01, 0.2], // nearly see-through
    [-0.4, 0.2, 0.6, 0.7, 0.05], // medium: kept
  ];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`;
  const body = Buffer.alloc(splats.length * props.length * 4);
  splats.forEach(([x, y, z, a, s], i) => [x, y, z, 1, -0.5, 0, logit(a), Math.log(s), Math.log(s / 2), Math.log(s / 4), 1, 0, 0, 0].forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
  const dir = mkdtempSync(join(tmpdir(), 'ssl-')), ply = join(dir, 'scene.ply'), out = join(dir, 'scene.lod.splat');
  writeFileSync(ply, Buffer.concat([Buffer.from(head, 'latin1'), body]));
  const r = await splatLod({ ply, out, max: 2, box: [-1, -1, -1, 1, 1, 1] });
  assert.deepEqual([r.count, r.kept, readFileSync(out).length], [5, 2, 64]);
  const rows = readSplat(readFileSync(out));
  near([rows[0].x, rows[0].y, rows[0].z, rows[1].x], [0.2, 0.1, -0.3, -0.4], 1e-6, 'the two that count most, in file order');
  near(rows[0].scale, [0.08, 0.04, 0.02], 1e-6, 'sizes in metres, not logs');
  const C0 = 0.28209479177387814;
  assert.deepEqual(rows[0].rgba, [Math.round((0.5 + C0) * 255), Math.round((0.5 - 0.5 * C0) * 255), 128, Math.round(0.9 * 255)], 'colour from its first spherical harmonic, opacity as alpha');
  near(rows[0].rot, [1, 0, 0, 0], 0.01, 'its turn');
  // A model that isn't upright (COLMAP alone) is levelled like its points: a quarter turn about x.
  const R = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  await splatLod({ ply, out, max: 5, rot: R });
  const turned = readSplat(readFileSync(out));
  near([turned[0].x, turned[0].y, turned[0].z], [0.2, 0.3, 0.1], 1e-6, 'centre turned');
  near(turned[0].rot, quatOf(R), 0.01, 'and its own turn with it');
  assert.equal(turned.length, 4, 'the see-through one is always left out');
  passed++;
  console.log('  ok building view: lighter copies of a splat (the most important splats in its box, levelled, as .splat rows)');
})();

globalThis.fetch = realFetch;

console.log(`\n${passed} checks passed`);
