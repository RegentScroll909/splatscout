// SplatStation dashboard.

const $ = (s) => document.querySelector(s);
const STAGES = [
  ['import', 'Import'], ['features', 'Features'], ['matching', 'Matching'], ['mapping', 'Camera solve'],
  ['undistort', 'Undistort'], ['train', 'Train'], ['finish', 'Finish'],
];
const WEIGHTS = { import: 4, features: 6, matching: 10, mapping: 10, undistort: 2, train: 66, finish: 2 };
const HISTORY = ['done', 'failed', 'cancelled', 'interrupted'];
let status = {};
const jobs = new Map();
const phoneSel = new Set();
const drafts = new Map(); // job id -> options picked on its card (kept across re-renders)

const ICONS = {
  upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  up: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="2.6"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  redo: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
};

function icon(name) {
  const s = document.createElement('span');
  s.className = 'ic';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

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
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
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
const presetName = (k) => (status.presets && status.presets[k] ? status.presets[k].label.split(' (')[0] : k);

// ------------------------------------------------------------------ status & settings
async function loadStatus() {
  status = await api('/api/status');
  const sel = $('#preset');
  sel.replaceChildren(...Object.entries(status.presets).map(([k, p]) => h('option', { value: k, selected: k === status.preset }, p.label)));
  $('#usePoses').checked = status.usePoses;
  $('#cropToBounds').checked = status.cropToBounds;
  $('#adb').checked = status.adbAutoImport;
  $('#phoneAutoImport').checked = status.phoneAutoImport;
  $('#autoProcess').checked = status.autoProcess;
  $('#startNow').checked = status.autoProcess;
  $('#pauseQueue').checked = status.queuePaused;
  renderPhone(status.phone);
  const t = status.tools;
  $('#paths').replaceChildren(...[
    pathRow('Inbox', status.inbox),
    pathRow('Library', status.library),
    status.lan.length ? pathRow('Phone on Wi-Fi', status.lan.join('  ')) : null,
    !t.colmap || !t.brush ? h('div', { class: 'err' }, `Missing tools: ${[!t.colmap && 'COLMAP', !t.brush && 'Brush'].filter(Boolean).join(', ')}. Edit station.config.json.`) : null,
  ].filter(Boolean));
  renderGpu(status.gpu);
}

function pathRow(label, value) {
  return h('div', { class: 'path' }, h('span', { class: 'lbl' }, label), h('code', {}, value));
}

function renderGpu(g) {
  if (!g || !g.name) return;
  const mem = `${((g.memUsed || 0) / 1024).toFixed(1)}/${((g.memTotal || 0) / 1024).toFixed(0)} GB`;
  $('#gpu').replaceChildren(
    h('span', { class: 'gpu-name' }, g.name.replace('NVIDIA GeForce ', '')),
    h('span', {}, `${g.util ?? 0}%`), h('span', {}, mem), h('span', {}, `${g.temp != null ? Math.round(g.temp) : '–'}°C`),
  );
}

const setting = (id, key, after) => $(id).addEventListener('change', (e) => api('/api/settings', { [key]: e.target.checked }).then(after || (() => {})));
$('#preset').addEventListener('change', (e) => api('/api/settings', { preset: e.target.value }).then(loadStatus));
setting('#usePoses', 'usePoses');
setting('#cropToBounds', 'cropToBounds');
setting('#adb', 'adbAutoImport', loadStatus);
setting('#phoneAutoImport', 'phoneAutoImport', loadStatus);
setting('#autoProcess', 'autoProcess', loadStatus);
$('#pauseQueue').addEventListener('change', (e) => api('/api/queue', { paused: e.target.checked }));
$('#processAll').addEventListener('click', () => api('/api/process-all', {}));
$('#phoneRefresh').addEventListener('click', () => api('/api/phone/refresh', {}).then(renderPhone));

// ------------------------------------------------------------------ phone
/** replaceChildren that skips null/false (optional parts). */
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

function renderPhone(p) {
  const el = $('#phone');
  p = p || {};
  status.phone = p;
  if (!status.tools || !status.tools.adb) return el.replaceChildren(h('p', { class: 'muted small' }, 'adb was not found, so phones over USB are unavailable. Upload ZIPs above instead.'));
  if (!status.adbAutoImport) return el.replaceChildren(h('p', { class: 'muted small' }, 'Phone detection is off (see Defaults).'));
  if (!p.connected) {
    return put(el, h('p', { class: 'muted small' }, 'No phone connected. Plug it in with USB debugging on, then export from SplatScout (Save ZIP).'), p.error ? h('p', { class: 'err small' }, p.error) : null);
  }
  const files = p.files || [];
  for (const n of [...phoneSel]) if (!files.some((f) => f.name === n)) phoneSel.delete(n);
  const fresh = files.filter((f) => !f.imported);
  const importBtn = h('button', {
    class: 'btn small primary', disabled: !phoneSel.size || !!p.pulling,
    onclick: async () => {
      importBtn.disabled = true;
      const r = await api('/api/phone/import', { names: [...phoneSel] });
      phoneSel.clear();
      if (r.error) alert(r.error);
    },
  }, icon('download'), phoneSel.size ? `Import ${phoneSel.size}` : 'Import');
  put(el,
    h('div', { class: 'phone-head' }, icon('phone'), h('b', {}, p.device), h('span', { class: 'muted small' }, `${files.length} export${files.length === 1 ? '' : 's'} · ${fresh.length} new`)),
    files.length
      ? h('div', { class: 'phone-files' }, files.map((f) => h('label', { class: 'pfile' + (f.imported ? ' done' : '') },
          h('input', { type: 'checkbox', checked: phoneSel.has(f.name), disabled: p.pulling === f.name, onchange: (e) => { e.target.checked ? phoneSel.add(f.name) : phoneSel.delete(f.name); renderPhone(status.phone); } }),
          h('span', { class: 'pname' }, f.name.replace(/\.zip$/, '')),
          h('span', { class: 'mono muted' }, fmtMB(f.size)),
          h('span', { class: 'mono muted' }, f.date),
          h('span', { class: 'tag ' + (p.pulling === f.name ? 'run' : f.imported ? '' : 'new') }, p.pulling === f.name ? 'Copying…' : f.imported ? 'Imported' : 'New'))))
      : h('p', { class: 'muted small' }, 'No SplatScout exports in the phone\'s Download folder yet.'),
    files.length
      ? h('div', { class: 'actions' },
          importBtn,
          fresh.length ? h('button', { class: 'btn small ghost', onclick: () => { fresh.forEach((f) => phoneSel.add(f.name)); renderPhone(status.phone); } }, 'Select new') : null,
          status.phoneAutoImport ? h('span', { class: 'muted small' }, 'New exports are copied automatically.') : null)
      : null,
  );
}

// ------------------------------------------------------------------ uploads
const drop = $('#drop');
$('#dropIcon').append(icon('upload'));
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
  const label = h('span', {}, `${file.name} · ${fmtMB(file.size)}`);
  const row = h('div', { class: 'up' }, label, h('div', { class: 'bar' }, fill));
  $('#uploads').append(row);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&preset=${$('#preset').value}&process=${$('#startNow').checked ? 1 : 0}`);
  xhr.upload.onprogress = (e) => e.lengthComputable && (fill.style.width = Math.round((e.loaded / e.total) * 100) + '%');
  xhr.onload = () => {
    let r = {};
    try {
      r = JSON.parse(xhr.responseText);
    } catch {}
    label.textContent = r.ok ? `${file.name} · received` : `${file.name} · ${r.error || 'upload failed'}`;
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
  const all = [...jobs.values()];
  const waiting = all.filter((j) => j.status === 'waiting').sort((a, b) => b.created - a.created);
  const queue = all.filter((j) => j.status === 'running' || j.status === 'queued')
    .sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : (a.order ?? a.created) - (b.order ?? b.created)));
  const history = all.filter((j) => HISTORY.includes(j.status)).sort((a, b) => (b.finished || b.created) - (a.finished || a.created));
  $('#waitingCount').textContent = String(waiting.length).padStart(2, '0');
  $('#queueCount').textContent = String(queue.length).padStart(2, '0');
  $('#historyCount').textContent = String(history.length).padStart(2, '0');
  $('#processAll').classList.toggle('hidden', waiting.length < 2);
  $('#waiting').replaceChildren(...(waiting.length ? waiting.map(waitingCard) : [empty('Nothing waiting. New captures land here and wait until you press Process.')]));
  $('#queue').replaceChildren(...(queue.length ? queue.map((j, i) => queueCard(j, i)) : [empty(status.queuePaused ? 'The queue is paused.' : 'Nothing queued.')]));
  $('#history').replaceChildren(...(history.length ? history.map(historyCard) : [empty('Finished and failed jobs appear here.')]));
}

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

function title(j) {
  return h('div', { class: 'job-title' }, h('span', {}, j.building || 'Unknown'), h('span', { class: 'sep' }, '/'), h('span', {}, j.room || j.source.name));
}

function summary(j) {
  const s = j.summary;
  const bits = [];
  if (j.source.kind === 'video') bits.push('Video', fmtMB(j.source.size));
  else if (s) {
    bits.push(`${s.photos} photos`);
    if (s.posed) bits.push(`${s.posed} with AR positions`);
    if (s.sessions > 1) bits.push(`${s.sessions} sessions${s.maps > 1 ? `, ${s.maps} maps` : ' lined up'}`);
    bits.push(s.area ? 'scan area marked' : 'no scan area');
    if (s.left) bits.push(`${s.left} left out at export`);
    bits.push(fmtMB(j.source.size));
  } else bits.push(fmtMB(j.source.size));
  return h('div', { class: 'meta' },
    s && s.grade ? h('span', { class: 'grade g-' + s.grade.toLowerCase() }, s.grade) : null,
    h('span', {}, bits.join(' · ')),
    h('span', { class: 'muted' }, ` · received ${fmtTime(j.created)}`));
}

/** Options chosen per capture before it's processed. */
function optionControls(j) {
  const d = drafts.get(j.id) || { preset: j.preset, usePoses: j.usePoses !== false && status.usePoses, crop: j.crop != null ? j.crop : status.cropToBounds };
  const read = () => ({ preset: sel.value, usePoses: poses.checked, crop: crop.checked });
  const keep = () => drafts.set(j.id, read());
  const sel = h('select', { onchange: keep }, ...Object.entries(status.presets || {}).map(([k, p]) => h('option', { value: k, selected: k === d.preset }, p.label)));
  const poses = h('input', { type: 'checkbox', checked: d.usePoses, onchange: keep });
  const crop = h('input', { type: 'checkbox', checked: d.crop, onchange: keep });
  const box = h('div', { class: 'opts' },
    h('label', { class: 'field inline' }, h('span', { class: 'lbl' }, 'Quality'), sel),
    j.source.kind === 'zip' ? h('label', { class: 'check inline' }, poses, h('span', {}, 'AR positions')) : null,
    j.source.kind === 'zip' ? h('label', { class: 'check inline' }, crop, h('span', {}, 'Crop to scan area')) : null);
  return { box, read };
}

function waitingCard(j) {
  const o = optionControls(j);
  return h('div', { class: 'job waiting' },
    h('div', { class: 'job-head' }, title(j), h('span', { class: 'badge waiting' }, 'Waiting')),
    summary(j),
    o.box,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => api(`/api/jobs/${j.id}/process`, o.read()) }, icon('play'), 'Process'),
      h('button', { class: 'btn ghost danger', onclick: () => confirm('Remove this capture from SplatStation? (It stays on the phone.)') && api(`/api/jobs/${j.id}/delete`, {}) }, icon('trash'), 'Remove')),
  );
}

function queueCard(j, i) {
  const active = j.status === 'running';
  const pct = Math.round(overall(j) * 100);
  const elapsed = j.started ? ((j.finished || Date.now()) - j.started) / 1000 : 0;
  const stageNote = j.stage && j.stages[j.stage] ? j.stages[j.stage].note : '';
  const actions = [];
  if (j.preview && active) {
    actions.push(h('a', { class: 'btn', href: `/viewer.html?ply=${encodeURIComponent(fileUrl(j, j.preview.file))}&title=${encodeURIComponent('Preview · step ' + j.preview.iter)}`, target: '_blank' }, icon('eye'), `Preview (step ${j.preview.iter.toLocaleString()})`));
  }
  if (active) actions.push(h('button', { class: 'btn ghost danger', onclick: () => api(`/api/jobs/${j.id}/cancel`, {}) }, icon('stop'), 'Cancel'));
  else {
    if (i > (queueHasRunning() ? 1 : 0)) actions.push(h('button', { class: 'btn ghost', onclick: () => api(`/api/jobs/${j.id}/next`, {}) }, icon('up'), 'Run next'));
    actions.push(h('button', { class: 'btn ghost', onclick: () => api(`/api/jobs/${j.id}/hold`, {}) }, icon('pause'), 'Hold'));
  }
  return h('div', { class: 'job' + (active ? ' running' : '') },
    h('div', { class: 'job-head' }, title(j),
      h('span', { class: 'badge ' + j.status }, active ? `${pct}%` : `#${i + (queueHasRunning() ? 0 : 1)} in queue`)),
    h('div', { class: 'meta' }, h('span', {}, `${presetName(j.preset)}${j.nImages ? ` · ${j.nImages} photos` : j.summary ? ` · ${j.summary.photos} photos` : ''}${elapsed ? ` · ${fmtDur(elapsed)}` : ''}`)),
    active ? stages(j) : null,
    active ? h('div', { class: 'note mono' }, stageNote || '') : null,
    active && j.messages && j.messages.length ? h('ul', { class: 'msgs' }, j.messages.slice(-3).map((m) => h('li', {}, m.text))) : null,
    h('div', { class: 'actions' }, actions),
  );
}

const queueHasRunning = () => [...jobs.values()].some((j) => j.status === 'running');

function stages(j) {
  return h('div', { class: 'stages' }, STAGES.map(([id, label]) => {
    const s = j.stages[id] || { p: 0 };
    const cls = 'stage' + (s.p >= 1 ? ' done' : '') + (j.stage === id && j.status === 'running' ? ' active' : '');
    return h('div', { class: cls },
      h('div', { class: 'stage-label' }, h('span', {}, label), h('span', { class: 'mono' }, s.p > 0 && s.p < 1 ? Math.round(s.p * 100) + '%' : s.p >= 1 ? '✓' : '')),
      h('div', { class: 'bar' }, h('div', { style: `width:${Math.round(s.p * 100)}%` })));
  }));
}

function historyCard(j) {
  const actions = [];
  if (j.status === 'done' && j.result) {
    actions.push(h('a', { class: 'btn primary', href: viewerUrl(j.result.folder, j.result.info), target: '_blank' }, icon('eye'), 'View splat'));
    actions.push(h('a', { class: 'btn', href: libUrl(j.result.folder, 'scene.ply'), download: `${j.building}_${j.room}.ply` }, icon('download'), '.ply'));
    actions.push(h('button', { class: 'btn ghost', onclick: () => api('/api/open', { path: relLib(j.result.folder) }) }, icon('folder'), 'Folder'));
  }
  const o = optionControls(j);
  const redo = h('details', { class: 'redo' },
    h('summary', {}, icon('redo'), j.status === 'done' ? 'Process again' : 'Retry'),
    o.box,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: () => api(`/api/jobs/${j.id}/process`, o.read()) }, icon('play'), 'Queue it')));
  const info = [];
  if (j.colmap) info.push(`${j.colmap.images} placed (${j.colmap.mode === 'ar-poses' ? 'AR positions' : j.colmap.mode === 'sfm-ar' ? 'SfM, AR frame' : 'SfM'})`);
  if (j.result && j.result.info && j.result.info.training) {
    const t = j.result.info.training;
    if (t.splats) info.push(`${(t.splats / 1e6).toFixed(2)} M splats`);
    info.push(`trained in ${fmtDur(t.seconds)}`);
  }
  if (j.started && j.finished) info.push(`total ${fmtDur((j.finished - j.started) / 1000)}`);
  return h('div', { class: 'job ' + j.status },
    h('div', { class: 'job-head' }, title(j), h('span', { class: 'badge ' + j.status }, j.status === 'done' ? 'Done' : j.status)),
    h('div', { class: 'meta' }, h('span', {}, `${presetName(j.preset)} · ${j.finished ? fmtTime(j.finished) : fmtTime(j.created)}${info.length ? ' · ' + info.join(' · ') : ''}`)),
    j.error ? h('div', { class: 'err' }, j.error) : null,
    j.messages && j.messages.length && j.status !== 'done' ? h('ul', { class: 'msgs' }, j.messages.slice(-2).map((m) => h('li', {}, m.text))) : null,
    h('div', { class: 'actions' }, actions,
      h('button', { class: 'btn ghost danger', onclick: () => confirm('Delete this job and its working files? Finished splats in the library are kept.') && api(`/api/jobs/${j.id}/delete`, {}) }, icon('trash'), 'Delete')),
    redo,
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
  $('#libraryCount').textContent = String(items.length).padStart(2, '0');
  if (!items.length) {
    $('#library').replaceChildren(empty('Finished splats appear here, organised by building and room.'));
    return;
  }
  $('#library').replaceChildren(...items.map((it) => {
    const base = '/files/library/' + it.path.split('/').map(encodeURIComponent).join('/');
    const i = it.info || {};
    const t = i.training || {};
    return h('div', { class: 'tile' },
      it.hasThumb ? h('img', { src: base + '/thumb.jpg', alt: '' }) : h('div', { class: 'tile-blank' }),
      h('div', { class: 'tile-body' },
        h('div', { class: 'tile-title' }, `${it.building} / ${it.room}`),
        h('div', { class: 'small muted mono' }, `${it.stamp.replace('_', ' ')} · ${i.photos || '?'} photos${t.splats ? ` · ${(t.splats / 1e6).toFixed(2)} M` : ''} · ${i.sizeMB || '?'} MB`),
        h('div', { class: 'actions' },
          h('a', { class: 'btn primary small', href: viewerFromPath(it), target: '_blank' }, icon('eye'), 'View'),
          h('a', { class: 'btn small', href: base + '/scene.ply', download: `${it.building}_${it.room}.ply` }, icon('download'), '.ply'),
          h('button', { class: 'btn small ghost', onclick: () => api('/api/open', { path: it.path }), title: 'Open folder' }, icon('folder')),
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
    scheduleRender(!prev || prev.status !== j.status);
    if (prev && prev.status !== 'done' && j.status === 'done') loadLibrary();
  });
  es.addEventListener('removed', (e) => {
    jobs.delete(JSON.parse(e.data).id);
    scheduleRender(true);
  });
  es.addEventListener('gpu', (e) => renderGpu(JSON.parse(e.data)));
  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
  es.addEventListener('phone', (e) => renderPhone(JSON.parse(e.data)));
  es.addEventListener('queue', (e) => {
    status.queuePaused = JSON.parse(e.data).paused;
    $('#pauseQueue').checked = status.queuePaused;
    scheduleRender(true);
  });
}

// Re-rendering replaces form controls, so only do it while nobody is editing one (or when a job
// changed state, which moves it between lists anyway).
let renderPending = false;
function scheduleRender(force) {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    const editing = document.activeElement && /SELECT|INPUT/.test(document.activeElement.tagName) && document.activeElement.closest('.list');
    if (editing && !force) return;
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
  setInterval(() => [...jobs.values()].some((j) => j.status === 'running') && scheduleRender(), 1000);
})();
