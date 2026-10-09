-- Zerake TRC20 deposits (PokerOK-style): address pool, deposit requests, scanner settings.
-- Run once in Supabase SQL Editor. TEST networks first (TRON Nile). BEP20 is left untouched.

-- Chain settings -------------------------------------------------------------------------
create table if not exists public.chain_config (
  network         text primary key check (network in ('TRC20', 'BEP20')),
  enabled         boolean not null default true,
  rpc_url         text not null,           -- BEP20: JSON-RPC url; TRC20: TronGrid base url
  usdt_contract   text not null,
  decimals        int  not null,
  confirmations   int  not null default 12,
  min_deposit     numeric(18,6) not null default 10,
  max_deposit     numeric(18,2) not null default 50000,
  request_ttl_min int  not null default 30,        -- how long a deposit request is valid
  pool_full_at    numeric(18,2) not null default 5000,  -- an address counts as full at this balance
  explorer_tx     text not null
);
create table if not exists public.scan_state (
  network    text primary key references public.chain_config (network),
  cursor     bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.staff (
  telegram_id bigint primary key,
  role        text not null default 'owner' check (role in ('owner', 'cashier'))
);

-- TRC20 address pool: one address receives until it is "full", then the next one ----------
create sequence if not exists public.pool_index_seq start 1000000;   -- apart from personal-address indexes
create or replace function public.next_pool_index() returns bigint
  language sql security definer set search_path = public as $$ select nextval('public.pool_index_seq') $$;
revoke all on function public.next_pool_index() from public, anon, authenticated;
grant execute on function public.next_pool_index() to service_role;

create table if not exists public.trc_pool (
  derivation_index bigint primary key,
  address          text not null unique,
  status           text not null default 'receiving' check (status in ('receiving', 'full')),
  received_total   numeric(18,6) not null default 0,
  created_at       timestamptz not null default now(),
  filled_at        timestamptz
);

-- A deposit request: "I want to pay about X". The unique tail of the amount identifies the payment.
create table if not exists public.deposit_requests (
  id          bigint generated always as identity primary key,
  request_no  text not null unique,
  user_id     uuid not null references auth.users (id) on delete cascade,
  network     text not null default 'TRC20',
  address     text not null,
  base_amount numeric(18,6) not null,
  amount      numeric(18,6) not null,           -- base + unique tail: the exact amount to send
  status      text not null default 'open' check (status in ('open', 'paid', 'expired', 'closed')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  tx_hash     text
);
-- Two live requests can never share the same address and exact amount.
create unique index if not exists deposit_requests_live_amount
  on public.deposit_requests (address, amount) where status in ('open', 'expired');
create index if not exists deposit_requests_user on public.deposit_requests (user_id, created_at desc);

-- Payments that match no request: staff sorts them out by hand.
create table if not exists public.unmatched_deposits (
  id           bigint generated always as identity primary key,
  network      text not null,
  tx_hash      text not null,
  address      text not null,
  from_address text,
  amount       numeric(18,6) not null,
  seen_at      timestamptz not null default now(),
  resolved     boolean not null default false,
  unique (network, tx_hash)
);

-- Link a recorded deposit to where it arrived and to its request.
alter table public.deposits add column if not exists to_address text;
alter table public.deposits add column if not exists request_id bigint;
alter table public.deposits drop constraint if exists deposits_status_check;
alter table public.deposits add  constraint deposits_status_check check (status in ('received', 'chips_sent', 'below_min'));

-- Add a received amount to its pool address; mark the address full at the threshold.
create or replace function public.pool_credit(p_address text, p_amount numeric) returns text
  language plpgsql security definer set search_path = public as $$
declare v_full numeric; v_status text;
begin
  select pool_full_at into v_full from public.chain_config where network = 'TRC20';
  update public.trc_pool set
    received_total = received_total + p_amount,
    filled_at = case when status = 'receiving' and received_total + p_amount >= coalesce(v_full, 5000) then now() else filled_at end,
    status    = case when received_total + p_amount >= coalesce(v_full, 5000) then 'full' else status end
  where address = p_address returning status into v_status;
  return v_status;
end $$;
revoke all on function public.pool_credit(text, numeric) from public, anon, authenticated;
grant execute on function public.pool_credit(text, numeric) to service_role;

-- Access: server only, except that a player can read their own requests -------------------
alter table public.chain_config       enable row level security;
alter table public.scan_state         enable row level security;
alter table public.staff              enable row level security;
alter table public.trc_pool           enable row level security;
alter table public.deposit_requests   enable row level security;
alter table public.unmatched_deposits enable row level security;
drop policy if exists "requests_select_own" on public.deposit_requests;
create policy "requests_select_own" on public.deposit_requests for select using (auth.uid() = user_id);

-- TEST settings. BEP20 stays switched off until we work on it. -------------------------------
insert into public.chain_config (network, enabled, rpc_url, usdt_contract, decimals, confirmations, min_deposit, explorer_tx) values
  ('BEP20', false, 'https://bsc-testnet-rpc.publicnode.com', '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', 18, 12, 10, 'https://testnet.bscscan.com/tx/'),
  ('TRC20', true,  'https://nile.trongrid.io',               'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj',          6, 19, 10, 'https://nile.tronscan.org/#/transaction/')
on conflict (network) do nothing;
insert into public.scan_state (network) values ('BEP20'), ('TRC20') on conflict do nothing;
insert into public.staff (telegram_id, role) values (5888605611, 'owner') on conflict do nothing;

-- Scheduler: run the scanner every minute -----------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('scan-deposits') where exists (select 1 from cron.job where jobname = 'scan-deposits');
select cron.schedule('scan-deposits', '* * * * *', $$
  select net.http_post(
    url     := 'https://saeekxoecwudpyixctab.supabase.co/functions/v1/scan-deposits',
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_EZAanXHojDg0NOdZovTqlw_OPS0oVyn","Authorization":"Bearer sb_publishable_EZAanXHojDg0NOdZovTqlw_OPS0oVyn"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
