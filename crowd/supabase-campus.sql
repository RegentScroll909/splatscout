-- SplatScout campus summary: what the club still needs photos of, for the phone's Campus map.
--
-- Run this AFTER supabase-beta.sql, in a NEW query (SQL Editor → New query → paste → Run).
-- Safe to run again.
--
-- SplatStation works out each space's expected splat quality on the club PC (from accepted photos, scans
-- and finished splats; the rules are in app/js/core/campusmodel.js) and publishes a summary here with the
-- secret key. Members' phones read it to colour the campus map and say what each space still needs.
-- Only counts and the names of spaces are published: no handles, no GPS points, no photos.
--
-- What it adds
--   campus_spaces   one row per space (building + floor + room): expected quality, accepted photos in
--                   each kind of light, and about how many more photos (in which light) would make it Good
--   campus_plans    the club's own plan for a building (how many spaces make it complete), where one is set

-- ------------------------------------------------------------------------------------ spaces
create table if not exists public.campus_spaces (
  space_key text primary key check (length(space_key) between 3 and 200), -- building|floor|room, as SplatStation matches them
  building_code text not null check (building_code ~ '^[a-z0-9-]{1,40}$'),
  floor text not null default '' check (length(floor) <= 20),
  room text not null check (length(room) between 1 and 80),
  kind text not null default 'room' check (kind in ('room', 'hallway', 'large')),
  score int not null check (score between 0 and 100),           -- expected quality of a splat, 0–100
  band text not null check (band in ('none', 'rough', 'fair', 'good', 'excellent')),
  morning int not null default 0 check (morning between 0 and 100000),     -- accepted photos in each kind of light
  afternoon int not null default 0 check (afternoon between 0 and 100000),
  evening int not null default 0 check (evening between 0 and 100000),
  night int not null default 0 check (night between 0 and 100000),
  pending int not null default 0 check (pending between 0 and 100000),     -- waiting for review
  scans int not null default 0 check (scans between 0 and 10000),
  builds int not null default 0 check (builds between 0 and 10000),        -- splats built on the club PC
  queued int not null default 0 check (queued between 0 and 10000),        -- captures waiting on the club PC
  need_good int not null default 0 check (need_good between 0 and 100000), -- about this many more photos make it Good
  need_excellent int not null default 0 check (need_excellent between 0 and 100000),
  need_light text check (need_light in ('morning', 'afternoon', 'evening', 'night')), -- ...in this light (null: any one)
  updated_at timestamptz not null default now(),
  constraint space_key_building check (starts_with(space_key, building_code || '|'))
);
create index if not exists campus_spaces_building on public.campus_spaces (building_code);

-- ------------------------------------------------------------------------------------ plans
create table if not exists public.campus_plans (
  building_code text primary key check (building_code ~ '^[a-z0-9-]{1,40}$'),
  spaces int not null check (spaces between 0 and 500),          -- 0 leaves a building out
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------------------ who sees what
-- Members read both (a stranger who signed in with the public key sees nothing, like the leaderboard);
-- nobody but SplatStation's secret key writes them.
alter table public.campus_spaces enable row level security;
alter table public.campus_plans enable row level security;

drop policy if exists "members read campus spaces" on public.campus_spaces;
create policy "members read campus spaces" on public.campus_spaces for select to authenticated
  using (exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned));

drop policy if exists "members read campus plans" on public.campus_plans;
create policy "members read campus plans" on public.campus_plans for select to authenticated
  using (exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned));

revoke all on public.campus_spaces, public.campus_plans from anon, authenticated;
grant select on public.campus_spaces, public.campus_plans to authenticated;
grant all on public.campus_spaces, public.campus_plans to service_role;

-- The result panel shows this one row when the whole script ran. ("Success. No rows returned" means a
-- different, older query ran: open a New query, paste this file's text, and run that.)
select 'SplatScout campus summary is installed' as result,
       (select count(*) from public.campus_spaces) as spaces,
       (select count(*) from public.campus_plans) as plans,
       (select count(*) from pg_policies where schemaname = 'public' and tablename in ('campus_spaces', 'campus_plans')) as member_rules;
