// Runs crowd/supabase-setup.sql and crowd/supabase-beta.sql on a local Postgres (PGlite, Postgres compiled
// to WebAssembly) with just enough of Supabase stubbed (roles, auth.uid(), storage tables), then checks that
// the rules do what they say: who can add what, that points can only come from SplatStation, and so on.
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
console.log('both scripts ran, and the second run of beta.sql was fine');

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
await db.exec(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}');
  insert into public.invites (code, label, max_uses) values ('CLUB-TEST', 'test', 2), ('CLUB-OFF', 'off', 5);
  update public.invites set active = false where code = 'CLUB-OFF';
  insert into public.restricted_buildings (code, reason) values ('cereus-hall', 'residence hall');`);

/** Run SQL as a signed-in user, or as anon; returns {rows} or {error}. */
async function as(user, sql, params = []) {
  await db.exec(user === 'anon' ? 'set role anon' : `set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false)`);
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
// Files first: a phone can only delete a file while its photo row still exists.
r = await as(A, `delete from storage.objects where bucket_id = 'club-photos'`);
assert.equal(r.n, 1, 'deleting your own files');
r = await as(A, `delete from public.photos where user_id = '${A}'`);
assert.equal(r.n, 400, 'deleting your own photos');
r = await as(A, `delete from public.profiles where user_id = '${A}'`);
assert.equal(r.n, 1, 'leaving the club');
assert.ok(!(await as(A, 'select * from public.leaderboard')).rows.some((x) => x.handle === 'Desert_Fox'));
pass('400-a-day cap, bans, and leaving the club removes your photos, files and profile');

console.log(`\n${checks} groups of checks passed`);
await db.close();
