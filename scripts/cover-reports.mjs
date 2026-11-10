// Daily Small Talk — reader reports of covers that don't match their topic.
//
// The iOS app lets a reader flag a card's cover ("사진이 주제와 안 맞아요"); the
// app POSTs { date, topic_title, image_url, note, install_id } to the Supabase
// table public.cover_reports (anon may only INSERT — see backend/cover_reports.sql).
// generate.mjs reads them back with the service-role key at the start of a run
// and learns from them three ways:
//   1. Blocklist — a reported file is never picked again, for any card, in
//      either slot (`image` or `imageAttributed`). Applied INSIDE every search
//      (generic cascade, subject photos, Commons name search, TMDB posters), not
//      after the pick, so a blocked file makes room for the next candidate
//      instead of leaving the card on the gradient.
//   2. Lessons — the most recent reports go into the prompt as one short line
//      each, so the model sees what kind of imageQueries went wrong.
//   3. Digest — content/cover-reports.md, rewritten each run, so a human (or
//      Claude) can review reports in the repo without database access.
//
// Everything here is FAIL-SOFT: no env (dry runs, local runs), table not
// created yet, network error → one log line and the run continues exactly as
// it did before reports existed. Kept in its own module (not inside the
// 2,400-line generator) so these functions can be exercised without running a
// generation — the generator has top-level side effects.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COVER_REPORT_DAYS = 180; // older reports have been learned from already
export const COVER_LESSONS_MAX = 15; // prompt lines — ~40 tokens each, keep the budget small
export const COVER_DIGEST_MAX = 50;

// One key per FILE, whatever size/thumbnail/host variant the URL points to.
// The deck ships three shapes of the same Commons file:
//   upload.wikimedia.org/wikipedia/commons/a/ae/Name.jpg?utm_…
//   thumb.wikimedia.org/wikipedia/commons/thumb/8/8d/Name.jpg/1280px-Name.jpg?utm_…
//   …/thumb/a/a9/Name.tif/lossy-page1-1280px-Name.tif.jpg
// and the app reports whichever one it displayed. Keying on the URL itself
// would let the 1280px thumb of a reported original straight back in. So:
//   Commons → "commons:<file name, decoded, lower-case, _ → space>"
//   TMDB    → "tmdb:<poster path>"  (original and w780 are the same poster)
//   other   → the bare URL without query/fragment (Openverse-hosted files)
export function commonsKey(name) {
  let n = String(name ?? '');
  try { n = decodeURIComponent(n); } catch {}
  n = n.replace(/^File:/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return n ? `commons:${n}` : null;
}

export function coverFileKey(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  const commons = u.match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i)
    || u.match(/commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/i);
  if (commons) return commonsKey(commons[1]);
  const tmdb = u.match(/image\.tmdb\.org\/t\/p\/[^/]+(\/[^?#]+)/i);
  if (tmdb) return `tmdb:${tmdb[1]}`;
  return u.replace(/[?#].*$/, '');
}

// What a human calls the file: the Commons file name as uploaded, "TMDB 포스터",
// or the URL. Used in the prompt and the digest only — never as a key.
export function coverFileLabel(url) {
  const u = String(url ?? '');
  const m = u.match(/\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i);
  if (m) {
    let n = m[1];
    try { n = decodeURIComponent(n); } catch {}
    return n.replace(/_/g, ' ');
  }
  if (/image\.tmdb\.org/i.test(u)) return 'TMDB 포스터';
  return u.replace(/[?#].*$/, '');
}

// Reports are anonymous writes, so their free text reaches the prompt and a
// public repo: one line, no quotes/backticks/markup, capped.
function clean(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/["'`<>|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// → { ok: true, reports } | { ok: false, why }. Never throws.
// `fetchImpl` is injectable for tests.
export async function loadCoverReports({ url, key, days = COVER_REPORT_DAYS, fetchImpl = globalThis.fetch } = {}) {
  if (!url || !key) return { ok: false, why: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' };
  try {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const q = new URLSearchParams({
      select: 'created_at,date,topic_title,image_url,note,install_id',
      created_at: `gte.${since}`,
      order: 'created_at.desc',
      limit: '5000',
    });
    const r = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/cover_reports?${q}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const txt = await r.text();
    if (!r.ok) {
      // A table that was never created comes back as 404 PGRST205 — the
      // expected state until backend/cover_reports.sql has been run.
      let detail = txt.slice(0, 120);
      try { const j = JSON.parse(txt); detail = [j.code, j.message].filter(Boolean).join(' ').slice(0, 120); } catch {}
      return { ok: false, why: `HTTP ${r.status} ${detail}`.trim() };
    }
    const rows = JSON.parse(txt);
    if (!Array.isArray(rows)) return { ok: false, why: 'unexpected response shape' };
    return { ok: true, reports: rows };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

// Every cover the deck actually shipped, from content/archive: key → [{ date, title, url }].
// A report only counts when its file is one of these. The table is
// anon-writable, so without this check anyone could blocklist arbitrary files
// or write whatever they like into the prompt; with it, a report can only ever
// say "this cover we really showed was wrong".
export function shippedCovers(archiveDir = 'content/archive', days = COVER_REPORT_DAYS + 7) {
  const out = new Map();
  try {
    const files = readdirSync(archiveDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-days);
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(join(archiveDir, f), 'utf8'));
        const date = j.date || f.slice(0, 10);
        for (const t of j.topics || []) {
          for (const u of [t.image, t.imageAttributed]) {
            const k = coverFileKey(u);
            if (!k) continue;
            if (!out.has(k)) out.set(k, []);
            out.get(k).push({ date, title: String(t.title || '').replace(/\s+/g, ' ').trim(), url: u });
          }
        }
      } catch {}
    }
  } catch {}
  return out;
}

// Raw rows → one entry per (file, date): the same bad cover reported by twelve
// readers is one lesson, not twelve. Newest first.
// → { groups: [{ key, label, url, date, title, reporters, notes, last }], ignored }
export function groupCoverReports(reports, shipped) {
  const groups = new Map();
  let ignored = 0;
  for (const r of reports || []) {
    const key = coverFileKey(r?.image_url);
    const ships = key && shipped.get(key);
    if (!ships) { ignored++; continue; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
    // The title we shipped beats the one the report carries: same text when
    // the app is honest, and the only trustworthy one when it is not.
    const ship = ships.find((s) => s.date === date) || ships[ships.length - 1];
    const gk = `${key}|${ship.date}`;
    let g = groups.get(gk);
    if (!g) {
      g = { key, label: coverFileLabel(ship.url), url: ship.url, date: ship.date, title: ship.title, ids: new Set(), notes: [], last: '' };
      groups.set(gk, g);
    }
    g.ids.add(String(r.install_id ?? ''));
    const note = clean(r.note, 120);
    if (note && !g.notes.includes(note) && g.notes.length < 3) g.notes.push(note);
    if (String(r.created_at || '') > g.last) g.last = String(r.created_at || '');
  }
  const list = [...groups.values()]
    .map(({ ids, ...g }) => ({ ...g, reporters: ids.size }))
    .sort((a, b) => b.last.localeCompare(a.last) || b.date.localeCompare(a.date));
  return { groups: list, ignored };
}

export function coverBlocklist(groups) {
  return new Set((groups || []).map((g) => g.key));
}

export function isCoverBlocked(blocked, url) {
  if (!blocked?.size) return false;
  const k = coverFileKey(url);
  return !!k && blocked.has(k);
}

// THE usable-candidate check of the generic cover cascade (see generate.mjs):
// not condemned by photoScore, and not a file readers reported. Lives here so
// the blocklist rule is tested where it is applied.
export function usableCandidates(list, blocked) {
  return (list || []).filter((c) => (c.q ?? 0) > -5 && !isCoverBlocked(blocked, c.url));
}

// Prompt section, or '' when there is nothing to learn from. Compact on
// purpose: one line per distinct report, file name and note cut short.
export function coverLessonsPrompt(groups, max = COVER_LESSONS_MAX) {
  const lines = (groups || []).slice(0, max).map((g) => {
    const note = g.notes[0] ? ` (메모: ${clean(g.notes[0], 60)})` : '';
    const who = g.reporters > 1 ? `독자 ${g.reporters}명이` : '독자가';
    return `- 주제 '${clean(g.title, 40)}'에 '${clean(g.label, 60)}' 사진이 붙었는데 ${who} '안 맞는다'고 신고함${note}`;
  });
  if (!lines.length) return { text: '', count: 0 };
  return {
    count: lines.length,
    text:
      `■ 커버 사진 신고 — 최근 독자가 "주제와 안 맞는다"고 신고한 커버예요(이 파일들은 코드가 다시 안 써요). 같은 실수를 반복하지 마세요:\n` +
      `${lines.join('\n')}\n` +
      `- → imageQueries는 분위기나 비슷한 장면이 아니라 그 주제의 구체적인 대상(그 음식·그 물건·그 날씨·그 행동)을 글자 그대로 찍은 장면으로 쓰세요(Write imageQueries that literally depict the topic's concrete subject). 화제 카드가 이름 있는 인물·그룹·팀·브랜드·제품·장소를 다루면 subjects를 꼭 채우세요.\n`,
  };
}

function mdCell(s, max) {
  return clean(s, max) || '—';
}

// content/cover-reports.md — newest first, no install ids.
export function coverReportsMarkdown(groups, { generatedAt = new Date().toISOString(), ignored = 0, days = COVER_REPORT_DAYS } = {}) {
  const rows = (groups || []).slice(0, COVER_DIGEST_MAX);
  const head =
    `# Cover reports\n\n` +
    `Readers' "cover doesn't match the topic" reports from the app (last ${days} days), ` +
    `one row per reported cover, newest first (max ${COVER_DIGEST_MAX}). ` +
    `Rewritten by scripts/generate.mjs on every run — don't edit by hand. ` +
    `Every file listed here is blocklisted: the generator never picks it again.\n\n` +
    `Updated ${generatedAt}. ${(groups || []).length} reported cover(s)` +
    (ignored ? `; ${ignored} report(s) ignored (not a cover the deck shipped)` : '') + `.\n\n`;
  if (!rows.length) return `${head}_No reports yet._\n`;
  const lines = rows.map((g) => {
    const file = g.key.startsWith('commons:')
      ? `[${mdCell(g.label, 80)}](https://commons.wikimedia.org/wiki/File:${encodeURIComponent(g.label.replace(/ /g, '_'))})`
      : `[${mdCell(g.label, 80)}](${String(g.url).replace(/[()\s]/g, encodeURIComponent)})`;
    return `| ${g.date || '—'} | ${mdCell(g.title, 60)} | ${file} | ${g.reporters} | ${g.notes.map((n) => mdCell(n, 120)).join(' / ') || '—'} |`;
  });
  return `${head}| date | topic | file | reporters | notes |\n|---|---|---|---|---|\n${lines.join('\n')}\n`;
}
