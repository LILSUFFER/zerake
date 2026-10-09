-- Zerake: cash-out fee. "chips" = what the player cashes out (chips taken in ClubGG),
-- "fee" = network fee kept by the club, "amount" = USDT actually sent (chips - fee).
alter table public.withdrawals add column if not exists chips numeric(18,6);
alter table public.withdrawals add column if not exists fee   numeric(18,6) not null default 0;
alter table public.chain_config add column if not exists wd_fee_fixed numeric(18,2) not null default 0;   -- USDT per cash out
alter table public.chain_config add column if not exists wd_fee_pct   numeric(6,3)  not null default 0;   -- percent of the cash out
update public.chain_config set wd_fee_fixed = 3, wd_fee_pct = 1 where network = 'TRC20';
