// Review screen: grade, concrete fixes, coverage map, per-photo quality, gallery and export.

import { h, mount, toast, fmtBytes, fmtDate, fmtDuration, confirmDialog, gradeClass } from './dom.js';
import { icon } from './icons.js';
import { analyzeCapture } from '../core/score.js';
import { getTemplate } from '../core/plans.js';
import { spaceOf } from '../core/spaces.js';
import { drawTopDown, drawPanorama } from '../capture/minimap.js';
import { buildExport, deliver } from '../data/exporter.js';
import * as store from '../data/store.js';
import { getSettings } from '../data/settings.js';

const FLAG_LABEL = {
  blurry: 'blurry', rushed: 'rushed', dark: 'dark', highlights: 'glare', lowtex: 'blank', untracked: 'no pose', rotonly: 'turned only',
};

export async function reviewScreen(root, { captureId, navigate }) {
  const capture = await store.getCapture(captureId);
  if (!capture) return navigate('#/');
  let frames = await store.getFrames(captureId);
  const template = getTemplate(capture.template);
  const urls = new Map();
  let filter = 'all';

  const thumbUrl = (f) => {
    if (!urls.has(f.id)) urls.set(f.id, URL.createObjectURL(f.thumb || f.jpeg));
    return urls.get(f.id);
  };

  async function render() {
    const a = analyzeCapture(frames, capture);
    capture.score = { score: a.score, grade: a.grade };
    capture.frameCount = frames.length;
    store.putCapture(capture);

    const has3d = capture.tracking === '6dof' && a.vstats.solid > 50;
    const map = h('canvas.review-map', { width: 640, height: has3d ? 640 : 320 });
    if (has3d) drawTopDown(map, { voxels: a.voxels, frames, pose: null, target: null, space: a.mainSpace, capture, bounds: a.bounds });
    else drawPanorama(map, { sphere: a.sphere, pose: null });
    const totalSize = frames.reduce((s, f) => s + (f.size || 0), 0);
    const flagged = frames.filter((f) => f.flags && f.flags.length);
    const blurry = frames.filter(isBlurry);
    const shown = filter === 'all' ? frames : filter === 'flagged' ? flagged : blurry;

    mount(
      root,
      h(
        'div.page',
        h('header.page-head',
          h('button.icon-btn', { onclick: () => navigate('#/'), 'aria-label': 'Back' }, icon('back')),
          h('div.head-text', h('div.kicker', capture.building || 'Capture'), h('h1', capture.room || 'Capture'))),
        h('div.meta-grid',
          meta('Plan', template.name),
          meta('Mode', modeLabel(capture)),
          meta('Photos', String(frames.length)),
          meta('Size', fmtBytes(totalSize)),
          meta('Active', capture.stats ? fmtDuration(capture.stats.activeSec || 0) : '–'),
          meta('Captured', fmtDate(capture.createdAt)),
        ),

        h('section.card.grade-card',
          h('div.grade-row',
            h('div.grade.' + gradeClass(a.grade), a.grade),
            h('div', h('div.score', `${a.score}`, h('span.score-of', '/100')), h('div.verdict', a.verdict))),
          h('ul.fixes', a.fixes.map((f) => h('li.' + f.level, f.text))),
          h('div.row',
            h('button.btn.primary', { onclick: () => navigate(`#/capture/${captureId}`) }, icon('camera'), 'Capture more'),
            h('button.btn', { onclick: () => openExport(a) }, icon('download'), 'Export'),
            capture.exportedAt ? h('span.tag', `Exported ${fmtDate(capture.exportedAt)}`) : null,
          ),
        ),

        h('section.card',
          h('div.card-head', h('h2', 'Coverage'), has3d && a.area ? h('span.mono.muted', `${Math.round(a.area)} m²`) : null),
          map,
          has3d
            ? h('div.legend-row',
                legend('q3', `3+ angles ${pct(a.vstats.q3, a.vstats.solid)}`),
                legend('q2', `2 angles ${pct(a.vstats.q2, a.vstats.solid)}`),
                legend('q1', `0–1 ${pct(a.vstats.q1 + a.vstats.q0, a.vstats.solid)}`))
            : h('p.small.muted', 'Every view direction around you, from ceiling (top) to floor (bottom). Green = captured from 2+ spots.'),
        ),

        h('section.card',
          h('h2', 'Score breakdown'),
          a.parts.map((p) => h('div.part',
            h('div.part-head', h('span', p.label), h('span.mono', Math.round(p.value * 100) + '%')),
            h('div.bar', h('div.bar-fill.' + (p.value >= 0.8 ? 'good' : p.value >= 0.55 ? 'warn' : 'bad'), { style: { width: Math.round(p.value * 100) + '%' } })),
            h('div.small.muted', p.detail))),
        ),

        h('section.card',
          h('h2', 'Sharpness over time'),
          timeline(frames),
          h('p.small.muted', 'One bar per photo. Taller is sharper; amber and red bars are flagged.'),
        ),

        h('section.card',
          h('div.card-head',
            h('h2', 'Photos'),
            blurry.length
              ? h('button.btn.small.danger', { onclick: () => removeFrames(blurry, `Delete ${blurry.length} blurry or rushed photo${blurry.length === 1 ? '' : 's'}?`) }, icon('trash'), `Blurry (${blurry.length})`)
              : null,
          ),
          h('div.seg',
            segBtn('all', `All ${frames.length}`),
            segBtn('flagged', `Flagged ${flagged.length}`),
            segBtn('blurry', `Blurry ${blurry.length}`),
          ),
          shown.length
            ? h('div.gallery', shown.map((f) => h('button.thumb', { onclick: () => openViewer(f) },
                h('img', { src: thumbUrl(f), loading: 'lazy', alt: `Photo ${f.seq}` }),
                f.flags && f.flags.length ? h('span.thumb-flag', FLAG_LABEL[f.flags[0]] || f.flags[0]) : null)))
            : h('p.muted', 'Nothing here.'),
        ),

        h('section.danger-zone',
          h('button.btn.small.danger', {
            onclick: async () => {
              if (await confirmDialog('Delete this capture and all its photos? This cannot be undone.', 'Delete', true)) {
                await store.deleteCapture(captureId);
                navigate('#/');
              }
            },
          }, icon('trash'), 'Delete capture'),
        ),
      ),
    );
  }

  function segBtn(id, label) {
    return h('button.seg-btn' + (filter === id ? '.active' : ''), { onclick: () => { filter = id; render(); } }, label);
  }

  async function removeFrames(list, msg) {
    if (!(await confirmDialog(msg, 'Delete', true))) return;
    for (const f of list) {
      await store.deleteFrame(f.id);
      if (urls.has(f.id)) URL.revokeObjectURL(urls.get(f.id));
      urls.delete(f.id);
    }
    const ids = new Set(list.map((f) => f.id));
    frames = frames.filter((f) => !ids.has(f.id));
    toast(`Deleted ${list.length} photo${list.length === 1 ? '' : 's'}`);
    render();
  }

  function openViewer(f0) {
    let idx = frames.indexOf(f0);
    let url = null;
    const img = h('img.viewer-img', { alt: '' });
    const info = h('div.viewer-info');
    const show = () => {
      const f = frames[idx];
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(f.jpeg);
      img.src = url;
      const m = f.m || {};
      mount(info,
        h('div.mono', `#${f.seq} · ${f.intr ? `${f.intr.w}×${f.intr.h}` : ''} · ${fmtBytes(f.size || 0)} · ${f.pass}`),
        h('div.small', `Sharpness ${Math.round((m.relSharp || 0) * 100)}% · brightness ${Math.round(m.mean || 0)} · glare ${((m.clipHi || 0) * 100).toFixed(1)}% · detail ${(m.texture || 0).toFixed(3)}`),
        h('div.small', `Turning ${Math.round(m.rotSpeed || 0)}°/s` + (m.linSpeed != null ? ` · moving ${m.linSpeed.toFixed(2)} m/s` : '') + (f.baseline != null ? ` · ${(f.baseline * 100).toFixed(0)} cm from previous` : '')),
        f.flags && f.flags.length ? h('div.small.warn-text', 'Flags: ' + f.flags.map((x) => FLAG_LABEL[x] || x).join(', ')) : null,
      );
    };
    const close = () => {
      if (url) URL.revokeObjectURL(url);
      back.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    };
    const step = (d) => {
      idx = Math.max(0, Math.min(frames.length - 1, idx + d));
      show();
    };
    const back = h('div.viewer',
      h('div.viewer-top',
        h('button.icon-btn', { onclick: close, 'aria-label': 'Close' }, icon('close')),
        h('div.row.tight',
          h('button.icon-btn', { onclick: () => step(-1), 'aria-label': 'Previous' }, icon('chevronLeft')),
          h('button.icon-btn', { onclick: () => step(1), 'aria-label': 'Next' }, icon('chevron')),
          h('button.btn.small.danger', { onclick: async () => { const f = frames[idx]; close(); await removeFrames([f], 'Delete this photo?'); } }, icon('trash'), 'Delete'),
        ),
      ),
      img,
      info,
    );
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    show();
  }

  // ---------------------------------------------------------------- export
  /** Choose what goes into the ZIP before building it. */
  function openExport(a) {
    const sel = { blurry: false, untracked: false, passes: new Set(), spaces: new Set() };
    const passes = [...new Set(frames.map((f) => f.pass))];
    const spaces = [...new Set(frames.filter((f) => f.tracked && f.pose).map((f) => spaceOf(f, capture)))];
    const spaceName = (sp) => {
      const segs = new Set(frames.filter((f) => f.tracked && spaceOf(f, capture) === sp).map((f) => f.segment));
      return `${sp === a.mainSpace ? 'Main map' : 'Other map'} · ${segs.size} session${segs.size === 1 ? '' : 's'}`;
    };
    const chosen = () =>
      frames.filter((f) =>
        !(sel.blurry && isBlurry(f)) &&
        !(sel.untracked && capture.tracking === '6dof' && !f.tracked) &&
        !sel.passes.has(f.pass) &&
        !(f.tracked && f.pose && sel.spaces.has(spaceOf(f, capture))));
    const summary = h('div.export-summary');
    const update = () => {
      const c = chosen();
      const size = c.reduce((s, f) => s + (f.size || 0), 0);
      mount(summary, h('span.mono', `${c.length}`), ` of ${frames.length} photos · ${fmtBytes(size)}`);
      go.disabled = c.length < 10;
    };
    const check = (label, count, on, onchange) =>
      h('label.check-row',
        h('input', { type: 'checkbox', checked: on, onchange: (e) => { onchange(e.target.checked); update(); } }),
        h('span.check-label', label),
        count != null ? h('span.mono.muted', String(count)) : null);
    const blurryN = frames.filter(isBlurry).length;
    const untrackedN = capture.tracking === '6dof' ? frames.filter((f) => !f.tracked).length : 0;
    const go = h('button.btn.primary', { onclick: () => { const c = chosen(); back.remove(); doExport(c, a); } }, icon('download'), 'Build ZIP');
    const back = h('div.modal-back', { onclick: (e) => e.target === back && back.remove() },
      h('div.modal.wide',
        h('h3', 'Export'),
        h('p.small.muted', 'Choose which photos go to SplatStation. Everything stays on the phone either way.'),
        h('h4', 'Leave out'),
        check('Blurry or rushed photos', blurryN, false, (v) => (sel.blurry = v)),
        untrackedN ? check('Photos without an AR position', untrackedN, false, (v) => (sel.untracked = v)) : null,
        passes.length > 1 ? h('h4', 'Passes') : null,
        passes.length > 1 ? passes.map((p) => check(passLabel(template, p), frames.filter((f) => f.pass === p).length, true, (v) => (v ? sel.passes.delete(p) : sel.passes.add(p)))) : null,
        spaces.length > 1 ? h('h4', 'AR maps') : null,
        spaces.length > 1 ? h('p.small.muted', 'Sessions that were lined up share a map. Only the main map gets AR positions; photos from other maps still help the camera solve.') : null,
        spaces.length > 1 ? spaces.map((sp) => check(spaceName(sp), frames.filter((f) => f.tracked && spaceOf(f, capture) === sp).length, true, (v) => (v ? sel.spaces.delete(sp) : sel.spaces.add(sp)))) : null,
        summary,
        h('div.row.end', h('button.btn.ghost', { onclick: () => back.remove() }, 'Cancel'), go),
      ),
    );
    document.body.appendChild(back);
    update();
  }

  async function doExport(chosenFrames, a) {
    const bar = h('div.bar-fill.good', { style: { width: '0%' } });
    const label = h('div.small.mono', 'Preparing…');
    const back = h('div.modal-back', h('div.modal', h('h3', 'Building ZIP'), h('div.bar', bar), label));
    document.body.appendChild(back);
    try {
      const ids = new Set(chosenFrames.map((f) => f.id));
      const full = (await store.getFrames(captureId)).filter((f) => ids.has(f.id));
      const left = {};
      const n = frames.length - full.length;
      if (n) left.chosen = n;
      const { blob, filename } = await buildExport(capture, full, { includePoses: true, selection: { total: frames.length, left } }, (p, l) => {
        bar.style.width = Math.round(p * 100) + '%';
        label.textContent = l;
      });
      const stationUrl = getSettings().stationUrl;
      mount(back.firstChild,
        h('h3', 'ZIP ready'),
        h('p.mono', `${filename} · ${fmtBytes(blob.size)} · ${full.length} photos`),
        h('p.small.muted', 'Save it, then bring it to SplatStation on your PC: plug the phone in over USB and pick it in the Phone list, upload it from the SplatStation page, or copy it into the station\'s inbox folder. Nothing is processed until you start it there.'),
        h('div.row.end',
          h('button.btn.ghost', { onclick: () => back.remove() }, 'Close'),
          stationUrl ? h('a.btn', { href: stationUrl, target: '_blank', rel: 'noopener' }, icon('external'), 'SplatStation') : null,
          h('button.btn.primary', {
            onclick: async () => {
              const r = await deliver(blob, filename);
              if (r !== 'cancelled') {
                capture.exportedAt = Date.now();
                capture.exportedFrames = frames.length; // photos at export time (to spot new ones later)
                await store.putCapture(capture);
                toast(r === 'shared' ? 'Shared' : 'Download started, check your Downloads folder');
                back.remove();
                render();
              }
            },
          }, icon('download'), 'Save ZIP'),
        ),
      );
    } catch (e) {
      console.error(e);
      mount(back.firstChild, h('h3', 'Export failed'), h('p', e.message || String(e)), h('button.btn', { onclick: () => back.remove() }, 'Close'));
    }
  }

  await render();
  return () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
  };
}

function isBlurry(f) {
  return !!(f.flags && (f.flags.includes('blurry') || f.flags.includes('rushed')));
}

function passLabel(template, id) {
  const p = template.passes.find((x) => x.id === id);
  return p ? p.name : id || 'Other';
}

function meta(label, value) {
  return h('div.meta', h('div.meta-lbl', label), h('div.meta-val', value));
}

function legend(cls, label) {
  return h('span.legend-item', h('span.legend-dot.' + cls), label);
}

function timeline(frames) {
  const c = h('canvas.timeline', { width: 1000, height: 140 });
  const ctx = c.getContext('2d');
  const n = frames.length;
  if (!n) return c;
  const w = 1000 / n;
  frames.forEach((f, i) => {
    const s = Math.min(1, (f.m && f.m.relSharp) || 0);
    const bad = isBlurry(f);
    const warn = f.flags && f.flags.length && !bad;
    ctx.fillStyle = bad ? '#f26d6d' : warn ? '#f5b942' : '#3ddcff';
    const bh = Math.max(3, s * 130);
    ctx.fillRect(i * w, 140 - bh, Math.max(1, w - (w > 3 ? 1 : 0)), bh);
  });
  return c;
}

function pct(a, b) {
  return b ? Math.round((a / b) * 100) + '%' : '0%';
}

export function modeLabel(c) {
  return { xr: 'AR tracked', camera: 'Camera', demo6: 'Practice · AR', demo3: 'Practice · camera' }[c.engine] || c.engine;
}
