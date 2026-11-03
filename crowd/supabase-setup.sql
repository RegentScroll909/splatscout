-- SplatScout crowdsourcing: run this once in your Supabase project (SQL Editor → New query → Run).
-- Safe to run again.
--
-- Phones sign in anonymously (turn on "Allow anonymous sign-ins" first), add a row for each capture,
-- and upload its photos to the private "captures" bucket under <building>/<floor-room>/<capture id>/.
-- A phone can only see, finish and delete its own uploads. SplatStation uses the secret key to
-- review and download everyone's.

-- ------------------------------------------------------------------------------------ captures
create table if not exists public.captures (
  id uuid primary key,                                   -- made by the phone; also its folder name
  user_id uuid not null default auth.uid(),              -- the phone's anonymous sign-in
  created_at timestamptz not null default now(),
  building_code text not null check (building_code ~ '^[a-z0-9-]{1,40}$'),
  building_name text not null check (length(building_name) <= 120),
  floor text not null default '' check (length(floor) <= 20),
  room text not null default '' check (length(room) <= 80), -- room number or section name
  storage_prefix text not null unique,                   -- <building>/<floor-room>/<id>
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  gps_accuracy_m real,                                   -- metres, as the phone reported it
  photo_count int not null check (photo_count between 1 and 5000),
  grade text,
  mode text,
  device text,
  contributor text check (length(contributor) <= 60),
  manifest jsonb,                                        -- the capture's splatscout.json
  status text not null default 'uploading'
    check (status in ('uploading', 'new', 'approved', 'rejected', 'processed')),
  constraint prefix_matches check (
    storage_prefix ~ '^[a-z0-9-]{1,40}/[a-z0-9-]{1,100}/[0-9a-f-]{36}$'
    and starts_with(storage_prefix, building_code || '/')
    and right(storage_prefix, 36) = id::text)
);
create index if not exists captures_place on public.captures (building_code, floor, room);
create index if not exists captures_status on public.captures (status);

alter table public.captures enable row level security;

drop policy if exists "add own captures" on public.captures;
create policy "add own captures" on public.captures for insert to authenticated
  with check (user_id = auth.uid() and status = 'uploading');

drop policy if exists "see own captures" on public.captures;
create policy "see own captures" on public.captures for select to authenticated
  using (user_id = auth.uid());

-- Only to mark an upload finished ('uploading' → 'new'); approving is SplatStation's job.
drop policy if exists "finish own uploads" on public.captures;
create policy "finish own uploads" on public.captures for update to authenticated
  using (user_id = auth.uid() and status = 'uploading')
  with check (user_id = auth.uid() and status in ('uploading', 'new'));

drop policy if exists "delete own captures" on public.captures;
create policy "delete own captures" on public.captures for delete to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------------------------------ photos
-- Photos, plus the export's metadata: JSON, the COLMAP pose text files and the AR depth points (.ply).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('captures', 'captures', false, 20971520,
        array['image/jpeg', 'image/png', 'application/json', 'text/plain', 'application/octet-stream'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Files go only into a capture of yours that is still uploading.
drop policy if exists "upload into own captures" on storage.objects;
create policy "upload into own captures" on storage.objects for insert to authenticated
  with check (bucket_id = 'captures' and exists (
    select 1 from public.captures c
    where c.user_id = auth.uid() and c.status = 'uploading'
      and starts_with(objects.name, c.storage_prefix || '/')));

drop policy if exists "see own capture files" on storage.objects;
create policy "see own capture files" on storage.objects for select to authenticated
  using (bucket_id = 'captures' and exists (
    select 1 from public.captures c
    where c.user_id = auth.uid() and starts_with(objects.name, c.storage_prefix || '/')));

drop policy if exists "delete own capture files" on storage.objects;
create policy "delete own capture files" on storage.objects for delete to authenticated
  using (bucket_id = 'captures' and exists (
    select 1 from public.captures c
    where c.user_id = auth.uid() and starts_with(objects.name, c.storage_prefix || '/')));
