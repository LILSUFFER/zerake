-- Zerake: profile table linking a signed-in user to their ClubGG ID.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  gg_id      text not null check (gg_id ~ '^[0-9]{5,10}$'),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user can read and change only their own row.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = user_id);

create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = user_id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
