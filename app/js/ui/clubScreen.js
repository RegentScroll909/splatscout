// Club (beta): join with an invite code, see your points and rank, the leaderboard, missions and what the
// club made of your scans. The club takes full scans only: you scan from the home screen (or a mission's
// Scan here), and send it from its review screen once the coach grades it B or better.

import { h, mount, toast, confirmDialog, fmtDate } from './dom.js';
import { icon } from './icons.js';
import * as club from '../data/club.js';
import * as store from '../data/store.js';
import * as campus from '../data/campus.js';
import { RULES, CONSENT, DRAFT_NOTE, POINTS_HELP, LIGHT_LABEL, suggestHandles, validHandle } from '../core/clubrules.js';

/** "Scan here": the capture setup with the place filled in. */
export const scanUrl = ({ building_code, floor = '', room = '' }) =>
  '#/setup?' + new URLSearchParams({ building: building_code || '', floor: floor || '', room: room || '' });

/** What happened to one of your scans, as a tag: [class, text]. */
export function scanState(s) {
  if (s.status === 'approved') return ['good', `Approved · +${s.points || 0}`];
  if (s.status === 'rejected') return ['bad', 'Not approved'];
  if (s.status === 'processed') return ['warn', 'Being built and reviewed'];
  return ['', 'Waiting for the club'];
}

export async function clubScreen(root, { navigate, query }) {
  const S = { profile: club.cachedProfile(), asked: false, offline: false, period: 'week', board: {}, missions: null, scans: null, buildings: new Map() };
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
        h('p.small', 'Help build a 3D map of ASU: scan shared spaces with the capture coach, earn points, and see how you rank. The club reviews every scan before anything made from it is published.'),
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
    const mine = myRow();
    const rank = (S.board.all || []).findIndex((r) => r.handle.toLowerCase() === S.profile.handle.toLowerCase()) + 1;
    const scans = S.scans || [];
    const n = (st) => scans.filter((s) => s.status === st).length;
    mount(body,
      h('section.card.club-head',
        h('div.row.space',
          h('div', h('div.kicker', 'You'), h('h2.handle', `@${S.profile.handle}`)),
          h('div.club-points', h('div.mono.pts', String(mine ? mine.points : 0)), h('div.small.muted', rank ? `points · #${rank}` : 'points'))),
        S.offline ? h('p.small.warn-text', 'Offline: showing what this phone last saw.') : null,
        S.profile.banned ? h('p.small.warn-text', 'This profile has been paused by the club.') : null,
        h('div.row', h('button.btn.primary', { onclick: () => navigate('#/setup') }, icon('camera'), 'Start a scan')),
        h('p.small.muted', 'Scan one shared space in one go with the capture coach. When it grades B or better, send it from its review screen (Upload to the club). The club builds the splat, checks it, and your points come when it’s approved.'),
        scans.length ? h('p.small.mono.muted', [`${n('new') + n('processed')} in review`, `${n('approved')} approved`, n('rejected') ? `${n('rejected')} not approved` : null].filter(Boolean).join(' · ')) : null),

      h('button.club-card', { onclick: () => navigate('#/campus') },
        icon('map'),
        h('div.club-card-body', h('div.club-card-title', 'Campus map'), h('div.small.muted', 'Which buildings and spaces are on the map, and which still need a scan')),
        icon('chevron', 'dim')),

      S.missions && S.missions.length
        ? h('section.card',
            h('div.card-head', h('h2', 'Missions'), h('span.mono.muted', String(S.missions.length).padStart(2, '0'))),
            S.missions.map(missionCard))
        : null,

      h('section.card',
        h('div.card-head', h('h2', 'My scans'), S.scans ? h('span.mono.muted', String(scans.length)) : null),
        !S.scans ? h('p.small.muted', 'Loading…')
          : scans.length ? h('div.c-rows', scans.slice(0, 30).map(scanRow))
          : h('p.small.muted', 'None yet. Scans you send show up here, with what the club made of them.')),

      h('section.card',
        h('div.card-head', h('h2', 'Leaderboard'), icon('trophy', 'dim')),
        h('div.seg',
          ['week', 'all'].map((p) => h('button.seg-btn' + (S.period === p ? '.active' : ''), { onclick: () => { S.period = p; renderMember(); } }, p === 'week' ? 'This week' : 'All time'))),
        board()),

      h('section.card',
        h('details',
          h('summary', 'How points work, and the rules'),
          h('ul.small.rules', POINTS_HELP.map((t) => h('li', t))),
          h('h4', 'Rules'),
          h('ol.small.rules', RULES.map((r) => h('li', r))))),

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
        h('span.small.muted.mono', r.scans ? `${r.scans} scan${r.scans === 1 ? '' : 's'}` : ''),
        h('span.mono.pts', String(r.points)))));
  }

  function missionCard(m) {
    const where = [m.building_code && bName(m.building_code), m.floor && `floor ${m.floor}`, m.room].filter(Boolean).join(' · ');
    return h('div.mission',
      h('div.row.space', h('b', m.title), h('span.tag.good', `+${m.bonus}`)),
      m.detail ? h('p.small.muted', m.detail) : null,
      h('div.small.muted', [where, m.light !== 'any' ? `${LIGHT_LABEL[m.light]} light` : null].filter(Boolean).join(' · ')),
      h('div.row.space',
        h('span.small.mono.muted', m.done ? `Scanned ${m.done} time${m.done === 1 ? '' : 's'} since it started` : 'Nobody has scanned it yet'),
        m.building_code ? h('button.btn.small', { onclick: () => navigate(scanUrl(m)) }, icon('camera'), 'Scan here') : null));
  }

  function scanRow(s) {
    const [cls, text] = scanState(s);
    const where = [s.building_name, s.floor && `floor ${s.floor}`, s.room].filter(Boolean).join(' · ');
    return h('div.c-row',
      h('span.c-row-main',
        h('span.c-row-title', where || 'Scan'),
        h('span.c-row-meta', [`grade ${s.grade || '?'}`, `${s.photo_count} photos`, fmtDate(s.created_at)].join(' · ')),
        s.status === 'rejected' && s.review_note ? h('span.small.warn-text', s.review_note) : null),
      h('span.tag' + (cls ? '.' + cls : ''), text));
  }

  async function leave() {
    if (!(await confirmDialog('Leave the club? Your scans and profile are deleted from the club database (and any photos you sent before the club took scans only). 3D models already built from them aren’t affected; ask the club if you want those removed.', 'Leave and delete', true))) return;
    const bar = h('p.small.mono', 'Working…');
    const back = h('div.modal-back', h('div.modal', h('h3', 'Leaving the club'), bar));
    document.body.appendChild(back);
    try {
      await club.leave((t) => (bar.textContent = t));
      await store.clearSnaps(); // single photos from before the club took scans only
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
  async function loadMember() {
    render();
    const [all, week, missions, scans] = await Promise.allSettled([club.leaderboard('all'), club.leaderboard('week'), club.missions(), club.myScans()]);
    if (!alive) return;
    S.board = { all: all.value || S.board.all, week: week.value || S.board.week };
    S.missions = missions.value || S.missions;
    S.scans = scans.value || S.scans || [];
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
  render();

  return () => {
    alive = false;
  };
}
