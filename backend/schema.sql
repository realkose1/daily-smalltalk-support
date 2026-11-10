-- Daily Small Talk — push token store (Supabase / Postgres)
--
-- One row per device. The app upserts its Expo push token + prefs; the daily
-- 9am GitHub Actions workflow reads the table and sends via the Expo Push API.
-- Run this once in the Supabase SQL editor.

create table if not exists public.push_tokens (
  token       text primary key,          -- ExpoPushToken[...]
  weekend     boolean not null default true,   -- false = skip Sat/Sun
  platform    text not null default 'ios',
  updated_at  timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

-- Anonymous clients may register/refresh ONLY by inserting/updating a row
-- keyed by their own token (they never read others' tokens). The daily sender
-- uses the service-role key, which bypasses RLS.
drop policy if exists "anon upsert own token" on public.push_tokens;
create policy "anon upsert own token"
  on public.push_tokens for insert
  to anon
  with check (true);

drop policy if exists "anon update own token" on public.push_tokens;
create policy "anon update own token"
  on public.push_tokens for update
  to anon
  using (true)
  with check (true);

drop policy if exists "anon delete own token" on public.push_tokens;
create policy "anon delete own token"
  on public.push_tokens for delete
  to anon
  using (true);

-- ────────────────────────────────────────────────────────────────────────────
-- Daily 09:00 KST push, sent by Supabase itself (added 2026-07-15).
-- GitHub Actions cron fired 3+ hours late every day, so scheduling moved to
-- pg_cron here. The generate workflow upserts today's headline into
-- daily_content at ~06:00 KST; at 09:00 KST sharp this cron reads tokens and
-- posts to the Expo Push API via pg_net. Run this whole block once.
-- ────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Today's headline (row id=1 only), written by the generation workflow with
-- the service-role key. RLS on with no policies: anon cannot read or write.
create table if not exists public.daily_content (
  id          int primary key default 1 check (id = 1),
  date_label  text not null,
  headline    text not null,
  updated_at  timestamptz not null default now()
);
alter table public.daily_content enable row level security;

create or replace function public.send_daily_push()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  kst_today date := (now() at time zone 'Asia/Seoul')::date;
  kst_dow int := extract(dow from (now() at time zone 'Asia/Seoul'))::int; -- 0=Sun, 6=Sat
  is_weekend boolean := kst_dow in (0, 6);
  head text := '오늘의 스몰토크 주제가 도착했어요';
  fresh public.daily_content%rowtype;
  batch record;
begin
  -- Use today's headline only if the sync actually ran today.
  select * into fresh from public.daily_content where id = 1;
  if found and (fresh.updated_at at time zone 'Asia/Seoul')::date = kst_today then
    head := fresh.headline;
  end if;

  -- Expo accepts up to 100 messages per request.
  for batch in
    select jsonb_agg(jsonb_build_object(
             'to', token,
             'title', '오늘의 스몰토크 ☀️',
             'body', head,
             'sound', 'default')) as msgs
    from (
      select token, row_number() over (order by token) as rn
      from public.push_tokens
      where weekend or not is_weekend
    ) t
    group by (rn - 1) / 100
  loop
    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := batch.msgs
    );
  end loop;
end;
$$;

-- Never callable from the public API roles.
revoke execute on function public.send_daily_push() from public, anon, authenticated;

-- 00:00 UTC == 09:00 KST, minute-accurate on Supabase infrastructure.
select cron.schedule('daily-smalltalk-push', '0 0 * * *', 'select public.send_daily_push()');

-- ────────────────────────────────────────────────────────────────────────────
-- Cover reports (added 2026-11-10). Readers flag "this cover doesn't match the
-- topic" in the app, which POSTs { date, topic_title, image_url, note,
-- install_id } to /rest/v1/cover_reports with `Prefer: return=minimal`.
-- scripts/generate.mjs reads them with the service-role key (bypasses RLS) to
-- blocklist reported files and teach the prompt. Anonymous clients may INSERT
-- only — no select/update/delete, so nobody can read others' reports or ids.
-- One report per install per card (unique below); a repeat tap is a 409 the
-- app can ignore. Run this whole block once in the Supabase SQL editor.
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.cover_reports (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  date         text not null,          -- deck date, YYYY-MM-DD (KST)
  topic_title  text not null,
  image_url    text not null,          -- the cover URL the app displayed
  note         text,                   -- optional free text from the reader
  install_id   text not null,          -- random per-install id, not a user id
  unique (install_id, date, topic_title)
);

alter table public.cover_reports enable row level security;

drop policy if exists "anon insert cover report" on public.cover_reports;
create policy "anon insert cover report"
  on public.cover_reports for insert
  to anon
  with check (
    date ~ '^\d{4}-\d{2}-\d{2}$'
    and char_length(topic_title) between 1 and 200
    and char_length(image_url) <= 1000
    and image_url like 'https://%'
    and (note is null or char_length(note) <= 300)
    and char_length(install_id) between 8 and 100
  );

-- RLS alone already denies anon everything the policy above doesn't allow;
-- the grants make the intent explicit (and keep a future permissive policy
-- from accidentally exposing reads). The insert needs no sequence grant
-- (identity column) and return=minimal needs no select.
revoke all on table public.cover_reports from anon, authenticated;
grant insert (date, topic_title, image_url, note, install_id) on table public.cover_reports to anon;
