// Settings.

import { h, mount, toast, fmtBytes, confirmDialog } from './dom.js';
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
      h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/') }, '←'), h('h1', 'Settings')),
      h('section.card',
        h('label.field', h('span', 'Your name (saved in exports)'), h('input', { value: s.author, placeholder: 'e.g. Alex R.', oninput: (e) => setSettings({ author: e.target.value }) })),
        toggle('voice', 'Voice coaching', 'Speaks the important warnings so you can watch the scene.'),
        toggle('sounds', 'Shutter tick', 'A soft click each time a photo is taken.'),
        toggle('overlayVoxels', 'Paint coverage on surfaces (AR)'),
      ),
      h('section.card',
        select('strictness', 'Coaching strictness', [['relaxed', 'Relaxed (beginners, quick scans)'], ['standard', 'Standard'], ['strict', 'Strict (archive quality, more photos)']],
          'Strict asks for slower motion and more overlap.'),
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
