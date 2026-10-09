-- Zerake: GRAM (the TON network's own coin, formerly Toncoin) next to USDT on TRC20 / BEP20 / TON.
-- GRAM goes to the same club TON wallet as USDT-TON. A request locks the GRAM/USD rate for 30 minutes:
-- base_amount = chips in USD, amount = GRAM to send. Deposits store the USD value credited (amount) and the GRAM paid (coin_amount).

alter table public.chain_config drop constraint if exists chain_config_network_check;
alter table public.chain_config add  constraint chain_config_network_check check (network in ('TRC20', 'BEP20', 'TON', 'GRAM'));
alter table public.deposits drop constraint if exists deposits_network_check;
alter table public.deposits add  constraint deposits_network_check check (network in ('TRC20', 'BEP20', 'TON', 'GRAM'));
alter table public.withdrawals drop constraint if exists withdrawals_network_check;
alter table public.withdrawals add  constraint withdrawals_network_check check (network in ('TRC20', 'BEP20', 'TON', 'GRAM'));
alter table public.deposit_requests drop constraint if exists deposit_requests_network_check;
alter table public.withdrawals drop constraint if exists withdrawals_address_format;
alter table public.withdrawals add  constraint withdrawals_address_format check (
  (network = 'TRC20' and address ~ '^T[1-9A-HJ-NP-Za-km-z]{33}$') or
  (network = 'BEP20' and address ~ '^0x[0-9a-fA-F]{40}$') or
  (network in ('TON', 'GRAM') and address ~ '^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$')
);

alter table public.deposits         add column if not exists coin_amount numeric(24,9);   -- GRAM actually paid
alter table public.deposit_requests add column if not exists rate        numeric(18,8);   -- USD per GRAM, locked for the request
alter table public.withdrawals      add column if not exists coin_amount numeric(24,9);   -- GRAM to pay (at the rate of the request)
alter table public.withdrawals      add column if not exists rate        numeric(18,8);
alter table public.unmatched_deposits alter column amount type numeric(24,9);

insert into public.chain_config (network, enabled, rpc_url, usdt_contract, decimals, confirmations, min_deposit, explorer_tx, receive_address)
  select 'GRAM', false, 'https://toncenter.com', 'native', 9, 0, 10, 'https://tonviewer.com/transaction/', receive_address
  from public.chain_config where network = 'TON'
on conflict (network) do nothing;
insert into public.scan_state (network) values ('GRAM') on conflict do nothing;
