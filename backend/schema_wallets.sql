-- Zerake: bound wallets (one per chain, chosen before the first deposit, cannot be changed by the player).
-- Chains: TRON (USDT-TRC20), BSC (USDT-BEP20), TON (USDT-TON and GRAM).
create table if not exists public.player_wallets (
  user_id    uuid not null references auth.users (id) on delete cascade,
  chain      text not null check (chain in ('TRON', 'BSC', 'TON')),
  address    text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, chain),
  constraint player_wallets_format check (
    (chain = 'TRON' and address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or
    (chain = 'BSC'  and address ~ '^0x[0-9a-fA-F]{40}$') or
    (chain = 'TON'  and address ~ '^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$')
  )
);
alter table public.player_wallets enable row level security;
drop policy if exists "wallets_select_own" on public.player_wallets;
create policy "wallets_select_own" on public.player_wallets for select using (auth.uid() = user_id);
-- a player may add a wallet for a chain once; there is no update or delete policy, so it cannot be changed by them
drop policy if exists "wallets_bind_once" on public.player_wallets;
create policy "wallets_bind_once" on public.player_wallets for insert with check (auth.uid() = user_id);

-- one wallet can belong to only one player (stops several accounts sharing a payout wallet)
create unique index if not exists player_wallets_address_key on public.player_wallets (chain, lower(address));

-- deposits remember whether they came from the bound wallet
alter table public.deposits add column if not exists from_bound boolean;

-- every bind is logged too
create or replace function public.wallet_log() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.ops_log (op_id, kind, event, status, actor_id, actor_name, row_data)
  values ('WALLET-' || new.chain, 'deposit', 'wallet bound', null, new.user_id, 'player', to_jsonb(new));
  return new;
end $$;
drop trigger if exists player_wallets_log on public.player_wallets;
create trigger player_wallets_log after insert on public.player_wallets for each row execute function public.wallet_log();
