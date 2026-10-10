-- Zerake: keep the player-facing functions warm (free plan workers fall asleep and the first call is slow).
select cron.unschedule('keep-warm') where exists (select 1 from cron.job where jobname = 'keep-warm');
select cron.schedule('keep-warm', '*/4 * * * *', $$
  select net.http_get(url := 'https://saeekxoecwudpyixctab.supabase.co/functions/v1/' || f)
  from unnest(array['tg-webapp-auth', 'create-deposit-request', 'wallet', 'admin-action', 'create-withdrawal']) as f
$$);
