-- Zerake: one ClubGG ID = one account; the ID is locked after the first deposit or cash out (support can change it).
create unique index if not exists profiles_gg_id_key on public.profiles (gg_id) where gg_id is not null;
create or replace function public.profiles_gg_lock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.gg_id is not null and new.gg_id is distinct from old.gg_id and coalesce(auth.role(), '') <> 'service_role'
     and (exists (select 1 from public.deposits where user_id = old.user_id) or exists (select 1 from public.withdrawals where user_id = old.user_id)) then
    raise exception 'ClubGG ID is locked after the first operation; change it through support';
  end if;
  return new;
end $$;
drop trigger if exists profiles_gg_lock on public.profiles;
create trigger profiles_gg_lock before update on public.profiles for each row execute function public.profiles_gg_lock();
