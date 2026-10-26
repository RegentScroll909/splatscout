// Capture screen: camera/AR view with the live coaching HUD, the scan-area tool, the guide, and the
// alignment panel (when the AR view has to find its place in the scan again).

import { h, mount, toast, fmtDuration, confirmDialog, gradeClass } from './dom.js';
import { icon } from './icons.js';
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
import { mainSpace, spaceOf } from '../core/spaces.js';
import { DEG } from '../core/math.js';
import * as store from '../data/store.js';
import { getSettings, setSettings } from '../data/settings.js';
import { unlockAudio, tick, chime, buzz, speak, keepAwake } from '../capture/audio.js';

const LEVEL_ICON = { bad: 'alert', warn: 'alert', info: 'info', good: 'check' };

const REASON = {
  resume: 'Continuing your scan',
  lost: 'Tracking was lost',
  jump: 'The position jumped',
  reset: 'AR reset its position',
  drift: 'The position drifted',
  manual: 'Re-aligning',
};

const ALIGN_TEXT = {
  more: ['Look around slowly', 'Sweep the phone across walls and furniture you scanned before.'],
  new: ['This part isn\'t in the scan', 'Go back to an area you scanned and point the phone at it.'],
  flat: ['Need more shape', 'Aim at a corner, a doorway or furniture. A plain wall could be anywhere.'],
  floor: ['Show the floor for a moment', 'Tilt down until the floor is in view, then back up.'],
  ambiguous: ['Two places look alike', 'Turn to something distinctive: a door, a cabinet, a corner.'],
  mismatch: ['Not matching yet', 'The room\'s outline fits but its contents don\'t. Keep looking around, or check it\'s the same room.'],
  matching: ['Matching…', 'Keep moving the phone slowly over what you scanned.'],
  locked: ['Found it', 'Lining up…'],
};

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

  // An earlier AR session to continue: photos with depth in one set of coordinates.
  const withDepth = (f) => f.tracked && f.pose && f.pts && f.pts.length;
  const resumeMain = tracked6 ? mainSpace(existing, capture, withDepth) : null;
  const canResume = !!(resumeMain && resumeMain.count >= 8);
  const refFrames = canResume ? pickReferences(existing.filter((f) => withDepth(f) && spaceOf(f, capture) === resumeMain.space)) : [];
  let refIdx = 0;
  const refUrls = refFrames.map((f) => URL.createObjectURL(f.thumb || f.jpeg));

  // ---------------------------------------------------------------- DOM
  const stage = h('div.cap-stage');
  const coachTitle = h('div.coach-title');
  const coachDetail = h('div.coach-detail');
  const coachIcon = h('div.coach-icon');
  const coach = h('div.coach', coachIcon, h('div.coach-text', coachTitle, coachDetail));
  const readouts = h('div.readouts');
  const ring = h('div.target-ring');
  const cueIcon = h('div.cue-icon');
  const cueLabel = h('div.cue-label');
  const cueSub = h('div.cue-sub');
  const cue = h('div.cue.hidden', cueIcon, h('div.cue-text', cueLabel, cueSub));
  const stuckBtn = h('button.pill-btn.stuck-btn.hidden.hud-interactive', { onclick: () => skipGuideSpot() }, icon('skip'), 'Skip this spot');
  const passName = h('span.pass-name');
  const passIdx = h('span.pass-idx');
  const passBar = h('div.pass-bar-fill');
  const covVal = h('span.stat-val', '—');
  const covLbl = h('span.stat-lbl', 'Area');
  const covStat = h('div.stat', covVal, covLbl);
  const count = h('span.stat-val', '0');
  const timer = h('span.stat-val', '0:00');
  const thumb = h('img.last-thumb', { alt: '' });
  const recBtn = h('button.rec.hud-interactive', { 'aria-label': 'Pause or resume' }, icon('pause', 'rec-pause'), icon('play', 'rec-play'));
  const mapCanvas = h('canvas.minimap.hud-interactive', { width: 280, height: 280 });
  const debug = h('pre.debug');
  const sheet = h('div.sheet.hidden.hud-interactive');
  const overlay = h('div.cap-overlay.hud-interactive');
  const ghost = h('img.ghost-photo.hidden', { alt: '' });

  const passPill = h('button.pass-pill.hud-interactive', { onclick: () => openPassSheet() },
    h('div.pass-line', passIdx, passName), h('div.pass-bar', passBar));
  const hudBottom = h(
    'div.hud-bottom',
    h('div.map-wrap', mapCanvas, h('div.map-legend', legendDot('q1', '1'), legendDot('q2', '2'), legendDot('q3', '3+'))),
    h('div.center-controls', recBtn),
    h('div.right-controls', thumb, h('button.shutter.hud-interactive', { onclick: () => session && session.shoot(), 'aria-label': 'Take a photo now' })),
  );

  // Marking the scan area: replaces the bottom controls.
  const cornerCount = h('span.corner-count', '0');
  const boundsBar = h(
    'div.bounds-bar.hidden',
    h('button.btn.ghost.hud-interactive', { onclick: () => skipBounds() }, 'Skip'),
    h('button.btn.hud-interactive', { onclick: () => session && session.undoCorner() }, 'Undo'),
    h('button.btn.primary.hud-interactive', { onclick: () => addCorner() }, icon('plus'), 'Corner'),
    h('button.btn.hud-interactive.done-btn', { onclick: () => finishBounds() }, 'Done ', cornerCount),
  );

  // Tools (AR): scan area, skip a spot, guide on/off, re-align.
  const tool = (name, label, title, onclick) => h('button.tool.hud-interactive', { onclick, title, 'aria-label': title }, icon(name), h('span.tool-label', label));
  const skipBtn = tool('skip', 'Skip', 'Stop counting a surface (windows, mirrors)', () => toggleSkipMode());
  const guideBtn = tool('route', 'Guide', 'Show or hide the path', () => toggleGuide());
  const tools = h(
    'div.tools' + (tracked6 ? '' : '.hidden'),
    tool('area', 'Area', 'Mark the scan area', () => redrawBounds()),
    skipBtn,
    guideBtn,
    tool('align', 'Align', 'Re-align with the scan (when the dots don\'t sit on the surfaces)', () => realign()),
  );

  // Re-alignment panel.
  const alignKicker = h('div.panel-kicker');
  const alignTitle = h('div.panel-title');
  const alignDetail = h('div.panel-detail');
  const alignMeter = h('div.meter-fill');
  const refImg = h('img.ref-img', { alt: 'Where to stand' });
  const refBox = h('div.ref' + (refFrames.length ? '' : '.hidden'),
    h('button.ref-photo.hud-interactive', { onclick: () => toggleGhost(), title: 'Overlay this photo on the camera view' }, refImg),
    h('div.ref-side',
      h('div.ref-cap', 'Stand here, aim the same way'),
      h('div.row.tight',
        h('button.icon-btn.small.hud-interactive', { onclick: () => stepRef(-1), 'aria-label': 'Previous photo' }, icon('chevronLeft')),
        h('button.icon-btn.small.hud-interactive', { onclick: () => stepRef(1), 'aria-label': 'Next photo' }, icon('chevron')),
        h('button.btn.small.hud-interactive', { onclick: () => imHere() }, icon('pin'), 'I\'m here'),
      ),
    ),
  );
  const rotL = h('button.icon-btn.small.hud-interactive.hidden', { onclick: () => session && session.nudgeAlignment(0, 0, -2), 'aria-label': 'Turn the scan left' }, icon('refresh', 'flip'));
  const rotR = h('button.icon-btn.small.hud-interactive.hidden', { onclick: () => session && session.nudgeAlignment(0, 0, 2), 'aria-label': 'Turn the scan right' }, icon('refresh'));
  const manualBtn = h('button.btn.small.hud-interactive', { onclick: () => setManual(!manual) }, icon('hand'), h('span', 'Line up by hand'));
  const acceptBtn = h('button.btn.small.primary.hud-interactive.hidden', { onclick: () => acceptAlignment() }, icon('check'), 'Use this position');
  const alignPanel = h('div.align-panel.hidden.hud-interactive',
    h('div.panel-head', icon('align'), alignKicker),
    alignTitle,
    alignDetail,
    h('div.meter', alignMeter),
    refBox,
    h('div.row.tight.wrap', manualBtn, rotL, rotR, acceptBtn, h('button.btn.small.ghost.hud-interactive', { onclick: () => newMap() }, 'Start a new map')),
  );
  // Full-screen gesture layer for lining up by hand.
  const alignPad = h('div.align-pad.hidden.hud-interactive', h('div.align-pad-hint', 'Drag to slide the scan · twist with two fingers to turn it'));

  const hud = h(
    'div.hud',
    h(
      'div.hud-top',
      h('button.icon-btn.hud-interactive', { onclick: () => quit(), 'aria-label': 'Close' }, icon('close')),
      passPill,
      h('div.stats', covStat, h('div.stat', count, h('span.stat-lbl', 'Photos')), h('div.stat.wide-only', timer, h('span.stat-lbl', 'Active'))),
      h('button.btn.small.primary.hud-interactive', { onclick: () => openFinishSheet() }, 'Done'),
    ),
    coach,
    alignPanel,
    readouts,
    h('div.reticle'),
    ring,
    cue,
    stuckBtn,
    tools,
    settings.showDebug ? debug : null,
    hudBottom,
    boundsBar,
    sheet,
    overlay,
  );
  const capRoot = h('div.cap#capture-root', stage, ghost, alignPad, hud);
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
  let manual = false;
  let resumeMode = false;
  let cueKind = '';

  mapCanvas.addEventListener('click', () => {
    mapBig = !mapBig;
    mapCanvas.classList.toggle('big', mapBig);
    const size = mapBig ? 640 : 280;
    mapCanvas.width = mapCanvas.height = size;
    lastMap = 0;
  });
  recBtn.addEventListener('click', () => {
    if (!session) return;
    if (session.paused) session.unpause();
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

  // Lining up by hand: one finger slides the scan, two fingers turn it.
  const touches = new Map();
  let twist = null;
  alignPad.addEventListener('pointerdown', (e) => {
    alignPad.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    twist = null;
  });
  alignPad.addEventListener('pointermove', (e) => {
    const p = touches.get(e.pointerId);
    if (!p || !session) return;
    if (touches.size === 1) {
      const k = 0.004; // metres per pixel
      session.nudgeAlignment((e.clientX - p.x) * k, -(e.clientY - p.y) * k, 0);
    } else if (touches.size === 2) {
      const [a, b] = [...touches.entries()].map(([id, q]) => (id === e.pointerId ? { x: e.clientX, y: e.clientY } : q));
      const ang = Math.atan2(b.y - a.y, b.x - a.x) / DEG;
      if (twist != null) session.nudgeAlignment(0, 0, ((ang - twist + 540) % 360) - 180);
      twist = ang;
    }
    p.x = e.clientX;
    p.y = e.clientY;
  });
  const lift = (e) => {
    touches.delete(e.pointerId);
    twist = null;
  };
  alignPad.addEventListener('pointerup', lift);
  alignPad.addEventListener('pointercancel', lift);

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
    const refPick = canResume ? h('img.start-ref', { src: refUrls[refIdx], alt: '' }) : null;
    mount(
      overlay,
      h(
        'div.overlay-card',
        h('div.overlay-kicker', `${capture.building} · ${capture.room}`),
        h('h2', canResume ? 'Continue this scan' : resumed ? 'Add more photos' : `${template.name} capture`),
        canResume
          ? h('div',
              h('p', `${existing.length} photos so far. Stand near one of these spots and aim the same way. Once AR starts, sweep the phone slowly over what you scanned: the app finds its place and brings back the scan area, coverage and path.`),
              h('div.start-ref-row',
                h('button.icon-btn.small', { onclick: () => { refIdx = (refIdx + refFrames.length - 1) % refFrames.length; refPick.src = refUrls[refIdx]; }, 'aria-label': 'Previous photo' }, icon('chevronLeft')),
                refPick,
                h('button.icon-btn.small', { onclick: () => { refIdx = (refIdx + 1) % refFrames.length; refPick.src = refUrls[refIdx]; }, 'aria-label': 'Next photo' }, icon('chevron')),
              ),
            )
          : resumed
            ? h('p', `${existing.length} photos so far.${isXR ? ' This AR session starts a new map: mark the scan area again and cover whole areas rather than single spots.' : ''}`)
            : h('p', h('b', `Pass 1 · ${p.name}. `), p.short),
        tracked6 && !canResume
          ? h(
              'ol.tips',
              h('li', h('b', 'Mark the scan area. '), 'Aim the centre cross at the floor in each corner and tap Corner. Only what\'s inside counts.'),
              h('li', h('b', 'Follow the path '), 'on the floor. The arrow in the middle says which way to turn, tilt or step.'),
              h('li', 'Photos are taken automatically while you walk at a slow, steady pace. No need to stop.'),
              h('li', 'Surfaces turn ', h('b.red', 'red'), ' → ', h('b.amber', 'amber'), ' → ', h('b.green', 'green'), ' as they\'re photographed from more angles. The area is done at about 85%.'),
            )
          : !tracked6
            ? h(
                'ul.tips',
                h('li', 'Move slowly and steadily. Photos are taken automatically.'),
                h('li', 'Step sideways between shots. Don\'t just turn on the spot.'),
                h('li', 'Fill the dots around you: white = never, amber = once, green = from 2+ spots.'),
                h('li', 'Keep the same phone orientation the whole time.'),
              )
            : null,
        tracked6 && window.innerHeight > window.innerWidth
          ? h('div.callout', h('b', 'Turn the phone sideways first. '), 'In landscape the AR camera sees twice as wide (70° instead of 35°), so surfaces get their angles sooner and the scan finishes faster.')
          : null,
        error ? h('div.error', error) : null,
        h('button.btn.primary.big', { onclick: () => begin(canResume) },
          canResume ? 'Continue in AR' : isXR ? 'Start AR capture' : engine.startsWith('demo') ? 'Start practice' : 'Start camera'),
        canResume ? h('button.btn', { onclick: () => begin(false) }, 'Start a new map instead') : null,
        engine.startsWith('demo') ? h('p.small.muted', 'Desktop: drag to look, WASD to walk, Q/E down/up, T toggles the auto-tour. J fakes a tracking jump, L fakes lost tracking. Touch: left half moves, right half looks.') : null,
        h('button.btn.ghost', { onclick: () => navigate(existing.length ? `#/review/${captureId}` : '#/') }, 'Cancel'),
      ),
    );
    overlay.classList.remove('hidden');
  }

  async function begin(resume) {
    unlockAudio();
    resumeMode = !!resume;
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
      const resumed = resumeMode && session.resume();
      if (resumed) {
        showRef();
        say('Continuing your scan. Look around slowly.');
      } else if (session.sixdof && !(session.bounds && session.bounds.poly)) {
        if (source.kind === 'demo' && capture.tour && !source.sessionXf) {
          setRoomBounds();
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
    // Like a real AR session, a later session in the practice room starts in its own coordinates.
    const later = engine === 'demo6' && (capture.segments || 0) > 0;
    const sessionXf = later ? { yaw: (Math.random() * 2 - 1) * Math.PI, t: [(Math.random() * 2 - 1) * 1.5, (Math.random() * 2 - 1) * 0.1, (Math.random() * 2 - 1) * 1.5] } : null;
    return new DemoSource({ container: stage, tracking: engine === 'demo3' ? '3dof' : '6dof', tourSpeed: capture.tour ? 1 : 0, sessionXf });
  }

  function setRoomBounds() {
    // The auto-tour marks the practice room's corners itself.
    const m = 0.05;
    session.setBounds(new Bounds({
      poly: [[ROOM.min[0] + m, ROOM.min[2] + m], [ROOM.max[0] - m, ROOM.min[2] + m], [ROOM.max[0] - m, ROOM.max[2] - m], [ROOM.min[0] + m, ROOM.max[2] - m]],
      floorY: 0, segment: session.segment, space: session.space,
    }));
  }

  // ---------------------------------------------------------------- re-alignment
  function showRef() {
    if (!refFrames.length) return;
    refImg.src = refUrls[refIdx];
    if (!ghost.classList.contains('hidden')) ghost.src = refUrls[refIdx];
  }

  function stepRef(d) {
    if (!refFrames.length) return;
    refIdx = (refIdx + d + refFrames.length) % refFrames.length;
    showRef();
  }

  function toggleGhost(force) {
    const on = force != null ? force : ghost.classList.contains('hidden');
    ghost.classList.toggle('hidden', !on || !refFrames.length);
    if (on && refFrames.length) ghost.src = URL.createObjectURL(refFrames[refIdx].jpeg || refFrames[refIdx].thumb);
  }

  function imHere() {
    if (!session || !refFrames.length) return;
    session.hintAlignment(refFrames[refIdx]);
    feedback();
    toast('Got it: matching from this spot');
  }

  function setManual(on) {
    manual = on;
    alignPad.classList.toggle('hidden', !on);
    acceptBtn.classList.toggle('hidden', !on);
    rotL.classList.toggle('hidden', !on);
    rotR.classList.toggle('hidden', !on);
    manualBtn.lastChild.textContent = on ? 'Back to automatic' : 'Line up by hand';
    if (on) toast('Drag to slide the dots onto the walls, twist with two fingers (or ⟲ ⟳) to turn them. Then tap "Use this position".', 6000);
  }

  function acceptAlignment() {
    if (!session) return;
    session.acceptAlignment();
  }

  async function newMap() {
    if (!session) return;
    const ok = await confirmDialog('Start a new map? This AR session gets its own coordinates: mark the scan area again. Photos already taken are kept, but coverage starts empty.', 'Start new map');
    if (!ok) return;
    session.startNewMap();
    setManual(false);
    toggleGhost(false);
    if (source.kind === 'demo' && capture.tour && !source.sessionXf) setRoomBounds();
    else if (settings.guide !== false) startBounds();
    toast('New map started');
  }

  function realign() {
    if (!session || !session.reloc) return;
    if (session.voxels.stats().solid < 150) return toast('Scan a little more first: there\'s nothing to line up with yet.');
    session.realignNow();
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
    if (!p) return toast(session.floorKnown() ? 'Aim the centre cross at the floor' : 'Still finding the floor: point the phone at it and move slowly');
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
    if (session.boundsDraft || (session.reloc && session.reloc.mode)) return;
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
    if (skipMode) toast('Tap surfaces that can\'t be captured well (windows, mirrors, places you can\'t reach). Tap Skip again when done.', 5000);
  }

  function toggleGuide() {
    const on = settings.guide === false;
    setSettings({ guide: on });
    settings.guide = on;
    updateGuideBtn();
    toast(on ? 'Guide on: follow the path and the arrow' : 'Guide hidden: coverage colours and tips only');
  }

  function updateGuideBtn() {
    guideBtn.classList.toggle('active', settings.guide !== false);
  }

  function skipGuideSpot() {
    if (!session) return;
    session.skipGuideSpot();
    feedback();
    toast('Skipped. On to the next spot.');
  }

  function onEvent(e) {
    if (e.type === 'passComplete') {
      if (settings.sounds) chime();
      buzz(40);
      const next = template.passes[session.passIndex + 1];
      toast(e.last ? `${e.pass.name} done. Keep filling gaps or tap Done.` : `${e.pass.name} done. Next: ${next.name}`, 3500);
      say(e.last ? `${e.pass.name} done.` : `${e.pass.name} done. Next, ${next.name}.`);
    } else if (e.type === 'passStart') {
      toast(`Pass ${e.index + 1}: ${e.pass.name}. ${e.pass.short}`, 5000);
    } else if (e.type === 'areaComplete') {
      if (settings.sounds) chime();
      buzz([30, 60, 30]);
      toast('Scan area complete. Tap Done to check the grade, or keep going for extra detail.', 6000);
      say('Scan area complete.');
    } else if (e.type === 'searching') {
      if (e.reason !== 'resume') {
        buzz([60, 40, 60]);
        say('Position lost. Point the phone at something you scanned.');
      }
      showRef();
    } else if (e.type === 'realigned') {
      if (settings.sounds) chime();
      buzz([20, 40, 20]);
      setManual(false);
      toggleGhost(false);
      toast(e.reason === 'resume' ? 'Found your scan. Carry on where you left off.' : 'Back on track: lined up with your scan.', 4000);
      say(e.reason === 'resume' ? 'Found your scan.' : 'Back on track.');
      if (e.reason === 'resume' && session.sixdof && !(session.bounds && session.bounds.poly) && settings.guide !== false && !(source.kind === 'demo' && capture.tour)) {
        startBounds();
      }
    } else if (e.type === 'trackingBack') {
      toast('Tracking back: position checked against the scan.');
    } else if (e.type === 'corrected') {
      toast(`Position corrected by ${e.cm} cm`);
    } else if (e.type === 'spotSkipped') {
      toast('Skipped a spot that couldn\'t be reached');
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
    const R = L.reloc;
    const searching = !!(R && R.mode === 'search');
    const marking = !!session.boundsDraft;

    let pr = L.primary;
    if (skipMode && !marking) pr = { level: 'info', title: 'Skip spots', detail: 'Tap a surface to stop counting it. Tap Skip again when you\'re done.' };
    if (R && R.mode === 'check') pr = { level: 'info', title: 'Checking position…', detail: 'Tracking was interrupted. Photos wait a moment while the view is matched against the scan.' };
    // The arrow in the middle already says what the guide wants: the banner is for problems.
    if (pr && pr.id === 'guide' && L.cue && !marking && !skipMode) pr = null;
    coach.classList.toggle('hidden', searching || !pr);
    if (pr) {
      coach.className = 'coach ' + pr.level + (searching ? ' hidden' : '');
      if (coach.dataset.icon !== pr.level) {
        mount(coachIcon, icon(LEVEL_ICON[pr.level] || 'info'));
        coach.dataset.icon = pr.level;
      }
      coachTitle.textContent = pr.title;
      coachDetail.textContent = pr.detail || '';
    }
    alignPanel.classList.toggle('hidden', !searching);
    if (searching) renderAlign(R);
    else if (manual) setManual(false);

    boundsBar.classList.toggle('hidden', !marking);
    hudBottom.classList.toggle('hidden', marking);
    tools.classList.toggle('hidden', !session.sixdof || marking || searching);
    capRoot.classList.toggle('aligning', searching);
    if (marking) cornerCount.textContent = `(${session.boundsDraft.corners.length})`;
    mount(readouts, ...Object.values(L.chips || {}).map((c) => h('div.readout.' + c.level, h('span.readout-dot'), h('span.readout-lbl', c.label), h('span.readout-val', c.value))));
    const pass = session.pass;
    passIdx.textContent = marking ? 'AREA' : `${String(session.passIndex + 1).padStart(2, '0')}/${String(template.passes.length).padStart(2, '0')}`;
    passName.textContent = marking ? 'Marking the scan area' : searching ? 'Re-aligning' : pass.name;
    passBar.style.width = Math.round(Math.min(1, L.passProgress || 0) * 100) + '%';
    if (L.coverage) {
      const v = L.coverage.value;
      const area = session.bounds && session.bounds.poly && L.coverage.kind === 'surfaces';
      covVal.textContent = `${Math.round(v * 100)}%`;
      covLbl.textContent = area ? 'Area' : L.coverage.kind === 'surfaces' ? 'Surfaces' : 'Views';
      covStat.className = 'stat ' + (L.coverage.kind !== 'surfaces' ? '' : v >= 0.85 ? 'good' : v >= 0.55 ? 'warn' : '');
    }
    count.textContent = String(L.frames);
    timer.textContent = fmtDuration(session.stats.activeSec);
    if (L.saveError) {
      toast('Saving failed: ' + L.saveError, 5000);
      L.saveError = null;
    }
    placeTarget(searching ? null : L.targetScreen, L.aimOk);
    placeCue(searching || marking ? null : L.cue);
    stuckBtn.classList.toggle('hidden', !L.stuck || searching || marking);
    if (now - lastMap > 500) {
      lastMap = now;
      if (session.sixdof && (session.voxels.vox.size > 0 || session.bounds)) {
        drawTopDown(mapCanvas, {
          voxels: session.voxels, frames: session.frames, pose: searching && !(session.reloc.state && session.reloc.state.preview) ? null : L.pose,
          target: session.target && session.target.point, space: session.space, capture, bounds: session.bounds,
          draft: session.boundsDraft && session.boundsDraft.corners,
          guidePath: session.guide && session.guide.hasPath ? session.guide.stations : null,
        });
      } else {
        drawPanorama(mapCanvas, { sphere: session.sphere, pose: L.pose });
      }
    }
    if (settings.showDebug && L.metrics) {
      const m = L.metrics;
      const vs = session.voxels.stats();
      const x = session.reloc ? session.reloc.xf : null;
      debug.textContent =
        `cam ${L.camRes}  track ${L.trackState}  depth ${session.source.info.depth ? 'on' : 'off'}\n` +
        `sharp ${m.sharp.toFixed(0)} rel ${m.relSharp.toFixed(2)}  mean ${m.mean.toFixed(0)} clip ${(m.clipHi * 100).toFixed(1)}%\n` +
        `tex ${m.texture.toFixed(3)} spread ${m.textureSpread.toFixed(2)}  rot ${m.rotSpeed.toFixed(1)}°/s  lin ${m.linSpeed == null ? '-' : m.linSpeed.toFixed(2)}\n` +
        `flow ${m.flowSpeed.toFixed(3)}  depth ${m.depthMed ? m.depthMed.toFixed(2) : '-'}m  h ${L.height == null ? '-' : L.height.toFixed(2)}m  floor ${session.floorHeight().toFixed(2)}\n` +
        `vox ${session.voxels.vox.size} solid ${vs.solid} out ${vs.outside}  q ${vs.q0}/${vs.q1}/${vs.q2}/${vs.q3}\n` +
        (x ? `align ${(x.yaw / DEG).toFixed(1)}° ${x.t.map((v) => v.toFixed(2)).join(' ')}  space ${session.space}` : '') +
        (R && R.metrics ? `\n${JSON.stringify(R.metrics)}` : '');
    }
  }

  function renderAlign(R) {
    const [title, detail] = R.manual
      ? ['Line it up by hand', 'Drag until the dots sit on the real walls and furniture, then tap "Use this position".']
      : ALIGN_TEXT[R.status] || ALIGN_TEXT.more;
    alignKicker.textContent = REASON[R.reason] || 'Re-aligning';
    alignTitle.textContent = title;
    // After a while without a match, point at the ways out.
    alignDetail.textContent = !R.manual && R.since > 25 && R.status !== 'matching'
      ? `${detail} Or line it up by hand, or start a new map.`
      : detail;
    alignMeter.style.width = Math.round(Math.min(1, R.confidence) * 100) + '%';
    alignMeter.className = 'meter-fill' + (R.confidence >= 0.55 ? ' good' : R.confidence >= 0.3 ? ' warn' : '');
  }

  function placeTarget(ts, ok) {
    const W = capRoot.clientWidth, H = capRoot.clientHeight;
    if (!ts || session.paused || !ts.front) {
      ring.style.display = 'none';
      return;
    }
    ring.classList.toggle('ok', !!ok);
    const m = 40;
    if (ts.x > m && ts.x < W - m && ts.y > m && ts.y < H - m) {
      ring.style.display = 'block';
      ring.style.transform = `translate(${ts.x}px, ${ts.y}px)`;
    } else {
      ring.style.display = 'none';
    }
  }

  function placeCue(c) {
    if (!c || session.paused) {
      cue.classList.add('hidden');
      return;
    }
    cue.classList.remove('hidden');
    cue.className = 'cue ' + c.kind;
    const kind = c.kind === 'turn' ? (c.arrow > 0 ? 'turnR' : 'turnL') : c.kind;
    if (kind !== cueKind) {
      cueKind = kind;
      mount(cueIcon, icon(c.kind === 'turn' ? 'turn' : c.kind === 'around' ? 'around' : c.kind === 'hold' ? 'hold' : 'arrow'));
    }
    const rot = c.kind === 'walk' || c.kind === 'tilt' ? `rotate(${c.arrow}deg)` : c.kind === 'turn' && c.arrow < 0 ? 'scaleX(-1)' : '';
    cueIcon.firstChild.style.transform = rot;
    cueLabel.textContent = c.label;
    cueSub.textContent = c.dist != null ? `${c.dist.toFixed(1)} m` : '';
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
        h('span.pass-item-n', String(i + 1).padStart(2, '0')),
        h('div', h('div.pass-item-title', p.name), h('div.pass-item-short', p.short)),
      ),
    );
    const cur = session.pass;
    const gs = session.live.guide;
    openSheet(
      h('div.sheet-kicker', 'Current pass'),
      h('h3', cur.name),
      h('ol.steps', cur.steps.map((s) => h('li', s))),
      h('div.row',
        session.passIndex < template.passes.length - 1
          ? h('button.btn.primary', { onclick: () => { session.nextPass(); closeSheet(); toast(`Next: ${session.pass.name}`); } }, `Next: ${template.passes[session.passIndex + 1].name}`, icon('chevron'))
          : null,
        gs && gs.next ? h('button.btn', { onclick: () => { skipGuideSpot(); closeSheet(); } }, icon('skip'), 'Skip this spot') : null,
      ),
      session.sixdof ? scanAreaControls() : null,
      h('h4', 'All passes'),
      items,
      cameraControls(),
      h('button.btn.ghost.block', { onclick: closeSheet }, 'Close'),
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
        b && b.poly ? h('button.btn.small.ghost', { onclick: () => { session.setBounds(b.skips.length ? new Bounds({ poly: null, floorY: null, skips: b.skips, segment: session.segment, space: session.space }) : null); closeSheet(); toast('Outline removed'); } }, 'Remove outline') : null,
        h('button.btn.small', { onclick: () => { closeSheet(); realign(); } }, icon('align'), 'Re-align'),
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
      parts.push(h('label.field', h('span', 'Exposure compensation'), h('input', { type: 'range', min: ec.min, max: ec.max, step: ec.step || 0.1, value: 0,
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
      h('div.grade-row', h('div.grade.' + gradeClass(res.grade), res.grade), h('div', h('div.score', `${res.score}`, h('span.score-of', '/100')), h('div.verdict', res.verdict))),
      h('ul.fixes', res.fixes.slice(0, 4).map((f) => h('li.' + f.level, f.text))),
      h('div.row.end',
        h('button.btn.ghost', { onclick: () => { closeSheet(); session.unpause(); updateRec(); } }, 'Keep capturing'),
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
        h('div.overlay-kicker', 'Session ended'),
        h('h2', 'The AR session stopped'),
        h('p', `${session.frames.length} photos are saved. Start AR again to carry on: the app lines the new session up with your scan, so the scan area, coverage and path come back.`),
        h('button.btn.primary.big', {
          onclick: async () => {
            cleanup();
            await session.stop();
            captureScreen(root, { captureId, navigate });
          },
        }, 'Continue'),
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
    for (const u of refUrls) URL.revokeObjectURL(u);
  }

  // Leaving via browser back.
  return () => {
    if (running) {
      cleanup();
      session && session.stop();
    }
  };
}

/** Up to four photos to show "where to stand": the last one, then others spread over the capture. */
function pickReferences(frames) {
  if (!frames.length) return [];
  const out = [frames[frames.length - 1]];
  for (const k of [0.2, 0.5, 0.8]) {
    const f = frames[Math.floor(k * (frames.length - 1))];
    if (!out.includes(f)) out.push(f);
  }
  return out.filter((f) => f.thumb || f.jpeg);
}

function legendDot(cls, label) {
  return h('span.legend-item', h('span.legend-dot.' + cls), label);
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
