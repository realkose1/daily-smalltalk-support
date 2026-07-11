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
