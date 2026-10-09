-- Zerake wallet tables (TEST MODE first). Run in Supabase: SQL Editor -> New query -> Run.
-- Players can only READ their own rows. Money-moving writes happen in server functions
-- (service role), never from the browser, except the withdrawal *request* below.

create table if not exists public.deposit_addresses (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  network    text not null default 'TRC20',
  address    text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.deposits (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  tx_hash    text not null unique,               -- one chain transfer is counted once
  amount     numeric(18,6) not null check (amount > 0),
  status     text not null default 'received'    -- received -> chips_sent
             check (status in ('received', 'chips_sent')),
  created_at timestamptz not null default now()
);

create table if not exists public.withdrawals (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  amount     numeric(18,6) not null check (amount > 0),
  address    text not null check (address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$'),
  status     text not null default 'pending'     -- pending -> approved -> paid | rejected
             check (status in ('pending', 'approved', 'paid', 'rejected')),
  tx_hash    text,
  created_at timestamptz not null default now()
);

alter table public.deposit_addresses enable row level security;
alter table public.deposits          enable row level security;
alter table public.withdrawals       enable row level security;

create policy "addr_select_own"        on public.deposit_addresses for select using (auth.uid() = user_id);
create policy "deposits_select_own"    on public.deposits          for select using (auth.uid() = user_id);
create policy "withdrawals_select_own" on public.withdrawals       for select using (auth.uid() = user_id);

-- A player may file a withdrawal request for themselves, always as 'pending'.
-- Approval and payout are done only by the server with the service role.
create policy "withdrawals_request_own" on public.withdrawals
  for insert with check (auth.uid() = user_id and status = 'pending' and tx_hash is null);
