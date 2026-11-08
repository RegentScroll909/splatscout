// Review screen: grade, concrete fixes, coverage map, per-photo quality, gallery and export.

import { h, mount, toast, fmtBytes, fmtDate, fmtDuration, confirmDialog, gradeClass } from './dom.js';
import { icon } from './icons.js';
import { analyzeCapture } from '../core/score.js';
import { getTemplate } from '../core/plans.js';
import { spaceOf, partsOf } from '../core/spaces.js';
import { drawTopDown, drawPanorama } from '../capture/minimap.js';
import { buildExport, exportFiles, deliver } from '../data/exporter.js';
import * as store from '../data/store.js';
import * as campus from '../data/campus.js';
import { uploadCapture, deleteUpload } from '../data/crowd.js';
import * as club from '../data/club.js';
import { getSettings, setSettings } from '../data/settings.js';
import { canUpload } from '../core/clubrules.js';

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
    if (has3d) drawTopDown(map, { voxels: a.voxels, frames: a.shown || frames, pose: null, target: null, space: a.mainSpace, capture, bounds: a.bounds });
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
            canUpload(a.grade) || uploading()
              ? h('button.btn', { onclick: () => startUpload(a) }, icon('upload'), uploading() ? 'Resume upload' : 'Upload to the club')
              : h('button.btn', { disabled: true, title: 'The club takes scans graded B or better' }, icon('upload'), 'Upload to the club'),
            capture.exportedAt ? h('span.tag', `Exported ${fmtDate(capture.exportedAt)}`) : null,
            capture.upload && capture.upload.status === 'done' ? h('span.tag.good', `Uploaded ${fmtDate(capture.upload.finished)}`) : null,
            uploading() ? h('span.tag.warn', `Upload paused · ${(capture.upload.sent || []).length} files sent`) : null,
          ),
          !canUpload(a.grade) && !uploading()
            ? h('p.small.muted', `The club takes scans graded B or better, and this one is ${a.grade}. Use Capture more to fix what’s listed above, then upload it.`)
            : null,
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
          capture.upload
            ? h('button.btn.small.danger', { onclick: removeUpload }, icon('trash'), uploading() ? 'Cancel upload' : 'Remove from club database')
            : null,
          h('button.btn.small.danger', {
            onclick: async () => {
              const msg = capture.upload
                ? 'Delete this capture and all its photos from this phone? Your upload stays in the club database (remove it first if you want it gone). This cannot be undone.'
                : 'Delete this capture and all its photos? This cannot be undone.';
              if (await confirmDialog(msg, 'Delete', true)) {
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
  /** Choose what goes into the ZIP (or the club upload) before building it. */
  function openExport(a, mode = 'zip') {
    const sel = { blurry: false, untracked: false, passes: new Set(), spaces: new Set() };
    const passes = [...new Set(frames.map((f) => f.pass))];
    const spaces = [...new Set(frames.filter((f) => f.tracked && f.pose).map((f) => spaceOf(f, capture)))];
    const partNo = new Map(partsOf(frames, capture).map((p) => [p.space, p.part]));
    const spaceName = (sp) => `Part ${partNo.get(sp) || '?'}${sp === a.mainSpace ? ' (main: sets the coordinates)' : ''}`;
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
    const go = mode === 'upload'
      ? h('button.btn.primary', { onclick: () => { const c = chosen(); back.remove(); openUpload(c); } }, icon('upload'), 'Next')
      : h('button.btn.primary', { onclick: () => { const c = chosen(); back.remove(); doExport(c, a); } }, icon('download'), 'Build ZIP');
    const back = h('div.modal-back', { onclick: (e) => e.target === back && back.remove() },
      h('div.modal.wide',
        h('h3', mode === 'upload' ? 'Upload to the club' : 'Export'),
        h('p.small.muted', mode === 'upload'
          ? 'Choose which photos to send to the club database, where SplatStation picks them up. Everything stays on the phone either way.'
          : 'Choose which photos go to SplatStation. Everything stays on the phone either way.'),
        h('h4', 'Leave out'),
        check('Blurry or rushed photos', blurryN, false, (v) => (sel.blurry = v)),
        untrackedN ? check('Photos without an AR position', untrackedN, false, (v) => (sel.untracked = v)) : null,
        passes.length > 1 ? h('h4', 'Passes') : null,
        passes.length > 1 ? passes.map((p) => check(passLabel(template, p), frames.filter((f) => f.pass === p).length, true, (v) => (v ? sel.passes.delete(p) : sel.passes.add(p)))) : null,
        spaces.length > 1 ? h('h4', 'Parts') : null,
        spaces.length > 1 ? h('p.small.muted', 'Tracking was lost (or a later session started on its own), so this scan is in parts, each with its own AR positions. SplatStation joins them from the photos where they overlap. Leave a part out only if it shows somewhere else.') : null,
        spaces.length > 1 ? spaces.map((sp) => check(spaceName(sp), frames.filter((f) => f.tracked && spaceOf(f, capture) === sp).length, true, (v) => (v ? sel.spaces.delete(sp) : sel.spaces.add(sp)))) : null,
        summary,
        h('div.row.end', h('button.btn.ghost', { onclick: () => back.remove() }, 'Cancel'), go),
      ),
    );
    document.body.appendChild(back);
    update();
  }

  // ---------------------------------------------------------------- club upload
  const uploading = () => !!(capture.upload && capture.upload.status === 'uploading');
  const practice = () => /^demo/.test(capture.engine || '');

  async function startUpload(a) {
    // The club takes scans graded B or better (the database refuses others too).
    if (!uploading() && !canUpload(a.grade)) return toast('The club takes scans graded B or better');
    // Uploads are for club members (invite code, handle, rules agreed): the database refuses anyone else.
    let me = null;
    try {
      me = await club.myProfile();
    } catch {
      me = club.cachedProfile();
    }
    if (!me) {
      toast('Join the club first: you upload as your handle');
      return navigate('#/club?join=1&back=' + encodeURIComponent('#/review/' + captureId));
    }
    if (uploading()) return doUpload(null, null);
    if (capture.upload) {
      // Uploaded before (e.g. then captured more): the new upload replaces it.
      if (!(await confirmDialog('This capture is already in the club database. Replace that upload with a new one?', 'Replace'))) return;
      try {
        await deleteUpload(capture);
      } catch (e) {
        return toast(e.message);
      }
      delete capture.upload;
      await store.putCapture(capture);
    }
    openExport(a, 'upload');
  }

  /** Where it's filed (building from the ASU list, floor, room), who took it, and consent. */
  async function openUpload(chosenFrames) {
    const asu = await campus.buildings();
    const guess = practice()
      ? null
      : (capture.buildingCode && (await campus.byCode(capture.buildingCode))) ||
        (await campus.matchName(capture.building)) ||
        (capture.geo && (await campus.near(capture.geo, 1)).map((x) => x.b)[0]) ||
        null;
    const st = { building: guess ? guess.name : '', floor: capture.floor || '', room: capture.room || '', handle: (club.cachedProfile() || {}).handle || '' };
    const size = chosenFrames.reduce((s, f) => s + (f.size || 0), 0);
    const msg = h('p.small.warn-text');
    const near = capture.geo && !practice() ? (await campus.near(capture.geo)).filter((x) => !x.b.restricted) : [];
    const bInput = h('input', { list: 'ublist', value: st.building, placeholder: 'Start typing an ASU building', oninput: (e) => (st.building = e.target.value) });
    const back = h('div.modal-back', { onclick: (e) => e.target === back && back.remove() },
      h('div.modal.wide',
        h('h3', 'Upload to the club'),
        practice()
          ? h('p.small.muted', 'Practice captures are filed under “Practice”, apart from real buildings.')
          : h('label.field', h('span', 'Building'), bInput, h('datalist#ublist', asu.filter((b) => !b.restricted).map((b) => h('option', { value: b.name })))),
        near.length
          ? h('div.chips', near.map(({ b, dist }) => h('button.btn.small', { onclick: () => { st.building = bInput.value = b.name; } }, b.name + (dist > 0 ? ` · ${Math.round(dist)} m` : ''))))
          : null,
        h('div.row.two',
          h('label.field', h('span', 'Room or section'), h('input', { value: st.room, placeholder: 'e.g. 214, Main lobby', oninput: (e) => (st.room = e.target.value) })),
          h('label.field.narrow', h('span', 'Floor'), h('input', { value: st.floor, placeholder: '2', oninput: (e) => (st.floor = e.target.value) }))),
        h('p.small', 'Uploading as ', h('b', `@${st.handle}`), '. You agreed to the club rules when you joined; no people may be in the photos.'),
        h('p.small.muted.upload-note', `${chosenFrames.length} photos · ${fmtBytes(size)}. Keep this screen open while it uploads; if it stops, press Resume upload to carry on. You can remove your upload from this phone at any time.`),
        msg,
        h('div.row.end',
          h('button.btn.ghost', { onclick: () => back.remove() }, 'Cancel'),
          h('button.btn.primary', {
            onclick: async () => {
              const b = practice() ? { code: 'practice', name: 'Practice' } : asu.find((x) => x.name.toLowerCase() === st.building.trim().toLowerCase()) || (await campus.matchName(st.building));
              if (!b) return (msg.textContent = 'Pick the building from the list, so everyone’s uploads of it end up together.');
              if (!st.room.trim()) return (msg.textContent = 'Say which room or part of the building this is.');
              if (b.restricted) return (msg.textContent = `That is ${campus.RESTRICTED_TEXT[b.restricted] || 'a restricted building'}: it isn’t open for uploads.`);
              back.remove();
              doUpload(chosenFrames.map((f) => f.id), { buildingCode: b.code, buildingName: b.name, floor: st.floor.trim(), room: st.room.trim(), contributor: st.handle });
            },
          }, icon('upload'), 'Upload'),
        ),
      ),
    );
    document.body.appendChild(back);
  }

  /** Send it (or carry on with an unfinished upload: same photos, same place). */
  async function doUpload(frameIds, tags) {
    const up = capture.upload;
    if (uploading()) {
      frameIds = frameIds || up.frameIds;
      tags = tags || up.tags;
    }
    if (!frameIds || !tags) return toast('Start the upload again from Upload');
    const bar = h('div.bar-fill.good', { style: { width: '0%' } });
    const label = h('div.small.mono', 'Preparing…');
    const stop = new AbortController();
    const pause = h('button.btn.ghost', { onclick: () => { stop.abort(); pause.disabled = true; label.textContent = 'Pausing…'; } }, 'Pause');
    const back = h('div.modal-back', h('div.modal', h('h3', 'Uploading'), h('div.bar', bar), label, h('div.row.end', pause)));
    document.body.appendChild(back);
    let lock = null;
    try {
      lock = await navigator.wakeLock.request('screen');
    } catch {}
    try {
      const ids = new Set(frameIds);
      const full = (await store.getFrames(captureId)).filter((f) => ids.has(f.id));
      if (!full.length) throw new Error('The photos chosen for this upload were deleted. Cancel it and upload again.');
      const left = frames.length - full.length;
      const { files } = await exportFiles(capture, full, { includePoses: true, selection: { total: frames.length, left: left ? { chosen: left } : {} } }, (p, l) => {
        bar.style.width = Math.round(p * 5) + '%';
        label.textContent = l;
      });
      const done = await uploadCapture(capture, files, tags, {
        save: (c) => store.putCapture(c),
        frameIds,
        signal: stop.signal,
        onProgress: (p, l) => {
          bar.style.width = Math.round(5 + p * 95) + '%';
          label.textContent = l;
        },
      });
      const where = [done.tags.buildingName, done.tags.floor && `floor ${done.tags.floor}`, done.tags.room].filter(Boolean).join(' · ');
      mount(back.firstChild,
        h('h3', 'Uploaded'),
        h('p', `Filed under ${where}.`),
        h('p.small.muted', 'The club reviews uploads in SplatStation before turning them into splats.'),
        h('div.row.end', h('button.btn.primary', { onclick: () => { back.remove(); render(); } }, 'Done')));
    } catch (e) {
      console.error(e);
      const paused = stop.signal.aborted;
      mount(back.firstChild,
        h('h3', paused ? 'Upload paused' : 'Upload stopped'),
        h('p', paused ? 'Press Resume upload to carry on where it stopped.' : e.message || String(e)),
        h('div.row.end',
          h('button.btn.ghost', { onclick: () => { back.remove(); render(); } }, 'Close'),
          uploading() ? h('button.btn.primary', { onclick: () => { back.remove(); doUpload(null, null); } }, 'Resume') : null));
    } finally {
      if (lock) lock.release().catch(() => {});
    }
  }

  async function removeUpload() {
    const ask = uploading() ? 'Cancel this upload and remove what was sent so far?' : 'Remove this capture from the club database? It stays on this phone.';
    if (!(await confirmDialog(ask, 'Remove', true))) return;
    try {
      await deleteUpload(capture);
      delete capture.upload;
      await store.putCapture(capture);
      toast('Removed from the club database');
    } catch (e) {
      toast(e.message);
    }
    render();
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
