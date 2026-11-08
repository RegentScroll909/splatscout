// SplatStation club page: the scans members send and your review of the splats built from them (approving one
// awards its points and puts it on the campus map), missions, invites, members, restricted places.

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

const S = { scans: [], tab: 'review', buildings: [], missions: [], invites: [], members: [], restricted: [] };

// ------------------------------------------------------------------ load
async function load() {
  S.buildings = await api('/api/club/buildings');
  const o = await api('/api/club');
  if (o.configured === false) {
    put($('#notice'), h('div', { class: 'err' }, o.error));
    $('#review').classList.add('hidden');
    return;
  }
  $('#notice').replaceChildren();
  renderStats(o.stats);
  const [scans, missions, invites, members, restricted] = await Promise.all([
    api('/api/club/scans'), api('/api/club/missions'), api('/api/club/invites'), api('/api/club/members'), api('/api/club/restricted'),
  ]);
  S.scans = scans.scans;
  S.missions = missions.missions;
  S.invites = invites.invites;
  S.members = members.members;
  S.restricted = restricted.restricted;
  renderScans();
  renderMissions();
  renderPeople();
  renderRestricted();
}

const reload = () => load().catch(alertErr);
$('#refresh').addEventListener('click', reload);

function renderStats(s) {
  put($('#stats'),
    ...[['Members', s.members], ['Sending now', s.uploading], ['Not on this PC yet', s.new, s.new > 0], ['On this PC', s.processed, s.processed > 0], ['Approved', s.approved], ['Not approved', s.rejected]]
      .map(([label, n, hot]) => h('div', { class: 'stat' + (hot ? ' hot' : '') }, h('b', {}, String(n)), h('span', {}, label))));
}

// ------------------------------------------------------------------ scans and their review
/** Where a scan is: sent, imported, built and waiting for you, or decided. */
function stage(x) {
  if (x.status === 'approved') return 'approved';
  if (x.status === 'rejected') return 'rejected';
  if (x.splat) return 'review'; // its splat is built: your turn
  if (x.status === 'new') return 'new'; // not on this PC yet
  return 'building'; // imported: on the dashboard, or being processed
}
const TABS = [
  ['review', 'Splats to review', (x) => stage(x) === 'review'],
  ['new', 'Not on this PC yet', (x) => stage(x) === 'new'],
  ['building', 'Being built', (x) => stage(x) === 'building'],
  ['approved', 'Approved', (x) => stage(x) === 'approved'],
  ['rejected', 'Not approved', (x) => stage(x) === 'rejected'],
];

function renderScans() {
  const waiting = S.scans.filter((x) => ['review', 'new'].includes(stage(x))).length;
  $('#reviewCount').textContent = `${String(waiting).padStart(2, '0')} need you`;
  put($('#tabs'), ...TABS.map(([id, label, fn]) =>
    h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), onclick: () => { S.tab = id; renderScans(); } }, `${label} `, h('span', { class: 'mono muted' }, String(S.scans.filter(fn).length)))));
  const list = S.scans.filter(TABS.find((t) => t[0] === S.tab)[2]);
  put($('#scans'), list.length ? list.map(scanCard) : h('p', { class: 'empty' }, {
    review: 'No splats waiting for you. When a member’s scan has been built, it appears here to approve or not.',
    new: 'Nothing new. Scans members send (graded B or better) appear here to import.',
    building: 'Nothing being built. Imported scans wait in Ready to process on the dashboard.',
    approved: 'Nothing approved yet.',
    rejected: 'Nothing turned down.',
  }[S.tab]));
}

const viewerUrl = (sp) => {
  const q = new URLSearchParams({ ply: '/files/library/' + sp.path.split('/').map(encodeURIComponent).join('/') + '/scene.ply', title: sp.title });
  if (sp.view) q.set('view', JSON.stringify(sp.view));
  return '/viewer.html?' + q;
};

function scanCard(x) {
  const st = stage(x);
  const title = [x.building_name, x.floor && `floor ${x.floor}`, x.room].filter(Boolean).join(' · ');
  const meta = [`@${x.handle}`, `grade ${x.grade || '?'}`, `${x.photo_count} photos`, `sent ${fmtTime(x.created_at)}`, x.lat != null ? `GPS ±${Math.round(x.gps_accuracy_m || 0)} m` : null].filter(Boolean).join(' · ');
  const act = async (op, extra = {}) => {
    try {
      await api('/api/club/scan', { op, id: x.id, ...extra });
      await reload();
    } catch (e) {
      alertErr(e);
    }
  };
  const del = h('button', { class: 'btn small ghost danger', onclick: () => confirm(`Delete this scan of ${title} from the club database (its photos and its row)? A splat already built from it stays on this PC.`) && act('delete') }, 'Delete from the cloud');
  let status, actions = [];
  if (st === 'new') {
    status = h('span', { class: 'badge' }, 'Sent');
    actions = [h('button', { class: 'btn small primary', disabled: x.busy, onclick: (e) => { e.target.disabled = true; e.target.textContent = 'Downloading…'; act('import'); } }, 'Import and build'), del];
  } else if (st === 'building') {
    status = h('span', { class: 'badge' }, x.job ? `On the dashboard: ${x.job.status}` : 'Imported');
    actions = [x.job ? h('a', { class: 'btn small', href: '/' }, 'Open the dashboard') : h('button', { class: 'btn small', onclick: () => act('import') }, 'Import again'), del];
  } else if (st === 'review') {
    const a = x.award, f = a && a.facts;
    status = h('span', { class: 'badge new' }, 'Your review');
    actions = [
      h('a', { class: 'btn small', href: viewerUrl(x.splat), target: '_blank' }, 'View the splat'),
      h('a', { class: 'btn small', href: `/building.html?code=${encodeURIComponent(x.building_code)}&review=${encodeURIComponent(x.splat.path)}`, target: '_blank', title: 'See it among the building’s other splats and line it up' }, 'Place it in the building'),
      h('button', { class: 'btn small primary', title: a ? a.parts.map(([t, v]) => `${t}: +${v}`).join('\n') : '', onclick: () => confirm(`Approve this splat of ${title}? It goes on the campus map and @${x.handle} gets ${a ? a.points : 0} points.`) && act('approve') }, `Approve${a ? ` (+${a.points})` : ''}`),
      h('button', { class: 'btn small ghost danger', onclick: () => decline(x, title, act) }, 'Don’t approve'),
    ];
    if (f) actions.push(h('span', { class: 'muted small' }, `Splat ${f.score}/100 (${f.measured ? 'measured' : 'estimated'})${f.rescan ? ' · its space was Good already' : f.newArea ? ` · adds about ${f.newArea} m² to the map` : ''}`));
  } else if (st === 'approved') {
    status = h('span', { class: 'badge done' }, `Approved · +${x.points}`);
    actions = x.splat ? [h('a', { class: 'btn small ghost', href: viewerUrl(x.splat), target: '_blank' }, 'View the splat')] : [];
  } else {
    status = h('span', { class: 'badge failed' }, 'Not approved');
    actions = [x.review_note ? h('span', { class: 'muted small' }, `Told them: ${x.review_note}`) : null, del];
  }
  return h('div', { class: 'job' },
    h('div', { class: 'job-head' }, h('div', { class: 'job-title' }, title), status),
    h('div', { class: 'meta muted small' }, meta, x.reviewed_at ? ` · reviewed ${fmtTime(x.reviewed_at)}` : ''),
    h('div', { class: 'actions' }, actions));
}

const REASONS = ['A person is in the scan', 'Too blurry or patchy', 'Not a public area', 'Screen or document in view', 'Wrong building or room', 'Other'];
/** Don't approve: the member is told why (their scan stays listed as not approved; nothing is deleted). */
function decline(x, title, act) {
  const sel = h('select', {}, REASONS.map((r) => h('option', {}, r)));
  const more = h('input', { type: 'text', placeholder: 'Anything to add (optional)', maxlength: 300 });
  const back = h('div', { id: 'lightbox', class: 'on', onclick: (e) => e.target === back && back.remove() },
    h('div', { class: 'panel', style: 'max-width:440px' },
      h('h3', {}, `Don’t approve: ${title}`),
      h('p', { class: 'muted small', style: 'margin:0' }, `@${x.handle} gets no points for it and sees the reason in the app. The splat stays on this PC, off the campus map.`),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Reason shown to the member'), sel),
      h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Note'), more),
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
        h('button', { class: 'btn ghost', onclick: () => back.remove() }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { back.remove(); act('reject', { note: [sel.value, more.value.trim()].filter(Boolean).join(': ') }); } }, 'Don’t approve'))));
  document.body.append(back);
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && document.querySelectorAll('#lightbox').forEach((b) => b.remove()));

// ------------------------------------------------------------------ missions
const nameOf = (code) => (S.buildings.find((b) => b.code === code) || {}).name || code || 'Anywhere';

function renderMissions() {
  $('#missionCount').textContent = String(S.missions.filter((m) => m.active).length).padStart(2, '0') + ' open';
  const f = {};
  const field = (key, label, el) => h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), (f[key] = el));
  put($('#missionForm'),
    field('title', 'Title', h('input', { type: 'text', placeholder: 'Scan the Hayden reading room', maxlength: 80 })),
    field('building', 'Building', h('select', {}, h('option', { value: '' }, 'Anywhere'), S.buildings.filter((b) => !b.restricted).map((b) => h('option', { value: b.code }, b.name)))),
    field('room', 'Room or area', h('input', { type: 'text', placeholder: 'Reading room' })),
    field('floor', 'Floor', h('input', { type: 'text', placeholder: '2' })),
    field('light', 'Light', h('select', {}, ['any', 'morning', 'afternoon', 'evening', 'night'].map((l) => h('option', { value: l }, l === 'any' ? 'Any light' : l)))),
    field('bonus', 'Bonus for an approved scan', h('input', { type: 'number', value: '15', min: 0, max: 50 })),
    field('detail', 'Details (optional)', h('input', { type: 'text', placeholder: 'Where to start, what to cover', maxlength: 400 })),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api('/api/club/mission', { op: 'create', title: f.title.value, detail: f.detail.value, building_code: f.building.value, room: f.room.value, floor: f.floor.value, light: f.light.value, bonus: f.bonus.value });
          await reload();
        } catch (e) {
          alertErr(e);
        }
      },
    }, 'Add mission'));
  put($('#missions'), ...(S.missions.length ? S.missions.map((m) => h('div', { class: 'job' },
    h('div', { class: 'job-head' }, h('div', { class: 'job-title' }, m.title), h('span', { class: 'badge ' + (m.active ? 'new' : '') }, m.active ? 'Open' : 'Off')),
    h('div', { class: 'meta muted small' }, [nameOf(m.building_code), m.floor && `floor ${m.floor}`, m.room, m.light !== 'any' && `${m.light} light`, `+${m.bonus} for an approved scan`].filter(Boolean).join(' · ')),
    m.detail ? h('div', { class: 'small muted' }, m.detail) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/club/mission', { op: 'toggle', id: m.id, active: !m.active }).catch(alertErr); reload(); } }, m.active ? 'Switch off' : 'Switch on'),
      h('button', { class: 'btn small ghost danger', onclick: async () => { if (confirm('Delete this mission? Scans approved for it keep their points.')) { await api('/api/club/mission', { op: 'delete', id: m.id }).catch(alertErr); reload(); } } }, 'Delete')))) : [h('p', { class: 'empty' }, 'No missions yet. A mission asks for a scan of a space (in a kind of light, if you like) and adds bonus points when one is approved.')]));
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
    ? h('table', { class: 'rows' }, h('tr', {}, h('th', {}, 'Handle'), h('th', {}, 'Points'), h('th', {}, 'Scans approved'), h('th', {}, 'Joined'), h('th', {})),
      S.members.map((m) => h('tr', { class: m.banned ? 'off' : '' },
        h('td', {}, `@${m.handle}`, m.banned ? h('span', { class: 'tag' }, ' paused') : null), h('td', { class: 'mono' }, String(m.points)), h('td', { class: 'mono' }, String(m.scans || 0)), h('td', { class: 'muted small' }, fmtTime(m.created_at)),
        h('td', { style: 'text-align:right;white-space:nowrap' },
          h('button', { class: 'btn small ghost', onclick: async () => { const hn = prompt('New handle for @' + m.handle, m.handle); if (hn && hn !== m.handle) { await api('/api/club/member', { op: 'rename', user_id: m.user_id, handle: hn }).catch(alertErr); reload(); } } }, 'Rename'),
          ' ', h('button', { class: 'btn small ghost', onclick: async () => { await api('/api/club/member', { op: 'ban', user_id: m.user_id, banned: !m.banned }).catch(alertErr); reload(); } }, m.banned ? 'Resume' : 'Pause'),
          ' ', h('button', { class: 'btn small ghost danger', onclick: async () => { if (confirm(`Remove @${m.handle} and delete everything they sent (their scans in the cloud, and their profile)? Splats already built stay on this PC. This can't be undone.`)) { await api('/api/club/member', { op: 'purge', user_id: m.user_id }).catch(alertErr); reload(); } } }, 'Remove')))))
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
    ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, S.restricted.map((r) => h('span', { class: 'tag' }, `${nameOf(r.code)} · ${r.reason} `, h('button', { class: 'link', title: 'Allow scans here again', onclick: async () => { await api('/api/club/restricted', { op: 'set', code: r.code, reason: null }).catch(alertErr); reload(); } }, '✕'))))
    : h('p', { class: 'empty' }, 'None yet. Press "Sync from ASU list" to enforce the residence-hall, health and police flags in the club database.'));
}

load().catch((e) => put($('#notice'), h('div', { class: 'err' }, e.message)));
