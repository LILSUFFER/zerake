-- Zerake: operation numbers and a permanent operations log.
-- Every deposit and cash out gets a public number (DEP-YYMMDD-XXXXXXXXXX / WD-...).
-- Every change of a deposit or cash out is written to ops_log by the database itself, with the full row,
-- who did it and when. ops_log can only be added to: updates and deletes are refused.

create or replace function public.make_op_id(prefix text) returns text language sql volatile as $$
  select prefix || '-' || to_char(now() at time zone 'utc', 'YYMMDD') || '-' ||
         upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
$$;

alter table public.deposits    add column if not exists op_id text;
alter table public.withdrawals add column if not exists op_id text;
update public.deposits    set op_id = public.make_op_id('DEP') where op_id is null;
update public.withdrawals set op_id = public.make_op_id('WD')  where op_id is null;
alter table public.deposits    alter column op_id set default public.make_op_id('DEP');
alter table public.withdrawals alter column op_id set default public.make_op_id('WD');
alter table public.deposits    alter column op_id set not null;
alter table public.withdrawals alter column op_id set not null;
create unique index if not exists deposits_op_id_key    on public.deposits (op_id);
create unique index if not exists withdrawals_op_id_key on public.withdrawals (op_id);

create table if not exists public.ops_log (
  id         bigint generated always as identity primary key,
  op_id      text not null,
  kind       text not null check (kind in ('deposit', 'withdrawal')),
  event      text not null,               -- created, status:a->b, claimed, released, updated
  status     text,
  actor_id   uuid,
  actor_name text,
  amount     numeric(18,6),
  row_data   jsonb not null,               -- the full record after the change
  changed    jsonb,                        -- only the fields that changed (old values)
  at         timestamptz not null default now()
);
create index if not exists ops_log_op_id on public.ops_log (op_id);
create index if not exists ops_log_at    on public.ops_log (at desc);
alter table public.ops_log enable row level security;   -- no policies: only the server reads it

create or replace function public.ops_log_guard() returns trigger language plpgsql as $$
begin raise exception 'ops_log is append-only'; end $$;
drop trigger if exists ops_log_no_change on public.ops_log;
create trigger ops_log_no_change before update or delete on public.ops_log for each row execute function public.ops_log_guard();

create or replace function public.ops_log_write() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_kind text := case when tg_table_name = 'deposits' then 'deposit' else 'withdrawal' end;
  v_event text; v_changed jsonb; v_actor uuid; v_name text;
  n jsonb := to_jsonb(new); o jsonb;
begin
  if tg_op = 'INSERT' then
    v_event := 'created';
  else
    o := to_jsonb(old);
    select jsonb_object_agg(k, o -> k) into v_changed from jsonb_object_keys(n) k where (n -> k) is distinct from (o -> k);
    if v_changed is null then return new; end if;
    if new.status is distinct from old.status then v_event := 'status:' || old.status || '->' || new.status;
    elsif (n ->> 'claimed_by') is distinct from (o ->> 'claimed_by') then
      v_event := case when n ->> 'claimed_by' is null then 'released' else 'claimed' end;
    else v_event := 'updated'; end if;
  end if;
  -- who: the manager who finished it, otherwise the one who took it, otherwise the player
  v_actor := coalesce(nullif(n ->> 'handled_by', '')::uuid, nullif(n ->> 'claimed_by', '')::uuid, (n ->> 'user_id')::uuid);
  v_name  := coalesce(n ->> 'handled_name', n ->> 'claimed_name');
  if v_event = 'claimed' or v_event = 'released' then v_actor := coalesce(nullif(n ->> 'claimed_by', '')::uuid, nullif(o ->> 'claimed_by', '')::uuid); v_name := coalesce(n ->> 'claimed_name', o ->> 'claimed_name'); end if;
  if v_event = 'created' then v_name := 'player'; end if;
  insert into public.ops_log (op_id, kind, event, status, actor_id, actor_name, amount, row_data, changed)
    values (new.op_id, v_kind, v_event, new.status, v_actor, v_name, (n ->> 'amount')::numeric, n, v_changed);
  return new;
end $$;

drop trigger if exists deposits_ops_log on public.deposits;
create trigger deposits_ops_log after insert or update on public.deposits for each row execute function public.ops_log_write();
drop trigger if exists withdrawals_ops_log on public.withdrawals;
create trigger withdrawals_ops_log after insert or update on public.withdrawals for each row execute function public.ops_log_write();

-- what already exists goes into the log once, as a starting point
insert into public.ops_log (op_id, kind, event, status, actor_id, amount, row_data)
  select d.op_id, 'deposit', 'snapshot', d.status, d.user_id, d.amount, to_jsonb(d) from public.deposits d
  where not exists (select 1 from public.ops_log l where l.op_id = d.op_id);
insert into public.ops_log (op_id, kind, event, status, actor_id, amount, row_data)
  select w.op_id, 'withdrawal', 'snapshot', w.status, w.user_id, w.amount, to_jsonb(w) from public.withdrawals w
  where not exists (select 1 from public.ops_log l where l.op_id = w.op_id);
