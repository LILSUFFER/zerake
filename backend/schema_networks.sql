-- Zerake: three networks (TRC20, BEP20, TON), generic address pool, withdrawals for the manager queue.
-- Run once in Supabase SQL Editor. Safe to run again.

-- 1) chain_config knows TON and the club's TON wallet ---------------------------------------------
alter table public.chain_config drop constraint if exists chain_config_network_check;
alter table public.chain_config add  constraint chain_config_network_check check (network in ('TRC20', 'BEP20', 'TON'));
alter table public.chain_config add column if not exists receive_address text;   -- TON: the club wallet that receives deposits

-- 2) deposits and withdrawals may be on any of the three networks ---------------------------------
alter table public.deposits drop constraint if exists deposits_network_check;
alter table public.deposits add  constraint deposits_network_check check (network in ('TRC20', 'BEP20', 'TON'));

alter table public.withdrawals drop constraint if exists withdrawals_network_check;
alter table public.withdrawals add  constraint withdrawals_network_check check (network in ('TRC20', 'BEP20', 'TON'));
alter table public.withdrawals drop constraint if exists withdrawals_address_format;
alter table public.withdrawals add  constraint withdrawals_address_format check (
  (network = 'TRC20' and address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or
  (network = 'BEP20' and address ~ '^0x[0-9a-fA-F]{40}$') or
  (network = 'TON'   and address ~ '^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$')
);
-- Manager handling of withdrawals (take it, then mark it paid with the transfer hash).
alter table public.withdrawals add column if not exists claimed_by   uuid references auth.users (id);
alter table public.withdrawals add column if not exists handled_by   uuid references auth.users (id);
alter table public.withdrawals add column if not exists claimed_name text;
alter table public.withdrawals add column if not exists claimed_at   timestamptz;
alter table public.withdrawals add column if not exists handled_name text;
alter table public.withdrawals add column if not exists handled_at   timestamptz;
alter table public.withdrawals add column if not exists note         text;

-- 3) one address pool for every network that uses addresses (TRC20, BEP20) ------------------------------
create table if not exists public.address_pool (
  network          text   not null check (network in ('TRC20', 'BEP20')),
  derivation_index bigint not null,
  address          text   not null,
  status           text   not null default 'receiving' check (status in ('receiving', 'full')),
  received_total   numeric(18,6) not null default 0,
  created_at       timestamptz not null default now(),
  filled_at        timestamptz,
  primary key (network, derivation_index),
  unique (network, address)
);
alter table public.address_pool enable row level security;
-- carry over the TRC20 addresses already in use
insert into public.address_pool (network, derivation_index, address, status, received_total, created_at, filled_at)
  select 'TRC20', derivation_index, address, status, received_total, created_at, filled_at from public.trc_pool
  on conflict do nothing;

create or replace function public.pool_credit(p_network text, p_address text, p_amount numeric) returns text
  language plpgsql security definer set search_path = public as $$
declare v_full numeric; v_status text;
begin
  select pool_full_at into v_full from public.chain_config where network = p_network;
  update public.address_pool set
    received_total = received_total + p_amount,
    filled_at = case when status = 'receiving' and received_total + p_amount >= coalesce(v_full, 5000) then now() else filled_at end,
    status    = case when received_total + p_amount >= coalesce(v_full, 5000) then 'full' else status end
  where network = p_network and address = p_address returning status into v_status;
  return v_status;
end $$;
revoke all on function public.pool_credit(text, text, numeric) from public, anon, authenticated;
grant execute on function public.pool_credit(text, text, numeric) to service_role;

-- 4) network settings (real networks) --------------------------------------------------------------
-- BEP20 on the real BNB Smart Chain. Restart its scan position (it held a test-network block number).
update public.chain_config set
  enabled = true, rpc_url = 'https://bsc-rpc.publicnode.com', usdt_contract = '0x55d398326f99059fF775485246999027B3197955',
  decimals = 18, confirmations = 12, explorer_tx = 'https://bscscan.com/tx/'
where network = 'BEP20';
update public.scan_state set cursor = 0 where network = 'BEP20';

-- TON: switched OFF until the club wallet address is filled in (receive_address).
insert into public.chain_config (network, enabled, rpc_url, usdt_contract, decimals, confirmations, min_deposit, explorer_tx, receive_address) values
  ('TON', false, 'https://toncenter.com', '0:B113A994B5024A16719F69139328EB759596C38A25F59028B146FECDC3621DFE', 6, 0, 10, 'https://tonviewer.com/transaction/', null)
on conflict (network) do nothing;
insert into public.scan_state (network) values ('TON') on conflict do nothing;

-- 5) Withdrawals are created by the server only (so managers are alerted and the rules are checked) ------
alter table public.chain_config add column if not exists min_withdraw numeric(18,6) not null default 10;
alter table public.chain_config add column if not exists max_withdraw numeric(18,2) not null default 50000;
drop policy if exists "withdrawals_request_own" on public.withdrawals;

-- 6) the first table version had a TRC20-only address check; the format check above replaces it
alter table public.withdrawals drop constraint if exists withdrawals_address_check;

-- 7) automatic payouts
alter table public.withdrawals drop constraint if exists withdrawals_status_check;
alter table public.withdrawals add  constraint withdrawals_status_check check (status in ('pending', 'approved', 'sending', 'paid', 'rejected'));
alter table public.withdrawals add column if not exists auto boolean not null default false;
alter table public.chain_config add column if not exists auto_max   numeric(18,2) not null default 3000;    -- one payout above this is paid by hand
alter table public.chain_config add column if not exists auto_daily numeric(18,2) not null default 20000;   -- automatic total per 24 hours
