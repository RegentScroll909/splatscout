// Settings.

import { h, mount, toast, fmtBytes, confirmDialog } from './dom.js';
import { icon } from './icons.js';
import { getSettings, setSettings } from '../data/settings.js';
import { APP_VERSION } from '../data/exporter.js';
import * as store from '../data/store.js';

export function settingsScreen(root, { navigate }) {
  const s = getSettings();
  const toggle = (key, label, hint) =>
    h('label.toggle-row',
      h('div', h('div', label), hint ? h('div.small.muted', hint) : null),
      h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => setSettings({ [key]: e.target.checked }) }));
  const select = (key, label, options, hint, parse = (v) => v) =>
    h('label.field', h('span', label),
      h('select', { onchange: (e) => setSettings({ [key]: parse(e.target.value) }) }, options.map(([v, t]) => h('option', { value: v, selected: String(s[key]) === v }, t))),
      hint ? h('div.small.muted', hint) : null);
  const storage = h('div.small.muted', '…');
  store.storageEstimate().then((e) => (storage.textContent = e ? `${fmtBytes(e.usage)} used of ${fmtBytes(e.quota)} available to this app` : 'Unknown'));

  mount(
    root,
    h('div.page',
      h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/'), 'aria-label': 'Back' }, icon('back')), h('h1', 'Settings')),
      h('section.card',
        h('label.field', h('span', 'Your name (saved in exports)'), h('input', { value: s.author, placeholder: 'e.g. Alex R.', oninput: (e) => setSettings({ author: e.target.value }) })),
        toggle('voice', 'Voice coaching', 'Speaks the important warnings so you can watch the scene.'),
        toggle('sounds', 'Shutter tick', 'A soft click each time a photo is taken.'),
        toggle('overlayVoxels', 'Paint coverage on surfaces (AR)'),
        toggle('guide', 'Guided capture (AR)', 'Mark the scan area at the start, then follow the path on the floor and the arrow in the middle of the screen.'),
        toggle('autoAdvance', 'Next pass automatically', 'Move on to the next pass when its path is done.'),
      ),
      h('section.card',
        h('label.field', h('span', 'SplatStation address (the processing app on your PC)'),
          h('input', { value: s.stationUrl, placeholder: 'http://192.168.1.20:8787', inputmode: 'url',
            oninput: (e) => setSettings({ stationUrl: e.target.value.trim().replace(/\/+$/, '') }) })),
        h('div.small.muted', 'Shown on the SplatStation dashboard ("From a phone on the same Wi-Fi"). Adds a SplatStation button after exporting. With the phone plugged in over USB, SplatStation lists your exports and you choose which ones to import and process.'),
      ),
      h('section.card',
        select('strictness', 'Photo pace', [['relaxed', 'Relaxed (fastest, accepts a little blur)'], ['standard', 'Balanced (default)'], ['strict', 'Strict (archive quality, slower, more photos)']],
          'How picky the app is about sharpness and overlap. All modes take photos while you walk.'),
        select('engine', 'Default capture mode', [['auto', 'AR when available'], ['camera', 'Camera only']]),
        select('jpegQuality', 'Photo quality', [['0.95', 'Maximum (larger files)'], ['0.92', 'High (default)'], ['0.85', 'Compact']], null, parseFloat),
      ),
      h('section.card',
        h('h2', 'Advanced'),
        toggle('arFlipY', 'AR frame orientation fix', 'Leave on. Turn it off only if photos captured in AR mode come out upside down.'),
        toggle('showDebug', 'Show live debug numbers', 'Raw sharpness, brightness, speed and depth values on the capture screen.'),
      ),
      h('section.card',
        h('h2', 'Storage'),
        storage,
        h('p.small.muted', 'Photos stay on this phone until you delete them. Export captures before clearing data.'),
        h('button.btn.danger.small', {
          onclick: async () => {
            if (await confirmDialog('Delete ALL captures and photos stored in SplatScout on this device?', 'Delete everything', true)) {
              await store.clearAll();
              toast('All data deleted');
              navigate('#/');
            }
          },
        }, 'Delete all data'),
      ),
      h('p.small.muted.center', `SplatScout ${APP_VERSION}`),
    ),
  );
}
