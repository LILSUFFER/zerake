-- Zerake: a personal TON deposit address for every player (USDT-TON and GRAM go to the same address).
-- Addresses are wallets v4 of the club TON key (TON_MNEMONIC) with different wallet ids: base 698983191 + 1000 + idx.
-- Money that arrives is credited to the owner of the address and stays there; payouts use whichever address holds enough.
create sequence if not exists public.ton_wallet_idx start 1;
create table if not exists public.ton_deposit_wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  idx        int  not null unique,
  address    text not null unique,          -- friendly, non-bounceable (UQ…)
  raw        text not null unique,          -- 0:HEX (upper case), the form toncenter returns
  created_at timestamptz not null default now()
);
alter table public.ton_deposit_wallets enable row level security;
drop policy if exists "ton_wallets_own" on public.ton_deposit_wallets;
create policy "ton_wallets_own" on public.ton_deposit_wallets for select using (auth.uid() = user_id);

-- deposits without a request (personal address): request_id may be empty
alter table public.deposits alter column request_id drop not null;

-- no scheduled sweeping: payouts are paid straight from the addresses that hold the money (like TRC20)
select cron.unschedule('ton-sweep') where exists (select 1 from cron.job where jobname = 'ton-sweep');

create or replace function public.next_ton_wallet_idx() returns bigint language sql security definer set search_path = public as $$ select nextval('public.ton_wallet_idx') $$;
revoke all on function public.next_ton_wallet_idx() from public, anon, authenticated;
