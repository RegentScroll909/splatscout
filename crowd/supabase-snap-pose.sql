-- SplatScout photo positions: Snap photos taken with "Track position (AR)" carry where the phone was.
--
-- Run this AFTER supabase-beta.sql, in a NEW query (SQL Editor -> New query -> paste -> Run).
-- Safe to run again.
--
-- A photo taken in AR keeps its AR camera pose (position and rotation in metres, in the coordinates of the AR
-- session it was taken in), the AR camera's lens, and that session's id. Within one session the poses are good
-- to centimetres, so SplatStation gives one session's poses to COLMAP as its starting cameras: the photos line
-- up faster and in metres. Until this runs, phones send AR photos without their positions.
--
-- What it changes
--   photos.pose   null for ordinary photos, else {"v": 1, "session": "<uuid>", "m": [16 numbers: camera-to-world,
--                 column-major, metres], "intr": {"fx", "fy", "cx", "cy", "w", "h"}, "t": seconds into the session}.
--                 Members write it only as part of adding their own photo (the "add own photos" rule: their own
--                 rows, members only, no restricted buildings, 400 a day) and can't change it afterwards: phones
--                 may only update a photo's status. Nobody else sees it: members see only their own photos.

alter table public.photos add column if not exists pose jsonb;

-- The shape, so a broken or oversized pose can't be stored. (A check that comes out unknown would pass, so
-- every part must be true.)
alter table public.photos drop constraint if exists photo_pose;
alter table public.photos add constraint photo_pose check (
  pose is null or coalesce(
    jsonb_typeof(pose) = 'object'
    and octet_length(pose::text) <= 1500
    and jsonb_typeof(pose -> 'session') = 'string' and (pose ->> 'session') ~ '^[0-9a-f-]{36}$'
    and case when jsonb_typeof(pose -> 'm') = 'array' then jsonb_array_length(pose -> 'm') = 16 else false end
    and not jsonb_path_exists(pose, '$.m[*] ? (@.type() != "number")')
    and jsonb_typeof(pose -> 'intr') = 'object'
    and jsonb_path_match(pose, '$.intr.fx.type() == "number" && $.intr.fy.type() == "number" && $.intr.cx.type() == "number"
                               && $.intr.cy.type() == "number" && $.intr.w.type() == "number" && $.intr.h.type() == "number"', '{}', true)
    and jsonb_path_match(pose, '$.intr.fx > 0 && $.intr.fy > 0 && $.intr.w > 0 && $.intr.h > 0', '{}', true),
    false)
);

-- (No new grants: adding a row already covers every column, and phones may update only "status".)

-- The result panel shows this one row when the whole script ran. ("Success. No rows returned" means a
-- different, older query ran: open a New query, paste this file's text, and run that.)
select 'SplatScout photo positions are installed' as result,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'photos' and column_name = 'pose')::int as pose_column,
       (select count(*) from pg_constraint where conname = 'photo_pose' and conrelid = 'public.photos'::regclass)::int as pose_check,
       (select count(*) from public.photos where pose is not null)::int as photos_with_positions;
