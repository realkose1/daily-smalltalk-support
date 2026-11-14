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
//
// The generator's other pure cover helpers live at the bottom for the same
// reason (tests: scripts/cover-reports.test.mjs): the hand blocklist
// (content/cover-blocklist.json), the sensitive-provenance filter, the cover
// judge's candidate choice and verdict, and the TMDB title core.
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
// A topic whose cover was swapped by hand after it shipped carries the old
// URL(s) in `imageReplaced: [url, …]` — readers who had already loaded the deck
// saw (and may report) that photo, so it counts as shipped too.
export function shippedCovers(archiveDir = 'content/archive', days = COVER_REPORT_DAYS + 7) {
  const out = new Map();
  try {
    const files = readdirSync(archiveDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-days);
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(join(archiveDir, f), 'utf8'));
        const date = j.date || f.slice(0, 10);
        for (const t of j.topics || []) {
          const replaced = Array.isArray(t.imageReplaced) ? t.imageReplaced.filter((u) => typeof u === 'string') : [];
          for (const u of [t.image, t.imageAttributed, ...replaced]) {
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

// --- hand blocklist: content/cover-blocklist.json ---------------------------
// Covers a human pulled by hand (a deck patched after it shipped), as
// { files: [{ url, date, topic, reason }] }. Merged into the reader-report
// blocklist, so every search skips these files exactly like reported ones.
// Missing file → nothing to merge; unreadable/invalid → one log line, nothing
// merged. Never throws.
export const HAND_BLOCKLIST_PATH = 'content/cover-blocklist.json';

export function handBlocklistKeys(json) {
  const keys = new Set();
  for (const f of Array.isArray(json?.files) ? json.files : []) {
    const k = coverFileKey(typeof f === 'string' ? f : f?.url);
    if (k) keys.add(k);
  }
  return keys;
}

// → { ok: true, keys, entries, missing? } | { ok: false, keys: Set(), why }
export function loadHandBlocklist(path = HAND_BLOCKLIST_PATH) {
  let txt;
  try {
    txt = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, keys: new Set(), entries: 0, missing: true };
    return { ok: false, keys: new Set(), why: e.message };
  }
  try {
    const j = JSON.parse(txt);
    if (!Array.isArray(j?.files)) return { ok: false, keys: new Set(), why: 'no "files" array' };
    return { ok: true, keys: handBlocklistKeys(j), entries: j.files.length };
  } catch (e) {
    return { ok: false, keys: new Set(), why: `invalid JSON: ${e.message}` };
  }
}

export function mergeBlocklists(...sets) {
  const out = new Set();
  for (const s of sets) for (const k of s || []) out.add(k);
  return out;
}

// --- sensitive provenance: never a cover, whatever the keywords say ---------
// Keyword overlap alone put a DOJ "Epstein Files" evidence photo (File:EFTA…,
// category "2019 FBI raid on Epstein's townhouse") on a 한파 card on
// 2026-11-14 — its filename described winter coats. Public-domain pools are
// full of government evidence, disaster and atrocity documentation, so these
// files are rejected before scoring, on every path (cascade, subject photo,
// Commons name search). Matched against the file name, description,
// categories (hidden ones too, where Commons gives them), author and credit.
// Ers on the safe side for evidence / raids / victims; plain "police", "fire
// truck" or "hanging" (coats on hooks) stay allowed.
const SENSITIVE_PROVENANCE = [
  [/epstein|\bEFTA\d{4,}/i, 'Epstein files'],
  // Acronyms case-sensitive ("Dea" is a name, "atf" a typo); the rest not.
  [/\b(FBI|DOJ|DEA|ATF)\b/, 'law-enforcement source'],
  [/federal bureau of investigation|department of justice|justice\.gov|fbi\.gov|u\.s\. marshals|drug enforcement administration/i, 'law-enforcement source'],
  [/\bevidence\b|\bexhibits? [a-z]?\d+\b|court exhibit|trial exhibit|\bseized\b|\bconfiscated\b|contraband|drug bust|narcotics/i, 'evidence'],
  [/\braid(s|ed)?\b/i, 'raid'],
  [/\bcrimes?\b|\bcriminals?\b|forensics?\b|\bmug ?shots?\b|booking photo|wanted poster|\barrest(ed|s)?\b|courtroom|indictment/i, 'crime / police record'],
  [/autops(y|ies)|post-?mortem|\bmorgue\b|\bcorpses?\b|cadavers?|dead bod(y|ies)|human remains|body bags?/i, 'death'],
  [/\bvictims?\b|\bcasualt(y|ies)\b|\binjured\b|\bwounded\b|\bmurder(s|ed)?\b|homicide|assassinat|\bsuicide\b|overdose|\babuse\b|hostages?|kidnap/i, 'victims / violence'],
  [/massacre|genocide|holocaust|\bshoah\b|auschwitz|concentration camp|war crimes?|atrocit(y|ies)|ethnic cleansing|\bnazi|swastika|ku klux|lynching|\btorture/i, 'atrocity'],
  [/terroris[mt]|terror attack|september 11 attacks|\bbombings?\b|car bomb|suicide bomb|\bexplosions?\b|mass shooting|school shooting/i, 'terrorism / attack'],
  [/\bexecution(s)?\b|\bexecuted\b|death row|gallows|electric chair/i, 'execution'],
  [/\bprisons?\b|\bprisoners?\b|\bjails?\b|penitentiary|\binmates?\b|incarcerat|detention (center|centre|camp)|\bgulag/i, 'prison'],
  [/\bdisasters?\b|aftermath|wreckage|\brubble\b|earthquake|tsunami|(hurricane|typhoon|storm|tornado|flood|fire) damage|burned[- ]out|\barson\b|(traffic|car|road|train|plane|air) (accident|crash)|\bcar crash|crash site|refugee camp/i, 'disaster'],
  [/world war|\bwar ?zone\b|battlefield|firearms?\b|handguns?\b|assault rifle/i, 'war / weapons'],
];

// → the reason (for the log) or null. Pass any number of text fields.
export function sensitiveProvenance(...texts) {
  const hay = texts.filter(Boolean).map(String).join(' | ').replace(/_/g, ' ');
  if (!hay.trim()) return null;
  for (const [re, why] of SENSITIVE_PROVENANCE) {
    const m = hay.match(re);
    if (m) return `${why} ("${m[0]}")`;
  }
  return null;
}

// --- cover judge: what a cheap vision model is shown, and what its verdict does
// Wikimedia thumbnails come in fixed steps (20/40/60/120/250/330/500/960/1280…);
// any other width is a 400 ("320px" fails, "330px" works). Turns the 1280px
// thumb or the original URL a candidate carries into the 330px step.
// → URL or null (not a Commons file / a type with no simple thumb).
export const JUDGE_THUMB_PX = 330;
export function wikimediaThumb(url, px = JUDGE_THUMB_PX) {
  const u = String(url ?? '').replace(/[?#].*$/, '');
  let m = u.match(/^(https:\/\/[a-z]+\.wikimedia\.org\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\/)([^/]+)$/i);
  if (m) {
    if (!/(^|-)\d+px-/.test(m[2])) return null;
    return m[1] + m[2].replace(/(^|-)\d+px-/, `$1${px}px-`);
  }
  m = u.match(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/i);
  if (!m) return null;
  const [, a, ab, name] = m;
  const base = `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${name}`;
  if (/\.(jpe?g|png|webp|gif)$/i.test(name)) return `${base}/${px}px-${name}`;
  if (/\.tiff?$/i.test(name)) return `${base}/lossy-page1-${px}px-${name}.jpg`;
  return null;
}

// The judge's candidates for one card: `picks` (what today's code would ship,
// in slot order) first, then the best of the rest of `pool` (ranked best-first),
// alternating attribution-free and attributed so both slots keep an
// alternative; photos shown in the last days go last, and `exclude` (file keys
// another card ships today) never appears. `freeOnly` for a poster card, whose
// attributed slot is the poster. → up to `max` distinct candidates.
// Alternatives from the same upload series ("Korea Viper 26 1 - V16 … (1)",
// "(2)", "(3)") are one choice, not three: they wait until nothing else is left.
const seriesKey = (c) => String(c?.name || coverFileLabel(c?.url) || '').toLowerCase()
  .replace(/\.[a-z0-9]+$/, '').replace(/\([^)]*\)/g, ' ').replace(/[\d_\-–.,:;#]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32);
export function judgeCandidates(picks, pool, { max = 4, freeOnly = false, recent = new Set(), exclude = new Set() } = {}) {
  const out = [];
  const seen = new Set();
  const series = new Set();
  const later = [];
  const add = (c, pick = false) => {
    if (!c?.url || out.length >= max || (freeOnly && !c.free)) return;
    const k = coverFileKey(c.url);
    if (!k || seen.has(k)) return;
    const s = seriesKey(c);
    if (!pick && s && series.has(s)) { later.push(c); return; }
    seen.add(k);
    if (s) series.add(s);
    out.push(c);
  };
  for (const c of picks || []) add(c, true);
  const rest = (pool || []).filter((c) => c?.url && !exclude.has(coverFileKey(c.url)));
  const ordered = [...rest.filter((c) => !recent.has(c.url)), ...rest.filter((c) => recent.has(c.url))];
  const free = ordered.filter((c) => c.free);
  const paid = freeOnly ? [] : ordered.filter((c) => !c.free);
  while (out.length < max && (free.length || paid.length)) {
    const nFree = out.filter((c) => c.free).length;
    const takeFree = free.length && (!paid.length || nFree <= out.length - nFree);
    add(takeFree ? free.shift() : paid.shift());
  }
  for (const c of later) add(c, true);
  return out;
}

// The judge's verdict → the card's two slots. `shown` are the candidates the
// model saw (1-based in `fits`, best first; [] = none fits).
//   image      — the best fitting attribution-free photo, or null (gradient on
//                builds without credit lines)
//   attributed — the best fitting photo when it needs a credit, or null: when
//                the best fit is free, `image` carries it. Untouched (undefined)
//                on a poster card, whose attributed slot is the poster.
export function coverFromVerdict(shown, fits, { poster = false } = {}) {
  const ok = [...new Set(Array.isArray(fits) ? fits : [])]
    .map((i) => (Number.isInteger(i) ? shown[i - 1] : null))
    .filter(Boolean);
  const image = ok.find((c) => c.free) || null;
  if (poster) return { image, attributed: undefined };
  const top = ok[0] || null;
  return { image, attributed: top && !top.free ? top : null };
}

// --- TMDB titles: the work's name without "극장판" / "the Movie" -----------------
// Korean distributors file anime films as "극장판 <title>: <subtitle>", and
// TMDB's English titles say "<Title> the Movie: …". The headline (and the
// model's media.title) says '치이카와' — so "극장판 치이카와: 인어 섬의 비밀" was
// neither an exact nor a title+subtitle match, and three 치이카와 box-office
// cards (2026-10-27, 11-02, 11-13) went without their poster. Strips those
// markers at either end; the rest of the title must still match exactly.
// A function declaration (no module-level regex) so POSTER_TEST can use it at
// the very top of the generator.
export function mediaTitleCore(s) {
  const raw = String(s ?? '').normalize('NFC').trim();
  let t = raw;
  for (let i = 0; i < 3; i++) {
    const next = t
      .replace(/^(?:극장판|劇場版|映画|영화판|애니메이션판|특별판|TV판)\s*[:：-]?\s*/u, '')
      .replace(/^(?:the\s+movie|movie)\s*[:：-]\s*/iu, '')
      .replace(/\s*[:：-]?\s*(?:the\s+movie|the\s+motion\s+picture|극장판|劇場版|더\s?무비|특별판|감독판)$/iu, '')
      .trim();
    if (next === t) break;
    t = next;
  }
  return t || raw;
}
