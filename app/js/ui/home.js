// Home: device readiness, start a capture, and all captures grouped by building.

import { h, mount, fmtDate, fmtBytes, gradeClass } from './dom.js';
import { xrSupport } from '../sources/xrSource.js';
import { getTemplate } from '../core/plans.js';
import { modeLabel } from './review.js';
import * as store from '../data/store.js';

export async function homeScreen(root, { navigate }) {
  const status = h('div.status-card', h('div.status-dot.pending'), h('div', h('b', 'Checking this device…')));
  const list = h('div');
  mount(
    root,
    h(
      'div.page',
      h('header.brand', h('img.brand-logo', { src: 'icons/icon.svg', alt: '' }), h('div', h('h1', 'SplatScout'), h('div.muted', 'AR capture coach for Gaussian splats'))),
      status,
      h('button.btn.primary.big.block', { onclick: () => navigate('#/new') }, '＋ New capture'),
      h('div.row.two',
        h('button.btn.block', { onclick: () => navigate('#/new?practice=1') }, '🎮 Practice room'),
        h('button.btn.block', { onclick: () => navigate('#/learn') }, '📘 Capture guide'),
      ),
      list,
      h('footer.foot', h('button.link', { onclick: () => navigate('#/settings') }, '⚙ Settings'), h('span.muted.small#storage')),
    ),
  );

  xrSupport().then((s) => {
    if (s.ok) {
      mount(status, h('div.status-dot.ok'), h('div', h('b', 'AR tracking ready'), h('div.small.muted', 'Captures record 3D camera positions and paint scanned surfaces live.')));
    } else {
      mount(status, h('div.status-dot.warn'), h('div', h('b', 'Camera mode'), h('div.small.muted', `${s.reason} Coverage is tracked from the motion sensors instead.`)));
    }
  });

  store.storageEstimate().then((e) => {
    const el = document.getElementById('storage');
    if (e && el) el.textContent = `${fmtBytes(e.usage)} used of ${fmtBytes(e.quota)}`;
  });

  const [buildings, captures] = await Promise.all([store.listBuildings(), store.listCaptures()]);
  if (!captures.length) {
    mount(list, h('div.empty', h('p', 'No captures yet.'), h('p.small.muted', 'New here? Try the Practice room first. It\'s a virtual classroom that shows how the coaching works.')));
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
        h('h2.group-title', bname(bid), h('span.muted.small', ` · ${caps.length} capture${caps.length === 1 ? '' : 's'}`)),
        caps.map((c) =>
          h('button.cap-card', { onclick: () => navigate(`#/review/${c.id}`) },
            h('div.grade.small.' + gradeClass(c.score && c.score.grade), (c.score && c.score.grade) || '–'),
            h('div.cap-card-body',
              h('div.cap-card-title', `${getTemplate(c.template).icon} ${c.room || 'Untitled'}${c.floor ? ` · floor ${c.floor}` : ''}`),
              h('div.small.muted', `${fmtDate(c.createdAt)} · ${c.frameCount || 0} photos · ${modeLabel(c)}${c.exportedAt ? ' · exported' : ''}`),
            ),
            h('span.chev', '›'),
          ),
        ),
      ),
    ),
  );
}
