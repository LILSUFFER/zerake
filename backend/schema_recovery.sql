-- Zerake: emergency wallet change with a recovery code and a delay.
--  * The first wallet bind gives the player a one-time recovery code (only its hash is stored).
--  * Change with the code: takes effect after 48 hours; cash outs are frozen meanwhile; the player can cancel.
--  * Change through support (code lost): a manager/owner files it; takes effect after 7 days.
--  * Due changes are applied by the database itself (cron every 5 minutes).

create table if not exists public.player_security (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  code_hash      text not null,
  failed         int  not null default 0,
  failed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.player_security enable row level security;      -- server only

create table if not exists public.wallet_changes (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  chain         text not null check (chain in ('TRON', 'BSC', 'TON')),
  old_address   text,
  new_address   text not null,
  method        text not null check (method in ('code', 'support')),
  status        text not null default 'pending' check (status in ('pending', 'cancelled', 'done')),
  new_code_hash text,                      -- the code that replaces the old one when this change is done
  requested_by  text,                      -- 'player' or the manager's name
  requested_at  timestamptz not null default now(),
  effective_at  timestamptz not null,
  closed_at     timestamptz
);
create index if not exists wallet_changes_user on public.wallet_changes (user_id, status);
alter table public.wallet_changes enable row level security;
drop policy if exists "wallet_changes_own" on public.wallet_changes;
create policy "wallet_changes_own" on public.wallet_changes for select using (auth.uid() = user_id);

-- binding now goes through the server (it hands out the recovery code), not straight from the app
drop policy if exists "wallets_bind_once" on public.player_wallets;

-- apply the changes whose time has come
create or replace function public.apply_wallet_changes() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select * from public.wallet_changes where status = 'pending' and effective_at <= now() order by id loop
    insert into public.player_wallets (user_id, chain, address) values (r.user_id, r.chain, r.new_address)
      on conflict (user_id, chain) do update set address = excluded.address, created_at = now();
    if r.new_code_hash is not null then
      update public.player_security set code_hash = r.new_code_hash, failed = 0, updated_at = now() where user_id = r.user_id;
    elsif r.method = 'support' then
      delete from public.player_security where user_id = r.user_id;   -- the lost code dies; the player makes a new one in the app
    end if;
    update public.wallet_changes set status = 'done', closed_at = now() where id = r.id;
    insert into public.ops_log (op_id, kind, event, status, actor_id, actor_name, row_data)
      values ('WALLET-' || r.chain, 'deposit', 'wallet changed', 'done', r.user_id, r.requested_by, to_jsonb(r));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.apply_wallet_changes() from public, anon, authenticated;

select cron.unschedule('apply-wallet-changes') where exists (select 1 from cron.job where jobname = 'apply-wallet-changes');
select cron.schedule('apply-wallet-changes', '*/5 * * * *', $$select public.apply_wallet_changes()$$);
