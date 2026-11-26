-- Reliable trigger for the GitHub Actions collector.
--
-- GitHub's own `schedule:` is best effort and can stay silent for hours. Supabase's pg_cron fires
-- on time, so every 15 minutes it asks GitHub to run the workflow (workflow_dispatch) using a
-- fine-grained token stored in Supabase Vault (Actions: read & write on this one repo only).
-- It is inert until that secret exists, and it skips a slot when a collection started in the last
-- 10 minutes, so it never doubles up with GitHub's schedule.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.dispatch_collector()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if token is null then
    return 'no token';
  end if;
  if exists (select 1 from public.collector_runs where started_at > now() - interval '10 minutes') then
    return 'recent run';
  end if;
  perform net.http_post(
    url := 'https://api.github.com/repos/Toolbloxindex/Jarvis/actions/workflows/collect.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'housewatch-cron',
      'Content-Type', 'application/json'
    )
  );
  return 'dispatched';
end;
$$;

revoke all on function public.dispatch_collector() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'housewatch-collect';
select cron.schedule('housewatch-collect', '3,18,33,48 * * * *', $$select public.dispatch_collector()$$);
