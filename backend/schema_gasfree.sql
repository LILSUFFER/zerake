-- Zerake: GasFree. New TRC20 deposit addresses are GasFree addresses of pool keys (payouts need no TRX).
alter table public.address_pool add column if not exists kind text not null default 'eoa' check (kind in ('eoa', 'gasfree'));
alter table public.address_pool add column if not exists eoa_address text;
update public.address_pool set eoa_address = address where eoa_address is null;
