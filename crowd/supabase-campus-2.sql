-- SplatScout campus summary, update 2: building completion by floor area.
--
-- Run this AFTER supabase-campus.sql, in a NEW query (SQL Editor -> New query -> paste -> Run).
-- Safe to run again.
--
-- A building's completion is now the share of its floor area (footprint x floors) that its spaces cover,
-- so phones need each space's floor area and the floor counts the club set. Until this runs, SplatStation
-- publishes without them and phones use typical sizes (a room 60 m², a hallway 150 m², a lobby 400 m²) and
-- OpenStreetMap's floor counts.
--
-- What it changes
--   campus_spaces.area    the floor area (m²) a space counts for: measured by a scan, set by the club, or
--                         typical for its size
--   campus_plans.floors   the club's own number of floors for a building
--   campus_plans.spaces   the old "planned spaces" count, no longer used (now optional)

alter table public.campus_spaces add column if not exists area int check (area between 1 and 100000);
alter table public.campus_plans add column if not exists floors int check (floors between 1 and 60);
alter table public.campus_plans alter column spaces drop not null;

-- The result panel shows this one row when the whole script ran. ("Success. No rows returned" means a
-- different, older query ran: open a New query, paste this file's text, and run that.)
select 'SplatScout campus update 2 is installed' as result,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and ((table_name = 'campus_spaces' and column_name = 'area')
                                         or (table_name = 'campus_plans' and column_name = 'floors'))) as new_columns;
