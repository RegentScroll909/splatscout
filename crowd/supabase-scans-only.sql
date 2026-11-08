-- SplatScout club: full scans only.
--
-- Run this AFTER supabase-beta.sql (and the campus scripts), in a NEW query (SQL Editor -> New query ->
-- paste -> Run). Safe to run again.
--
-- The club takes full scans only: one member scanning one space in one go gives a splat with one lighting
-- and one arrangement of the furniture; single photos from many people and times don't. Members send a scan
-- when the capture coach grades it B or better; SplatStation builds the splat, the club reviews it, and
-- approving it publishes it and awards the points.
--
-- What it changes
--   photos            no new single photos (members can still see and delete the ones they sent)
--   captures          a scan can only be added with grade A or B; review_note says why one wasn't approved
--   leaderboard,      points and counts from approved scans
--   leaderboard_week
--   missions_open     "done" counts approved scans of the mission's space since the mission started

-- ------------------------------------------------------------------------------------ no new photos
drop policy if exists "add own photos" on public.photos;
drop policy if exists "upload own club photos" on storage.objects;

-- ------------------------------------------------------------------------------------ scans: B or better
alter table public.captures add column if not exists review_note text check (length(review_note) <= 400);

drop policy if exists "add own captures" on public.captures;
create policy "add own captures" on public.captures for insert to authenticated
  with check (
    user_id = auth.uid() and status = 'uploading' and points = 0 and reviewed_at is null and review_note is null
    and grade in ('A', 'B')
    and exists (select 1 from public.profiles pr where pr.user_id = auth.uid() and not pr.banned)
    and not exists (select 1 from public.restricted_buildings r where r.code = building_code)
  );

-- ------------------------------------------------------------------------------------ what phones see
-- Same columns as before (photos stays, always 0), so an older app keeps working.
create or replace view public.leaderboard as
select p.handle,
       coalesce(ca.pts, 0)::int as points,
       0::int as photos,
       coalesce(ca.n, 0)::int as scans
from public.profiles p
left join (select user_id, sum(points) as pts, count(*) as n
           from public.captures where status = 'approved' group by user_id) ca on ca.user_id = p.user_id
where not p.banned
  and exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned)
order by points desc, p.handle
limit 200;

create or replace view public.leaderboard_week as
select p.handle,
       coalesce(ca.pts, 0)::int as points,
       0::int as photos,
       coalesce(ca.n, 0)::int as scans
from public.profiles p
left join (select user_id, sum(points) as pts, count(*) as n
           from public.captures
           where status = 'approved'
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
left join lateral (
  select count(*) as n from public.captures ca
  where ca.status = 'approved' and ca.building_code = m.building_code
    and (m.room = '' or lower(trim(ca.room)) = lower(trim(m.room)))
    and ca.created_at >= m.created_at) c on true
where m.active and (m.ends_at is null or m.ends_at > now())
  and exists (select 1 from public.profiles me where me.user_id = auth.uid() and not me.banned)
order by m.created_at desc;

revoke all on public.leaderboard, public.leaderboard_week, public.missions_open from anon;
grant select on public.leaderboard, public.leaderboard_week, public.missions_open to authenticated;

-- The result panel shows this one row when the whole script ran. ("Success. No rows returned" means a
-- different, older query ran: open a New query, paste this file's text, and run that.)
select 'SplatScout club takes scans only' as result,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'photos' and policyname = 'add own photos') as photo_uploads_open,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'captures' and column_name = 'review_note') as review_note_column;
