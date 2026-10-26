// SplatStation dashboard.

const $ = (s) => document.querySelector(s);
const STAGES = [
  ['import', 'Import'], ['features', 'Features'], ['matching', 'Matching'], ['mapping', 'Camera solve'],
  ['undistort', 'Undistort'], ['train', 'Train splat'], ['finish', 'Finish'],
];
const WEIGHTS = { import: 4, features: 6, matching: 10, mapping: 10, undistort: 2, train: 66, finish: 2 };
let status = {};
const jobs = new Map();

function h(tag, attrs, ...kids) {
  // Attributes are optional: a string, node or array in that position is a child.
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) kids.unshift(attrs);
    attrs = {};
  }
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const api = (path, body) =>
  fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const fmtTime = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);
const fmtMB = (b) => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';

// ------------------------------------------------------------------ status & settings
async function loadStatus() {
  status = await api('/api/status');
  const sel = $('#preset');
  sel.replaceChildren(...Object.entries(status.presets).map(([k, p]) => h('option', { value: k, selected: k === status.preset }, p.label)));
  $('#usePoses').checked = status.usePoses;
  $('#cropToBounds').checked = status.cropToBounds;
  $('#adb').checked = status.adbAutoImport;
  renderPhone();
  const t = status.tools;
  $('#paths').replaceChildren(...[
    h('div', {}, 'Inbox folder: ', h('code', {}, status.inbox)),
    h('div', {}, 'Library: ', h('code', {}, status.library)),
    status.lan.length ? h('div', {}, 'From a phone on the same Wi-Fi: ', ...status.lan.map((u) => h('code', {}, u + ' '))) : null,
    !t.colmap || !t.brush ? h('div', { style: 'color: var(--bad)' }, `Missing tools: ${[!t.colmap && 'COLMAP', !t.brush && 'Brush'].filter(Boolean).join(', ')}. Edit station.config.json.`) : null,
  ].filter(Boolean));
  renderGpu(status.gpu);
}

function renderPhone() {
  const p = status.phone || {};
  $('#phone').textContent = !status.tools.adb
    ? 'adb not found: USB auto-import is unavailable.'
    : !status.adbAutoImport
      ? 'USB auto-import is off.'
      : p.connected
        ? `📱 ${p.device} connected. New SplatScout exports in its Download folder are imported automatically.`
        : 'No phone connected over USB.';
}

function renderGpu(g) {
  if (!g || !g.name) return;
  $('#gpu').innerHTML = `<b>${g.name.replace('NVIDIA GeForce ', '')}</b> · ${g.util ?? 0}% · ${((g.memUsed || 0) / 1024).toFixed(1)}/${((g.memTotal || 0) / 1024).toFixed(0)} GB · ${g.temp ?? '–'}°C`;
}

$('#preset').addEventListener('change', (e) => api('/api/settings', { preset: e.target.value }));
$('#usePoses').addEventListener('change', (e) => api('/api/settings', { usePoses: e.target.checked }));
$('#cropToBounds').addEventListener('change', (e) => api('/api/settings', { cropToBounds: e.target.checked }));
$('#adb').addEventListener('change', (e) => api('/api/settings', { adbAutoImport: e.target.checked }).then(loadStatus));

// ------------------------------------------------------------------ uploads
const drop = $('#drop');
$('#pick').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => [...e.target.files].forEach(upload));
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  [...e.dataTransfer.files].forEach(upload);
});

function upload(file) {
  const fill = h('div', { style: 'width:0%' });
  const label = h('span', `${file.name} · ${fmtMB(file.size)}`);
  const row = h('div', { class: 'up' }, label, h('div', { class: 'bar' }, fill));
  $('#uploads').append(row);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&preset=${$('#preset').value}`);
  xhr.upload.onprogress = (e) => e.lengthComputable && (fill.style.width = Math.round((e.loaded / e.total) * 100) + '%');
  xhr.onload = () => {
    let r = {};
    try {
      r = JSON.parse(xhr.responseText);
    } catch {}
    label.textContent = r.ok ? `${file.name} · queued ✓` : `${file.name} · ${r.error || 'upload failed'}`;
    setTimeout(() => row.remove(), r.ok ? 4000 : 15000);
  };
  xhr.onerror = () => (label.textContent = `${file.name} · upload failed`);
  xhr.send(file);
}

// ------------------------------------------------------------------ jobs
function overall(j) {
  let s = 0, w = 0;
  for (const [id] of STAGES) {
    s += (j.stages[id] ? j.stages[id].p : 0) * WEIGHTS[id];
    w += WEIGHTS[id];
  }
  return s / w;
}

function renderJobs() {
  const list = [...jobs.values()].sort((a, b) => b.created - a.created);
  if (!list.length) {
    $('#jobs').replaceChildren(h('p', { class: 'muted' }, 'No jobs yet. Drop a SplatScout export above, put it in the inbox folder, or plug in your phone.'));
    return;
  }
  $('#jobs').replaceChildren(...list.map(renderJob));
}

function renderJob(j) {
  const active = j.status === 'running';
  const pct = Math.round(overall(j) * 100);
  const elapsed = j.started ? ((j.finished || Date.now()) - j.started) / 1000 : 0;
  const stageNote = j.stage && j.stages[j.stage] ? j.stages[j.stage].note : '';
  const presetLabel = status.presets && status.presets[j.preset] ? status.presets[j.preset].label.split(' (')[0] : j.preset;
  const actions = [];
  if (j.status === 'done' && j.result) {
    actions.push(h('a', { class: 'btn primary', href: viewerUrl(j.result.folder, j.result.info) , target: '_blank' }, '👁 View splat'));
    actions.push(h('a', { class: 'btn', href: libUrl(j.result.folder, 'scene.ply'), download: `${j.building}_${j.room}.ply` }, '⬇ .ply'));
    actions.push(h('button', { class: 'btn small', onclick: () => api('/api/open', { path: relLib(j.result.folder) }) }, '📁 Folder'));
  }
  if (j.preview && active) {
    actions.push(h('a', { class: 'btn', href: `/viewer.html?ply=${encodeURIComponent(fileUrl(j, j.preview.file))}&title=${encodeURIComponent('Preview · step ' + j.preview.iter)}`, target: '_blank' }, `Preview (step ${j.preview.iter.toLocaleString()})`));
  }
  if (active || j.status === 'queued') actions.push(h('button', { class: 'btn small danger', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}) }, 'Cancel'));
  if (['failed', 'cancelled', 'interrupted', 'done'].includes(j.status)) {
    const sel = h('select', {}, ...Object.entries(status.presets || {}).map(([k, p]) => h('option', { value: k, selected: k === j.preset }, p.label.split(' (')[0])));
    actions.push(h('span', { class: 'preview' }, sel, h('button', { class: 'btn small', onclick: () => api(`/api/jobs/${j.id}/retry`, { preset: sel.value }) }, j.status === 'done' ? 'Re-train' : 'Retry')));
    actions.push(h('button', { class: 'btn small danger', onclick: () => confirm('Delete this job and its working files? Finished splats in the library are kept.') && api(`/api/jobs/${j.id}/delete`, {}) }, 'Delete'));
  }
  const info = [];
  if (j.nImages) info.push(`${j.nImages} photos`);
  if (j.colmap) info.push(`${j.colmap.images} placed (${j.colmap.mode === 'ar-poses' ? 'AR poses' : 'SfM'})`);
  if (j.capture && j.capture.grade) info.push(`capture grade ${j.capture.grade}`);
  if (j.result && j.result.info && j.result.info.training) {
    const t = j.result.info.training;
    if (t.splats) info.push(`${(t.splats / 1e6).toFixed(2)} M splats`);
    info.push(`trained in ${fmtDur(t.seconds)}`);
  }
  return h('div', { class: 'job' },
    h('div', { class: 'job-head' },
      h('div', {},
        h('div', { class: 'job-title' }, `${j.building || 'Unknown'} · ${j.room || j.source.name}`),
        h('div', { class: 'small muted' }, `${j.source.kind === 'video' ? '🎞 video' : '🗜 SplatScout'} · ${presetLabel} · ${fmtTime(j.created)}${elapsed ? ' · ' + fmtDur(elapsed) : ''}${info.length ? ' · ' + info.join(' · ') : ''}`),
      ),
      h('span', { class: 'badge ' + j.status }, j.status === 'running' ? `${pct}%` : j.status),
    ),
    j.status === 'queued' ? null : h('div', { class: 'stages' }, STAGES.map(([id, label]) => {
      const s = j.stages[id] || { p: 0 };
      const cls = 'stage' + (s.p >= 1 ? ' done' : '') + (active && j.stage === id ? ' active' : '');
      return h('div', { class: cls }, h('div', { class: 'stage-label' }, h('span', label), h('span', s.p > 0 && s.p < 1 ? Math.round(s.p * 100) + '%' : s.p >= 1 ? '✓' : '')), h('div', { class: 'bar' }, h('div', { style: `width:${Math.round(s.p * 100)}%` })));
    })),
    active ? h('div', { class: 'note' }, stageNote || '') : null,
    j.messages && j.messages.length ? h('ul', { class: 'msgs' }, j.messages.slice(active ? -3 : -2).map((m) => h('li', m.text))) : null,
    j.error ? h('div', { class: 'err' }, j.error) : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

const fileUrl = (j, abs) => `/files/jobs/${j.id}/` + abs.slice(abs.lastIndexOf(j.id) + j.id.length + 1).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
function relLib(folder) {
  const i = folder.replace(/\\/g, '/').indexOf('/library/');
  return folder.replace(/\\/g, '/').slice(i + '/library/'.length);
}
const libUrl = (folder, file) => '/files/library/' + relLib(folder).split('/').map(encodeURIComponent).join('/') + '/' + file;
function viewerUrl(folder, info) {
  const q = new URLSearchParams({ ply: libUrl(folder, 'scene.ply'), title: `${info.building} · ${info.room}` });
  if (info.view) q.set('view', JSON.stringify(info.view));
  return '/viewer.html?' + q;
}

// ------------------------------------------------------------------ library
async function loadLibrary() {
  const items = await api('/api/library');
  if (!items.length) {
    $('#library').replaceChildren(h('p', { class: 'muted' }, 'Finished splats appear here, organised by building and room.'));
    return;
  }
  $('#library').replaceChildren(...items.map((it) => {
    const base = '/files/library/' + it.path.split('/').map(encodeURIComponent).join('/');
    const i = it.info || {};
    const t = i.training || {};
    return h('div', { class: 'tile' },
      it.hasThumb ? h('img', { src: base + '/thumb.jpg', alt: '' }) : h('div', { style: 'aspect-ratio:16/10;background:#000' }),
      h('div', { class: 'tile-body' },
        h('div', { class: 'tile-title' }, `${it.building} · ${it.room}`),
        h('div', { class: 'small muted' }, `${it.stamp.replace('_', ' ')} · ${i.photos || '?'} photos${t.splats ? ` · ${(t.splats / 1e6).toFixed(2)} M splats` : ''} · ${i.sizeMB || '?'} MB`),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary', href: viewerFromPath(it), target: '_blank' }, '👁 View'),
          h('a', { class: 'btn', href: base + '/scene.ply', download: `${it.building}_${it.room}.ply` }, '⬇ .ply'),
          h('button', { class: 'btn small', onclick: () => api('/api/open', { path: it.path }) }, '📁'),
        ),
      ),
    );
  }));
}

function viewerFromPath(it) {
  const q = new URLSearchParams({ ply: '/files/library/' + it.path.split('/').map(encodeURIComponent).join('/') + '/scene.ply', title: `${it.building} · ${it.room}` });
  if (it.info && it.info.view) q.set('view', JSON.stringify(it.info.view));
  return '/viewer.html?' + q;
}

// ------------------------------------------------------------------ live updates
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    const prev = jobs.get(j.id);
    jobs.set(j.id, j);
    scheduleRender();
    if (prev && prev.status !== 'done' && j.status === 'done') loadLibrary();
  });
  es.addEventListener('removed', (e) => {
    jobs.delete(JSON.parse(e.data).id);
    scheduleRender();
  });
  es.addEventListener('gpu', (e) => renderGpu(JSON.parse(e.data)));
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
}

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    renderJobs();
  }, 250);
}

function appendLog(entry) {
  const el = $('#log');
  el.textContent += `[${new Date(entry.t).toLocaleTimeString()}] ${entry.text}\n`;
  el.scrollTop = el.scrollHeight;
}

(async function init() {
  await loadStatus();
  for (const j of await api('/api/jobs')) jobs.set(j.id, j);
  renderJobs();
  loadLibrary();
  for (const e of await api('/api/log')) appendLog(e);
  connect();
  setInterval(() => api('/api/status').then((s) => {
    status = { ...status, ...s };
    renderPhone();
  }), 10000);
  setInterval(() => [...jobs.values()].some((j) => j.status === 'running') && scheduleRender(), 1000);
})();
