-- Zerake: automatic payouts. Run once in Supabase SQL Editor.
-- 7) automatic payouts
alter table public.withdrawals drop constraint if exists withdrawals_status_check;
alter table public.withdrawals add  constraint withdrawals_status_check check (status in ('pending', 'approved', 'sending', 'paid', 'rejected'));
alter table public.withdrawals add column if not exists auto boolean not null default false;
alter table public.chain_config add column if not exists auto_max   numeric(18,2) not null default 3000;    -- one payout above this is paid by hand
alter table public.chain_config add column if not exists auto_daily numeric(18,2) not null default 20000;   -- automatic total per 24 hours
