// Capture screen: camera/AR view with the live coaching HUD, the scan-area tool and the guide.

import { h, mount, toast, fmtDuration, confirmDialog, gradeClass } from './dom.js';
import { CaptureSession } from '../capture/session.js';
import { XRSource } from '../sources/xrSource.js';
import { CameraSource } from '../sources/cameraSource.js';
import { DemoSource } from '../sources/demoSource.js';
import { ROOM } from '../sources/demoScene.js';
import { requestOrientationPermission } from '../sources/orientation.js';
import { drawTopDown, drawPanorama } from '../capture/minimap.js';
import { analyzeCapture } from '../core/score.js';
import { getTemplate } from '../core/plans.js';
import { Bounds } from '../core/bounds.js';
import * as store from '../data/store.js';
import { getSettings, setSettings } from '../data/settings.js';
import { unlockAudio, tick, chime, buzz, speak, keepAwake } from '../capture/audio.js';

const ICON = { bad: '⛔', warn: '⚠️', info: '💡', good: '✅' };

export async function captureScreen(root, { captureId, navigate }) {
  const settings = getSettings();
  const capture = await store.getCapture(captureId);
  if (!capture) {
    navigate('#/');
    return;
  }
  const template = getTemplate(capture.template);
  const existing = await store.getFrames(captureId);
  const engine = capture.engine;
  const isXR = engine === 'xr';
  const tracked6 = engine === 'xr' || engine === 'demo6';
  const say = (text) => settings.voice && speak(text);

  // ---------------------------------------------------------------- DOM
  const stage = h('div.cap-stage');
  const coachTitle = h('div.coach-title');
  const coachDetail = h('div.coach-detail');
  const coachIcon = h('div.coach-icon');
  const coach = h('div.coach', coachIcon, h('div', coachTitle, coachDetail));
  const chips = h('div.chips');
  const ring = h('div.target-ring');
  const walkArrow = h('span.walk-arrow', '➜');
  const walkLabel = h('span.walk-label');
  const walkHint = h('div.walk-hint.hidden', walkArrow, walkLabel);
  const arrow = h('div.edge-arrow', '➤');
  const passName = h('span.pass-name');
  const passBar = h('div.pass-bar-fill');
  const covPill = h('div.cov-pill', '—');
  const count = h('div.count', '0');
  const timer = h('div.timer', '0:00');
  const thumb = h('img.last-thumb', { alt: '' });
  const recBtn = h('button.rec.hud-interactive', { 'aria-label': 'Pause or resume' });
  const mapCanvas = h('canvas.minimap.hud-interactive', { width: 280, height: 280 });
  const debug = h('pre.debug');
  const sheet = h('div.sheet.hidden.hud-interactive');
  const overlay = h('div.cap-overlay.hud-interactive');

  const passPill = h('button.pass-pill.hud-interactive', { onclick: () => openPassSheet() }, passName, h('div.pass-bar', passBar));
  const hudBottom = h(
    'div.hud-bottom',
    h('div.map-wrap', mapCanvas, h('div.map-legend', legendDot('#ff4d4d', '1'), legendDot('#ffbd2e', '2'), legendDot('#3ddc84', '3+'))),
    h('div.center-controls', recBtn, h('div.counts', count, h('span.count-label', 'photos'), timer)),
    h(
      'div.right-controls',
      thumb,
      h('button.shutter.hud-interactive', { onclick: () => session && session.shoot(), 'aria-label': 'Take a photo now' }),
    ),
  );

  // Marking the scan area: replaces the bottom controls.
  const cornerCount = h('span.corner-count', '0');
  const boundsBar = h(
    'div.bounds-bar.hidden',
    h('button.btn.ghost.hud-interactive', { onclick: () => skipBounds() }, 'Skip'),
    h('button.btn.hud-interactive', { onclick: () => session && session.undoCorner() }, 'Undo'),
    h('button.btn.primary.big.hud-interactive', { onclick: () => addCorner() }, '＋ Corner'),
    h('button.btn.hud-interactive.done-btn', { onclick: () => finishBounds() }, 'Done ', cornerCount),
  );

  // Tools (AR): scan area, skip a spot, guide on/off.
  const skipBtn = h('button.tool.hud-interactive', { onclick: () => toggleSkipMode(), title: 'Stop counting a surface' }, h('span.tool-icon', '⊘'), h('span.tool-label', 'Skip spot'));
  const guideBtn = h('button.tool.hud-interactive', { onclick: () => toggleGuide(), title: 'Show or hide the path' }, h('span.tool-icon', '🧭'), h('span.tool-label', 'Guide'));
  const tools = h(
    'div.tools' + (tracked6 ? '' : '.hidden'),
    h('button.tool.hud-interactive', { onclick: () => redrawBounds(), title: 'Mark the scan area' }, h('span.tool-icon', '⬚'), h('span.tool-label', 'Area')),
    skipBtn,
    guideBtn,
  );

  const hud = h(
    'div.hud',
    h(
      'div.hud-top',
      h('button.icon-btn.hud-interactive', { onclick: () => quit(), 'aria-label': 'Close' }, '✕'),
      passPill,
      covPill,
      h('button.btn.small.primary.hud-interactive', { onclick: () => openFinishSheet() }, 'Done'),
    ),
    coach,
    chips,
    h('div.reticle'),
    ring,
    arrow,
    walkHint,
    tools,
    settings.showDebug ? debug : null,
    hudBottom,
    boundsBar,
    sheet,
    overlay,
  );
  const capRoot = h('div.cap#capture-root', stage, hud);
  mount(root, capRoot);
  document.body.classList.add('capturing');

  let session = null;
  let source = null;
  let running = false;
  let lastMap = 0;
  let mapBig = false;
  let raf = 0;
  let lastUi = 0;
  let skipMode = false;

  mapCanvas.addEventListener('click', () => {
    mapBig = !mapBig;
    mapCanvas.classList.toggle('big', mapBig);
    const size = mapBig ? 640 : 280;
    mapCanvas.width = mapCanvas.height = size;
    lastMap = 0;
  });
  recBtn.addEventListener('click', () => {
    if (!session) return;
    if (session.paused) session.resume();
    else session.pause();
    updateRec();
  });

  // Taps on the camera view (not on controls): place a corner, or skip a spot.
  let down = null;
  capRoot.addEventListener('pointerdown', (e) => {
    down = e.target.closest && e.target.closest('.hud-interactive') ? null : { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  capRoot.addEventListener('pointerup', (e) => {
    if (!down || !session) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 12 || !quick) return;
    const r = capRoot.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (session.boundsDraft) {
      const p = session.floorPoint(x, y);
      if (p && session.floorKnown()) {
        session.addCorner(p);
        feedback();
      } else toast('Tap a spot on the floor');
    } else if (skipMode) {
      const p = session.surfacePoint(x, y);
      if (p) {
        session.skipSpot(p);
        feedback();
        toast('Spot skipped: it no longer needs covering');
      } else toast('No scanned surface there yet');
    }
  });

  function feedback() {
    if (settings.sounds) tick('shot');
    buzz(15);
  }

  function updateRec() {
    recBtn.classList.toggle('paused', !!(session && session.paused));
  }

  // ---------------------------------------------------------------- start overlay
  showStartOverlay();

  function showStartOverlay(error) {
    const p = template.passes[0];
    const resumed = existing.length > 0;
    mount(
      overlay,
      h(
        'div.overlay-card',
        h('div.overlay-kicker', `${capture.building} · ${capture.room}`),
        h('h2', resumed ? 'Add more photos' : `${template.icon} ${template.name} capture`),
        resumed
          ? h('p', `${existing.length} photos so far. ${isXR ? 'A new AR session starts its own map, so mark the scan area again and cover whole areas rather than single spots.' : ''}`)
          : h('p', h('b', `Pass 1: ${p.name}. `), p.short),
        tracked6
          ? h(
              'ol.tips',
              h('li', h('b', 'Mark the scan area: '), 'aim the centre dot at the floor in each corner and tap ＋ Corner. Only what\'s inside counts.'),
              h('li', h('b', 'Follow the glowing path '), 'on the floor and keep the blue ring near the centre of the screen.'),
              h('li', 'Photos are taken automatically while you walk at a steady, slow pace. No need to stop.'),
              h('li', 'Surfaces turn ', h('b.red', 'red'), ' → ', h('b.amber', 'amber'), ' → ', h('b.green', 'green'), ' as they\'re photographed from more angles. The area is done at about 85%.'),
            )
          : h(
              'ul.tips',
              h('li', 'Move slowly and steadily. Photos are taken automatically.'),
              h('li', 'Step sideways between shots. Don\'t just turn on the spot.'),
              h('li', 'Fill the dots around you: white = never, amber = once, green = from 2+ spots.'),
              h('li', 'Keep the same phone orientation the whole time.'),
            ),
        tracked6 && window.innerHeight > window.innerWidth
          ? h('div.callout', h('b', '↻ Turn the phone sideways first. '), 'In landscape the AR camera sees twice as wide (70° instead of 35°), so surfaces get their angles much sooner and the scan finishes faster. Keep it sideways for the whole capture.')
          : null,
        error ? h('div.error', error) : null,
        h('button.btn.primary.big', { onclick: begin }, isXR ? 'Start AR capture' : engine.startsWith('demo') ? 'Start practice' : 'Start camera'),
        engine.startsWith('demo') ? h('p.small.muted', 'Desktop: drag to look, WASD to walk, Q/E down/up, T toggles the auto-tour. Touch: left half moves, right half looks.') : null,
        h('button.btn.ghost', { onclick: () => navigate(existing.length ? `#/review/${captureId}` : '#/') }, 'Cancel'),
      ),
    );
    overlay.classList.remove('hidden');
  }

  async function begin() {
    unlockAudio();
    try {
      if (engine === 'camera') await requestOrientationPermission();
      source = makeSource();
      session = new CaptureSession({
        capture,
        template,
        source,
        settings,
        existingFrames: existing,
        speak,
        onKeyframe: (meta, thumbBlob) => {
          if (settings.sounds) tick('shot');
          buzz(10);
          const url = URL.createObjectURL(thumbBlob);
          const old = thumb.src;
          thumb.src = url;
          thumb.classList.remove('flash');
          void thumb.offsetWidth;
          thumb.classList.add('flash');
          if (old && old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000);
        },
        onSourceEnd: () => {
          if (!running) return;
          running = false;
          showEndedOverlay();
        },
      });
      capture.tracking = source.tracking;
      if (location.hostname === 'localhost') window.__splatscout = session; // handy for debugging
      capRoot.classList.toggle('xr-active', isXR);
      await session.start();
      running = true;
      overlay.classList.add('hidden');
      keepAwake(true);
      updateRec();
      updateGuideBtn();
      if (source.kind === 'demo') source.autopilot = () => session.autopilotTarget();
      if (session.sixdof && !(session.bounds && session.bounds.poly)) {
        if (source.kind === 'demo' && capture.tour) {
          // The auto-tour marks the practice room's corners itself.
          const m = 0.05;
          session.setBounds(new Bounds({ poly: [[ROOM.min[0] + m, ROOM.min[2] + m], [ROOM.max[0] - m, ROOM.min[2] + m], [ROOM.max[0] - m, ROOM.max[2] - m], [ROOM.min[0] + m, ROOM.max[2] - m]], floorY: 0, segment: session.segment }));
        } else if (settings.guide !== false) {
          startBounds();
        }
      }
      loop();
      if (isXR && !source.info.depth) toast('Depth sensing is off: coverage uses view directions instead of surfaces.', 4500);
    } catch (e) {
      console.error(e);
      capRoot.classList.remove('xr-active');
      try {
        source && source.stop();
      } catch {}
      session = null;
      showStartOverlay(explainError(e, engine));
    }
  }

  function makeSource() {
    if (engine === 'xr') return new XRSource({ overlayRoot: capRoot, flipY: settings.arFlipY, maxDepth: Math.min(8, template.maxObsDist + 1) });
    if (engine === 'camera') {
      return new CameraSource({ container: stage, deviceId: capture.cameraId || settings.cameraId, resolution: capture.resolution || settings.resolution, lens: capture.lens || 'auto' });
    }
    return new DemoSource({ container: stage, tracking: engine === 'demo3' ? '3dof' : '6dof', tourSpeed: capture.tour ? 1 : 0 });
  }

  // ---------------------------------------------------------------- scan area
  function startBounds() {
    setSkipMode(false);
    session.beginBounds();
    updateRec();
  }

  function addCorner() {
    if (!session || !session.boundsDraft) return;
    const p = session.centerFloorPoint();
    if (!p) return toast(session.floorKnown() ? 'Aim the centre dot at the floor' : 'Still finding the floor: point the phone at it and move slowly');
    session.addCorner(p);
    feedback();
  }

  function finishBounds() {
    if (!session) return;
    const n = session.boundsDraft ? session.boundsDraft.corners.length : 0;
    if (n < 3) return toast('Mark at least 3 corners');
    const area = session.draftArea();
    session.finishBounds();
    updateRec();
    if (settings.sounds) chime();
    toast(`Scan area set: ${area.toFixed(0)} m². Pass 1: ${session.pass.name}`, 3500);
    say(`Scan area set. ${session.pass.name}. Follow the path.`);
  }

  function skipBounds() {
    if (!session) return;
    session.cancelBounds();
    updateRec();
    toast('No scan area: everything you see counts, and the guide points at gaps instead of a path.', 4500);
  }

  function redrawBounds() {
    if (!session || !session.sixdof) return;
    if (session.boundsDraft) return;
    startBounds();
    toast('Mark the corners again. The old outline is replaced when you tap Done.');
  }

  function setSkipMode(on) {
    skipMode = on;
    skipBtn.classList.toggle('active', on);
  }

  function toggleSkipMode() {
    if (!session || session.boundsDraft) return;
    setSkipMode(!skipMode);
    if (skipMode) toast('Tap surfaces that can\'t be captured well (windows, mirrors, places you can\'t reach). Tap ⊘ again when done.', 5000);
  }

  function toggleGuide() {
    const on = settings.guide === false;
    setSettings({ guide: on });
    settings.guide = on;
    updateGuideBtn();
    toast(on ? 'Guide on: follow the path and the ring' : 'Guide hidden: coverage colours and tips only');
  }

  function updateGuideBtn() {
    guideBtn.classList.toggle('active', settings.guide !== false);
  }

  function onEvent(e) {
    if (e.type === 'passComplete') {
      if (settings.sounds) chime();
      buzz(40);
      const next = template.passes[session.passIndex + 1];
      toast(e.last ? `✓ ${e.pass.name} done. Keep filling gaps or tap Done.` : `✓ ${e.pass.name} done. Next: ${next.name}`, 3500);
      say(e.last ? `${e.pass.name} done.` : `${e.pass.name} done. Next, ${next.name}.`);
    } else if (e.type === 'passStart') {
      toast(`Pass ${e.index + 1}: ${e.pass.name}. ${e.pass.short}`, 5000);
    } else if (e.type === 'areaComplete') {
      if (settings.sounds) chime();
      buzz([30, 60, 30]);
      toast('🎉 Scan area complete! Tap Done to check the grade, or keep going for extra detail.', 6000);
      say('Scan area complete.');
    }
  }

  // ---------------------------------------------------------------- HUD loop
  function loop() {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    if (now - lastUi < 110 || !session) return;
    lastUi = now;
    while (session.events.length) onEvent(session.events.shift());
    const L = session.live;
    const pr = skipMode && !session.boundsDraft
      ? { level: 'info', title: 'Skip spots', detail: 'Tap a surface to stop counting it. Tap ⊘ again when you\'re done.' }
      : L.primary;
    if (pr) {
      coach.className = 'coach ' + pr.level;
      coachIcon.textContent = ICON[pr.level] || '';
      coachTitle.textContent = pr.title;
      coachDetail.textContent = pr.detail || '';
    }
    const marking = !!session.boundsDraft;
    boundsBar.classList.toggle('hidden', !marking);
    hudBottom.classList.toggle('hidden', marking);
    tools.classList.toggle('hidden', !session.sixdof || marking);
    if (marking) cornerCount.textContent = `(${session.boundsDraft.corners.length})`;
    mount(chips, ...Object.values(L.chips || {}).map((c) => h('div.chip.' + c.level, h('span.chip-label', c.label), h('span.chip-value', c.value))));
    const pass = session.pass;
    passName.textContent = marking ? 'Marking the scan area' : `${session.passIndex + 1}/${template.passes.length} · ${pass.name}`;
    passBar.style.width = Math.round(Math.min(1, L.passProgress || 0) * 100) + '%';
    if (L.coverage) {
      const v = L.coverage.value;
      const area = session.bounds && session.bounds.poly && L.coverage.kind === 'surfaces';
      covPill.textContent = `${area ? 'Area' : L.coverage.kind === 'surfaces' ? 'Surfaces' : 'Views'} ${Math.round(v * 100)}%`;
      covPill.className = 'cov-pill ' + (L.coverage.kind !== 'surfaces' ? '' : v >= 0.85 ? 'good' : v >= 0.55 ? 'warn' : '');
    }
    count.textContent = String(L.frames);
    timer.textContent = fmtDuration(session.stats.activeSec);
    if (L.saveError) {
      toast('Saving failed: ' + L.saveError, 5000);
      L.saveError = null;
    }
    placeTarget(L.targetScreen, L.aimOk);
    placeWalkHint(L.walk);
    if (now - lastMap > 500) {
      lastMap = now;
      if (session.sixdof && (session.voxels.vox.size > 0 || session.bounds)) {
        drawTopDown(mapCanvas, {
          voxels: session.voxels, frames: session.frames, pose: L.pose, target: session.target && session.target.point,
          segment: session.segment, bounds: session.bounds, draft: session.boundsDraft && session.boundsDraft.corners,
          guidePath: session.guide && session.guide.hasPath ? session.guide.stations : null,
        });
      } else {
        drawPanorama(mapCanvas, { sphere: session.sphere, pose: L.pose });
      }
    }
    if (settings.showDebug && L.metrics) {
      const m = L.metrics;
      const vs = session.voxels.stats();
      debug.textContent =
        `cam ${L.camRes}  track ${L.trackState}  depth ${session.source.info.depth ? 'on' : 'off'}\n` +
        `sharp ${m.sharp.toFixed(0)} rel ${m.relSharp.toFixed(2)}  mean ${m.mean.toFixed(0)} clip ${(m.clipHi * 100).toFixed(1)}%\n` +
        `tex ${m.texture.toFixed(3)} spread ${m.textureSpread.toFixed(2)}  rot ${m.rotSpeed.toFixed(1)}°/s  lin ${m.linSpeed == null ? '-' : m.linSpeed.toFixed(2)}\n` +
        `flow ${m.flowSpeed.toFixed(3)}  depth ${m.depthMed ? m.depthMed.toFixed(2) : '-'}m  h ${L.height == null ? '-' : L.height.toFixed(2)}m  floor ${session.floorHeight().toFixed(2)}\n` +
        `vox ${session.voxels.vox.size} solid ${vs.solid} out ${vs.outside}  q ${vs.q0}/${vs.q1}/${vs.q2}/${vs.q3}`;
    }
  }

  function placeTarget(ts, ok) {
    const W = capRoot.clientWidth, H = capRoot.clientHeight;
    if (!ts || session.paused) {
      ring.style.display = 'none';
      arrow.style.display = 'none';
      return;
    }
    ring.classList.toggle('ok', !!ok);
    // Keep markers inside the free middle area: below the coach banner, left of the chips,
    // above the bottom controls.
    const box = { x0: 40, x1: W - 100, y0: 200, y1: H - 180 };
    if (box.x1 - box.x0 < 80 || box.y1 - box.y0 < 80) Object.assign(box, { x0: 30, x1: W - 30, y0: 80, y1: H - 80 });
    if (ts.front && ts.x > box.x0 && ts.x < box.x1 && ts.y > box.y0 && ts.y < box.y1) {
      ring.style.display = 'block';
      ring.style.transform = `translate(${ts.x}px, ${ts.y}px)`;
      arrow.style.display = 'none';
    } else {
      ring.style.display = 'none';
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
      const a = Math.atan2(ts.y - cy, ts.x - cx);
      const rx = (box.x1 - box.x0) / 2, ry = (box.y1 - box.y0) / 2;
      const k = Math.min(Math.abs(rx / Math.cos(a) || 1e9), Math.abs(ry / Math.sin(a) || 1e9));
      arrow.style.display = 'block';
      arrow.style.transform = `translate(${cx + Math.cos(a) * k}px, ${cy + Math.sin(a) * k}px) rotate(${a}rad)`;
    }
  }

  function placeWalkHint(w) {
    if (!w || settings.guide === false) {
      walkHint.classList.add('hidden');
      return;
    }
    walkHint.classList.remove('hidden');
    // The arrow glyph points right; 0° = ahead (up on screen).
    walkArrow.style.transform = `rotate(${w.angle - 90}deg)`;
    const a = Math.abs(w.angle);
    const label = a < 40 ? 'Walk ahead' : a > 140 ? 'Step back' : w.angle > 0 ? 'Sidestep right' : 'Sidestep left';
    const where = a < 40 ? 'ahead' : a > 140 ? 'behind you' : w.angle > 0 ? 'to your right' : 'to your left';
    walkLabel.textContent = w.dist > 1.2 ? `${w.dist.toFixed(1)} m ${where}` : label;
  }

  // ---------------------------------------------------------------- sheets
  function openPassSheet() {
    if (!session) return;
    const items = template.passes.map((p, i) =>
      h(
        'button.pass-item' + (i === session.passIndex ? '.active' : ''),
        {
          onclick: () => {
            session.setPass(i);
            closeSheet();
            toast(`Pass ${i + 1}: ${p.name}`);
          },
        },
        h('div.pass-item-title', `${i + 1}. ${p.name}`),
        h('div.pass-item-short', p.short),
      ),
    );
    const cur = session.pass;
    const gs = session.live.guide;
    openSheet(
      h('h3', `Now: ${cur.name}`),
      h('ol.steps', cur.steps.map((s) => h('li', s))),
      session.passIndex < template.passes.length - 1
        ? h('button.btn.primary', { onclick: () => { session.nextPass(); closeSheet(); toast(`Next: ${session.pass.name}`); } }, `Next pass: ${template.passes[session.passIndex + 1].name} →`)
        : null,
      gs && gs.mode === 'gaps' && gs.next
        ? h('button.btn', { onclick: () => { session.skipGuideSpot(); closeSheet(); toast('Skipped. Picking another spot.'); } }, 'Skip this spot')
        : null,
      session.sixdof ? scanAreaControls() : null,
      h('h4', 'All passes'),
      items,
      cameraControls(),
      h('button.btn.ghost', { onclick: closeSheet }, 'Close'),
    );
  }

  function scanAreaControls() {
    const b = session.bounds;
    const skips = b ? b.skips.length : 0;
    return h('div',
      h('h4', 'Scan area'),
      h('p.small.muted', b && b.poly ? `${b.area.toFixed(0)} m² marked${skips ? `, ${skips} skipped spot${skips === 1 ? '' : 's'}` : ''}.` : 'No outline: everything you see counts.'),
      h('div.row',
        h('button.btn.small', { onclick: () => { closeSheet(); redrawBounds(); } }, b && b.poly ? 'Redraw outline' : 'Mark outline'),
        skips ? h('button.btn.small', { onclick: () => { session.undoSkip(); closeSheet(); toast('Last skipped spot restored'); } }, 'Undo last skip') : null,
        b && b.poly ? h('button.btn.small.ghost', { onclick: () => { session.setBounds(b.skips.length ? new Bounds({ poly: null, floorY: null, skips: b.skips, segment: session.segment }) : null); closeSheet(); toast('Outline removed'); } }, 'Remove outline') : null,
      ),
    );
  }

  function cameraControls() {
    if (!source || source.kind !== 'camera' || !source.info.controls) return null;
    const c = source.info.controls;
    if (!c.exposureLock && !c.whiteBalanceLock && !c.focusLock && !c.exposureCompensation) {
      return h('p.small.muted', 'This browser does not allow locking exposure. The app watches for brightness jumps instead.');
    }
    const parts = [h('h4', 'Camera')];
    if (c.exposureLock || c.whiteBalanceLock || c.focusLock) {
      parts.push(
        h('label.toggle', h('input', { type: 'checkbox', onchange: async (e) => {
          try {
            await source.setLocks(e.target.checked);
            toast(e.target.checked ? 'Exposure, white balance and focus locked' : 'Auto exposure restored');
          } catch (err) {
            toast('Could not lock: ' + err.message);
          }
        } }), ' Lock exposure / white balance / focus (meter on a typical view first)'),
      );
    }
    if (c.exposureCompensation) {
      const ec = c.exposureCompensation;
      parts.push(h('label.small', 'Exposure compensation', h('input', { type: 'range', min: ec.min, max: ec.max, step: ec.step || 0.1, value: 0,
        oninput: (e) => source.setExposureCompensation(parseFloat(e.target.value)).catch(() => {}) })));
    }
    return h('div', parts);
  }

  function openFinishSheet() {
    if (!session) return;
    if (session.boundsDraft) session.cancelBounds();
    session.pause();
    updateRec();
    const res = analyzeCapture(session.frames, { ...capture, stats: session.stats, tracking: session.tracking });
    openSheet(
      h('div.grade-row', h('div.grade.' + gradeClass(res.grade), res.grade), h('div', h('div.score', `${res.score}/100`), h('div.verdict', res.verdict))),
      h('ul.fixes', res.fixes.slice(0, 4).map((f) => h('li.' + f.level, f.text))),
      h('div.row',
        h('button.btn.ghost', { onclick: () => { closeSheet(); session.resume(); updateRec(); } }, 'Keep capturing'),
        h('button.btn.primary', { onclick: () => finish(res) }, 'Finish & review'),
      ),
    );
  }

  function openSheet(...content) {
    mount(sheet, h('div.sheet-handle'), ...content);
    sheet.classList.remove('hidden');
  }
  function closeSheet() {
    sheet.classList.add('hidden');
  }

  function showEndedOverlay() {
    mount(
      overlay,
      h(
        'div.overlay-card',
        h('h2', 'AR session ended'),
        h('p', `${session.frames.length} photos saved. You can start a new AR session to add more. Note that it starts a new map.`),
        h('button.btn.primary.big', {
          onclick: async () => {
            cleanup();
            await session.stop();
            captureScreen(root, { captureId, navigate });
          },
        }, 'Start a new AR session'),
        h('button.btn', { onclick: () => finish() }, 'Finish & review'),
      ),
    );
    overlay.classList.remove('hidden');
  }

  async function finish(res) {
    cleanup();
    if (session) {
      await session.stop();
      const r = res || analyzeCapture(session.frames, { ...capture, stats: session.stats, tracking: session.tracking });
      capture.score = { score: r.score, grade: r.grade };
      capture.status = 'done';
      await store.putCapture(capture);
    }
    navigate(`#/review/${captureId}`);
  }

  async function quit() {
    if (session && session.frames.length > existing.length) {
      const ok = await confirmDialog('Stop capturing? Photos taken so far are saved.', 'Stop');
      if (!ok) return;
      return finish();
    }
    cleanup();
    if (session) await session.stop();
    navigate(existing.length ? `#/review/${captureId}` : '#/');
  }

  function cleanup() {
    running = false;
    cancelAnimationFrame(raf);
    keepAwake(false);
    document.body.classList.remove('capturing');
  }

  // Leaving via browser back.
  return () => {
    if (running) {
      cleanup();
      session && session.stop();
    }
  };
}

function legendDot(color, label) {
  return h('span.legend-item', h('span.legend-dot', { style: { background: color } }), label);
}

function explainError(e, engine) {
  const msg = (e && (e.message || e.name)) || String(e);
  if (engine === 'xr') {
    if (/NotSupported|not supported|camera-access/i.test(msg)) {
      return 'This browser could not start AR with camera access. Update Chrome and Google Play Services for AR, or use Camera mode.';
    }
    if (/NotAllowed|denied|permission/i.test(msg)) return 'AR or camera permission was denied. Allow it in site settings and try again.';
    if (/user activation|gesture/i.test(msg)) return 'Tap the button again to start AR.';
  }
  if (/NotAllowed|denied|Permission/i.test(msg)) return 'Camera permission was denied. Allow camera access for this site and try again.';
  if (/NotFound|Overconstrained/i.test(msg)) return 'The selected camera is not available. Pick another camera in setup.';
  if (/NotReadable/i.test(msg)) return 'The camera is in use by another app. Close it and try again.';
  return 'Could not start: ' + msg;
}
