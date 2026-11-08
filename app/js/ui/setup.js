// New capture setup: where, what kind of space, which capture mode, and a pre-flight checklist.

import { h, mount, toast } from './dom.js';
import { icon, templateIcon } from './icons.js';
import { TEMPLATES, PREFLIGHT, getTemplate } from '../core/plans.js';
import { xrSupport } from '../sources/xrSource.js';
import { listCameras, RESOLUTIONS, LENS_FOV } from '../sources/cameraSource.js';
import * as store from '../data/store.js';
import * as campus from '../data/campus.js';
import { getSettings, setSettings } from '../data/settings.js';

export async function setupScreen(root, { navigate, query }) {
  const settings = getSettings();
  const practice = query.get('practice') === '1';
  const [buildings, asu] = await Promise.all([store.listBuildings(), campus.buildings()]);
  const names = [...new Set([...buildings.map((b) => b.name), ...asu.map((b) => b.name)])];
  const xr = await xrSupport();
  // From the Campus map or a mission ("Scan here"): the building, floor and room filled in.
  const pre = !practice && query.get('building') ? asu.find((b) => b.code === query.get('building') && !b.restricted) || null : null;

  const st = {
    buildingCode: practice ? null : pre ? pre.code : settings.lastBuildingCode || null,
    geo: null,
    near: null, // [{b, dist}] from the last GPS fix
    locating: false,
    geoMsg: '',
    building: practice ? 'Practice' : pre ? pre.name : settings.lastBuilding || '',
    room: practice ? 'Demo classroom' : pre ? (query.get('room') || '').slice(0, 80) : '',
    floor: pre ? (query.get('floor') || '').slice(0, 20) : '',
    notes: '',
    template: practice ? 'room' : settings.lastTemplate || 'room',
    engine: practice ? 'demo6' : settings.engine === 'camera' || !xr.ok ? 'camera' : 'xr',
    cameraId: settings.cameraId || '',
    lens: 'auto',
    resolution: settings.resolution || '4k',
    tour: false,
    checks: new Set(),
  };

  const body = h('div');
  const render = () => {
    const tpl = getTemplate(st.template);
    mount(
      body,
      practice
        ? h('section.card',
            h('h2', 'Practice room'),
            h('p.small', 'A virtual classroom on screen. It runs the same coaching, coverage tracking, scoring and export as a real capture, so you can learn the motions and see what a good capture looks like.'),
            h('div.seg',
              segBtn('engine', 'demo6', 'AR simulation'),
              segBtn('engine', 'demo3', 'Camera-mode simulation'),
            ),
            h('label.toggle', h('input', { type: 'checkbox', checked: st.tour, onchange: (e) => (st.tour = e.target.checked) }), ' Auto-tour (watch a full capture)'),
          )
        : h('section.card',
            h('h2', 'Where'),
            h('label.field', h('span', 'Building'),
              h('input', { list: 'blist', value: st.building, placeholder: 'e.g. Hayden Library', oninput: (e) => { st.building = e.target.value; st.buildingCode = null; } }),
              h('datalist#blist', names.map((n) => h('option', { value: n })))),
            h('div.geo-row',
              h('button.btn.small', { onclick: findBuilding, disabled: st.locating }, icon('pin'), st.locating ? 'Finding you…' : 'Find my building'),
              st.geoMsg ? h('span.small.muted', st.geoMsg) : null),
            st.near && st.near.length
              ? h('div.chips', st.near.map(({ b, dist }) => h('button.btn.small' + (b.code === st.buildingCode ? '.primary' : ''), { onclick: () => pick(b) },
                  b.name + (dist > 0 ? ` · ${Math.round(dist)} m` : ''))))
              : null,
            h('div.row.two',
              h('label.field', h('span', 'Room / area'), h('input', { value: st.room, placeholder: 'e.g. Room 214, Main lobby', oninput: (e) => (st.room = e.target.value) })),
              h('label.field.narrow', h('span', 'Floor'), h('input', { value: st.floor, placeholder: '2', oninput: (e) => (st.floor = e.target.value) })),
            ),
          ),

      h('section.card',
        h('h2', 'Type of space'),
        h('div.tpl-grid', TEMPLATES.map((t) => h('button.tpl' + (t.id === st.template ? '.active' : ''), { onclick: () => { st.template = t.id; render(); } },
          templateIcon(t.id, 'tpl-icon'), h('span', t.name)))),
        h('p.small.muted', tpl.desc),
        h('ol.small.pass-list', tpl.passes.map((p) => h('li', h('b', p.name), ` · ${p.short}`))),
      ),

      practice
        ? null
        : h('section.card',
            h('h2', 'Capture mode'),
            h('div.seg',
              segBtn('engine', 'xr', 'AR tracked', !xr.ok),
              segBtn('engine', 'camera', 'Camera only'),
            ),
            st.engine === 'xr'
              ? h('p.small', h('b', 'Recommended. '), 'Uses ARCore to track where the phone is in 3D, paints scanned surfaces live, and exports camera poses and depth points. Photos are the AR camera\'s resolution (usually about 1920 px).')
              : h('div',
                  h('p.small', xr.ok
                    ? 'Full camera resolution, but no 3D tracking: coverage comes from the motion sensors and parallax is estimated from the image. Use AR mode unless you need maximum resolution.'
                    : `AR is not available here (${xr.reason}). Camera mode tracks view directions with the motion sensors and estimates parallax from the image.`),
                  cameraOptions(),
                ),
          ),

      practice ? null : h('section.card',
        h('h2', 'Before you start'),
        h('div.checklist', PREFLIGHT.map((c) => h('label.check',
          h('input', { type: 'checkbox', checked: st.checks.has(c.id), onchange: (e) => (e.target.checked ? st.checks.add(c.id) : st.checks.delete(c.id), updateCount()) }),
          h('span', c.text)))),
        h('div.small.muted#checkcount'),
        h('label.field', h('span', 'Notes (optional)'), h('textarea', { rows: 2, placeholder: 'Lighting, access, anything unusual…', oninput: (e) => (st.notes = e.target.value) }, st.notes)),
      ),

      h('button.btn.primary.big.block', { onclick: start }, practice ? 'Open practice room' : 'Continue to capture'),
    );
    updateCount();
  };

  // GPS suggests the building (good to a few metres outside, often 10–50 m indoors); you confirm it.
  async function findBuilding(quiet = false) {
    st.locating = true;
    st.geoMsg = '';
    render();
    try {
      const fix = await campus.locate();
      st.geo = fix;
      st.near = await campus.near(fix);
      const sure = await campus.sureBuilding(fix);
      if (sure && (!st.building || quiet !== true)) pick(sure, false);
      st.geoMsg = !st.near.length ? `No ASU building within reach (GPS good to ${fix.acc} m)` : sure ? `GPS good to ${fix.acc} m` : `GPS good to ${fix.acc} m: pick your building`;
    } catch (e) {
      if (quiet !== true) st.geoMsg = e.message;
    }
    st.locating = false;
    render();
  }

  function pick(b, draw = true) {
    st.building = b.name;
    st.buildingCode = b.code;
    if (draw) render();
  }

  function segBtn(key, value, label, disabled) {
    return h('button.seg-btn' + (st[key] === value ? '.active' : ''), { disabled, onclick: () => { st[key] = value; render(); } }, label);
  }

  function updateCount() {
    const el = body.querySelector('#checkcount');
    if (el) el.textContent = `${st.checks.size} of ${PREFLIGHT.length} checked`;
  }

  function cameraOptions() {
    const sel = h('select', { onchange: (e) => { st.cameraId = e.target.value; const opt = e.target.selectedOptions[0]; st.lens = opt ? opt.dataset.lens || 'auto' : 'auto'; } },
      h('option', { value: '' }, 'Default back camera'));
    const res = h('select', { onchange: (e) => (st.resolution = e.target.value) },
      Object.entries(RESOLUTIONS).map(([k, r]) => h('option', { value: k, selected: k === st.resolution }, r.label)));
    const fill = async () => {
      try {
        let cams = await listCameras();
        if (cams.length && !cams[0].label.trim().length) cams = [];
        if (!cams.length || cams.every((c) => c.label === 'Camera')) {
          // Labels need one permission grant.
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          s.getTracks().forEach((t) => t.stop());
          cams = await listCameras();
        }
        for (const c of cams) {
          const tag = c.lens === 'multi' ? ' (auto-switching, avoid)' : c.lens === 'ultrawide' ? ' (ultra-wide)' : c.lens === 'tele' ? ' (telephoto, avoid)' : '';
          sel.appendChild(h('option', { value: c.deviceId, selected: c.deviceId === st.cameraId, 'data-lens': c.lens }, c.label + tag));
        }
        toast(`${cams.length} camera${cams.length === 1 ? '' : 's'} found`);
      } catch (e) {
        toast('Could not list cameras: ' + e.message);
      }
    };
    return h('div.cam-opts',
      h('label.field', h('span', 'Lens'), h('div.row', sel, h('button.btn.small', { onclick: fill }, 'Detect'))),
      h('p.small.muted', `Use the main 1× camera for best detail, or ultra-wide (${LENS_FOV.ultrawide}° view) for tight spaces. Avoid "Dual/Triple" cameras: they switch lenses on their own.`),
      h('label.field', h('span', 'Resolution'), res),
    );
  }

  async function start() {
    if (!practice && !st.room.trim()) {
      toast('Give the room or area a name');
      return;
    }
    const b = await store.findOrCreateBuilding(st.building || 'Unnamed building');
    // One fixed name per ASU building, so uploads from different phones land together.
    const asuB = practice ? null : st.buildingCode ? await campus.byCode(st.buildingCode) : await campus.matchName(st.building);
    const code = asuB && asuB.name.toLowerCase() === b.name.toLowerCase() ? asuB.code : st.buildingCode;
    if (!practice) setSettings({ lastBuilding: b.name, lastBuildingCode: code || null, lastTemplate: st.template, cameraId: st.cameraId, resolution: st.resolution });
    const capture = {
      id: store.uid(),
      buildingId: b.id,
      buildingCode: code || null,
      geo: st.geo,
      building: b.name,
      room: st.room.trim() || 'Untitled',
      floor: st.floor.trim(),
      notes: st.notes.trim(),
      template: st.template,
      engine: st.engine,
      cameraId: st.cameraId,
      lens: st.lens,
      resolution: st.resolution,
      tour: st.tour,
      author: settings.author || '',
      createdAt: Date.now(),
      status: 'recording',
      segments: 0,
      frameCount: 0,
      preflight: [...st.checks],
    };
    await store.putCapture(capture);
    store.requestPersistence();
    navigate(`#/capture/${capture.id}`);
  }

  mount(root, h('div.page', h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/'), 'aria-label': 'Back' }, icon('back')), h('h1', practice ? 'Practice' : 'New capture')), body));
  render();
  // Location already allowed: look it up without asking (keeps a building you typed).
  if (!practice && (await campus.locationAllowed())) findBuilding(true);
}
