// SplatStation club page: review photos from phones, missions, invites, members, restricted places.

const $ = (s) => document.querySelector(s);

function h(tag, attrs, ...kids) {
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
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `error ${r.status}`);
  return j;
};
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const fmtTime = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const alertErr = (e) => alert(e.message || String(e));

const S = { photos: [], tab: 'review', sel: new Set(), buildings: [], missions: [], invites: [], members: [], restricted: [], ffmpeg: true };
const LIGHT = { morning: 'morning', afternoon: 'afternoon', evening: 'evening', night: 'night' };

// ------------------------------------------------------------------ load
async function load() {
  S.buildings = await api('/api/club/buildings');
  const o = await api('/api/club');
  if (o.configured === false) {
    put($('#notice'), h('div', { class: 'err' }, o.error));
    for (const s of ['#overview', '#review']) $(s).classList.add('hidden');
    $('#overview').classList.remove('hidden');
    $('#sync').disabled = $('#free').disabled = true;
    return;
  }
  $('#notice').replaceChildren();
  S.ffmpeg = o.ffmpeg;
  renderStats(o.stats);
  const [photos, missions, invites, members, restricted] = await Promise.all([
    api('/api/club/photos'), api('/api/club/missions'), api('/api/club/invites'), api('/api/club/members'), api('/api/club/restricted'),
  ]);
  S.photos = photos.photos;
  S.missions = missions.missions;
  S.invites = invites.invites;
  S.members = members.members;
  S.restricted = restricted.restricted;
  for (const id of [...S.sel]) if (!S.photos.some((p) => p.id === id)) S.sel.delete(id);
  renderReview();
  renderMissions();
  renderPeople();
  renderRestricted();
}

const reload = () => load().catch(alertErr);

function renderStats(s) {
  put($('#stats'),
    ...[['Members', s.members], ['Sending now', s.uploading], ['To review', s.new, s.new > 0], ['Accepted', s.accepted], ['Rejected', s.rejected]]
      .map(([label, n, hot]) => h('div', { class: 'stat' + (hot ? ' hot' : '') }, h('b', {}, String(n)), h('span', {}, label))));
}

// ------------------------------------------------------------------ sync
let syncTimer = 0;
async function pollSync() {
  const s = await api('/api/club/sync').catch(() => null);
  if (!s) return;
  $('#syncText').textContent = s.running ? `Downloading ${s.text}…` : s.error ? s.error : s.result ? `${s.result.downloaded} new photo(s) downloaded${s.result.failed ? `, ${s.result.failed} failed` : ''}` : '';
  $('#syncText').classList.toggle('note-ok', !s.running && !s.error && !!s.result);
  $('#sync').disabled = s.running;
  if (s.running) syncTimer = setTimeout(pollSync, 700);
  else if (s.result && !s.error) {
    s.result = null;
    reload();
  }
}
$('#sync').addEventListener('click', async () => {
  if (!S.ffmpeg && !confirm('ffmpeg was not found, so photos can\'t be checked. Try anyway?')) return;
  try {
    await api('/api/club/sync', {});
    clearTimeout(syncTimer);
    pollSync();
  } catch (e) {
    alertErr(e);
  }
});
$('#refresh').addEventListener('click', reload);
$('#free').addEventListener('click', async () => {
  if (!confirm('Delete the cloud copies of accepted photos that are saved on this PC? (They stay here, and still count for points.)')) return;
  try {
    const r = await api('/api/club/free-cloud', {});
    $('#syncText').textContent = `Freed ${(r.bytes / 1048576).toFixed(0)} MB (${r.photos} photos)`;
  } catch (e) {
    alertErr(e);
  }
});

// ------------------------------------------------------------------ review
const level = (p) => (p.status === 'accepted' ? 'accepted' : p.verdict ? p.verdict.level : 'review');
const TABS = [
  ['review', 'To review', (p) => p.status === 'new'],
  ['accept', 'Look fine', (p) => p.status === 'new' && level(p) === 'accept'],
  ['look', 'Need a look', (p) => p.status === 'new' && level(p) === 'review'],
  ['reject', 'Suggest reject', (p) => p.status === 'new' && level(p) === 'reject'],
  ['accepted', 'Accepted', (p) => p.status === 'accepted'],
];

function renderReview() {
  const tab = TABS.find((t) => t[0] === S.tab);
  $('#reviewCount').textContent = String(S.photos.filter((p) => p.status === 'new').length).padStart(2, '0') + ' to review';
  put($('#tabs'), ...TABS.map(([id, label, fn]) =>
    h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), onclick: () => { S.tab = id; renderReview(); } }, `${label} `, h('span', { class: 'mono muted' }, String(S.photos.filter(fn).length)))));
  const list = S.photos.filter(tab[2]);
  if (!list.length) {
    put($('#places'), h('p', { class: 'empty' }, S.tab === 'accepted' ? 'Nothing accepted yet.' : S.photos.length ? 'Nothing here.' : 'No photos yet. Photos sent from phones appear here after you press Sync.'));
    return renderBulk();
  }
  const groups = new Map();
  for (const p of list) {
    const k = [p.building_name, p.floor, p.room].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  put($('#places'), ...[...groups.entries()].sort().map(([k, ps]) => place(ps)));
  renderBulk();
}

function place(ps) {
  const p0 = ps[0];
  const title = [p0.building_name, p0.floor && `floor ${p0.floor}`, p0.room].filter(Boolean).join(' · ');
  const allSel = ps.every((p) => S.sel.has(p.id));
  const accepted = S.photos.filter((p) => p.status === 'accepted' && p.building_code === p0.building_code && p.floor === p0.floor && p.room === p0.room);
  return h('div', { class: 'place' },
    h('div', { class: 'place-head' },
      h('b', {}, title), h('span', { class: 'muted small mono' }, `${ps.length} photo${ps.length === 1 ? '' : 's'}`),
      h('button', { class: 'btn small ghost', onclick: () => { ps.forEach((p) => (allSel ? S.sel.delete(p.id) : S.sel.add(p.id))); renderReview(); } }, allSel ? 'Clear' : 'Select all'),
      S.tab === 'accepted' || accepted.length >= 10
        ? h('button', { class: 'btn small', title: 'Put this room\'s accepted photos into Ready to process', onclick: () => build(p0, accepted.length) }, `Build a capture from ${accepted.length} accepted`)
        : null),
    h('div', { class: 'pgrid' }, ps.map(tile)));
}

function tile(p) {
  const lv = level(p);
  const why = p.status === 'accepted' ? (p.review_note || '') : p.verdict ? p.verdict.reasons.join(' · ') : '';
  const box = h('input', { type: 'checkbox', checked: S.sel.has(p.id), onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? S.sel.add(p.id) : S.sel.delete(p.id); renderBulk(); tileEl.classList.toggle('sel', S.sel.has(p.id)); } });
  const tileEl = h('div', { class: 'ptile' + (S.sel.has(p.id) ? ' sel' : ''), onclick: () => lightbox(p) },
    box,
    h('span', { class: 'lv ' + (lv === 'accepted' ? 'accept' : lv) }, lv === 'accepted' ? `+${p.points}` : lv === 'accept' ? 'ok' : lv),
    p.local ? h('img', { src: `/api/club/thumb/${p.id}`, loading: 'lazy', alt: '' }) : h('div', { class: 'noimg' }, 'press Sync'),
    h('div', { class: 'pbody' },
      h('span', {}, `@${p.handle} · ${LIGHT[p.lightSlot] || ''}`),
      p.mission ? h('span', { class: 'muted' }, `mission: ${p.mission}`) : null,
      why ? h('span', { class: 'why' }, why) : null));
  return tileEl;
}

function renderBulk() {
  const n = S.sel.size, el = $('#bulk');
  el.classList.toggle('hidden', !n);
  if (!n) return;
  const sel = S.photos.filter((p) => S.sel.has(p.id));
  const fresh = sel.filter((p) => p.status === 'new').length;
  put(el,
    h('b', {}, `${n} selected`),
    h('span', { class: 'grow' }),
    fresh ? h('button', { class: 'btn primary', onclick: () => act('accept') }, `Accept ${fresh}`) : null,
    h('button', { class: 'btn danger', onclick: () => reject() }, `Reject and delete ${n}`),
    sel.some((p) => p.status === 'accepted') ? h('button', { class: 'btn ghost', onclick: () => act('reopen') }, 'Move back to review') : null,
    h('button', { class: 'btn ghost', onclick: () => { S.sel.clear(); renderReview(); } }, 'Clear'));
}

async function act(action, note) {
  const ids = [...S.sel];
  try {
    const r = await api('/api/club/review', { ids, action, note });
    S.sel.clear();
    $('#syncText').textContent = action === 'accept' ? `Accepted ${r.changed}, ${r.points} points awarded` : `${r.changed} updated`;
    await load();
  } catch (e) {
    alertErr(e);
  }
}

const REASONS = ['A person is in the frame', 'Blurry', 'Not a public area', 'Screen or document in frame', 'Duplicate view', 'Other'];
function reject() {
  const sel = h('select', {}, REASONS.map((r) => h('option', {}, r)));
  const back = h('div', { id: 'lightbox', class: 'on', onclick: (e) => e.target === back && back.remove() },
    h('div', { class: 'panel', style: 'max-width:420px' },
      h('h3', {}, `Reject ${S.sel.size} photo(s)`),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Rejected photos are deleted from this PC and from the club database, and the member is told why. This can\'t be undone.'),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Reason shown to the member'), sel),
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
        h('button', { class: 'btn ghost', onclick: () => back.remove() }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { back.remove(); act('reject', sel.value); } }, 'Reject and delete'))));
  document.body.append(back);
}

function lightbox(p) {
  const box = $('#lightbox');
  box.classList.add('on');
  put(box,
    p.local ? h('img', { src: `/api/club/image/${p.id}`, alt: '' }) : h('p', {}, 'Not on this PC yet: press Sync.'),
    h('div', { class: 'small muted' }, `@${p.handle} · ${p.building_name}${p.floor ? ` · floor ${p.floor}` : ''}${p.room ? ` · ${p.room}` : ''} · ${LIGHT[p.lightSlot]} · ${fmtTime(p.taken_at)}${p.meta ? ` · ${p.meta.w}×${p.meta.h}, sharpness ${p.meta.sharp}, brightness ${Math.round(p.meta.mean)}` : ''}`),
    p.verdict && p.verdict.reasons.length ? h('div', { class: 'small', style: 'color:var(--warn)' }, p.verdict.reasons.join(' · ')) : null,
    h('div', { style: 'display:flex;gap:8px' },
      p.status === 'new' ? h('button', { class: 'btn primary', onclick: () => { S.sel = new Set([p.id]); box.classList.remove('on'); act('accept'); } }, 'Accept') : null,
      h('button', { class: 'btn danger', onclick: () => { S.sel = new Set([p.id]); box.classList.remove('on'); reject(); } }, 'Reject'),
      h('button', { class: 'btn ghost', onclick: () => box.classList.remove('on') }, 'Close')));
}
$('#lightbox').addEventListener('click', (e) => e.target.id === 'lightbox' && $('#lightbox').classList.remove('on'));
document.addEventListener('keydown', (e) => e.key === 'Escape' && $('#lightbox').classList.remove('on'));

/** What the photos' AR positions bring (Track position on the phone), for the build message. */
const arNote = (r) => !r.ar ? ''
  : r.ar.session ? `AR positions: ${r.ar.photos} photos from one AR session set the coordinates, so COLMAP starts from them and the splat is in metres${r.ar.posed > r.ar.photos ? ` (${r.ar.posed - r.ar.photos} more from ${r.ar.sessions - 1} other AR session(s) are placed by COLMAP)` : ''}.\n`
  : `${r.ar.posed} photos have AR positions, but no AR session has the 10 it takes to set the coordinates: COLMAP works it out from the photos alone.\n`;

async function build(p, n) {
  if (!confirm(`Put ${n} accepted photos of ${p.room || p.building_name} into Ready to process? You can then process them like any capture.`)) return;
  try {
    const r = await api('/api/club/build', { building_code: p.building_code, floor: p.floor, room: p.room });
    alert(`${r.photos} photos from ${r.contributors.map((c) => '@' + c).join(', ')} are in Ready to process on the dashboard (${r.file}).${r.sharedCamera ? '' : '\nTheir lenses differ (different phones, or AR and ordinary photos), so COLMAP will work out each one.'}\n${arNote(r)}Light: ${r.lightSlots.join(', ')}.`);
  } catch (e) {
    alertErr(e);
  }
}

// ------------------------------------------------------------------ missions
const nameOf = (code) => (S.buildings.find((b) => b.code === code) || {}).name || code || 'Anywhere';

function renderMissions() {
  $('#missionCount').textContent = String(S.missions.filter((m) => m.active).length).padStart(2, '0') + ' open';
  const f = {};
  const field = (key, label, el) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), (f[key] = el));
  put($('#missionForm'),
    field('title', 'Title', h('input', { type: 'text', placeholder: 'Hayden lobby in evening light', maxlength: 80 })),
    field('building', 'Building', h('select', {}, h('option', { value: '' }, 'Anywhere'), S.buildings.filter((b) => !b.restricted).map((b) => h('option', { value: b.code }, b.name)))),
    field('room', 'Room or area', h('input', { type: 'text', placeholder: 'Main lobby' })),
    field('floor', 'Floor', h('input', { type: 'text', placeholder: '1' })),
    field('light', 'Light', h('select', {}, ['any', 'morning', 'afternoon', 'evening', 'night'].map((l) => h('option', { value: l }, l === 'any' ? 'Any light' : l)))),
    field('bonus', 'Bonus per photo', h('input', { type: 'number', value: '2', min: 0, max: 50 })),
    field('wanted', 'Photos wanted', h('input', { type: 'number', value: '20', min: 1, max: 5000 })),
    field('detail', 'Details (optional)', h('input', { type: 'text', placeholder: 'Where to stand, what to cover', maxlength: 400 })),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api('/api/club/mission', { op: 'create', title: f.title.value, detail: f.detail.value, building_code: f.building.value, room: f.room.value, floor: f.floor.value, light: f.light.value, bonus: f.bonus.value, wanted: f.wanted.value });
          await reload();
        } catch (e) {
          alertErr(e);
        }
      },
    }, 'Add mission'));
  put($('#missions'), ...(S.missions.length ? S.missions.map((m) => h('div', { class: 'job' },
    h('div', { class: 'job-head' }, h('div', { class: 'job-title' }, m.title), h('span', { class: 'badge ' + (m.active ? 'new' : '') }, m.active ? 'Open' : 'Off')),
    h('div', { class: 'meta muted small' }, [nameOf(m.building_code), m.floor && `floor ${m.floor}`, m.room, m.light !== 'any' && `${m.light} light`, `+${m.bonus} each`, `${m.wanted} wanted`].filter(Boolean).join(' · ')),
    m.detail ? h('div', { class: 'small muted' }, m.detail) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/club/mission', { op: 'toggle', id: m.id, active: !m.active }).catch(alertErr); reload(); } }, m.active ? 'Switch off' : 'Switch on'),
      h('button', { class: 'btn small ghost danger', onclick: async () => { if (confirm('Delete this mission? Photos taken for it keep their points.')) { await api('/api/club/mission', { op: 'delete', id: m.id }).catch(alertErr); reload(); } } }, 'Delete')))) : [h('p', { class: 'empty' }, 'No missions yet. A mission asks for a view, in a kind of light, and adds bonus points.')]));
}

// ------------------------------------------------------------------ invites and members
function renderPeople() {
  $('#memberCount').textContent = `${String(S.members.length).padStart(2, '0')} members`;
  const label = h('input', { type: 'text', placeholder: 'e.g. Robotics club' }), uses = h('input', { type: 'number', value: '25', min: 1, max: 10000 });
  put($('#inviteForm'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Who it\'s for'), label),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'People who can join'), uses),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          const r = await api('/api/club/invite', { op: 'create', label: label.value, max_uses: uses.value });
          prompt('New invite code (copy it):', r.invite.code);
          reload();
        } catch (e) {
          alertErr(e);
        }
      },
    }, 'New code'));
  put($('#invites'), S.invites.length
    ? h('table', { class: 'rows' }, h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'For'), h('th', {}, 'Used'), h('th', {})),
      S.invites.map((i) => h('tr', { class: i.active ? '' : 'off' },
        h('td', { class: 'code' }, i.code), h('td', {}, i.label), h('td', { class: 'mono' }, `${i.uses}/${i.max_uses}`),
        h('td', {}, h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/club/invite', { op: 'toggle', code: i.code, active: !i.active }).catch(alertErr); reload(); } }, i.active ? 'Switch off' : 'Switch on')))))
    : h('p', { class: 'empty' }, 'No invite codes yet. Make one and give it to the people you want in the beta.'));
  put($('#members'), S.members.length
    ? h('table', { class: 'rows' }, h('tr', {}, h('th', {}, 'Handle'), h('th', {}, 'Points'), h('th', {}, 'Photos'), h('th', {}, 'Joined'), h('th', {})),
      S.members.map((m) => h('tr', { class: m.banned ? 'off' : '' },
        h('td', {}, `@${m.handle}`, m.banned ? h('span', { class: 'tag' }, ' paused') : null), h('td', { class: 'mono' }, String(m.points)), h('td', { class: 'mono' }, String(m.photos)), h('td', { class: 'muted small' }, fmtTime(m.created_at)),
        h('td', { style: 'text-align:right;white-space:nowrap' },
          h('button', { class: 'btn small ghost', onclick: async () => { const hn = prompt('New handle for @' + m.handle, m.handle); if (hn && hn !== m.handle) { await api('/api/club/member', { op: 'rename', user_id: m.user_id, handle: hn }).catch(alertErr); reload(); } } }, 'Rename'),
          ' ', h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/club/member', { op: 'ban', user_id: m.user_id, banned: !m.banned }).catch(alertErr); reload(); } }, m.banned ? 'Resume' : 'Pause'),
          ' ', h('button', { class: 'btn small ghost danger', onclick: async () => { if (confirm(`Remove @${m.handle} and delete everything they sent (photos here and in the cloud, scans, profile)? This can't be undone.`)) { await api('/api/club/member', { op: 'purge', user_id: m.user_id }).catch(alertErr); reload(); } } }, 'Remove')))))
    : h('p', { class: 'empty' }, 'Nobody has joined yet.'));
}

// ------------------------------------------------------------------ restricted places
function renderRestricted() {
  $('#restrictedCount').textContent = String(S.restricted.length).padStart(2, '0');
  const open = S.buildings.filter((b) => !S.restricted.some((r) => r.code === b.code));
  const pick = h('select', {}, open.map((b) => h('option', { value: b.code }, b.name))), why = h('select', {}, ['residence', 'health', 'safety', 'children', 'lab', 'other'].map((r) => h('option', {}, r)));
  put($('#restrictedForm'),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Add a building'), pick),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Why'), why),
    h('button', { class: 'btn', onclick: async () => { await api('/api/club/restricted', { op: 'set', code: pick.value, reason: why.value }).catch(alertErr); reload(); } }, 'Add'),
    h('button', { class: 'btn ghost', title: 'Copy the flags from the ASU building list into the database', onclick: async () => { const r = await api('/api/club/restricted', { op: 'sync' }).catch(alertErr); if (r) alert(`${r.count} buildings from the ASU list are restricted in the club database.`); reload(); } }, 'Sync from ASU list'));
  put($('#restricted'), S.restricted.length
    ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, S.restricted.map((r) => h('span', { class: 'tag' }, `${nameOf(r.code)} · ${r.reason} `, h('button', { class: 'link', title: 'Allow photos again', onclick: async () => { await api('/api/club/restricted', { op: 'set', code: r.code, reason: null }).catch(alertErr); reload(); } }, '✕'))))
    : h('p', { class: 'empty' }, 'None yet. Press "Sync from ASU list" to enforce the residence-hall, health and police flags in the club database.'));
}

load().catch((e) => put($('#notice'), h('div', { class: 'err' }, e.message))).then(() => pollSync());
