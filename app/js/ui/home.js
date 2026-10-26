// Home: device readiness, start a capture, and all captures grouped by building.

import { h, mount, fmtDate, fmtBytes, gradeClass } from './dom.js';
import { icon, templateIcon } from './icons.js';
import { xrSupport } from '../sources/xrSource.js';
import { modeLabel } from './review.js';
import * as store from '../data/store.js';

export async function homeScreen(root, { navigate }) {
  const status = h('div.status-line', h('span.status-dot.pending'), h('span.mono', 'Checking device…'));
  const storage = h('span.mono.muted.small');
  const list = h('div.cap-list');
  mount(
    root,
    h(
      'div.page.home',
      h('header.brand',
        h('img.brand-logo', { src: 'icons/icon.svg', alt: '' }),
        h('div.brand-text', h('h1', 'SplatScout'), h('div.brand-sub', 'Capture interiors for Gaussian splats')),
        h('button.icon-btn', { onclick: () => navigate('#/settings'), 'aria-label': 'Settings' }, icon('settings')),
      ),
      status,
      h('button.btn.primary.big.block', { onclick: () => navigate('#/new') }, icon('plus'), 'New capture'),
      h('div.row.two',
        h('button.btn.block', { onclick: () => navigate('#/new?practice=1') }, icon('cube'), 'Practice room'),
        h('button.btn.block', { onclick: () => navigate('#/learn') }, icon('book'), 'Capture guide'),
      ),
      list,
      h('footer.foot', storage),
    ),
  );

  xrSupport().then((s) => {
    mount(status,
      h('span.status-dot.' + (s.ok ? 'ok' : 'warn')),
      h('span.mono', s.ok ? 'AR READY' : 'CAMERA MODE'),
      h('span.muted.small', s.ok ? 'Tracks 3D position and paints scanned surfaces live' : `${s.reason} Coverage comes from the motion sensors.`));
  });

  store.storageEstimate().then((e) => {
    if (e) storage.textContent = `${fmtBytes(e.usage)} used · ${fmtBytes(e.quota)} available`;
  });

  const [buildings, captures] = await Promise.all([store.listBuildings(), store.listCaptures()]);
  if (!captures.length) {
    mount(list, h('div.empty', icon('layers', 'big'), h('p', 'No captures yet.'), h('p.small.muted', 'New here? The Practice room is a virtual classroom that shows how the guide and coaching work.')));
    return;
  }
  const byB = new Map();
  for (const c of captures.sort((a, b) => b.createdAt - a.createdAt)) {
    if (!byB.has(c.buildingId)) byB.set(c.buildingId, []);
    byB.get(c.buildingId).push(c);
  }
  const bname = (id) => (buildings.find((b) => b.id === id) || {}).name || 'Unknown building';
  mount(
    list,
    [...byB.entries()].map(([bid, caps]) =>
      h('section.group',
        h('div.group-title', h('span', bname(bid)), h('span.mono.muted', String(caps.length).padStart(2, '0'))),
        caps.map((c) =>
          h('button.cap-row', { onclick: () => navigate(`#/review/${c.id}`) },
            h('div.grade.small.' + gradeClass(c.score && c.score.grade), (c.score && c.score.grade) || '–'),
            h('div.cap-row-body',
              h('div.cap-row-title', templateIcon(c.template, 'dim'), h('span', `${c.room || 'Untitled'}${c.floor ? ` · floor ${c.floor}` : ''}`)),
              h('div.cap-row-meta', `${fmtDate(c.createdAt)} · ${c.frameCount || 0} photos · ${modeLabel(c)}`),
            ),
            exportTag(c),
            icon('chevron', 'dim'),
          ),
        ),
      ),
    ),
  );
}

/** Whether the latest photos have been exported for SplatStation. */
function exportTag(c) {
  if (!c.exportedAt) return h('span.tag', 'Not exported');
  const stale = c.exportedFrames != null && c.frameCount > c.exportedFrames;
  return h('span.tag.' + (stale ? 'warn' : 'good'), stale ? 'New photos' : 'Exported');
}
