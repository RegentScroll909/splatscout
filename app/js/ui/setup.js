// New capture setup: where, what kind of space, which capture mode, and a pre-flight checklist.

import { h, mount, toast } from './dom.js';
import { TEMPLATES, PREFLIGHT, getTemplate } from '../core/plans.js';
import { xrSupport } from '../sources/xrSource.js';
import { listCameras, RESOLUTIONS, LENS_FOV } from '../sources/cameraSource.js';
import * as store from '../data/store.js';
import { getSettings, setSettings } from '../data/settings.js';

export async function setupScreen(root, { navigate, query }) {
  const settings = getSettings();
  const practice = query.get('practice') === '1';
  const buildings = await store.listBuildings();
  const xr = await xrSupport();

  const st = {
    building: practice ? 'Practice' : settings.lastBuilding || '',
    room: practice ? 'Demo classroom' : '',
    floor: '',
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
              h('input', { list: 'blist', value: st.building, placeholder: 'e.g. Hayden Library', oninput: (e) => (st.building = e.target.value) }),
              h('datalist#blist', buildings.map((b) => h('option', { value: b.name })))),
            h('div.row.two',
              h('label.field', h('span', 'Room / area'), h('input', { value: st.room, placeholder: 'e.g. Room 214, Main lobby', oninput: (e) => (st.room = e.target.value) })),
              h('label.field.narrow', h('span', 'Floor'), h('input', { value: st.floor, placeholder: '2', oninput: (e) => (st.floor = e.target.value) })),
            ),
          ),

      h('section.card',
        h('h2', 'Type of space'),
        h('div.tpl-grid', TEMPLATES.map((t) => h('button.tpl' + (t.id === st.template ? '.active' : ''), { onclick: () => { st.template = t.id; render(); } },
          h('span.tpl-icon', t.icon), h('span', t.name)))),
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

      h('button.btn.primary.big.block', { onclick: start }, practice ? 'Open practice room' : 'Continue to capture →'),
    );
    updateCount();
  };

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
    if (!practice) setSettings({ lastBuilding: b.name, lastTemplate: st.template, cameraId: st.cameraId, resolution: st.resolution });
    const capture = {
      id: store.uid(),
      buildingId: b.id,
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

  mount(root, h('div.page', h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/') }, '←'), h('h1', practice ? 'Practice' : 'New capture')), body));
  render();
}
