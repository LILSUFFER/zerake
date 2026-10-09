-- Zerake wallet v2: two networks (TRC20 and BEP20). Run once in Supabase SQL Editor.
-- Safe to run on the test tables from schema_wallet.sql (they are empty).

-- 1) One personal deposit address per player and network ------------------------------
drop table if exists public.deposit_addresses;
create table public.deposit_addresses (
  user_id          uuid   not null references auth.users (id) on delete cascade,
  network          text   not null check (network in ('TRC20', 'BEP20')),
  address          text   not null,
  derivation_index bigint not null,
  created_at       timestamptz not null default now(),
  primary key (user_id, network),
  unique (network, address),
  unique (network, derivation_index)
);
alter table public.deposit_addresses enable row level security;
create policy "addr_select_own" on public.deposit_addresses for select using (auth.uid() = user_id);

-- Index counter for address derivation (server only).
create sequence if not exists public.deposit_index_seq start 1;
create or replace function public.next_deposit_index() returns bigint
  language sql security definer set search_path = public as $$ select nextval('public.deposit_index_seq') $$;
revoke all on function public.next_deposit_index() from public, anon, authenticated;
grant execute on function public.next_deposit_index() to service_role;

-- 2) Deposits and withdrawals know their network ---------------------------------------
alter table public.deposits    add column if not exists network text not null default 'TRC20';
alter table public.deposits    add column if not exists from_address text;
alter table public.withdrawals add column if not exists network text not null default 'TRC20';

alter table public.deposits    drop constraint if exists deposits_network_check;
alter table public.deposits    add  constraint deposits_network_check check (network in ('TRC20', 'BEP20'));
alter table public.withdrawals drop constraint if exists withdrawals_network_check;
alter table public.withdrawals add  constraint withdrawals_network_check check (network in ('TRC20', 'BEP20'));

-- The same tx hash may exist on different networks, so uniqueness is per network.
alter table public.deposits drop constraint if exists deposits_tx_hash_key;
alter table public.deposits drop constraint if exists deposits_network_tx_hash_key;
alter table public.deposits add  constraint deposits_network_tx_hash_key unique (network, tx_hash);

-- Address format must match the chosen network.
alter table public.withdrawals drop constraint if exists withdrawals_address_check;
alter table public.withdrawals drop constraint if exists withdrawals_address_format;
alter table public.withdrawals add constraint withdrawals_address_format check (
  (network = 'TRC20' and address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or
  (network = 'BEP20' and address ~ '^0x[0-9a-fA-F]{40}$')
);
