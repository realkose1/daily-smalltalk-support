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
