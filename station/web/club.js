// SplatStation club page: the scans members send and your review of the splats built from them (approving one
// awards its points and puts it on the campus map), how full the club's cloud storage is and freeing a reviewed
// scan's copy there, missions, invites, members, restricted places.

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
  if (!r.ok) throw Object.assign(new Error(j.error || `error ${r.status}`), { status: r.status });
  return j;
};
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const fmtTime = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const alertErr = (e) => alert(e.message || String(e));
const MB = 1048576;
const fmtSize = (b) => (b >= 1024 * MB ? `${+(b / (1024 * MB)).toFixed(2)} GB` : b >= 100 * MB ? `${Math.round(b / MB)} MB` : b >= MB / 10 ? `${(b / MB).toFixed(1)} MB` : `${Math.max(b ? 1 : 0, Math.round(b / 1024))} KB`);
const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// storage: what the scans take in the club's cloud storage ({bytes, files, limit, scans: {id: {bytes, files}}}),
// null until it has been measured, {error} when it couldn't be.
const S = { scans: [], tab: 'review', buildings: [], missions: [], invites: [], members: [], restricted: [], storage: null };

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
  renderStorage();
  const [scans, missions, invites, members, restricted] = await Promise.all([
    api('/api/club/scans'), api('/api/club/missions'), api('/api/club/invites'), api('/api/club/members'), api('/api/club/restricted'),
  ]);
  S.scans = scans.scans;
  S.missions = missions.missions;
  S.invites = invites.invites;
  S.members = members.members;
  S.restricted = restricted.restricted;
  loadStorage(); // listing the cloud folders takes a few seconds the first time: the page doesn't wait for it
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

// ------------------------------------------------------------------ cloud storage
// Scans stay in the club's cloud storage after they're imported. The free plan has about 1 GB, so this says
// how full it is, and each reviewed scan offers "Free cloud copy" (below). Nothing is freed by itself.
let storageAsk = 0;
async function loadStorage(fresh = false) {
  const ask = ++storageAsk;
  if (fresh) {
    S.storage = null;
    renderStorage();
  }
  let s;
  try {
    s = await api('/api/club/storage' + (fresh ? '?fresh=1' : ''));
  } catch (e) {
    // 404: this page is newer than the SplatStation serving it (its pages are read from disk, its code isn't).
    s = { error: e.message || String(e), restart: e.status === 404 };
  }
  if (ask !== storageAsk) return; // a later request is on its way
  S.storage = s;
  renderStorage();
  renderScans();
}

/** A scan's files in the cloud: {bytes, files}, or null while that isn't known. */
const cloudOf = (x) => (S.storage && S.storage.scans && S.storage.scans[x.id]) || null;
const reviewed = (x) => x.status === 'approved' || x.status === 'rejected';

function renderStorage() {
  const el = $('#cloud'), s = S.storage;
  const label = h('span', { class: 'lbl' }, 'Cloud storage');
  if (!s) {
    el.className = 'cloud';
    return put(el, h('div', { class: 'cloud-head' }, label, h('span', { class: 'muted small' }, 'Measuring what the scans take there…')));
  }
  if (s.error) {
    el.className = 'cloud';
    if (s.restart) return put(el, h('div', { class: 'cloud-head' }, label, h('span', { class: 'muted small' }, 'Restart SplatStation to see how full it is and to free reviewed scans’ cloud copies (it was started before this was added).')));
    return put(el, h('div', { class: 'cloud-head' }, label, h('span', { class: 'muted small' }, `Couldn’t measure it: ${s.error}`), h('span', { class: 'grow' }),
      h('button', { class: 'btn small ghost', onclick: () => loadStorage(true) }, 'Try again')));
  }
  const share = s.bytes / s.limit, pct = Math.round(share * 100);
  el.className = 'cloud' + (share >= 0.9 ? ' full' : share >= 0.75 ? ' warn' : '');
  const holding = Object.values(s.scans).filter((x) => x.files > 0).length;
  // What could be freed: reviewed scans that still have their files there.
  const free = S.scans.filter((x) => reviewed(x) && (cloudOf(x) || {}).files > 0);
  const freeBytes = free.reduce((sum, x) => sum + cloudOf(x).bytes, 0);
  const show = (tab, text) => h('button', { class: 'link', onclick: () => { S.tab = tab; renderScans(); $('#review').scrollIntoView({ behavior: 'smooth' }); } }, text);
  const nA = free.filter((x) => x.status === 'approved').length, nR = free.length - nA;
  put(el,
    h('div', { class: 'cloud-head' }, label,
      h('b', {}, `${fmtSize(s.bytes)} of about ${fmtSize(s.limit)}`),
      h('span', { class: 'muted small' }, `${pct}% · ${plural(s.files, 'file')} from ${plural(holding, 'scan')}`),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small ghost', title: 'List every scan’s folder in the cloud again (sizes are otherwise remembered while SplatStation runs)', onclick: () => loadStorage(true) }, 'Measure again')),
    h('div', { class: 'bar' }, h('div', { style: `width:${Math.min(100, share * 100).toFixed(1)}%` })),
    h('p', { class: 'muted small' },
      free.length
        ? [`${fmtSize(freeBytes)} of it is ${plural(free.length, 'scan')} you’ve already reviewed (`, nA ? show('approved', `${nA} approved`) : null, nA && nR ? ', ' : null, nR ? show('rejected', `${nR} not approved`) : null,
          '). Free cloud copy on one of them deletes its files there and keeps its entry, so the member keeps their points. Nothing is freed by itself.']
        : s.bytes
          ? 'None of it belongs to a scan you’ve reviewed yet. Once a scan is approved or not, Free cloud copy on it makes room and keeps the member’s points.'
          : 'No scan has files in the cloud right now.',
      share >= 0.9 ? h('b', {}, ' Nearly full: make room before members send more scans.') : null));
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
  // What it takes in the club's cloud storage, once that has been measured.
  const cloud = cloudOf(x);
  const meta = [`@${x.handle}`, `grade ${x.grade || '?'}`, `${x.photo_count} photos`, `sent ${fmtTime(x.created_at)}`, x.lat != null ? `GPS ±${Math.round(x.gps_accuracy_m || 0)} m` : null,
    cloud && cloud.files > 0 ? `${fmtSize(cloud.bytes)} in the cloud` : null].filter(Boolean).join(' · ');
  const act = async (op, extra = {}) => {
    try {
      await api('/api/club/scan', { op, id: x.id, ...extra });
      await reload();
    } catch (e) {
      alertErr(e);
    }
  };
  // Deleting takes the scan's entry too: the member's record of it (and, were it approved, its points).
  const del = h('button', { class: 'btn small ghost danger', onclick: () => confirm(`Delete this scan of ${title} from the club database (its photos and its row)? @${x.handle} no longer sees it in My scans. A splat already built from it stays on this PC.`) && act('delete') }, 'Delete from the club database');
  // A scan you've decided on: its files in the cloud can go while its entry (the points, My scans) stays.
  const free = !reviewed(x) || !cloud ? null
    : cloud.files > 0 ? h('button', { class: 'btn small ghost', title: 'Delete its files from the club’s cloud storage and keep its entry in the club database', onclick: () => freeCloud(x, title, cloud) }, 'Free cloud copy')
      : h('span', { class: 'freed' }, 'Cloud copy freed');
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
    actions = [x.splat ? h('a', { class: 'btn small ghost', href: viewerUrl(x.splat), target: '_blank' }, 'View the splat') : null, free];
  } else {
    status = h('span', { class: 'badge failed' }, 'Not approved');
    actions = [x.review_note ? h('span', { class: 'muted small' }, `Told them: ${x.review_note}`) : null, free, del];
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

/**
 * Free cloud copy: a reviewed scan's files leave the club's cloud storage and its entry (its row: the points,
 * the member's My scans) stays. Asked first, saying what stays and what stops working; whether this PC still
 * has the scan's ZIP decides how much is lost, so that is said too.
 */
function freeCloud(x, title, cloud) {
  const approved = x.status === 'approved';
  const stays = [
    approved
      ? `Its entry in the club database (its row): @${x.handle} keeps the ${plural(x.points, 'point')} and still sees the scan in My scans as approved.`
      : `Its entry in the club database (its row): @${x.handle} still sees the scan in My scans as not approved${x.review_note ? ', with the reason' : ''}.`,
    x.splat ? `The splat built from it, on this PC${approved ? ' and on the campus map' : ''}.` : null,
    x.zip ? `This PC’s copy of the scan: ${x.zip.name}, in ${x.zip.in === 'inbox' ? 'the inbox' : 'its job’s folder for as long as that job is in History'}.` : null,
  ];
  const stops = [
    'Import again: the scan can’t be downloaded from the cloud any more.',
    x.zip ? 'Processing it again needs this PC’s ZIP from then on: there is no other copy to fetch.' : 'Processing it again: there will be no copy of the scan left to process.',
  ];
  const lost = x.zip ? null
    : `This PC doesn’t have the scan’s ZIP (it was never imported here, or its job was deleted from History), so the photos are gone for good once the cloud copy is freed${x.splat ? '. The splat stays.' : ', and there is no splat of it on this PC.'}`;
  const msg = h('div', { class: 'err hidden' });
  const cancel = h('button', { class: 'btn ghost', onclick: () => back.remove() }, 'Cancel');
  const go = h('button', {
    class: 'btn danger',
    onclick: async () => {
      go.disabled = cancel.disabled = true;
      go.textContent = 'Freeing…';
      try {
        await api('/api/club/scan', { op: 'free', id: x.id });
        back.remove();
        await reload();
      } catch (e) {
        const why = e.message || String(e);
        msg.textContent = `Couldn’t free it: ${why}${/fetch failed/i.test(why) ? ' (the club database couldn’t be reached)' : ''}`;
        msg.classList.remove('hidden');
        go.disabled = cancel.disabled = false;
        go.textContent = 'Free cloud copy';
        loadStorage(); // some of it may be gone
      }
    },
  }, 'Free cloud copy');
  const back = h('div', { id: 'lightbox', class: 'on', onclick: (e) => e.target === back && !go.disabled && back.remove() },
    h('div', { class: 'panel', style: 'max-width:540px' },
      h('h3', {}, `Free cloud copy: ${title}`),
      h('p', { class: 'small', style: 'margin:0' }, `This deletes the scan’s ${plural(cloud.files, 'file')} (${fmtSize(cloud.bytes)}) from the club’s cloud storage. It can’t be undone.`),
      lost ? h('p', { class: 'gone' }, lost) : null,
      h('span', { class: 'lbl' }, 'Stays'),
      h('ul', { class: 'keeps' }, stays.filter(Boolean).map((t) => h('li', {}, t))),
      h('span', { class: 'lbl' }, 'Stops working'),
      h('ul', { class: 'keeps stops' }, stops.map((t) => h('li', {}, t))),
      msg,
      h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, cancel, go)));
  document.body.append(back);
}

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
