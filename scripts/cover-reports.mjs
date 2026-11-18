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
// judge's candidate choice and verdict, its second round (retry queries, the
// hand-vetted pool in content/cover-pool.json, the merge into the cover
// fields), and the TMDB title core.
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
  [/sexual (harassment|assault|misconduct|abuse)|\bharass(ment|ed|ing)?\b|\bscandals?\b|public apology/i, 'scandal'],
  // Korean file names, descriptions and categories. Wikidata's P18 for 김윤석
  // was "(TV10) 김윤석 무릎 담요 성희롱 발언 공개 사과 (…언론시사회) 58s.jpg" — a
  // still from a public apology over harassment remarks — and every pattern
  // above is English (2026-11-15). Plain substrings: \b means nothing next to
  // Hangul. 사과 only in its apology sense (사과 과수원, 사과나무 = the fruit);
  // 법정 not as 法定 (법정 공휴일); 경찰 / 사고 only as an investigation or an
  // accident scene (a police car, 사고방식 stay allowed).
  [/성희롱|성추행|성폭[력행]|성범죄|성착취|불법\s?촬영/, '성범죄·성희롱'],
  [/(공개|대국민|공식)\s?사과|사과\s?(문|기자회견|발언|성명|영상)|사과(하는|했|드리|드립|합니다|의 뜻)|사죄|논란|해명|물의|구설|학폭|학교\s?폭력|갑질|음주\s?운전|마약|도박/, '논란·사과'],
  [/사건|사고\s?현장|교통\s?사고|(열차|항공|선박|추락|붕괴|폭발)\s?사고|피해자|희생자|유족|폭행|살인|살해|흉기|범죄|피의자|용의자|혐의|체포|구속|기소|재판|법정(?!\s?(공휴일|기념일|휴일|단위|최저|최고))|검찰|경찰\s?(조사|수사|출석|소환)|압수\s?수색|교도소|수감/, '사건·수사·재판'],
  [/사망|별세|시신|빈소|장례|추모|영결식|참사|재난|화재|붕괴|실종|테러|폭격|전쟁/, '사망·재난'],
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

// The judge rates every candidate good / ok / wrong (since 2026-11-18; the
// yes/no "fits" bar left 2–4 of 8 cards a day on the gradient, rejecting a
// BTS photo for a BTS award story and a campus gate for 수능). Its answer lists
// the 1-based photo numbers it rates `good` and `ok`, best first within each;
// every other photo is wrong. A number in both lists counts as good; numbers
// out of range or repeated are ignored.
// → the photos that may ship, best first: { c, level, n }[]
//   good, fresh search result     (whatever the judge said, a fresh photo
//   good, hand-vetted pool photo   beats a pool photo of the same level: the
//   ok,   fresh search result      pool is the safety net, and letting it win
//   ok,   pool photo               every tie would put the same few pool photos
//   good, category fallback        in the deck every day)
//   ok,   category fallback       — the last resort: a generic pool photo for
//                                   the card's category (see poolFallbacks)
export const LEVELS = ['good', 'ok', 'wrong'];
export function rankByLevel(shown, levels) {
  const { good = [], ok = [] } = levels || {};
  const list = Array.isArray(shown) ? shown : [];
  const seen = new Set();
  const take = (nums, level) => {
    const out = [];
    for (const n of Array.isArray(nums) ? nums : []) {
      if (!Number.isInteger(n) || n < 1 || n > list.length || seen.has(n) || !list[n - 1]) continue;
      seen.add(n);
      out.push({ c: list[n - 1], level, n });
    }
    return out;
  };
  const g = take(good, 'good');
  const o = take(ok, 'ok');
  const fresh = (x) => !x.c.pool && !x.c.fallback;
  const pool = (x) => x.c.pool && !x.c.fallback;
  const fb = (x) => !!x.c.fallback;
  return [...g.filter(fresh), ...g.filter(pool), ...o.filter(fresh), ...o.filter(pool), ...g.filter(fb), ...o.filter(fb)];
}

// Per photo, in shown order: 'good' | 'ok' | 'wrong' — for the log.
export function photoLevels(count, levels) {
  const level = new Map();
  for (const x of rankByLevel(Array.from({ length: count }, () => ({})), levels)) level.set(x.n, x.level);
  return Array.from({ length: count }, (_, i) => level.get(i + 1) || 'wrong');
}

// The judge's levels → the card's two slots.
//   image      — the best attribution-free photo that is not wrong, or null
//                (gradient on builds without credit lines)
//   attributed — the best photo when it needs a credit, or null: when the best
//                is free, `image` carries it. Untouched (undefined) on a poster
//                card, whose attributed slot is the poster.
//   level      — the level of the card's main cover ('good' | 'ok'), or null
export function coverFromLevels(shown, levels, { poster = false } = {}) {
  const ranked = rankByLevel(shown, levels);
  const image = ranked.find((x) => x.c.free)?.c || null;
  if (poster) return { image, attributed: undefined, level: ranked.find((x) => x.c.free)?.level || null };
  const top = ranked[0] || null;
  return { image, attributed: top && !top.c.free ? top.c : null, level: top?.level || null };
}

// The judge's levels when some of today's keyword picks never reached it — their
// thumbnails were rate-limited (3 of 8 cards on the 2026-11-18 dry run, which
// until then skipped the judge and shipped the unseen pick). The other
// candidates it did see decide: the best good / ok one ships, exactly as
// coverFromLevels. Only when none of them is good or ok does an unseen pick
// stay, in its own slot — it may be fine, and "wrong" was never said about it;
// a pick the judge saw and rated wrong goes. `unseen` = picks not shown.
// → coverFromLevels' result + keptUnseen
export function coverWithUnseen(shown, levels, unseen = [], { poster = false } = {}) {
  const pick = coverFromLevels(shown, levels, { poster });
  const left = (unseen || []).filter((c) => c?.url);
  if (pick.level || !left.length) return { ...pick, keptUnseen: false };
  const image = left.find((c) => c.free) || null;
  if (poster) return { image, attributed: undefined, level: null, keptUnseen: !!image };
  return { image, attributed: left.find((c) => !c.free) || null, level: null, keptUnseen: true };
}

// One card's candidate list: `picks` (today's keyword picks — the judge can only
// overrule what it has seen) first, then RESERVED slots for the hand-vetted pool
// matches — min(reserve, how many matched) of the `max`, so a pool photo can
// no longer be crowded out by four search results (2026-11-17: the 퇴근길 card's
// pool match, score 5, never reached the judge) — then search results, then
// more pool photos if the search ran short. Distinct files only.
// → [...picks, ...search, ...pool] in that display order.
export function slotCandidates({ picks = [], search = [], pool = [], max = 4, reserve = 2 } = {}) {
  const seen = new Set();
  const P = [];
  const S = [];
  const Q = [];
  const room = () => max - P.length - S.length - Q.length;
  const add = (c, into) => {
    const k = c?.url ? coverFileKey(c.url) : null;
    if (!k || seen.has(k) || room() <= 0) return;
    seen.add(k);
    into.push(c);
  };
  for (const c of picks || []) add(c, P);
  const keep = Math.min(reserve, (pool || []).length);
  for (const c of pool || []) { if (Q.length >= keep) break; add(c, Q); }
  for (const c of search || []) add(c, S);
  for (const c of pool || []) add(c, Q);
  return [...P, ...S, ...Q];
}

// The card's two slots as candidate-shaped objects, for mergeRetryCover.
export function coverSlotsOf(t) {
  return {
    image: t?.image ? { url: t.image, free: true } : null,
    attributed: t?.imageAttributed ? { url: t.imageAttributed, free: false, credit: t.imageCredit } : null,
  };
}

// THE way a verdict reaches the card, in both judge rounds: `image` takes an
// attribution-free photo; `imageAttributed` + `imageCredit` are set or removed
// strictly as a pair (the app shows them only together). A poster card keeps
// its attributed slot — the poster — untouched. Mutates and returns `t`.
export function applyCoverSlots(t, { image, attributed } = {}, { poster = false } = {}) {
  if (image?.url) t.image = image.url; else delete t.image;
  if (poster) return t;
  if (attributed?.url && attributed.credit) {
    t.imageAttributed = attributed.url;
    t.imageCredit = attributed.credit;
  } else {
    delete t.imageAttributed;
    delete t.imageCredit;
  }
  return t;
}

// --- cover judge, round 2: a second search for the cards round 1 left empty --
// Round 1 can only choose among what the keyword search found; on 2026-11-15
// the search offered foreign dishes for 붕어빵 and the Nile, Hue and London for
// a Mississippi riverboat story. Having just seen why, the judge also writes
// 1–2 better Commons queries for each card with no good or ok photo; the
// generator runs them, adds matching pool photos and category fallbacks, and
// asks once more for just those cards.

// The judge's `retry` → at most `max` plain Commons queries. Commons search
// syntax is stripped (quotes, `intitle:`, a leading `-` = NOT, `*`, `|`): the
// query lands in `filetype:bitmap <query>` and must stay a list of words.
// Hangul goes too — the keyword rule matches file names on ASCII word
// boundaries, so a Korean word never counts as a hit. Lower-case (no `OR`
// operator), ≤ RETRY_MAX_WORDS words (Commons ANDs them, long phrases find
// nothing), at least one keyword the relevance rule can use (> 2 letters),
// distinct, and not one of `skip` (the card's own imageQueries, already run).
export const RETRY_MAX_QUERIES = 2;
export const RETRY_MAX_WORDS = 5;
const RETRY_STOPWORDS = new Set(['a', 'an', 'the', 'with', 'of', 'in', 'on', 'at']);
const retryNorm = (s) => String(s ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9' -]+/g, ' ')
  .split(/\s+/)
  .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
  .filter(Boolean)
  .slice(0, RETRY_MAX_WORDS)
  .join(' ');
export function cleanRetryQueries(raw, { max = RETRY_MAX_QUERIES, skip = [] } = {}) {
  const done = new Set((skip || []).map(retryNorm).filter(Boolean));
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (out.length >= max) break;
    if (typeof r !== 'string') continue;
    // "intitle:foo" → "foo": drop search keywords before the colon goes.
    const q = retryNorm(r.replace(/\b[a-z]+:/gi, ' '));
    if (!q || done.has(q)) continue;
    if (!q.split(' ').some((w) => w.length > 2 && !RETRY_STOPWORDS.has(w))) continue;
    done.add(q);
    out.push(q);
  }
  return out;
}

// Round-robin merge of per-query candidate lists (best first each), so the
// second query's best result is not buried under the first query's tenth.
export function interleave(...lists) {
  const out = [];
  const n = Math.max(0, ...lists.map((l) => (Array.isArray(l) ? l.length : 0)));
  for (let i = 0; i < n; i++) for (const l of lists) if (Array.isArray(l) && i < l.length) out.push(l[i]);
  return out;
}

// Which round-1 cards get a second look: only cards with NO good or ok photo
// (no photo at all after round 1 — the app would draw its gradient) and
// something to try: retry queries, a matching pool photo or a category
// fallback. Poster cards (the poster is the cover) and cards the judge never
// answered for are left alone. All of them get round 2's pool photos and
// fallbacks; only the first `searchMax` may spend Commons searches (each up to
// RETRY_MAX_QUERIES searches + a few thumbnails). Input order is kept.
// `cards`: [{ poster, verdict, hasCover, retry, poolCount, fallbackCount, … }]
// → [{ …card, search: boolean }]
export const RETRY_MAX_CARDS = 4;
export function retryTargets(cards, { searchMax = RETRY_MAX_CARDS } = {}) {
  const out = [];
  let searches = 0;
  for (const c of cards || []) {
    if (!c || c.poster || !c.verdict || c.hasCover) continue;
    const queries = Array.isArray(c.retry) ? c.retry.length : 0;
    if (!queries && !(c.poolCount > 0) && !(c.fallbackCount > 0)) continue;
    const search = queries > 0 && searches < searchMax;
    if (search) searches++;
    out.push({ ...c, search });
  }
  return out;
}

// Round 2's verdict on top of round 1's slots (both from coverSlotsOf /
// coverFromLevels). Round 2 only ever adds: nothing good or ok → round 1
// stands. Something good or ok
// → it becomes the main cover; when that photo needs a credit and round 2 had
// no attribution-free fit, older builds keep round 1's `image`.
// → { image, attributed, changed }
export function mergeRetryCover(before, pick) {
  const image = before?.image || null;
  const attributed = before?.attributed || null;
  if (!pick?.attributed && !pick?.image) return { image, attributed, changed: false };
  return { image: pick.image || image, attributed: pick.attributed || null, changed: true };
}

// --- hand-vetted cover pool: content/cover-pool.json ------------------------
// Photos picked and checked by hand for topics the keyword search keeps
// missing (붕어빵, 보일러, a Seoul commute), as
//   { note, photos: [{ url, file, free, credit, tags, desc, added }] }
// with `url` a 1280px Commons thumb, `credit` { author, license, licenseUrl,
// sourceUrl } or null when `free`, `tags` Korean and English words.
// A pool photo is never a cover on its own: when its tags appear on a card, the
// best 1–2 go in front of the cover judge on reserved slots (slotCandidates,
// both rounds), and only a good / ok rating ships one — behind any fresh search
// result of the same level (rankByLevel). As a last resort, a card that has
// nothing after round 1 is also offered generic pool photos for its category
// (poolFallbacks). Pre-vetted, so no licence / provenance / size checks; still
// skipped when blocklisted or shown in the last days.
// Missing file → empty pool; unreadable / invalid → one log line, empty pool.
// Never throws.
export const COVER_POOL_PATH = 'content/cover-pool.json';
export const POOL_MAX_OFFER = 2;
export const POOL_MIN_SCORE = 2; // see poolMatches
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const poolText = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// A repo file a human wrote, not an anonymous report: one line, capped, but
// apostrophes and brackets survive ("O'Neil", "Pajeon (Korean pancake).jpg").
const poolLine = (s, max) => (typeof s === 'string' ? s : '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function poolCredit(c, file) {
  const author = poolLine(c?.author, 80);
  const license = poolLine(c?.license, 40);
  if (!author || !license) return null;
  const credit = { author, license };
  if (typeof c.licenseUrl === 'string' && /^https?:\/\//i.test(c.licenseUrl.trim())) credit.licenseUrl = c.licenseUrl.trim();
  const src = typeof c.sourceUrl === 'string' && /^https?:\/\//i.test(c.sourceUrl.trim()) ? c.sourceUrl.trim()
    : file ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}` : '';
  if (src) credit.sourceUrl = src;
  return credit;
}

// Tags kept for matching: Korean ones of ≥ 2 syllables ("비", "눈", "밤" would
// substring-match 비트코인 / 눈치 / 밤새 — write "비 오는 날", "첫눈"),
// English ones of ≥ 2 letters ("tv", "ai").
function poolTags(tags) {
  const out = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = poolText(raw);
    if (!t) continue;
    if (HANGUL.test(t) ? [...t.replace(/\s/g, '')].length < 2 : t.replace(/[^a-z0-9]/g, '').length < 2) continue;
    out.add(t);
  }
  return [...out];
}

// → { photos, dropped }: well-formed, distinct entries as judge candidates.
export function parseCoverPool(json) {
  const photos = [];
  const seen = new Set();
  let dropped = 0;
  for (const p of Array.isArray(json?.photos) ? json.photos : []) {
    const url = typeof p?.url === 'string' ? p.url.trim() : '';
    const key = /^https:\/\/\S+$/i.test(url) ? coverFileKey(url) : null;
    const tags = poolTags(p?.tags);
    const free = p?.free === true;
    const file = poolLine(p?.file, 200).replace(/^File:/i, '') || coverFileLabel(url);
    const credit = free ? null : poolCredit(p?.credit, file);
    if (!key || seen.has(key) || !tags.length || (!free && !credit)) { dropped++; continue; }
    seen.add(key);
    photos.push({ url, thumb: url, name: file, free, credit, tags, desc: poolLine(p?.desc, 120), added: poolLine(p?.added, 10), pool: true });
  }
  return { photos, dropped };
}

// → { ok: true, photos, dropped, missing? } | { ok: false, photos: [], why }
export function loadCoverPool(path = COVER_POOL_PATH) {
  let txt;
  try {
    txt = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, photos: [], dropped: 0, missing: true };
    return { ok: false, photos: [], why: e.message };
  }
  try {
    const j = JSON.parse(txt);
    if (!Array.isArray(j?.photos)) return { ok: false, photos: [], why: 'no "photos" array' };
    return { ok: true, ...parseCoverPool(j) };
  } catch (e) {
    return { ok: false, photos: [], why: `invalid JSON: ${e.message}` };
  }
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Korean tag: a substring of the text ("붕어빵" in "붕어빵에"), spaces optional
// ("비 오는 날" ~ "비오는 날"). English tag: whole words, a plural or -y
// allowed ("rain" ~ "rainy street", not "rainbow").
function poolTagHit(tag, hay, hayTight) {
  if (HANGUL.test(tag)) return hay.includes(tag) || (tag.includes(' ') && hayTight.includes(tag.replace(/\s/g, '')));
  return new RegExp(`(^|[^a-z0-9])${reEscape(tag).replace(/ /g, '[\\s-]+')}(s|es|y)?(?![a-z0-9])`).test(hay);
}

// The best `max` pool photos for one card, best first. `texts` = what the card
// says: its Korean title and desc, plus English text (its imageQueries, the
// judge's retry queries, subject names). Score = tag hits: a Korean hit counts
// 2 (the card's own words), an English phrase 2 ("street food", "seoul
// subway"), a single English word 1 — and a photo needs POOL_MIN_SCORE = 2.
// One English word alone is sense-blind: the 2026-11-15 SK하이닉스 card
// ("stock market chart screen") was offered a bungeoppang-at-a-market photo
// through its tag "market". Skipped: `blocked` files (reader reports + hand
// list), `recent` (URLs shown in the last days — any URL shape of the file),
// `exclude` (file keys: another card's cover, or already shown to this card),
// and non-free photos when `freeOnly` (a poster card's spare slot).
export function poolMatches(photos, { texts = [], blocked = null, recent = [], exclude = new Set(), freeOnly = false, max = POOL_MAX_OFFER } = {}) {
  const hay = poolText((texts || []).filter(Boolean).join(' | '));
  if (!hay || max <= 0) return [];
  const hayTight = hay.replace(/\s/g, '');
  const recentKeys = new Set([...(recent || [])].map(coverFileKey).filter(Boolean));
  const out = [];
  (photos || []).forEach((p, i) => {
    if (!p?.url || (freeOnly && !p.free)) return;
    const k = coverFileKey(p.url);
    if (!k || exclude?.has(k) || recentKeys.has(k) || isCoverBlocked(blocked, p.url)) return;
    const hits = (p.tags || []).filter((t) => poolTagHit(t, hay, hayTight));
    const score = hits.reduce((n, t) => n + (HANGUL.test(t) || t.includes(' ') ? 2 : 1), 0);
    if (score < POOL_MIN_SCORE) return;
    const span = hits.reduce((n, t) => n + [...t].length, 0);
    out.push({ p: { ...p, poolScore: score, poolHits: hits }, score, span, i });
  });
  // Ties: the longer matched tags win — "보일러" says more than "겨울" (which
  // also sits inside "올겨울") — then file order.
  return out.sort((a, b) => b.score - a.score || b.span - a.span || a.i - b.i).slice(0, max).map((x) => x.p);
}

// --- last resort: generic pool photos for the card's category ---------------
// A card the judge left empty after round 1 and that no search or tag match
// rescues still deserves a photo (the owner's bar: only a clearly WRONG photo
// is worse than none). These are pool photos carrying a tag that suits the
// card's category: FALLBACK_TAGS[subtopic], the subtopic's own words
// ("커피·음료" → 커피, 음료), then FALLBACK_TAGS[cat] — exact tag matches,
// tried in that order. They still need the judge's good / ok, and rank behind
// every other candidate (rankByLevel). A fresh photo beats one shown in the
// last days; a recently shown one is used only when nothing fresh is left.
// Keys are the generator's cat / subtopic values (content/archive: 경제/주식·투자,
// 쇼핑/신제품·테크, 취미/스포츠, 음식/제철음식 … most common).
export const FALLBACK_TAGS = {
  // subtopics
  '출퇴근': ['출근길', '퇴근길', '대중교통'],
  '업무방식': ['업무', '재택근무'],
  '회사생활': ['직장 생활', '업무'],
  '자기계발': ['공부', '독서'],
  '커피·음료': ['커피', '카페'],
  '디저트': ['디저트 카페', '카페'],
  '집밥·요리': ['집밥', '찌개', '한식'],
  '제철음식': ['겨울 간식', '김장'],
  '배달·외식': ['배달 음식', '치킨', '야식'],
  '맛집': ['국밥', '한식', '점심 메뉴'],
  '웹툰·책': ['독서'],
  '음악': ['음악 감상'],
  '운동': ['운동', '러닝'],
  '다이어트': ['운동', '러닝'],
  '컨디션·피로': ['조용한 휴식', '담요', '따뜻한 방'],
  '수면': ['담요', '이불'],
  '잠·수면': ['담요', '이불'],
  '주말계획': ['주말 나들이', '산책', '나들이'],
  '국내여행': ['국내 여행', '기차 여행'],
  '당일치기': ['기차 여행', '나들이'],
  '여행준비': ['기차 여행'],
  '명절': ['귀성길', '명절 이동'],
  '주식·투자': ['투자'],
  '월급·저축': ['결제'],
  '소비습관': ['결제'],
  '온라인쇼핑': ['결제', '모바일 결제'],
  '세일·할인': ['결제'],
  '추위': ['겨울 풍경', '담요', '한파'],
  '눈': ['눈 오는 날'],
  '비·장마': ['비 오는 날', '비 오는 거리'],
  '일교차': ['가을 풍경', '단풍'],
  // categories (after the subtopic's)
  '시즌': ['가을 풍경', '겨울 풍경'],
  '날씨': ['가을 풍경', '겨울 풍경', '비 오는 거리'],
  '음식': ['한식', '찌개', '커피 한잔'],
  '일상': ['커피 한잔', '산책', '집콕'],
  '여행': ['국내 여행', '기차 여행'],
  '문화': ['조용한 휴식', '음악 감상'],
  '건강': ['운동', '조용한 휴식'],
  '취미': ['독서', '게임'],
  '쇼핑': ['결제'],
  '경제': ['투자', '결제'],
  '커리어': ['업무', '출근길'],
  '관계': ['커피 한잔', '카페', '주말 나들이'],
};
export const FALLBACK_MAX = 2;
export function fallbackTags(cat, subtopic, map = FALLBACK_TAGS) {
  const own = String(subtopic ?? '').split('·').map((s) => s.trim()).filter((s) => [...s].length >= 2);
  return [...new Set([...(map[subtopic] || []), ...own, ...(map[cat] || [])].map(poolText).filter(Boolean))];
}
export function poolFallbacks(photos, { cat, subtopic, map = FALLBACK_TAGS, blocked = null, recent = [], exclude = new Set(), freeOnly = false, max = FALLBACK_MAX } = {}) {
  const want = fallbackTags(cat, subtopic, map);
  if (!want.length || max <= 0) return [];
  const recentKeys = new Set([...(recent || [])].map(coverFileKey).filter(Boolean));
  const found = [];
  (photos || []).forEach((p, i) => {
    if (!p?.url || (freeOnly && !p.free)) return;
    const k = coverFileKey(p.url);
    if (!k || exclude?.has(k) || isCoverBlocked(blocked, p.url)) return;
    const rank = want.findIndex((w) => (p.tags || []).includes(w));
    if (rank < 0) return;
    found.push({ p: { ...p, fallback: true, poolHits: [want[rank]] }, rank, stale: recentKeys.has(k) ? 1 : 0, i });
  });
  return found.sort((a, b) => a.stale - b.stale || a.rank - b.rank || a.i - b.i).slice(0, max).map((x) => x.p);
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

// One word for the log: what the judge did to a card. `before`/`after` are
// { image, attributed } URLs. The main cover is what builds with credit lines
// show (attributed, else image); `image` alone is what older builds show.
export function judgeStatus(before, after) {
  const main = (s) => s?.attributed || s?.image || '';
  if ((before?.image || '') === (after?.image || '') && (before?.attributed || '') === (after?.attributed || '')) return 'kept';
  if (!main(after)) return 'rejected';
  if (main(after) === main(before)) return after?.image ? 'kept (old-build photo changed)' : 'kept (old-build photo dropped)';
  return 'changed';
}
