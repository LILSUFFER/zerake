-- Zerake staff queue: who took a deposit, who handled it, managers' usernames.
-- Run once in Supabase SQL Editor.
alter table public.staff    add column if not exists username     text;
alter table public.deposits add column if not exists claimed_by   uuid references auth.users (id);
alter table public.deposits add column if not exists claimed_name text;
alter table public.deposits add column if not exists claimed_at   timestamptz;
alter table public.deposits add column if not exists handled_by   uuid references auth.users (id);
alter table public.deposits add column if not exists handled_name text;
alter table public.deposits add column if not exists handled_at   timestamptz;
update public.staff set username = 'whoisfirst' where telegram_id = 5888605611 and username is null;
