// Runs crowd/supabase-setup.sql, supabase-beta.sql, supabase-campus.sql, -campus-2.sql and -snap-pose.sql on a local Postgres (PGlite, Postgres
// compiled to WebAssembly) with just enough of Supabase stubbed (roles, auth.uid(), storage tables), then checks
// that the rules do what they say: who can add what, that points can only come from SplatStation, and so on.
// Not part of `npm run check` (the project has no dependencies). To run it:
//   npm install --no-save @electric-sql/pglite
//   node tools/sql-test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.log('This check needs PGlite: run  npm install --no-save @electric-sql/pglite  first.');
  process.exit(1);
}
const ROOT = new URL('../crowd/', import.meta.url);
const db = new PGlite();

await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid default auth.uid());
  alter table storage.objects enable row level security;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant all on storage.objects to authenticated, service_role;
  grant select on storage.buckets to authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);

const run = async (file) => db.exec(readFileSync(new URL(file, ROOT), 'utf8'));
await run('supabase-setup.sql');
await run('supabase-beta.sql');
await run('supabase-beta.sql'); // safe to run again
await run('supabase-campus.sql');
const campusResult = (await run('supabase-campus.sql')).at(-1).rows[0]; // safe to run again; ends with a result row
assert.deepEqual(campusResult, { result: 'SplatScout campus summary is installed', spaces: 0, plans: 0, member_rules: 2 });
await run('supabase-campus-2.sql');
const campus2 = (await run('supabase-campus-2.sql')).at(-1).rows[0]; // safe to run again too
assert.deepEqual(campus2, { result: 'SplatScout campus update 2 is installed', new_columns: 2 });
await run('supabase-snap-pose.sql');
const snapPose = (await run('supabase-snap-pose.sql')).at(-1).rows[0]; // safe to run again; ends with a result row
assert.deepEqual(snapPose, { result: 'SplatScout photo positions are installed', pose_column: 1, pose_check: 1, photos_with_positions: 0 });
console.log('the scripts ran, and second runs of beta.sql, campus.sql, campus-2.sql and snap-pose.sql were fine');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
  insert into public.invites (code, label, max_uses) values ('CLUB-TEST', 'test', 2), ('CLUB-OFF', 'off', 5);
  update public.invites set active = false where code = 'CLUB-OFF';
  insert into public.restricted_buildings (code, reason) values ('cereus-hall', 'residence hall');`);

/** Run SQL as a signed-in user, as anon, or as 'service' (SplatStation's secret key); returns {rows} or {error}. */
async function as(user, sql, params = []) {
  await db.exec(user === 'anon' ? 'set role anon' : user === 'service' ? 'set role service_role' : `set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false)`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows, n: r.affectedRows };
  } catch (e) {
    return { error: String(e.message) };
  } finally {
    await db.exec('reset role');
  }
}
const ok = (r, msg) => assert.ok(!r.error, `${msg}: ${r.error}`);
const fails = (r, msg, re) => {
  assert.ok(r.error, `${msg}: should have failed`);
  if (re) assert.match(r.error, re, msg);
};
let checks = 0;
const pass = (name) => (checks++, console.log('  ok', name));

const uuid = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const photoSql = (id, extra = {}) => {
  const f = { building_code: 'hayden-library', building_name: 'Hayden Library', floor: '1', room: 'lobby', ...extra };
  const path = `${f.building_code}/floor-${f.floor}-${f.room}/${id}.jpg`;
  return [`insert into public.photos (id, taken_at, building_code, building_name, floor, room, storage_path, session, width, height, bytes, phash, light${extra.status ? ', status' : ''}${extra.points != null ? ', points' : ''})
           values ($1, now(), $2, $3, $4, $5, $6, $7, 1920, 1080, 500000, '0123456789abcdef', 'evening'${extra.status ? `, '${extra.status}'` : ''}${extra.points != null ? `, ${extra.points}` : ''})`,
    [id, f.building_code, f.building_name, f.floor, f.room, path, uuid(999)]];
};
const pathOf = (id, code = 'hayden-library') => `${code}/floor-1-lobby/${id}.jpg`;

// ---- not a member yet
fails(await as(A, ...photoSql(uuid(1))), 'a non-member adds a photo', /row-level security/);
fails(await as(A, `insert into public.captures (id, building_code, building_name, storage_prefix, photo_count) values ('${uuid(2)}', 'hayden-library', 'Hayden', 'hayden-library/x/${uuid(2)}', 5)`), 'a non-member adds a scan', /row-level security/);
fails(await as('anon', 'select * from public.leaderboard'), 'anon reads the leaderboard', /permission denied/);
fails(await as('anon', `select public.join_club('anon_user', 'CLUB-TEST', 'beta-1')`), 'anon joins', /permission denied/);
pass('non-members can add nothing; the bare public key can read nothing');

// ---- joining
let r = await as(A, `select public.join_club('Desert_Fox', 'WRONG', 'beta-1') as p`);
fails(r, 'wrong code', /invite code/);
fails(await as(A, `select public.join_club('x', 'CLUB-TEST', 'beta-1')`), 'short handle', /3 to 20/);
fails(await as(A, `select public.join_club('Desert Fox!', 'CLUB-TEST', 'beta-1')`), 'bad characters', /3 to 20/);
fails(await as(A, `select public.join_club('Desert_Fox', 'CLUB-TEST', '')`), 'no consent', /Agree/);
fails(await as(A, `select public.join_club('Desert_Fox', 'CLUB-OFF', 'beta-1')`), 'switched-off code', /invite code/);
r = await as(A, `select public.join_club('Desert_Fox', ' club-test ', 'beta-1') as p`);
ok(r, 'join');
assert.equal(r.rows[0].p.handle, 'Desert_Fox');
assert.equal(r.rows[0].p.consent_version, 'beta-1');
r = await as(A, `select public.join_club('Other_Name', 'CLUB-TEST', 'beta-1') as p`);
assert.equal(r.rows[0].p.handle, 'Desert_Fox', 'joining again returns the existing profile');
assert.equal((await db.query(`select uses from public.invites where code = 'CLUB-TEST'`)).rows[0].uses, 1, 'one use counted');
fails(await as(B, `select public.join_club('desert_fox', 'CLUB-TEST', 'beta-1')`), 'handle taken (any case)', /taken/);
ok(await as(B, `select public.join_club('Sun_Devil', 'CLUB-TEST', 'beta-1')`), 'second member');
fails(await as(C, `select public.join_club('Third_One', 'CLUB-TEST', 'beta-1')`), 'invite used up', /invite code/);
r = await as(A, 'select * from public.profiles');
assert.equal(r.rows.length, 1, 'a member sees only their own profile');
pass('invite codes, handles (unique in any case), consent, use limits');

// ---- photos
ok(await as(A, ...photoSql(uuid(1))), 'member adds a photo row');
fails(await as(A, ...photoSql(uuid(3), { points: 50 })), 'photo with points', /row-level security/);
fails(await as(A, ...photoSql(uuid(4), { status: 'accepted' })), 'photo already accepted', /row-level security/);
fails(await as(A, ...photoSql(uuid(5), { building_code: 'cereus-hall', building_name: 'Cereus Hall' })), 'restricted building', /row-level security/);
fails(await as(A, `insert into public.photos (id, taken_at, building_code, building_name, storage_path) values ('${uuid(6)}', now(), 'hayden-library', 'H', 'hayden-library/x/${uuid(7)}.jpg')`), 'path not matching the id', /photo_path/);
fails(await as(A, `insert into public.photos (id, user_id, taken_at, building_code, building_name, storage_path) values ('${uuid(8)}', '${B}', now(), 'hayden-library', 'H', 'hayden-library/x/${uuid(8)}.jpg')`), "adding as someone else", /row-level security/);
pass('photo rows: own only, no points or status tricks, restricted buildings refused');

// files
ok(await as(A, `insert into storage.objects (bucket_id, name) values ('club-photos', '${pathOf(uuid(1))}')`), 'file for the row');
fails(await as(A, `insert into storage.objects (bucket_id, name) values ('club-photos', '${pathOf(uuid(77))}')`), 'file with no row', /row-level security/);
fails(await as(B, `insert into storage.objects (bucket_id, name) values ('club-photos', '${pathOf(uuid(1))}')`), "someone else's row", /row-level security/);
assert.equal((await as(B, `select * from storage.objects`)).rows.length, 0, "B can't list A's files");
assert.equal((await as(A, `select * from storage.objects`)).rows.length, 1, 'A lists own file');
pass('files go only into your own unfinished photo');

// finishing and column rules
r = await as(A, `update public.photos set status = 'new' where id = '${uuid(1)}'`);
ok(r, 'finish upload');
assert.equal(r.n, 1);
fails(await as(A, `insert into storage.objects (bucket_id, name) values ('club-photos', '${pathOf(uuid(1))}-2')`), 'file after finishing', /row-level security|photo/);
fails(await as(A, `update public.photos set points = 99 where id = '${uuid(1)}'`), 'edit own points', /permission denied/);
fails(await as(A, `update public.photos set review_note = 'great' where id = '${uuid(1)}'`), 'edit review note', /permission denied/);
r = await as(A, `update public.photos set status = 'accepted' where id = '${uuid(1)}'`);
assert.ok(r.error || r.n === 0, 'a phone must not accept its own photo');
assert.equal((await db.query(`select status from public.photos where id = '${uuid(1)}'`)).rows[0].status, 'new');
r = await as(B, `update public.photos set status = 'rejected' where id = '${uuid(1)}'`);
assert.ok(r.error || r.n === 0, "B can't touch A's photo");
assert.equal((await as(B, 'select * from public.photos')).rows.length, 0, "B can't see A's photos");
r = await as(B, `delete from public.photos where id = '${uuid(1)}'`);
assert.equal(r.n, 0, "B can't delete A's photo");
pass('phones can only finish their own upload; points, status and notes are SplatStation-only');

// ---- photo positions (supabase-snap-pose.sql): written with your own photo, never changed afterwards
const poseOf = (o = {}) => ({ v: 1, session: uuid(500), m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.4, -2.25, 1], intr: { fx: 1374.2, fy: 1374.2, cx: 430, cy: 960, w: 860, h: 1920 }, t: 12.5, ...o });
const posedSql = (id, pose, { code = 'hayden-library', user = null } = {}) => [`insert into public.photos (id, ${user ? 'user_id, ' : ''}taken_at, building_code, building_name, floor, room, storage_path, session, width, height, bytes, phash, light, pose)
   values ($1, ${user ? `'${user}', ` : ''}now(), $2, 'Somewhere', '1', 'lobby', $3, $4, 860, 1920, 400000, '0123456789abcdef', 'evening', $5::jsonb)`,
  [id, code, `${code}/floor-1-lobby/${id}.jpg`, uuid(999), pose == null ? null : JSON.stringify(pose)]];
ok(await as(B, ...posedSql(uuid(40), poseOf())), 'a member adds an AR photo with its position');
ok(await as(B, ...posedSql(uuid(41), null)), 'and an ordinary one without');
r = await as(B, `select pose from public.photos where id = '${uuid(40)}'`);
assert.deepEqual(r.rows[0].pose, poseOf(), 'the position is kept as sent');
assert.equal((await as(A, `select * from public.photos where id = '${uuid(40)}'`)).rows.length, 0, "nobody else sees it");
const badPoses = {
  'a pose that is a list': [1, 2, 3],
  'a pose that is text': 'here',
  'no session': poseOf({ session: undefined }),
  'a session that is not an id': poseOf({ session: 'my-session' }),
  'a session that is a number': poseOf({ session: 12 }),
  '15 numbers': poseOf({ m: Array(15).fill(0) }),
  'a word among the numbers': poseOf({ m: [...poseOf().m.slice(0, 15), 'x'] }),
  'm as one number': poseOf({ m: 3 }),
  'no lens': poseOf({ intr: undefined }),
  'a lens with no focal length': poseOf({ intr: { cx: 430, cy: 960, w: 860, h: 1920 } }),
  'a focal length of 0': poseOf({ intr: { ...poseOf().intr, fx: 0 } }),
  'a width as text': poseOf({ intr: { ...poseOf().intr, w: '860' } }),
  'an oversized pose': poseOf({ note: 'x'.repeat(1500) }),
};
let n = 50;
for (const [what, pose] of Object.entries(badPoses)) fails(await as(B, ...posedSql(uuid(n++), pose)), what, /photo_pose/);
fails(await as(B, `update public.photos set pose = null where id = '${uuid(40)}'`), 'clearing a position afterwards', /permission denied/);
fails(await as(B, `update public.photos set pose = $1::jsonb where id = '${uuid(41)}'`, [JSON.stringify(poseOf())]), 'adding one afterwards', /permission denied/);
fails(await as(B, ...posedSql(uuid(70), poseOf(), { code: 'cereus-hall' })), 'an AR photo of a restricted building', /row-level security/);
fails(await as(B, ...posedSql(uuid(71), poseOf(), { user: A })), "an AR photo in someone else's name", /row-level security/);
fails(await as(C, ...posedSql(uuid(72), poseOf())), 'an AR photo from someone who never joined', /row-level security/);
assert.equal((await db.query(`select count(*)::int as n from public.photos where pose is not null`)).rows[0].n, 1, 'only the one good position was stored');
await db.exec(`delete from public.photos where id in ('${uuid(40)}', '${uuid(41)}')`); // (the later checks count photos)
pass('photo positions: only with your own new photo, in the right shape, never changed afterwards; restricted places still refused');

// ---- the leaderboard (SplatStation awards points with the secret key: superuser here)
await db.exec(`update public.photos set status = 'accepted', points = 7, reviewed_at = now() where id = '${uuid(1)}'`);
r = await as(B, 'select * from public.leaderboard');
ok(r, 'leaderboard');
assert.deepEqual(r.rows.map((x) => [x.handle, x.points, x.photos, x.scans]), [['Desert_Fox', 7, 1, 0], ['Sun_Devil', 0, 0, 0]]);
r = await as(B, 'select * from public.leaderboard_week');
assert.equal(r.rows[0].points, 7, 'counts this week');
await db.exec(`update public.photos set reviewed_at = now() - interval '20 days' where id = '${uuid(1)}'`);
r = await as(B, 'select * from public.leaderboard_week');
assert.equal(r.rows[0].points, 0, "last month's points are not this week's");
assert.equal((await as(B, 'select * from public.leaderboard')).rows[0].points, 7);
fails(await as(B, 'select user_id from public.leaderboard'), 'view exposes ids', /column/);
assert.equal((await as(C, 'select * from public.leaderboard')).rows.length, 0, 'a stranger sees no leaderboard');
assert.equal((await as(C, 'select * from public.leaderboard_week')).rows.length, 0);
pass('leaderboard: handles and points only, all-time and this week, members only');

// ---- scans: members only, points only from SplatStation
ok(await as(A, `insert into public.captures (id, building_code, building_name, storage_prefix, photo_count) values ('${uuid(20)}', 'hayden-library', 'Hayden Library', 'hayden-library/floor-1-lobby/${uuid(20)}', 40)`), 'member adds a scan');
fails(await as(A, `update public.captures set points = 500 where id = '${uuid(20)}'`), 'scan points', /permission denied/);
ok(await as(A, `update public.captures set status = 'new' where id = '${uuid(20)}'`), 'finish scan');
await db.exec(`update public.captures set status = 'approved', points = 40, reviewed_at = now() where id = '${uuid(20)}'`);
r = await as(B, 'select * from public.leaderboard');
assert.deepEqual(r.rows[0], { handle: 'Desert_Fox', points: 47, photos: 1, scans: 1 });
fails(await as(A, `insert into public.captures (id, building_code, building_name, storage_prefix, photo_count) values ('${uuid(21)}', 'cereus-hall', 'Cereus Hall', 'cereus-hall/x/${uuid(21)}', 40)`), 'scan of a restricted building', /row-level security/);
pass('scans: same membership and restricted-place rules, points only from SplatStation');

// ---- missions
await db.exec(`insert into public.missions (title, building_code, light, bonus, wanted) values ('Hayden lobby at night', 'hayden-library', 'night', 3, 10),
                                                    ('Ended mission', null, 'any', 1, 5);
               update public.missions set ends_at = now() - interval '1 day' where title = 'Ended mission';`);
r = await as(A, 'select * from public.missions_open');
assert.equal(r.rows.length, 1);
assert.deepEqual([r.rows[0].title, r.rows[0].bonus, r.rows[0].done], ['Hayden lobby at night', 3, 0]);
fails(await as(A, 'select * from public.missions'), 'reading the missions table', /permission denied/);
assert.equal((await as(C, 'select * from public.missions_open')).rows.length, 0, 'strangers see no missions');
fails(await as(A, `insert into public.missions (title) values ('my own mission')`), 'adding a mission', /permission denied/);
pass('missions: members read open ones with progress; only SplatStation writes them');

// ---- the campus summary: SplatStation publishes it with the secret key, members read it
const spaceRow = (o = {}) => ({ space_key: 'hayden-library|1|main lobby', building_code: 'hayden-library', floor: '1', room: 'Main lobby', kind: 'large', score: 51, band: 'fair', evening: 90, need_good: 118, need_light: 'evening', ...o });
const upsert = (row) => {
  const cols = Object.keys(row);
  return [`insert into public.campus_spaces (${cols}) values (${cols.map((_, i) => '$' + (i + 1))})
           on conflict (space_key) do update set ${cols.map((col) => `${col} = excluded.${col}`)}`, Object.values(row)];
};
ok(await as('service', ...upsert(spaceRow())), 'the secret key publishes a space');
ok(await as('service', ...upsert(spaceRow({ score: 60, evening: 110 }))), 'and publishing again updates it');
ok(await as('service', `insert into public.campus_plans (building_code, spaces) values ('hayden-library', 4)`), 'and a building plan');
r = await as(A, 'select * from public.campus_spaces');
ok(r, 'a member reads the summary');
assert.deepEqual(r.rows.map((x) => [x.space_key, x.score, x.evening, x.morning, x.need_light]), [['hayden-library|1|main lobby', 60, 110, 0, 'evening']]);
assert.equal((await as(B, 'select * from public.campus_plans')).rows[0].spaces, 4);
assert.equal((await as(C, 'select * from public.campus_spaces')).rows.length, 0, 'a stranger (signed in, never joined) sees nothing');
assert.equal((await as(C, 'select * from public.campus_plans')).rows.length, 0);
fails(await as('anon', 'select * from public.campus_spaces'), 'anon reads the summary', /permission denied/);
fails(await as('anon', 'select * from public.campus_plans'), 'anon reads the plans', /permission denied/);
fails(await as(A, ...upsert(spaceRow({ space_key: 'old-main|1|hall', building_code: 'old-main' }))), 'a member adds a space', /permission denied/);
fails(await as(A, 'update public.campus_spaces set score = 100'), 'a member raises a score', /permission denied/);
fails(await as(A, 'delete from public.campus_spaces'), 'a member deletes the summary', /permission denied/);
fails(await as(A, `insert into public.campus_plans (building_code, spaces) values ('old-main', 1)`), 'a member sets a plan', /permission denied/);
fails(await as('service', ...upsert(spaceRow({ space_key: 'hayden-library|9|a', score: 101 }))), 'a score over 100', /check/);
fails(await as('service', ...upsert(spaceRow({ space_key: 'hayden-library|9|b', band: 'great' }))), 'an unknown band', /check/);
fails(await as('service', ...upsert(spaceRow({ space_key: 'hayden-library|9|c', need_light: 'dusk' }))), 'an unknown light', /check/);
fails(await as('service', ...upsert(spaceRow({ space_key: 'old-main|1|lobby' }))), 'a key from another building', /space_key_building/);
// A publish removes what it didn't send again (older rows).
ok(await as('service', ...upsert(spaceRow({ space_key: 'hayden-library|2|gone', room: 'Gone', updated_at: new Date(Date.now() - 864e5).toISOString() }))), 'an old row');
r = await as('service', `delete from public.campus_spaces where updated_at < now() - interval '1 hour'`);
assert.equal(r.n, 1, 'only the old row goes');
assert.equal((await as(A, 'select * from public.campus_spaces')).rows.length, 1);
// supabase-campus-2.sql: each space's floor area, and the club's floor counts instead of planned spaces.
ok(await as('service', ...upsert(spaceRow({ area: 400 }))), 'a space with the floor area it counts for');
ok(await as('service', `insert into public.campus_plans (building_code, floors) values ('memorial-union', 3)`), 'a floor count, with no planned-spaces count');
fails(await as('service', ...upsert(spaceRow({ space_key: 'hayden-library|9|d', area: 0 }))), 'an area of 0', /check/);
fails(await as('service', `insert into public.campus_plans (building_code, floors) values ('old-main', 0)`), 'no floors at all', /check/);
assert.deepEqual((await as(A, `select area from public.campus_spaces`)).rows, [{ area: 400 }]);
assert.equal((await as(B, `select floors from public.campus_plans where building_code = 'memorial-union'`)).rows[0].floors, 3, 'members read floor counts');
fails(await as(A, `update public.campus_plans set floors = 1`), 'a member changes a floor count', /permission denied/);
pass('campus summary: members read it, strangers and the bare public key see nothing, only the secret key writes');

// ---- the daily cap, bans, deleting your own data
await db.exec(`insert into public.photos (id, user_id, taken_at, building_code, building_name, storage_path, status)
               select ('bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0'))::uuid, '${A}', now(), 'hayden-library', 'Hayden Library',
                      'hayden-library/floor-1-lobby/bbbbbbbb-bbbb-4bbb-8bbb-' || lpad(g::text, 12, '0') || '.jpg', 'new'
               from generate_series(1, 399) g`);
fails(await as(A, ...photoSql(uuid(30))), 'the 401st photo in a day', /row-level security/);
ok(await as(B, ...photoSql(uuid(31))), 'the cap is per person');
await db.exec(`update public.profiles set banned = true where user_id = '${B}'`);
fails(await as(B, ...photoSql(uuid(32))), 'a banned member', /row-level security/);
assert.ok(!(await as(A, 'select * from public.leaderboard')).rows.some((x) => x.handle === 'Sun_Devil'), 'banned members leave the leaderboard');
assert.equal((await as(B, 'select * from public.campus_spaces')).rows.length, 0, 'and see no campus summary');
// Files first: a phone can only delete a file while its photo row still exists.
r = await as(A, `delete from storage.objects where bucket_id = 'club-photos'`);
assert.equal(r.n, 1, 'deleting your own files');
r = await as(A, `delete from public.photos where user_id = '${A}'`);
assert.equal(r.n, 400, 'deleting your own photos');
r = await as(A, `delete from public.profiles where user_id = '${A}'`);
assert.equal(r.n, 1, 'leaving the club');
assert.ok(!(await as(A, 'select * from public.leaderboard')).rows.some((x) => x.handle === 'Desert_Fox'));
assert.equal((await as(A, 'select * from public.campus_spaces')).rows.length, 0, 'having left, no campus summary either');
pass('400-a-day cap, bans, and leaving the club removes your photos, files and profile');

console.log(`\n${checks} groups of checks passed`);
await db.close();
