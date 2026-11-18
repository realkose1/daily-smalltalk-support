-- Daily Small Talk — on-time trigger for the generation workflow (Supabase)
--
-- Why: GitHub Actions' own `schedule:` cron fires hours late. On 2026-11-17 the
-- first scheduled run of daily.yml started at 11:36 KST, and on 2026-11-18
-- none had started by 10:35 KST, so the app kept showing yesterday's deck.
-- pg_cron on Supabase is minute-accurate (the 09:00 KST push already relies on
-- it), so it now *dispatches* the workflow through the GitHub REST API
-- (workflow_dispatch) instead of waiting for GitHub's scheduler.
--
-- Schedule (KST has no DST, so the UTC cron strings are fixed):
--   04:50 KST  ==  19:50 UTC   main trigger
--   06:20 KST  ==  21:20 UTC   backup trigger, in case the first run failed
--
-- GitHub's own three schedules in .github/workflows/daily.yml stay in place as
-- a fallback. Extra triggers are harmless: the generator's "already generated
-- today" guard exits 0 before any fetch or API call. For that to hold, the
-- dispatch below passes `force: "false"`; the workflow input defaults to true
-- ("regenerate even if today's deck exists"), which would defeat the guard.
--
-- The only manual step is the GitHub token (see 1). Everything else is this
-- file; it is safe to re-run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Token (one-time, by hand — never commit the real value)
--
-- Create a fine-grained personal access token at
-- https://github.com/settings/personal-access-tokens/new
--   Repository access : Only select repositories -> realkose1/daily-smalltalk-support
--   Permissions       : Actions: Read and write   (nothing else)
--   Expiration        : pick a date and note it; the trigger silently 401s after.
--
-- Store it in Supabase Vault (run once in the SQL editor):
--
--   select vault.create_secret('<paste token>', 'github_actions_token', 'GitHub PAT for daily.yml dispatch');
--
-- Rotate it later (same name, new value):
--
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'github_actions_token'),
--     new_secret := '<paste new token>');
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Dispatch function
--
-- net.http_post(url, body jsonb, params jsonb, headers jsonb, timeout_ms) is
-- asynchronous: it queues the request and returns a request id. The response
-- lands in net._http_response (GitHub answers 204 No Content on success).
-- Passing `headers` replaces the default Content-Type, so it is set explicitly.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.trigger_daily_generation()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  gh_token text;
begin
  select decrypted_secret into gh_token
  from vault.decrypted_secrets
  where name = 'github_actions_token'
  limit 1;

  if gh_token is null or gh_token = '' then
    raise notice 'trigger_daily_generation: vault secret github_actions_token is missing; skipping dispatch';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/realkose1/daily-smalltalk-support/actions/workflows/daily.yml/dispatches',
    -- workflow_dispatch inputs are strings. force=false keeps the
    -- already-generated guard active so the backup run is a no-op.
    body := '{"ref": "main", "inputs": {"force": "false"}}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || gh_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'daily-smalltalk-trigger',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Never callable from the public API roles.
revoke execute on function public.trigger_daily_generation() from public, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Schedules (unschedule-if-exists, so re-running this file is safe)
-- ────────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (select 1 from cron.job where jobname = 'daily-smalltalk-generate') then
    perform cron.unschedule('daily-smalltalk-generate');
  end if;
  if exists (select 1 from cron.job where jobname = 'daily-smalltalk-generate-backup') then
    perform cron.unschedule('daily-smalltalk-generate-backup');
  end if;
end;
$$;

-- 19:50 UTC == 04:50 KST
select cron.schedule('daily-smalltalk-generate', '50 19 * * *', 'select public.trigger_daily_generation()');
-- 21:20 UTC == 06:20 KST (backup)
select cron.schedule('daily-smalltalk-generate-backup', '20 21 * * *', 'select public.trigger_daily_generation()');

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Verify (run by hand after storing the token; commented on purpose)
--
-- Fire once. Note: with force=false this exits early if today's deck already
-- exists, so a 204 here proves the dispatch, not a regeneration.
--   select public.trigger_daily_generation();
--
-- Give it a few seconds, then look at the newest responses (204 = success;
-- 401 = bad/expired token, 403/404 = token lacks Actions access to the repo,
-- 422 = the workflow has no workflow_dispatch trigger on `main`):
--   select id, status_code, content, error_msg, created
--   from net._http_response order by created desc limit 5;
--
-- Confirm both jobs exist and are active:
--   select jobname, schedule, active from cron.job;
--
-- Past runs of the jobs (did cron fire on time?):
--   select jobid, status, return_message, start_time
--   from cron.job_run_details order by start_time desc limit 5;
-- ────────────────────────────────────────────────────────────────────────────
