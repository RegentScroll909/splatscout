// Club (beta): join with an invite code, see your points and rank, the leaderboard, missions and the
// photos you've sent. Taking photos is the Snap screen; scans are uploaded from their review screen.

import { h, mount, toast, confirmDialog } from './dom.js';
import { icon } from './icons.js';
import * as club from '../data/club.js';
import * as snaps from '../data/snaps.js';
import * as store from '../data/store.js';
import * as campus from '../data/campus.js';
import { RULES, CONSENT, DRAFT_NOTE, POINTS_HELP, LIGHT_LABEL, suggestHandles, validHandle } from '../core/clubrules.js';

export async function clubScreen(root, { navigate, query }) {
  const S = { profile: club.cachedProfile(), asked: false, offline: false, period: 'week', board: {}, missions: null, counts: null, snaps: [], buildings: new Map() };
  const urls = new Map(); // snap id -> thumbnail object URL
  const thumbUrl = (s) => {
    if (!s.thumb) return '';
    if (!urls.has(s.id)) urls.set(s.id, URL.createObjectURL(s.thumb));
    return urls.get(s.id);
  };
  const body = h('div.club');
  mount(root, h('div.page',
    h('header.page-head',
      h('button.icon-btn', { onclick: () => navigate('#/'), 'aria-label': 'Back' }, icon('back')),
      h('div.head-text', h('div.kicker', 'Beta'), h('h1', 'Club'))),
    body));
  let alive = true;

  const render = () => (S.profile ? renderMember() : S.asked ? renderJoin() : mount(body, h('div.empty', h('p', 'Loading…'))));

  // ------------------------------------------------------------------ not a member yet
  function renderJoin() {
    const j = (S.join ||= { handle: suggestHandles(1)[0], code: (query.get('code') || '').toUpperCase(), agreed: CONSENT.map(() => false) });
    const msg = h('p.small.warn-text');
    const handle = h('input', { value: j.handle, maxlength: 20, autocapitalize: 'off', autocomplete: 'off', spellcheck: false, oninput: (e) => (j.handle = e.target.value) });
    const code = h('input', { value: j.code, maxlength: 24, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, placeholder: 'e.g. CLUB-1234', oninput: (e) => (j.code = e.target.value.toUpperCase()) });
    const go = h('button.btn.primary.block', {
      onclick: async () => {
        msg.textContent = '';
        if (!validHandle(j.handle)) return (msg.textContent = 'A handle is 3 to 20 letters, numbers or underscores.');
        if (!j.code.trim()) return (msg.textContent = 'Enter the invite code you were given.');
        if (!j.agreed.every(Boolean)) return (msg.textContent = 'Tick each box to agree to the rules.');
        go.disabled = true;
        go.textContent = 'Joining…';
        try {
          S.profile = await club.join(j.handle, j.code);
          toast(`Welcome, @${S.profile.handle}`);
          snaps.kick();
          if (query.get('back')) return navigate(query.get('back'));
          await loadMember();
        } catch (e) {
          msg.textContent = e.message; // stay on the form: a re-render would wipe the message
          go.disabled = false;
          go.textContent = 'Join the club';
        }
      },
    }, 'Join the club');
    mount(body,
      h('section.card',
        h('div.card-head', h('h2', 'Join the club'), h('span.tag.good', 'Closed beta')),
        h('p.small', 'Help build a 3D map of ASU: take sharp photos of shared spaces, earn points, and see how you rank. The club reviews every photo before anything is made from it.'),
        h('h4', 'Rules'),
        h('ol.small.rules', RULES.map((r) => h('li', r))),
        h('label.field', h('span', 'Pick a handle (shown on the leaderboard)'), handle),
        h('div.chips', suggestHandles(3).map((s) => h('button.btn.small', { onclick: () => (j.handle = handle.value = s) }, s))),
        h('label.field', h('span', 'Invite code'), code),
        h('h4', 'Agree to continue'),
        CONSENT.map((t, i) => h('label.check-row', h('input', { type: 'checkbox', checked: j.agreed[i], onchange: (e) => (j.agreed[i] = e.target.checked) }), h('span.check-label.small', t))),
        h('p.small.muted.upload-note', DRAFT_NOTE),
        msg,
        go),
    );
  }

  // ------------------------------------------------------------------ member
  const bName = (code) => (S.buildings.get(code) || {}).name || code;
  const myRow = () => (S.board.all || []).find((r) => r.handle.toLowerCase() === S.profile.handle.toLowerCase());

  function renderMember() {
    const c = S.counts || { waiting: 0, failed: 0, sent: 0, accepted: 0, rejected: 0, points: 0 };
    const mine = myRow();
    const rank = (S.board.all || []).findIndex((r) => r.handle.toLowerCase() === S.profile.handle.toLowerCase()) + 1;
    const sendState = snaps.status();
    mount(body,
      h('section.card.club-head',
        h('div.row.space',
          h('div', h('div.kicker', 'You'), h('h2.handle', `@${S.profile.handle}`)),
          h('div.club-points', h('div.mono.pts', String(mine ? mine.points : c.points)), h('div.small.muted', rank ? `points · #${rank}` : 'points'))),
        S.offline ? h('p.small.warn-text', 'Offline: showing what this phone last saw.') : null,
        h('div.row',
          h('button.btn.primary', { onclick: () => navigate('#/snap') }, icon('camera'), 'Take photos'),
          h('button.btn', { onclick: () => navigate('#/') }, icon('layers'), 'Upload a scan')),
        h('p.small.muted', 'Take sharp photos of a space, walking around it so each wall is seen from several spots. A full scan from the home screen counts for more.'),
        h('p.small.mono.muted', [
          `${c.waiting} waiting to send`, `${c.sent} in review`, `${c.accepted} accepted`, c.rejected ? `${c.rejected} rejected` : null, c.failed ? `${c.failed} failed` : null,
        ].filter(Boolean).join(' · ')),
        sendState.blocked === 'banned' ? h('p.small.warn-text', 'This profile has been paused by the club.') : null,
        c.waiting && navigator.onLine === false ? h('p.small.muted', 'Offline: photos will send when you have a connection.') : null,
        c.waiting && navigator.onLine !== false && !sendState.running ? h('button.btn.small', { onclick: () => snaps.kick() }, icon('upload'), 'Send now') : null),

      h('button.club-card', { onclick: () => navigate('#/campus') },
        icon('map'),
        h('div.club-card-body', h('div.club-card-title', 'Campus map'), h('div.small.muted', 'Which buildings and spaces still need photos, and in what light')),
        icon('chevron', 'dim')),

      S.missions && S.missions.length
        ? h('section.card',
            h('div.card-head', h('h2', 'Missions'), h('span.mono.muted', String(S.missions.length).padStart(2, '0'))),
            S.missions.map(missionCard))
        : null,

      h('section.card',
        h('div.card-head', h('h2', 'Leaderboard'), icon('trophy', 'dim')),
        h('div.seg',
          ['week', 'all'].map((p) => h('button.seg-btn' + (S.period === p ? '.active' : ''), { onclick: () => { S.period = p; renderMember(); } }, p === 'week' ? 'This week' : 'All time'))),
        board()),

      S.snaps.length
        ? h('section.card',
            h('div.card-head', h('h2', 'My photos'), h('span.mono.muted', String(S.snaps.length))),
            h('div.snap-grid', S.snaps.slice(0, 24).map(snapCell)),
            S.snaps.length > 24 ? h('p.small.muted', `Showing the latest 24 of ${S.snaps.length}.`) : null)
        : null,

      h('section.card',
        h('details',
          h('summary', 'How points work, and the rules'),
          h('ul.small.rules', POINTS_HELP.map((t) => h('li', t))),
          h('h4', 'Rules'),
          h('ol.small.rules', RULES.map((r) => h('li', r))),
          h('p.small.muted', 'A photo only counts after the club has looked at it. Points appear then.'))),

      h('section.danger-zone', h('button.btn.small.danger', { onclick: leave }, icon('trash'), 'Leave the club and delete my data')),
    );
  }

  function board() {
    const rows = S.board[S.period];
    if (!rows) return h('p.small.muted', 'Loading…');
    if (!rows.length || rows.every((r) => !r.points)) return h('p.small.muted', S.period === 'week' ? 'No points yet this week. Be first.' : 'No points yet. Be first.');
    const me = S.profile.handle.toLowerCase();
    return h('ol.board', rows.slice(0, 15).map((r, i) =>
      h('li.board-row' + (r.handle.toLowerCase() === me ? '.me' : ''),
        h('span.rank.mono', String(i + 1)),
        h('span.who', `@${r.handle}`),
        h('span.small.muted.mono', [r.photos ? `${r.photos} photos` : null, r.scans ? `${r.scans} scans` : null].filter(Boolean).join(' · ')),
        h('span.mono.pts', String(r.points)))));
  }

  function missionCard(m) {
    const pct = Math.min(100, Math.round((m.done / m.wanted) * 100));
    const where = [m.building_code && bName(m.building_code), m.floor && `floor ${m.floor}`, m.room].filter(Boolean).join(' · ');
    return h('div.mission',
      h('div.row.space', h('b', m.title), h('span.tag.good', `+${m.bonus} each`)),
      m.detail ? h('p.small.muted', m.detail) : null,
      h('div.small.muted', [where, m.light !== 'any' ? `${LIGHT_LABEL[m.light]} light` : null].filter(Boolean).join(' · ')),
      h('div.bar', h('div.bar-fill', { style: { width: pct + '%' } })),
      h('div.row.space', h('span.small.mono.muted', `${m.done} of ${m.wanted} photos`), h('button.btn.small', { onclick: () => navigate(`#/snap?mission=${m.id}`) }, icon('camera'), 'Go')));
  }

  function snapCell(s) {
    const st = s.state === 'failed' ? ['bad', 'Failed'] : s.state !== 'done' ? ['', 'Waiting'] : s.serverStatus === 'accepted' ? ['good', `+${s.points}`] : s.serverStatus === 'rejected' ? ['bad', 'No'] : ['warn', 'Review'];
    return h('button.snap-cell', { onclick: () => snapSheet(s), 'aria-label': st[1] },
      s.thumb ? h('img', { src: thumbUrl(s), alt: '', loading: 'lazy' }) : h('div.snap-blank'),
      h('span.cell-tag.' + (st[0] || 'plain'), st[1]));
  }

  /** What happened to one photo, with the actions that make sense for it. */
  function snapSheet(s) {
    const why =
      s.state === 'failed' ? `Not sent: ${s.error || 'unknown problem'}`
        : s.state !== 'done' ? 'Waiting to send.'
        : s.serverStatus === 'accepted' ? `Accepted, +${s.points} points.${s.note ? ' ' + s.note : ''}`
        : s.serverStatus === 'rejected' ? `Not accepted${s.note ? ': ' + s.note : '.'}`
        : 'Sent. The club hasn’t reviewed it yet.';
    const back = h('div.modal-back', { onclick: (e) => e.target === back && back.remove() },
      h('div.modal',
        s.thumb ? h('img.sheet-img', { src: thumbUrl(s), alt: '' }) : null,
        h('p', `${s.building.name}${s.floor ? ` · floor ${s.floor}` : ''}${s.room ? ` · ${s.room}` : ''}`),
        h('p.small.muted', why),
        h('div.row.end',
          h('button.btn.ghost', { onclick: () => back.remove() }, 'Close'),
          s.state === 'failed' ? h('button.btn', { onclick: async () => { back.remove(); await snaps.retry(s.id); } }, 'Try again') : null,
          s.state !== 'done' || s.serverStatus !== 'accepted'
            ? h('button.btn.danger', { onclick: async () => { back.remove(); await snaps.remove(s.id); await loadLocal(); render(); } }, icon('trash'), 'Remove')
            : null)));
    document.body.appendChild(back);
  }

  async function leave() {
    if (!(await confirmDialog('Leave the club? Your photos, scans and profile are deleted from the club database and from this phone. 3D models already built from them aren’t affected; ask the club if you want those removed.', 'Leave and delete', true))) return;
    const bar = h('p.small.mono', 'Working…');
    const back = h('div.modal-back', h('div.modal', h('h3', 'Leaving the club'), bar));
    document.body.appendChild(back);
    try {
      await club.leave((t) => (bar.textContent = t));
      await store.clearSnaps();
      S.profile = null;
      S.join = null;
      toast('You left the club and your data was deleted');
    } catch (e) {
      toast('Could not finish: ' + e.message, 5000);
    }
    back.remove();
    if (alive) render();
  }

  // ------------------------------------------------------------------ data
  async function loadLocal() {
    [S.counts, S.snaps] = await Promise.all([snaps.counts(), snaps.listSnaps()]);
  }

  async function loadMember() {
    await loadLocal();
    render();
    const [all, week, missions, rows] = await Promise.allSettled([club.leaderboard('all'), club.leaderboard('week'), club.missions(), snaps.refreshStatuses()]);
    if (!alive) return;
    S.board = { all: all.value || S.board.all, week: week.value || S.board.week };
    S.missions = missions.value || S.missions;
    if (rows.status === 'fulfilled') await loadLocal();
    render();
  }

  (async () => {
    S.buildings = new Map((await campus.buildings()).map((b) => [b.code, b]));
    try {
      S.profile = await club.myProfile({ fresh: true });
    } catch {
      S.offline = true; // keep the cached profile (if any)
    }
    S.asked = true;
    if (!alive) return;
    if (S.profile) await loadMember();
    else render();
  })();
  const unsub = snaps.subscribe(() => {
    if (!alive || !S.profile) return;
    loadLocal().then(() => alive && renderMember());
  });
  render();

  return () => {
    alive = false;
    unsub();
    for (const u of urls.values()) URL.revokeObjectURL(u);
  };
}
