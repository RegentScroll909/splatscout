// Snap: take single, sharp photos of a space for the club. Pick the building (GPS suggests it), floor and
// room, then shoot. Every photo is checked on the spot (blur, light, near-duplicates) and a bad one isn't
// kept; good ones are saved on the phone and sent in the background. The camera is the only source: no
// gallery uploads.
// "Track position (AR)" takes the photos inside an AR session instead (the same WebXR source as a scan):
// each photo also keeps where the phone was, so SplatStation lines up an outing's photos faster and in
// metres, and the height change since the session started suggests when you're on another floor. AR photos
// are the AR camera's own frames, smaller than ordinary ones (on the club's Pixel 860×1920, about 1.7 MP).

import { h, mount, toast } from './dom.js';
import { icon } from './icons.js';
import * as campus from '../data/campus.js';
import * as club from '../data/club.js';
import * as snaps from '../data/snaps.js';
import { getSettings, setSettings } from '../data/settings.js';
import { analyzeImage, rgbaToGray, SharpnessReference } from '../core/analyzer.js';
import { RULES, LIGHT_LABEL, LIGHT_SLOTS, lightSlot, dhash, hamming, NEAR_DUPLICATE, photoChecks } from '../core/clubrules.js';
import { poseRecord, floorSuggestion, HeightFilter } from '../core/snappose.js';
import { LIGHT_HOURS } from '../data/campusmap.js';
import { XRSource, xrSupport } from '../sources/xrSource.js';

const MAX_EDGE = 2048; // long side of the saved photo, px
const QUALITY = 0.85;
const DAILY_MAX = 400; // what the club database accepts per phone per day
const BLUR_REJECT = 0.6; // sharper than this fraction of what the camera just saw, or it isn't kept

const toBlob = (canvas, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encode failed'))), 'image/jpeg', q));

const PHOTO_TEXT = 'The camera’s full photos (about 2 to 3 MP kept). SplatStation works out where each was taken from the photos themselves.';
const AR_TEXT = 'Each photo also keeps where the phone was, measured by AR tracking, so SplatStation lines up this outing’s photos faster and in metres, and the Campus map learns the space’s real size. The photos are the AR camera’s, smaller than ordinary ones (about 1.7 MP on a Pixel): the club measures which makes better splats.';
const HINT = { ok: 'Steady. Tap to shoot', moving: 'Hold still…', dark: 'Too dark', bright: 'Too bright', wait: '', start: 'Starting AR: move the phone slowly…', tracking: 'Finding where you are: aim at something with detail, move slowly' };

let deviceName = null;
async function device() {
  if (deviceName) return deviceName;
  try {
    const hi = await navigator.userAgentData.getHighEntropyValues(['model']);
    if (hi.model) return (deviceName = hi.model);
  } catch {}
  return (deviceName = (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || 'unknown');
}

export async function snapScreen(root, { navigate, query }) {
  let me = null;
  try {
    me = await club.myProfile();
  } catch {
    me = club.cachedProfile();
  }
  if (!me) {
    toast('Join the club to send photos');
    navigate('#/club?join=1&back=' + encodeURIComponent('#/snap' + (query.toString() ? '?' + query.toString() : '')));
    return;
  }

  const [asu, xr] = await Promise.all([campus.buildings(), xrSupport().catch((e) => ({ ok: false, reason: e.message }))]);
  const settings = getSettings();
  const S = {
    building: asu.find((b) => b.code === settings.snapBuilding && !b.restricted) || null,
    floor: settings.snapFloor || '', room: settings.snapRoom || '',
    mission: null, session: crypto.randomUUID(), geo: null, near: [], geoMsg: '', stopWatch: null,
    stream: null, timer: 0, hashes: [], taken: 0, last: null, light: 'wait', busy: false,
    want: null, // the light the Campus map said this space needs
    // Track position (AR)
    ar: !!settings.snapAR && xr.ok, xr: null, camera: '',
    arSession: null, arT0: 0, trackState: 'start', lastAna: 0, anaBusy: false, shot: null,
    heights: new HeightFilter(), floorStart: null, floorHint: null, floorKey: '', lastFloorCheck: 0,
  };
  // From the Campus map: the building, floor and room filled in, the light the space needs, and the way back.
  const back = /^#\/[\w/?=&%.+-]*$/.test(query.get('back') || '') ? query.get('back') : '#/club';
  const pre = query.get('building') && asu.find((b) => b.code === query.get('building') && !b.restricted);
  if (pre) {
    S.building = pre;
    S.floor = query.get('floor') || '';
    S.room = query.get('room') || '';
  }
  if (LIGHT_SLOTS.includes(query.get('light'))) S.want = query.get('light');
  if (query.get('mission')) {
    const m = (await club.missions().catch(() => [])).find((x) => x.id === query.get('mission'));
    if (m) {
      S.mission = m;
      const b = m.building_code && asu.find((x) => x.code === m.building_code);
      if (b) S.building = b;
      if (m.floor) S.floor = m.floor;
      if (m.room) S.room = m.room;
    }
  }
  let alive = true;
  const unsubs = [];

  const resolve = (name) => asu.find((b) => b.name.toLowerCase() === name.trim().toLowerCase()) || null;

  /** The light the Campus map asked for, and whether it is that light now. */
  function lightNote(want) {
    const now = lightSlot(Date.now());
    const words = `${LIGHT_LABEL[want].toLowerCase()} light (${LIGHT_HOURS[want]})`;
    return h('section.card.mission',
      h('b', `This space needs ${words}`),
      now === want
        ? h('p.small.muted', 'It’s that light now: good time to shoot.')
        : h('p.small.warn-text', `It’s ${LIGHT_LABEL[now].toLowerCase()} now. Photos in other light help a space only a little, so come back in ${LIGHT_LABEL[want].toLowerCase()} light if you can.`));
  }

  // ------------------------------------------------------------------ step 1: where
  function renderSetup() {
    stopCamera();
    document.body.classList.remove('capturing');
    const msg = h('p.small.warn-text');
    const geo = h('div.geo-row');
    const chips = h('div.chips');
    const bInput = h('input', {
      list: 'snap-blist', value: S.building ? S.building.name : '', placeholder: 'Start typing an ASU building', autocomplete: 'off',
      oninput: (e) => (S.building = resolve(e.target.value)),
    });
    const paint = () => {
      mount(geo,
        h('button.btn.small', { onclick: find, disabled: S.locating }, icon('pin'), S.locating ? 'Finding you…' : 'Find my building'),
        S.geoMsg ? h('span.small.muted', S.geoMsg) : null);
      mount(chips, S.near.map(({ b, dist }) => b.restricted
        ? h('button.btn.small', { disabled: true, title: 'Not open for photos' }, `${b.name} · not open`)
        : h('button.btn.small' + (S.building && S.building.code === b.code ? '.primary' : ''), { onclick: () => { S.building = b; bInput.value = b.name; paint(); } }, b.name + (dist > 0 ? ` · ${Math.round(dist)} m` : ''))));
    };
    async function find(quiet) {
      S.locating = true;
      S.geoMsg = '';
      paint();
      try {
        const fix = await campus.locate();
        S.geo = fix;
        S.near = await campus.near(fix);
        const sure = await campus.sureBuilding(fix);
        if (sure && !sure.restricted && (!S.building || quiet !== true)) {
          S.building = sure;
          bInput.value = sure.name;
        }
        S.geoMsg = !S.near.length ? `No ASU building within reach (GPS good to ${fix.acc} m)` : sure ? `GPS good to ${fix.acc} m` : `GPS good to ${fix.acc} m: pick your building`;
      } catch (e) {
        if (quiet !== true) S.geoMsg = e.message;
      }
      S.locating = false;
      if (alive) paint();
    }
    const floor = h('input', { value: S.floor, placeholder: '2', oninput: (e) => (S.floor = e.target.value) });
    const room = h('input', { value: S.room, placeholder: 'e.g. Main lobby, Room 214', oninput: (e) => (S.room = e.target.value) });
    // Photo or Track position (AR)
    const modeCard = h('section.card');
    const paintMode = () => mount(modeCard,
      h('h2', 'Camera'),
      h('div.seg',
        h('button.seg-btn' + (!S.ar ? '.active' : ''), { 'aria-pressed': String(!S.ar), onclick: () => setMode(false) }, 'Photo'),
        h('button.seg-btn' + (S.ar ? '.active' : ''), { 'aria-pressed': String(S.ar), disabled: !xr.ok, onclick: () => setMode(true) }, 'Track position (AR)')),
      h('p.small.muted', S.ar ? AR_TEXT : PHOTO_TEXT),
      S.ar ? h('p.small.muted', 'Start in the space and move the phone slowly for a moment, until the ring turns green. Take the stairs and the app suggests the new floor.') : null,
      !xr.ok ? h('p.small.muted', `Track position needs AR, which isn’t available here: ${xr.reason}`) : null);
    const setMode = (ar) => {
      S.ar = ar;
      setSettings({ snapAR: ar });
      paintMode();
      start.lastChild.textContent = ar ? 'Start AR camera' : 'Start camera';
    };
    const start = h('button.btn.primary.big.block', {
      onclick: () => {
        const b = S.building || resolve(bInput.value);
        if (!b) return (msg.textContent = 'Pick the building from the list.');
        if (b.restricted) return (msg.textContent = `That is ${campus.RESTRICTED_TEXT[b.restricted] || 'a restricted building'}: it isn’t open for photos.`);
        if (!S.room.trim()) return (msg.textContent = 'Say which room or part of the building you are in.');
        S.building = b;
        setSettings({ snapBuilding: b.code, snapFloor: S.floor.trim(), snapRoom: S.room.trim() });
        // (AR must start from this tap: nothing may be awaited before the session is asked for.)
        if (S.ar) startAR();
        else startCamera();
      },
    }, icon('camera'), h('span', S.ar ? 'Start AR camera' : 'Start camera'));
    paintMode();
    mount(root, h('div.page',
      h('header.page-head',
        h('button.icon-btn', { onclick: () => navigate(back), 'aria-label': 'Back' }, icon('back')),
        h('div.head-text', h('div.kicker', 'Club beta'), h('h1', 'Take photos'))),
      S.mission ? h('section.card.mission', h('div.row.space', h('b', S.mission.title), h('span.tag.good', `+${S.mission.bonus} each`)), S.mission.detail ? h('p.small.muted', S.mission.detail) : null,
        S.mission.light !== 'any' ? h('p.small.warn-text', `Needs ${LIGHT_LABEL[S.mission.light].toLowerCase()} light: it only scores in that light.`) : null) : null,
      !S.mission && S.want ? lightNote(S.want) : null,
      h('section.card',
        h('h2', 'Where are you?'),
        h('label.field', h('span', 'Building'), bInput, h('datalist#snap-blist', asu.filter((b) => !b.restricted).map((b) => h('option', { value: b.name })))),
        geo, chips,
        h('div.row.two', h('label.field', h('span', 'Room or area'), room), h('label.field.narrow', h('span', 'Floor'), floor))),
      modeCard,
      h('section.card',
        h('h2', 'Before you start'),
        h('ul.small.rules', RULES.slice(0, 4).map((r) => h('li', r))),
        h('p.small.muted', 'Walk a few steps between photos so every wall is seen from several spots. Hold still: blurry photos aren’t kept.')),
      msg, start));
    paint();
    campus.locationAllowed().then((ok) => ok && alive && find(true));
  }

  // ------------------------------------------------------------------ step 2: shoot
  const video = h('video.snap-video', { playsInline: true, muted: true, autoplay: true });
  const full = document.createElement('canvas');
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const ref = new SharpnessReference(1.0);

  /** Grayscale copy of a drawable at a given width (analysis size). */
  function grayOf(src, sw, sh, W) {
    const H = Math.max(2, Math.round((W * sh) / sw));
    small.width = W;
    small.height = H;
    sctx.drawImage(src, 0, 0, W, H);
    return { gray: rgbaToGray(sctx.getImageData(0, 0, W, H).data, W, H), w: W, h: H };
  }

  async function startCamera() {
    const msg = 'Could not start the camera';
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
    } catch (e) {
      toast(`${msg}: ${e.name === 'NotAllowedError' ? 'allow camera access for this site' : e.message}`, 5000);
      return;
    }
    const track = S.stream.getVideoTracks()[0];
    S.camera = (track && track.label) || '';
    video.srcObject = S.stream;
    document.body.classList.add('capturing');
    renderCamera(false);
    await video.play().catch(() => {}); // the element was moved into the page: make sure it plays
    S.stopWatch = campus.watchLocation((fix) => (S.geo = fix));
    ref.reset();
    S.timer = setInterval(tick, 300);
  }

  /** AR: the same screen, shown over the AR camera. Called straight from the Start tap. */
  function startAR() {
    const overlay = renderCamera(true); // the page the AR view shows over the camera must be in place first
    const source = new XRSource({ overlayRoot: overlay, flipY: settings.arFlipY !== false, depth: false });
    S.xr = source;
    S.camera = source.info.label;
    S.arSession = null;
    S.trackState = 'start';
    S.light = 'wait';
    paintLive();
    source.start({ onFrame: (fi) => onArFrame(source, fi), onEnd: () => onArEnd(source) }).then(() => {
      if (S.xr !== source) return source.stop(); // left while it was starting
      document.body.classList.add('capturing');
      S.stopWatch = campus.watchLocation((fix) => (S.geo = fix));
      ref.reset();
    }).catch((e) => {
      console.error(e);
      if (S.xr !== source) return;
      S.xr = null;
      toast(`Could not start AR: ${e.message}. Photo mode still works.`, 5000);
      if (alive) renderSetup();
    });
  }

  function stopCamera() {
    clearInterval(S.timer);
    if (S.stopWatch) S.stopWatch();
    S.stopWatch = null;
    if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
    if (S.xr) {
      const x = S.xr;
      S.xr = null; // first, so its end isn't taken for the phone leaving AR
      x.stop();
    }
    S.shot = null;
    S.busy = false;
  }

  /** The AR session ended without us (the phone's back gesture, or AR stopped): back to the first step. */
  function onArEnd(source) {
    if (S.xr !== source) return;
    S.xr = null;
    if (alive) {
      toast('AR stopped');
      renderSetup();
    }
  }

  /** Every AR frame: tracking, the height for the floor, the live check, and a photo when one was asked for. */
  function onArFrame(source, fi) {
    if (S.xr !== source) return;
    const t = fi.t;
    // A new set of coordinates: when the session starts, and whenever tracking starts over somewhere else.
    if (!S.arSession || fi.reset) {
      S.arSession = crypto.randomUUID();
      S.arT0 = t;
      S.heights.reset();
      S.floorStart = null;
      setFloorHint(null);
    }
    const state = !fi.pose ? (S.trackState === 'start' ? 'start' : 'lost') : fi.trackState;
    if (state !== S.trackState) {
      S.trackState = state;
      paintLive();
    }
    const tracked = !!fi.pose && fi.trackState === 'ok';
    if (tracked) {
      const y = S.heights.add(fi.pose[13]);
      if (!S.floorStart || !Number.isFinite(S.floorStart.y)) S.floorStart = { y, floor: S.floor };
      if (t - S.lastFloorCheck > 0.5) {
        S.lastFloorCheck = t;
        setFloorHint(floorSuggestion(S.floorStart, y));
      }
    }
    // The live check, three times a second: steady? light?
    if (fi.requestAnalysis && !S.anaBusy && t - S.lastAna > 0.3) {
      S.anaBusy = true;
      S.lastAna = t;
      fi.requestAnalysis().then((a) => S.xr === source && liveCheck(a.gray, a.w, a.h)).catch(() => {}).finally(() => (S.anaBusy = false));
    }
    // A photo was asked for: this frame's picture, with this frame's pose.
    if (S.shot && fi.requestCandidate) {
      S.shot = null;
      if (!tracked) {
        S.busy = false;
        return toast('Lost track of where you are: hold still a moment, then shoot again');
      }
      const pose = fi.pose.slice(), intr = { ...fi.intr }, session = S.arSession, at = t - S.arT0;
      fi.requestCandidate()
        .then((c) => keepAR(c, pose, intr, session, at))
        .catch((e) => fail(e))
        .finally(() => (S.busy = false));
    }
  }

  /** How sharp and bright the camera is now: feeds the ring and the hint. */
  function liveCheck(gray, w, hh) {
    const a = analyzeImage(gray, w, hh);
    const rel = ref.update(a.sharp, performance.now() / 1000);
    S.light = a.mean < 40 ? 'dark' : a.mean > 225 ? 'bright' : rel < 0.8 ? 'moving' : 'ok';
    paintLive();
  }

  function paintLive() {
    const state = S.xr && S.trackState !== 'ok' ? (S.trackState === 'start' ? 'start' : 'tracking') : S.light;
    ring.className = 'snap-shutter ' + (state === 'start' ? 'tracking' : state);
    hint.textContent = HINT[state];
  }

  /** The live check in photo mode. */
  function tick() {
    if (video.readyState < 2 || !video.videoWidth) return;
    const g = grayOf(video, video.videoWidth, video.videoHeight, 320);
    liveCheck(g.gray, g.w, g.h);
  }

  const hint = h('div.snap-hint');
  const ring = h('button.snap-shutter.wait', { onclick: shoot, 'aria-label': 'Take photo' }, h('span'));
  const lastThumb = h('button.snap-thumb', { onclick: () => navigate('#/club'), 'aria-label': 'Your photos' });
  const queue = h('button.snap-chip.mono', { onclick: () => snaps.kick() });
  const count = h('span.snap-chip.mono');
  const place = h('button.snap-chip.place', { onclick: renderSetup });
  const floorBox = h('div.snap-floor');

  const paintPlace = () => mount(place, icon('pin'), `${S.building.name}${S.floor ? ` · F${S.floor}` : ''} · ${S.room}`);

  /** Build the shooting screen; returns its root (in AR, the page shown over the camera). */
  function renderCamera(ar) {
    const el = h('div.snap' + (ar ? '.ar' : ''),
      ar ? null : video,
      h('div.snap-top',
        h('button.icon-btn.glass', { onclick: () => navigate(back), 'aria-label': 'Done' }, icon('check')),
        place,
        count),
      S.mission ? h('div.snap-mission', icon('flag'), S.mission.title + (S.mission.light !== 'any' ? ` · ${LIGHT_LABEL[S.mission.light].toLowerCase()} light` : '')) : null,
      floorBox,
      hint,
      h('div.snap-bottom', lastThumb, ring, queue),
      h('div.snap-rules', 'No people · no screens or papers · only public areas'),
      h('div.snap-flash#snapflash'));
    mount(root, el);
    paintPlace();
    mount(floorBox);
    paintCounts();
    return el;
  }

  // ---- AR: which floor
  function setFloorHint(s) {
    const key = s ? `${s.floor}|${s.storeys}` : '';
    S.floorHint = s;
    if (key === S.floorKey) return;
    S.floorKey = key;
    if (!s) return mount(floorBox);
    const moved = `You went ${s.dy > 0 ? 'up' : 'down'} about ${Math.abs(s.dy).toFixed(1)} m`;
    mount(floorBox, h('div.snap-floor-card',
      s.floor
        ? [h('span', `${moved}. Now on floor ${s.floor}?`), h('button.btn.small.primary', { onclick: acceptFloor }, `Floor ${s.floor}`)]
        : [h('span', `${moved}: on another floor? Tap the place above to set it.`)],
      h('button.btn.small', { onclick: sameFloor }, 'Same floor')));
  }

  function acceptFloor() {
    const s = S.floorHint;
    if (!s || !s.floor) return;
    S.floor = s.floor;
    setSettings({ snapFloor: S.floor });
    S.floorStart = { y: S.heights.value(), floor: S.floor }; // count from here on
    setFloorHint(null);
    paintPlace();
    toast(`Floor ${S.floor}. In another room now? Tap the place to rename it.`, 3500);
  }

  function sameFloor() {
    S.floorStart = { y: S.heights.value(), floor: S.floor }; // a mezzanine or a ramp: count from here
    setFloorHint(null);
  }

  async function paintCounts() {
    const c = await snaps.counts();
    const st = snaps.status();
    count.textContent = `${S.taken} this outing${S.xr ? ' · AR' : ''}`;
    queue.textContent = st.blocked === 'banned' ? 'Paused' : c.waiting ? `${c.waiting} to send` : `${c.sent + c.accepted} sent`;
    queue.disabled = !c.waiting;
    if (S.last) lastThumb.style.backgroundImage = `url(${S.last})`;
  }
  unsubs.push(snaps.subscribe(() => alive && (S.stream || S.xr) && paintCounts()));

  /** Room on the phone and in today's limit for another photo? */
  async function roomForMore() {
    if ((await snaps.counts()).all >= 4000) {
      toast('Your phone holds a lot of photos already: send them first');
      return false;
    }
    const recent = (await snaps.listSnaps()).filter((s) => Date.now() - s.createdAt < 864e5).length;
    if (recent >= DAILY_MAX) {
      toast(`That’s the daily limit (${DAILY_MAX} photos). Come back tomorrow.`);
      return false;
    }
    return true;
  }

  function fail(e) {
    console.error(e);
    toast('Could not save the photo: ' + e.message, 4000);
  }

  async function shoot() {
    if (S.busy) return;
    if (S.xr) return shootAR();
    if (!S.stream || video.readyState < 2) return;
    S.busy = true;
    try {
      if (!(await roomForMore())) return;
      const vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, MAX_EDGE / Math.max(vw, vh));
      const W = Math.round(vw * k), H = Math.round(vh * k);
      full.width = W;
      full.height = H;
      full.getContext('2d').drawImage(video, 0, 0, W, H);
      // How sharp is it compared with what the camera was just seeing? (Same size as the live check.)
      const g320 = grayOf(full, W, H, 320);
      await keep(W, H, ref.relative(analyzeImage(g320.gray, g320.w, g320.h).sharp), null);
    } catch (e) {
      fail(e);
    } finally {
      S.busy = false;
    }
  }

  /** AR: the photo is taken from the next AR frame, with that frame's pose. */
  async function shootAR() {
    if (S.trackState !== 'ok') return toast('Hold on: AR is still finding where you are. Aim at something with detail and move slowly.');
    S.busy = true;
    try {
      if (!(await roomForMore())) return (S.busy = false);
    } catch (e) {
      S.busy = false;
      return fail(e);
    }
    const shot = {};
    S.shot = shot;
    setTimeout(() => {
      if (S.shot === shot) {
        S.shot = null; // no AR frame came (the session stopped)
        S.busy = false;
      }
    }, 2000);
  }

  let frameCanvas = null;
  async function keepAR(c, pose, intr, session, at) {
    const img = c.image;
    try {
      if (!S.xr) return;
      const k = Math.min(1, MAX_EDGE / Math.max(img.w, img.h));
      const W = Math.round(img.w * k), H = Math.round(img.h * k);
      const data = new ImageData(new Uint8ClampedArray(img.rgba.buffer, img.rgba.byteOffset, img.w * img.h * 4), img.w, img.h);
      full.width = W;
      full.height = H;
      if (k === 1) full.getContext('2d').putImageData(data, 0, 0);
      else {
        frameCanvas = frameCanvas || document.createElement('canvas');
        frameCanvas.width = img.w;
        frameCanvas.height = img.h;
        frameCanvas.getContext('2d').putImageData(data, 0, 0);
        full.getContext('2d').drawImage(frameCanvas, 0, 0, W, H);
      }
      // Sharpness against the live check, both measured on the same small copy of the AR camera's image.
      const rel = ref.relative(analyzeImage(c.gray, c.w, c.h).sharp);
      img.release();
      await keep(W, H, rel, poseRecord(pose, intr, session, at, k));
    } finally {
      img.release();
    }
  }

  /** Check the picture in `full` (W×H), and keep it: on the phone, then sent in the background. */
  async function keep(W, H, rel, pose) {
    const g = grayOf(full, W, H, 640);
    const a = analyzeImage(g.gray, g.w, g.h);
    const verdict = photoChecks({ w: W, h: H, mean: a.mean, clipHi: a.clipHi, rel }, { blurReject: BLUR_REJECT });
    if (verdict.level === 'reject') {
      navigator.vibrate && navigator.vibrate([20, 40, 20]);
      return toast(`Not kept: ${verdict.reasons.join(', ')}.${verdict.reasons.includes('blurry') ? ' Hold still and try again.' : ''}`);
    }
    const hash = dhash(g.gray, g.w, g.h);
    if (S.hashes.some((x) => hamming(x, hash) <= NEAR_DUPLICATE)) {
      navigator.vibrate && navigator.vibrate([20, 40, 20]);
      return toast('Same view as a recent photo: take a few steps first');
    }
    const blob = await toBlob(full, QUALITY);
    const t = document.createElement('canvas');
    const ts = 240 / Math.max(W, H);
    t.width = Math.round(W * ts);
    t.height = Math.round(H * ts);
    t.getContext('2d').drawImage(full, 0, 0, t.width, t.height);
    const thumb = await toBlob(t, 0.7);

    const now = Date.now();
    await snaps.saveSnap({
      id: crypto.randomUUID(), session: S.session, createdAt: now, takenAt: now, blob, thumb, w: W, h: H, bytes: blob.size,
      building: { code: S.building.code, name: S.building.name }, floor: S.floor.trim(), room: S.room.trim(),
      missionId: S.mission ? S.mission.id : null, geo: S.geo && now - S.geo.t < 120000 ? S.geo : null,
      sharp: +a.sharp.toFixed(2), brightness: +a.mean.toFixed(1), phash: hash, light: lightSlot(now),
      device: await device(), camera: S.camera,
      pose, // AR only: where the phone was (core/snappose.js)
    });
    S.hashes.push(hash);
    if (S.hashes.length > 30) S.hashes.shift();
    S.taken++;
    if (S.last) URL.revokeObjectURL(S.last);
    S.last = URL.createObjectURL(thumb);
    navigator.vibrate && navigator.vibrate(25);
    const fl = document.getElementById('snapflash');
    if (fl) {
      fl.classList.remove('go');
      void fl.offsetWidth;
      fl.classList.add('go');
    }
    if (verdict.level === 'review') toast(`Saved, but ${verdict.reasons.join(', ')}. Better light helps.`);
    else if (S.taken === 3) toast('Good. Keep moving a few steps between photos.', 3500);
    paintCounts();
  }

  renderSetup();
  return () => {
    alive = false;
    stopCamera();
    unsubs.forEach((u) => u());
    if (S.last) URL.revokeObjectURL(S.last);
    document.body.classList.remove('capturing');
  };
}
