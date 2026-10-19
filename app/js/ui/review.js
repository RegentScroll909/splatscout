// Review screen: grade, concrete fixes, coverage map, per-photo quality, gallery and export.

import { h, mount, toast, fmtBytes, fmtDate, fmtDuration, confirmDialog, gradeClass } from './dom.js';
import { analyzeCapture } from '../core/score.js';
import { getTemplate } from '../core/plans.js';
import { drawTopDown, drawPanorama } from '../capture/minimap.js';
import { buildExport, deliver } from '../data/exporter.js';
import * as store from '../data/store.js';

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

    const map = h('canvas.review-map', { width: 640, height: capture.tracking === '6dof' && a.vstats.solid > 50 ? 640 : 320 });
    if (capture.tracking === '6dof' && a.vstats.solid > 50) {
      drawTopDown(map, { voxels: a.voxels, frames, pose: null, target: null, segment: null });
    } else {
      drawPanorama(map, { sphere: a.sphere, pose: null });
    }
    const totalSize = frames.reduce((s, f) => s + (f.size || 0), 0);
    const flagged = frames.filter((f) => f.flags && f.flags.length);
    const blurry = frames.filter((f) => f.flags && (f.flags.includes('blurry') || f.flags.includes('rushed')));
    const shown = filter === 'all' ? frames : filter === 'flagged' ? flagged : blurry;

    mount(
      root,
      h(
        'div.page',
        h('header.page-head', h('button.icon-btn', { onclick: () => navigate('#/') }, '←'), h('div', h('div.kicker', capture.building), h('h1', capture.room || 'Capture'))),
        h('div.meta-line', `${template.icon} ${template.name} · ${modeLabel(capture)} · ${fmtDate(capture.createdAt)} · ${frames.length} photos · ${fmtBytes(totalSize)}` +
          (capture.stats ? ` · ${fmtDuration(capture.stats.activeSec || 0)} active` : '')),

        h('section.card.grade-card',
          h('div.grade-row', h('div.grade.' + gradeClass(a.grade), a.grade), h('div', h('div.score', `${a.score}/100`), h('div.verdict', a.verdict))),
          h('ul.fixes', a.fixes.map((f) => h('li.' + f.level, f.text))),
          h('div.row',
            h('button.btn.primary', { onclick: () => navigate(`#/capture/${captureId}`) }, '+ Capture more'),
            h('button.btn', { onclick: () => doExport() }, '⬇ Export ZIP'),
          ),
        ),

        h('section.card',
          h('h2', 'Coverage'),
          map,
          capture.tracking === '6dof' && a.vstats.solid > 50
            ? h('p.small.muted', `Floor plan of scanned surfaces. ${pct(a.vstats.q3, a.vstats.solid)} seen from 3+ angles, ${pct(a.vstats.q2, a.vstats.solid)} from 2, ${pct(a.vstats.q1 + a.vstats.q0, a.vstats.solid)} from 0–1.` +
                (a.area ? ` Approx. ${Math.round(a.area)} m² mapped.` : ''))
            : h('p.small.muted', 'Every view direction around you, from ceiling (top) to floor (bottom). Green = captured from 2+ spots.'),
        ),

        h('section.card',
          h('h2', 'Score breakdown'),
          a.parts.map((p) => h('div.part', h('div.part-head', h('span', p.label), h('span.muted', Math.round(p.value * 100) + '%')),
            h('div.bar', h('div.bar-fill.' + (p.value >= 0.8 ? 'good' : p.value >= 0.55 ? 'warn' : 'bad'), { style: { width: Math.round(p.value * 100) + '%' } })),
            h('div.small.muted', p.detail))),
        ),

        h('section.card',
          h('h2', 'Sharpness over time'),
          timeline(frames),
          h('p.small.muted', 'Each bar is one photo. Taller is sharper. Orange and red bars are flagged.'),
        ),

        h('section.card',
          h('div.row.space',
            h('h2', 'Photos'),
            blurry.length
              ? h('button.btn.small.danger', { onclick: () => removeFrames(blurry, `Delete ${blurry.length} blurry or rushed photo${blurry.length === 1 ? '' : 's'}?`) }, `Remove blurry (${blurry.length})`)
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

        h('section.card.danger-zone',
          h('button.btn.danger.small', {
            onclick: async () => {
              if (await confirmDialog('Delete this capture and all its photos? This cannot be undone.', 'Delete', true)) {
                await store.deleteCapture(captureId);
                navigate('#/');
              }
            },
          }, 'Delete capture'),
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
        h('div', h('b', `#${f.seq}`), ` · ${f.intr ? `${f.intr.w}×${f.intr.h}` : ''} · ${fmtBytes(f.size || 0)} · pass "${f.pass}"`),
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
        h('button.icon-btn', { onclick: close }, '✕'),
        h('div.row',
          h('button.icon-btn', { onclick: () => step(-1) }, '‹'),
          h('button.icon-btn', { onclick: () => step(1) }, '›'),
          h('button.btn.small.danger', { onclick: async () => { const f = frames[idx]; close(); await removeFrames([f], 'Delete this photo?'); } }, 'Delete'),
        ),
      ),
      img,
      info,
    );
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    show();
  }

  async function doExport() {
    const bar = h('div.bar-fill.good', { style: { width: '0%' } });
    const label = h('div.small', 'Preparing…');
    const back = h('div.modal-back', h('div.modal', h('h3', 'Exporting'), h('div.bar', bar), label));
    document.body.appendChild(back);
    try {
      const full = await store.getFrames(captureId);
      const { blob, filename } = await buildExport(capture, full, { includePoses: true }, (p, l) => {
        bar.style.width = Math.round(p * 100) + '%';
        label.textContent = l;
      });
      mount(back.firstChild,
        h('h3', 'Export ready'),
        h('p', `${filename} · ${fmtBytes(blob.size)}`),
        h('p.small.muted', 'Copy the ZIP to your PC (USB, Quick Share or cloud drive), unzip it, and point your splat pipeline at the images/ folder. AR poses and depth points are in poses/ if your pipeline can use them.'),
        h('div.row.end',
          h('button.btn.ghost', { onclick: () => back.remove() }, 'Close'),
          h('button.btn.primary', {
            onclick: async () => {
              const r = await deliver(blob, filename);
              if (r !== 'cancelled') {
                capture.exportedAt = Date.now();
                await store.putCapture(capture);
                toast(r === 'shared' ? 'Shared' : 'Download started, check your Downloads folder');
              }
            },
          }, 'Save ZIP'),
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

function timeline(frames) {
  const c = h('canvas.timeline', { width: 1000, height: 140 });
  const ctx = c.getContext('2d');
  const n = frames.length;
  if (!n) return c;
  const w = 1000 / n;
  frames.forEach((f, i) => {
    const s = Math.min(1, (f.m && f.m.relSharp) || 0);
    const bad = f.flags && (f.flags.includes('blurry') || f.flags.includes('rushed'));
    const warn = f.flags && f.flags.length && !bad;
    ctx.fillStyle = bad ? '#ff4d4d' : warn ? '#ffbd2e' : '#3ddc84';
    const bh = Math.max(3, s * 130);
    ctx.fillRect(i * w, 140 - bh, Math.max(1, w - (w > 3 ? 1 : 0)), bh);
  });
  return c;
}

function pct(a, b) {
  return b ? Math.round((a / b) * 100) + '%' : '0%';
}

export function modeLabel(c) {
  return { xr: 'AR tracked', camera: 'Camera mode', demo6: 'Practice (AR sim)', demo3: 'Practice (camera sim)' }[c.engine] || c.engine;
}
