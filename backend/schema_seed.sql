-- Zerake: secret phrase (12 words, BIP39) instead of a short code.
--  * code_hash now holds the hash of the phrase (no user id inside), so a phrase finds its account.
--  * restore: a new Telegram account + the phrase takes over the old account (ClubGG ID, wallets, history).
--    Cash outs are frozen for 48 hours after a restore.
alter table public.player_security add column if not exists restored_at timestamptz;
update public.player_security set code_hash = null;            -- old short codes are retired (phrases replace them)
create unique index if not exists player_security_code_key on public.player_security (code_hash) where code_hash is not null;

create or replace function public.transfer_account(p_old uuid, p_new uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if p_old = p_new then return; end if;
  -- the new account must be empty
  if exists (select 1 from public.player_wallets where user_id = p_new)
     or exists (select 1 from public.deposits where user_id = p_new)
     or exists (select 1 from public.withdrawals where user_id = p_new)
     or exists (select 1 from public.profiles where user_id = p_new and gg_id is not null) then
    raise exception 'account not empty';
  end if;
  delete from public.profiles where user_id = p_new;
  delete from public.player_security where user_id = p_new;
  update public.profiles         set user_id = p_new where user_id = p_old;
  update public.player_wallets   set user_id = p_new where user_id = p_old;
  update public.player_security  set user_id = p_new, restored_at = now(), pin_hash = null, pin_failed = 0 where user_id = p_old;
  update public.deposits         set user_id = p_new where user_id = p_old;
  update public.withdrawals      set user_id = p_new where user_id = p_old;
  update public.deposit_requests set user_id = p_new where user_id = p_old;
  update public.wallet_changes   set user_id = p_new where user_id = p_old;
  insert into public.ops_log (op_id, kind, event, status, actor_id, actor_name, row_data)
    values ('ACCOUNT', 'deposit', 'account restored with the secret phrase', null, p_new, 'player', jsonb_build_object('from', p_old, 'to', p_new));
end $$;
revoke all on function public.transfer_account(uuid, uuid) from public, anon, authenticated;
