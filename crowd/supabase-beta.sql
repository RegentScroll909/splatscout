-- SplatScout club beta: invite-only members, single photos, missions and the leaderboard.
--
-- Run this AFTER supabase-setup.sql, in a NEW query (SQL Editor → New query → paste → Run).
-- Safe to run again.
--
-- What it adds
--   invites, profiles       people join with an invite code and a handle; nothing can be uploaded without
--                           being a member (this also applies to scan uploads from supabase-setup.sql)
--   restricted_buildings    places that can't be photographed (residence halls, health, ...): enforced here
--   photos                  one row per photo, plus the private "club-photos" bucket for the files
--   missions                "we need this view, in this light" requests that give bonus points
--   leaderboard views       handles and points only; SplatStation (the secret key) awards the points

-- ------------------------------------------------------------------------------------ members
create table if not exists public.invites (
  code text primary key check (code = upper(code) and code ~ '^[A-Z0-9-]{4,24}$'),
  label text not null default '',
  max_uses int not null default 25 check (max_uses between 1 and 10000),
  uses int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security; -- no policies: only SplatStation and join_club() touch it

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  handle text not null check (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  invite_code text references public.invites (code) on delete set null,
  consent_version text not null,
  consent_at timestamptz not null default now(),
  banned boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_handle_key on public.profiles (lower(handle));
alter table public.profiles enable row level security;

drop policy if exists "see own profile" on public.profiles;
create policy "see own profile" on public.profiles for select to authenticated using (user_id = auth.uid());
drop policy if exists "delete own profile" on public.profiles;
create policy "delete own profile" on public.profiles for delete to authenticated using (user_id = auth.uid());

create table if not exists public.restricted_buildings (
  code text primary key,
  reason text not null default ''
);
alter table public.restricted_buildings enable row level security;
drop policy if exists "read restricted list" on public.restricted_buildings;
create policy "read restricted list" on public.restricted_buildings for select to authenticated using (true);

-- Joining: checks the invite code, makes the profile, counts the use. Running it again as a member
-- just returns the profile.
create or replace function public.join_club(p_handle text, p_code text, p_consent text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  inv public.invites%rowtype;
  prof public.profiles%rowtype;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select * into prof from public.profiles where user_id = me;
  if found then return to_jsonb(prof); end if;
  if p_handle is null or p_handle !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'A handle is 3 to 20 letters, numbers or underscores';
  end if;
  if coalesce(p_consent, '') = '' then raise exception 'Agree to the rules first'; end if;
  select * into inv from public.invites
    where code = upper(trim(coalesce(p_code, ''))) and active and uses < max_uses for update;
  if not found then raise exception 'That invite code isn''t valid, or it has been used up'; end if;
  begin
    insert into public.profiles (user_id, handle, invite_code, consent_version)
      values (me, p_handle, inv.code, p_consent) returning * into prof;
  exception when unique_violation then
    raise exception 'That handle is taken, try another';
  end;
  update public.invites set uses = uses + 1 where code = inv.code;
  return to_jsonb(prof);
end $$;
revoke all on function public.join_club(text, text, text) from public, anon;
grant execute on function public.join_club(text, text, text) to authenticated;

-- ------------------------------------------------------------------------------------ scans need membership
alter table public.captures add column if not exists points int not null default 0 check (points between 0 and 1000);
alter table public.captures add column if not exists reviewed_at timestamptz;

drop policy if exists "add own captures" on public.captures;
create policy "add own captures" on public.captures for insert to authenticated
  with check (
    user_id = auth.uid() and status = 'uploading' and points = 0 and reviewed_at is null
    and exists (select 1 from public.profiles pr where pr.user_id = auth.uid() and not pr.banned)
    and not exists (select 1 from public.restricted_buildings r where r.code = building_code)
  );

-- A phone may only change the status of its own capture (finishing the upload), never its points.
revoke update on public.captures from anon, authenticated;
grant update (status) on public.captures to authenticated;

-- ------------------------------------------------------------------------------------ missions
create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null check (length(title) between 3 and 80),
  detail text not null default '' check (length(detail) <= 400),
  building_code text,
  floor text not null default '' check (length(floor) <= 20),
  room text not null default '' check (length(room) <= 80),
  light text not null default 'any' check (light in ('any', 'morning', 'afternoon', 'evening', 'night')),
  bonus int not null default 2 check (bonus between 0 and 50),   -- extra points per accepted photo
  wanted int not null default 20 check (wanted between 1 and 5000),
  active boolean not null default true,
  ends_at timestamptz
);
alter table public.missions enable row level security; -- phones read the missions_open view below

-- ------------------------------------------------------------------------------------ photos
create table if not exists public.photos (
  id uuid primary key,                                   -- made by the phone; also the file name
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  taken_at timestamptz not null,                         -- the phone's clock (SplatStation re-checks it)
  building_code text not null check (building_code ~ '^[a-z0-9-]{1,40}$'),
  building_name text not null check (length(building_name) <= 120),
  floor text not null default '' check (length(floor) <= 20),
  room text not null default '' check (length(room) <= 80),
  storage_path text not null unique,                     -- <building>/<floor-room>/<id>.jpg
  session text check (session ~ '^[0-9a-f-]{36}$'),      -- one outing: photos taken in one go
  mission_id uuid references public.missions (id) on delete set null,
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  gps_accuracy_m real,
  width int, height int, bytes int,
  device text check (length(device) <= 120),
  camera text check (length(camera) <= 120),
  sharp real, brightness real,                           -- measured on the phone
  phash text check (phash ~ '^[0-9a-f]{16}$'),
  light text check (light in ('morning', 'afternoon', 'evening', 'night')),
  status text not null default 'uploading' check (status in ('uploading', 'new', 'accepted', 'rejected')),
  points int not null default 0 check (points between 0 and 1000),
  review_note text,
  reviewed_at timestamptz,
  file_removed boolean not null default false,           -- the file was moved to the club PC and deleted here
  constraint photo_path check (
    storage_path ~ '^[a-z0-9-]{1,40}/[a-z0-9-]{1,100}/[0-9a-f-]{36}\.jpg$'
    and starts_with(storage_path, building_code || '/')
    and right(storage_path, 40) = id::text || '.jpg')
);
create index if not exists photos_place on public.photos (building_code, floor, room);
create index if not exists photos_status on public.photos (status);
create index if not exists photos_user on public.photos (user_id, created_at);

alter table public.photos enable row level security;

drop policy if exists "add own photos" on public.photos;
create policy "add own photos" on public.photos for insert to authenticated
  with check (
    user_id = auth.uid() and status = 'uploading' and points = 0
    and reviewed_at is null and review_note is null and not file_removed
    and exists (select 1 from public.profiles pr where pr.user_id = auth.uid() and not pr.banned)
    and not exists (select 1 from public.restricted_buildings r where r.code = building_code)
    -- at most 400 a day from one phone: a runaway app or a script can't fill the storage
    and (select count(*) from public.photos p where p.user_id = auth.uid() and p.created_at > now() - interval '24 hours') < 400
  );

drop policy if exists "see own photos" on public.photos;
create policy "see own photos" on public.photos for select to authenticated using (user_id = auth.uid());

drop policy if exists "finish own photos" on public.photos;
create policy "finish own photos" on public.photos for update to authenticated
  using (user_id = auth.uid() and status = 'uploading')
  with check (user_id = auth.uid() and status in ('uploading', 'new'));

drop policy if exists "delete own photos" on public.photos;
create policy "delete own photos" on public.photos for delete to authenticated using (user_id = auth.uid());

revoke update on public.photos from anon, authenticated;
grant update (status) on public.photos to authenticated;

-- The files: a private bucket, JPEG only, 5 MB each.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('club-photos', 'club-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "upload own club photos" on storage.objects;
create policy "upload own club photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'club-photos' and exists (
    select 1 from public.photos p
    where p.user_id = auth.uid() and p.status = 'uploading' and p.storage_path = objects.name));

drop policy if exists "see own club photos" on storage.objects;
create policy "see own club photos" on storage.objects for select to authenticated
  using (bucket_id = 'club-photos' and exists (
    select 1 from public.photos p where p.user_id = auth.uid() and p.storage_path = objects.name));

drop policy if exists "delete own club photos" on storage.objects;
create policy "delete own club photos" on storage.objects for delete to authenticated
  using (bucket_id = 'club-photos' and exists (
    select 1 from public.photos p where p.user_id = auth.uid() and p.storage_path = objects.name));

-- ------------------------------------------------------------------------------------ what phones see
-- Views run with the owner's rights, so they can total everyone's points while exposing only a
-- handle and counts. Members only: anyone else (a stranger who signed in with the public key) sees nothing.
create or replace view public.leaderboard as
select p.handle,
       (coalesce(ph.pts, 0) + coalesce(ca.pts, 0))::int as points,
       coalesce(ph.n, 0)::int as photos,
       coalesce(ca.n, 0)::int as scans
from public.profiles p
left join (select user_id, sum(points) as pts, count(*) as n
           from public.photos where status = 'accepted' group by user_id) ph on ph.user_id = p.user_id
left join (select user_id, sum(points) as pts, count(*) as n
           from public.captures where status in ('approved', 'processed') group by user_id) ca on ca.user_id = p.user_id
where not p.banned
  and exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned)
order by points desc, p.handle
limit 200;

create or replace view public.leaderboard_week as
select p.handle,
       (coalesce(ph.pts, 0) + coalesce(ca.pts, 0))::int as points,
       coalesce(ph.n, 0)::int as photos,
       coalesce(ca.n, 0)::int as scans
from public.profiles p
left join (select user_id, sum(points) as pts, count(*) as n
           from public.photos
           where status = 'accepted'
             and (reviewed_at at time zone 'America/Phoenix') >= date_trunc('week', now() at time zone 'America/Phoenix')
           group by user_id) ph on ph.user_id = p.user_id
left join (select user_id, sum(points) as pts, count(*) as n
           from public.captures
           where status in ('approved', 'processed')
             and (reviewed_at at time zone 'America/Phoenix') >= date_trunc('week', now() at time zone 'America/Phoenix')
           group by user_id) ca on ca.user_id = p.user_id
where not p.banned
  and exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned)
order by points desc, p.handle
limit 200;

create or replace view public.missions_open as
select m.id, m.title, m.detail, m.building_code, m.floor, m.room, m.light, m.bonus, m.wanted, m.ends_at,
       coalesce(c.n, 0)::int as done
from public.missions m
left join (select mission_id, count(*) as n
           from public.photos where status = 'accepted' and mission_id is not null
           group by mission_id) c on c.mission_id = m.id
where m.active and (m.ends_at is null or m.ends_at > now())
  and exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned)
order by m.created_at desc;

revoke all on public.leaderboard, public.leaderboard_week, public.missions_open from anon;
grant select on public.leaderboard, public.leaderboard_week, public.missions_open to authenticated;

-- Nothing here is for the bare public key.
revoke all on public.invites, public.profiles, public.restricted_buildings, public.missions, public.photos from anon;
revoke all on public.invites, public.missions from authenticated;

-- The result panel shows this one row when the whole script ran. ("Success. No rows returned" means a
-- different, older query ran: open a New query, paste this file's text, and run that.)
select 'SplatScout club beta is installed' as result,
       (select count(*) from public.restricted_buildings) as restricted_buildings,
       (select count(*) from public.profiles) as members;
