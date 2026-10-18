// Daily Small Talk — content generator (real-time from FREE sources, cheap).
// Runs via GitHub Actions at 04:47 / 05:47 / 06:47 KST (three tries because
// GitHub's cron lands hours late — see daily.yml); the first run that starts
// builds the deck and the others skip (see the run guard below), so the deck
// is in place before the 09:00 push.
// Real-time signals come from free APIs (no Anthropic web search — that injects
// ~100k tokens of page content and costs ~$10/mo). One Sonnet call turns the
// compact brief into 8 topics — the deck went 5 → 8 so that the app's 관심 주제
// picker has enough categories present each day to actually re-order anything.
// Cost ≈ $1.5/month.
//   - Weather: Open-Meteo (free, keyless)
//   - News: Google News KR RSS (free, keyless) — section feeds (top stories,
//     연예, 테크, 스포츠, 경제) plus a product-launch search and a 생활경제
//     search, filtered and deduped into ≤19 headlines. The model turns 1–2 of
//     them into named "오늘의 화제" cards.
//   - Cover photos: Openverse (free, keyless, CC0-only so no attribution is
//     required) — the model also writes 3 generic English `imageQueries` per
//     topic, which we search after generation. No image found → the app
//     falls back to a solid color-gradient cover (never a broken image).
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY (not needed for --brief-only)
// Flags / env:
//   --brief-only  gather weather/markets/news, print the brief the model would
//                 get, and exit — no API call, no files written.
//   FORCE=1       regenerate even if today.json is already from today (KST).
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';

const MODEL = 'claude-sonnet-5-5'; // reliable "exactly 5 + concise"; bump to opus for max quality

const BRIEF_ONLY = process.argv.includes('--brief-only');
const FORCE = process.env.FORCE === '1';

const now = new Date();
const kst = new Date(now.getTime() + 9 * 3600 * 1000);
const month = kst.getUTCMonth() + 1;
const day = kst.getUTCDate();
const kstIsoDate = (d) => {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
};
const isoDate = kstIsoDate(now);
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const wd = kst.getUTCDay();
const dateLabel = `${month}월 ${day}일 ${weekdays[wd]}요일`;
const isWeekend = wd === 0 || wd === 6;

// --- run guard: only the first scheduled run of the day spends an API call ---
// daily.yml fires at 04:47, 05:47 and 06:47 KST because GitHub's cron lands
// 2–5 h late (a 06:00 schedule finished anywhere from 07:49 to 11:20 KST,
// 2026-10). Whichever run starts first builds the deck; the rest see the
// committed today.json is already from today and exit 0 before any fetch or
// API call. A run that failed leaves yesterday's file in place, so the next
// schedule doubles as a free retry.
function generatedDay() {
  try {
    const j = JSON.parse(readFileSync('today.json', 'utf8'));
    const t = Date.parse(j.generatedAt);
    if (Number.isFinite(t)) return kstIsoDate(new Date(t));
    if (typeof j.date === 'string') return j.date;
    // Files from before generatedAt/date existed only carry the label.
    if (j.dateLabel === dateLabel) return isoDate;
    return j.dateLabel ? `"${j.dateLabel}"` : null;
  } catch {
    return null; // no/invalid today.json → generate
  }
}
if (!BRIEF_ONLY) {
  if (FORCE) {
    console.log(`FORCE=1 — generating ${isoDate} regardless of the committed today.json`);
  } else {
    const hour = kst.getUTCHours();
    // A schedule firing absurdly late (yesterday's run landing after midnight)
    // must not build "today's" deck from the middle of the night's news.
    if (hour < 4) {
      console.log(`it's ${hour}:${String(kst.getUTCMinutes()).padStart(2, '0')} KST — before 04:00, not generating ${isoDate} yet, skipping`);
      process.exit(0);
    }
    const done = generatedDay();
    if (done === isoDate) {
      console.log(`already generated for ${isoDate}, skipping`);
      process.exit(0);
    }
    console.log(`today.json is from ${done ?? '(none)'} — generating ${isoDate}`);
  }
}

const SEASON = {
  1: '한겨울, 신정·설 준비, 붕어빵·귤', 2: '늦겨울~초봄, 설 연휴, 졸업·개학',
  3: '초봄, 벚꽃 시작, 새 학기·입사, 미세먼지', 4: '완연한 봄, 벚꽃, 나들이, 환절기',
  5: '늦봄~초여름, 어린이날·어버이날, 가정의 달', 6: '초여름, 장마 전후, 참외·수박',
  7: '한여름, 장마·폭염, 초복·중복, 여름휴가, 냉면·삼계탕·수박', 8: '한여름, 말복·처서, 열대야, 물놀이',
  9: '초가을, 추석 전후, 선선, 햇과일', 10: '완연한 가을, 단풍, 환절기',
  11: '늦가을~초겨울, 김장, 수능, 첫추위', 12: '한겨울, 연말·크리스마스, 송년회, 눈·귤',
};

const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림', 45: '안개', 48: '안개',
  51: '이슬비', 53: '이슬비', 55: '이슬비', 61: '비', 63: '비', 65: '강한 비',
  71: '눈', 73: '눈', 75: '많은 눈', 80: '소나기', 81: '소나기', 82: '강한 소나기',
  95: '뇌우', 96: '뇌우', 99: '뇌우',
};

async function getWeather() {
  try {
    const r = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978' +
      '&current=temperature_2m,precipitation,weather_code' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul',
      { signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    const c = j.current, d = j.daily;
    const desc = WMO[c.weather_code] ?? '';
    return `서울 오늘: ${desc}, 현재 ${Math.round(c.temperature_2m)}°C (최고 ${Math.round(d.temperature_2m_max[0])}° / 최저 ${Math.round(d.temperature_2m_min[0])}°), 강수확률 ${d.precipitation_probability_max[0]}%`;
  } catch (e) {
    console.log('weather fetch failed:', e.message);
    return null;
  }
}

// Drop politically-charged / crime / disaster headlines so small-talk stays light.
const BLOCK = /대통령|정부|여당|야당|국민의힘|민주당|조국|이재명|이준석|한동훈|윤석열|트럼프|바이든|국회|의원|장관|청와대|대선|총선|선거|정치|탄핵|특검|검찰|경찰|법원|기소|구속|체포|사망|숨진|숨져|살해|피살|성범죄|성폭|성착취|N번방|딥페이크|불법촬영|협박|폭행|고소|피소|마약|도박|음주운전|사기|참사|화재|폭발|지진|실종|자살|극단적|전쟁|미사일/;
// The top-stories feed is mostly hard news, and BLOCK alone let through 국힘
// statements, 전작권, a 흉기난동, a French riot and a 후티 civil war when it
// was checked (2026-10-18). Same intent as BLOCK, wider net. (Lookarounds keep
// 급부상 / 무기한 / "사고 싶은" / 수비 불안보다 / 중상위권 from tripping it.)
const HARD_NEWS = /국힘|민주|여권|야권|당대표|원내|국정|국무|국감|총리|차관|청장(?!년)|지자체장|시장직|도지사|출마|공천|비대위|전작권|북한|北|안보(?![다여이인고])|국방|군사|미군|(?<!급)부상|중상(?!위)|중태|무기(?!한)|군수|백악관|크렘린|시위|폭동|내전|분쟁|공습|휴전|테러|약탈|털려|털렸|털어|도난|절도|강도|방화|흉기|난동|칼부림|범행|범죄|용의자|피의자|수사|혐의|재판|판결|선고|실형|징역|유죄|무죄|피해|유족|희생|순직|사고(?!\s*싶)|붕괴|침몰|추락|실신|이송|응급|심정지|비극|해킹|인종차별|카지노|바카라|블랙잭/;
// People news is fine when it is about public work (작품·컴백·공연·수상·경기),
// never about private life. The ♥/근황/자택/가족 markers are how Korean
// entertainment desks flag relationship and family gossip — on 2026-10-18 the
// 연예 feed's top items included a pregnancy, a ♥ family outing at a theme park
// and an 80th-birthday party at home.
const PRIVATE_BLOCK = /임신|출산|결혼|이혼|열애|결별|파경|불화|폭로|논란|해명|사과문|갑질|학폭|투병|수술|입원|건강 이상|별세|부고|빈소|사생활|루머|의혹|소송|고발|저격|♥|♡|❤|근황|셀카|자택|(?<![가-힣])아내|남편|부부|여친|남친|연인|신혼|태교|D라인|육아|엄마|아빠|(?<![가-힣])딸(?!기)|(?<![가-힣])아들|모친|부친|[장빙][인모]상|비보(?!이)|노브라|몸매|비키니|노출|성형|병역|복무|무단이탈|악플|스토커|팔순|칠순|백수연|고백/;
// Not news at all: photo/video desks, ads and events, horoscopes, opinion
// columns, detailed weather (the brief already has real weather), coin and
// stock-tip chatter (the 경제 card gets real numbers from [시장 시그널]).
const NOT_NEWS = /^\s*[[【(]\s*(포토|사진|영상|화보|포토뉴스|카드뉴스|만평|광고|AD|PR|이벤트|사설|칼럼|기고|오피니언|시론|기자수첩|인사|동정|부고)\s*[\]】)]|광고|응모|경품|운세|띠별|별자리|사주|날씨|기상청|예보|주의보|경보|특보|강수량|㎜|비트코인|이더리움|리플(?!레)|XRP|시바이누|도지코인|솔라나|가상자산|가상화폐|암호화폐|알트코인|밈코인|스테이블코인|특징주|목표가|목표주가|급등주/;
// Machine-translated aggregators (they also end their "headlines" with a
// full stop — "…실행에 옮겼습니다." — which real Korean headlines never do).
const SOURCE_BLOCK = /GameGPU|Vietnam\.vn|Laodong|Calgary Roughnecks|토큰포스트/i;
const SENTENCE_TITLE = /(습니다|[다요])\.\s*$/;

const NEWS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const NEWS_MAX_AGE_MS = 36 * 3600 * 1000;
const GN = 'hl=ko&gl=KR&ceid=KR:ko';
const topicFeed = (t) => `https://news.google.com/rss/headlines/section/topic/${t}?${GN}`;
const searchFeed = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:2d`)}&${GN}`;

// Listed in PRIORITY order: a story that shows up in several feeds is filed
// under the first section that has it, so 주요 (top stories) only keeps what
// no topical section already covers. `show` is the order in the brief.
// TECHNOLOGY items carry no related-coverage list, so big launches come from a
// brand × launch-verb search instead (its duplicate outlets become the signal).
const LAUNCH_BRANDS = '테슬라|애플|아이폰|삼성|갤럭시|구글|엔비디아|닌텐도|소니|현대차|기아|오픈AI|샤오미';
const LAUNCH_VERBS = '공개|출시|발표|언팩|신제품';
// The search also matches article BODIES, and 삼성/LG/기아 are ball clubs too
// (a KBO 골든글러브 list came back as a "launch"): the headline itself must name
// a brand and a launch verb, and must not be about sport.
const LAUNCH_TITLE = new RegExp(`(?=.*(${LAUNCH_BRANDS}))(?=.*(${LAUNCH_VERBS}))`, 'i');
const SPORT_WORDS = /KBO|프로야구|야구|축구|농구|배구|골프|골든글러브|감독|선수|구단|리그|라이온즈|타이거즈|썬더스/;
const NEWS_SECTIONS = [
  { tag: '연예', cap: 5, show: 0, feeds: [['ENTERTAINMENT', topicFeed('ENTERTAINMENT')]] },
  { tag: '스포츠', cap: 3, show: 2, feeds: [['SPORTS', topicFeed('SPORTS')]] },
  {
    tag: '테크', cap: 4, show: 1, feeds: [
      ['TECHNOLOGY', topicFeed('TECHNOLOGY')],
      [
        'launch search',
        searchFeed(`(${LAUNCH_VERBS.split('|').join(' OR ')}) (${LAUNCH_BRANDS.split('|').join(' OR ')})`),
        (t) => LAUNCH_TITLE.test(t) && !SPORT_WORDS.test(t),
      ],
    ],
  },
  {
    tag: '경제', cap: 3, show: 4, feeds: [
      ['BUSINESS', topicFeed('BUSINESS')],
      ['경제 search', searchFeed('(물가 OR 경제 OR 주식 OR 부동산 OR 금리 OR 월급)')],
    ],
  },
  // Top stories without a related-coverage list are the feed's niche filler
  // (a CO₂-capture explainer, one company's drug recall) — not "top".
  { tag: '주요', cap: 4, show: 3, minRelated: 1, feeds: [['top stories', `https://news.google.com/rss?${GN}`]] },
];

function xmlField(item, tag) {
  const m = item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? plain(m[1]) : '';
}

// "headline - 매체" → "headline". Some outlets add their own name as well
// ("… - 머니투데이 - 머니투데이", "… - 조선비즈 - Chosunbiz"), so peel that too.
function stripOutlet(title, source) {
  let t = title;
  if (!source || !t.endsWith(` - ${source}`)) t = t.replace(/\s+-\s+[^-]+$/, '');
  // "… - 머니투데이 - 머니투데이"
  while (source && t.endsWith(` - ${source}`)) t = t.slice(0, -(source.length + 3));
  // "… - 조선비즈 - Chosunbiz": a Latin-named source after the Korean name.
  if (/^[A-Za-z .]+$/.test(source)) t = t.replace(/\s+-\s+[가-힣]{2,8}$/, '');
  // Trailing desk/column tags ("[주간전망]", "[핫피플]") are noise.
  return t.replace(/\s*\[[^\]]{1,15}\]\s*$/, '').trim();
}

async function fetchFeed(label, url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': NEWS_UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      console.log(`news feed "${label}": HTTP ${r.status}`);
      return null;
    }
    const xml = await r.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const item = m[1];
      const source = xmlField(item, 'source');
      const pub = Date.parse(xmlField(item, 'pubDate'));
      return {
        title: stripOutlet(xmlField(item, 'title'), source),
        source,
        pub: Number.isFinite(pub) ? pub : null,
        // <description> is an HTML list of the same story's coverage (escaped
        // in the raw XML). Google caps it at 5; 0 = a lone article.
        related: (item.match(/&lt;li&gt;|<li>/g) || []).length,
      };
    });
  } catch (e) {
    console.log(`news feed "${label}" failed: ${e.message}`);
    return null;
  }
}

// Same story, different outlet. Two tests, either is enough:
//  - ≥60% of the shorter title's 2-char Hangul/alnum shingles (after dropping
//    [tags] and punctuation) also occur in the other — rewrites of one wire story;
//  - ≥30% shingle overlap AND two shared distinctive words — the same event
//    told from different angles ("테슬라, 신형 로드스터 공개에도 주가 하락" /
//    "테슬라, '하늘 나는 로드스터' 공개…") only overlaps ~40%, so without this
//    one launch filled half the 테크 slots on 2026-10-18;
//  - the same LEADING quoted title ('100일의 거짓말' …) — one drama, one line.
//    Leading only: "'치이카와' 극장판, '암살자(들)' 제치고 1위" is not a story
//    about 암살자(들).
// Clusters are single-linkage (a newcomer joins if it matches ANY member), since
// syndicated rewrites chain: A≈B and B≈C even when A≉C.
function shingles(title) {
  const words = title.toLowerCase().replace(/\[[^\]]*\]|【[^】]*】/g, ' ').match(/[가-힣a-z0-9]+/g) || [];
  const out = new Set();
  for (const w of words) {
    if (w.length === 1) out.add(w);
    for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}
const PARTICLE = /(에서|에게|으로|부터|까지|에도|에선|이라|라는|은|는|이|가|을|를|의|에|도|와|과|로|만)$/;
const GENERIC_WORDS = new Set(
  ('공개 출시 발표 신형 신제품 차세대 국내 한국 세계 최초 최대 최고 최악 역대 올해 내년 오늘 어제 내일 이번 ' +
   '감독 선수 배우 가수 경기 시즌 승리 우승 결승 전망 이유 시장 가격 판매 예약 시작 공식 정식 기술 제품 ' +
   '서비스 투자 개최 성공 주가 하락 상승 급등 급락 반등 확대 강화 가속 본격 추진 연속 만에 나는 있는 없는 ' +
   '하는 위한 대한 통해 관련 이후 앞둔 앞두고 직후 개막 프로야구 프로축구 프로농구 프로배구 1위 드라마 영화 예능 ' +
   '음악 앨범 콘서트 공연 시청률 예매율 흥행 스마트폰 노트북 자동차 전기차 신차 코스피 금리 물가 주식 증시 경제 ai pc').split(' '),
);
function keyWords(title) {
  const out = new Set();
  for (let w of title.toLowerCase().replace(/\[[^\]]*\]/g, ' ').match(/[가-힣a-z0-9]+/g) || []) {
    if (w.length > 2) w = w.replace(PARTICLE, '');
    if (w.length < 2 || /^\d+(년|월|일)?$/.test(w) || GENERIC_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}
const quotedTitles = (title) =>
  [...title.matchAll(/['‘’"“”]([^'‘’"“”]{2,25})['‘’"“”]/g)].map((m) => m[1].toLowerCase().replace(/\s+/g, '')).filter((q) => q.length >= 3);
function sameStory(a, b) {
  if (a.qt && a.qt === b.qt) return true;
  const [small, big] = a.sh.size <= b.sh.size ? [a.sh, b.sh] : [b.sh, a.sh];
  if (small.size < 3) return false;
  let shared = 0;
  for (const s of small) if (big.has(s)) shared++;
  const overlap = shared / small.size;
  if (overlap >= 0.6) return true;
  if (overlap < 0.3) return false;
  let words = 0;
  for (const w of a.kw) if (b.kw.has(w) && ++words >= 2) return true;
  return false;
}

// Headlines come back with their publication day attached. Without it the model
// reads a HEADLINE's "오늘 저녁" as tonight — it announced 여의도 불꽃축제 for
// "오늘 밤" on the morning after it had already happened (2026-09-06).
async function getNews() {
  const jobs = NEWS_SECTIONS.flatMap((s) => s.feeds.map(([label, url, keep]) => ({ s, label, url, keep })));
  const results = await Promise.all(jobs.map((j) => fetchFeed(j.label, j.url)));
  if (results.every((r) => r === null)) {
    console.log('news: every feed failed — brief goes out without news');
    return null;
  }
  const drop = { stale: 0, block: 0, private: 0, notNews: 0, offTopic: 0 };
  const stories = []; // all sections, so cross-feed duplicates merge
  for (const s of NEWS_SECTIONS) {
    const pool = jobs
      .flatMap((j, i) => (j.s === s ? results[i] || [] : []).filter((it) => !j.keep || j.keep(it.title) || (drop.offTopic++, false)))
      .filter((it) => {
        if (!it.pub || now - it.pub > NEWS_MAX_AGE_MS || it.pub - now > 3600e3) return drop.stale++, false;
        if (it.title.length <= 6 || NOT_NEWS.test(it.title) || SOURCE_BLOCK.test(it.source) || SENTENCE_TITLE.test(it.title)) return drop.notNews++, false;
        if (BLOCK.test(it.title) || HARD_NEWS.test(it.title)) return drop.block++, false;
        if (PRIVATE_BLOCK.test(it.title)) return drop.private++, false;
        return true;
      })
      // Best-covered, then newest, becomes the story's representative.
      .sort((a, b) => b.related - a.related || b.pub - a.pub);
    for (const it of pool) {
      const me = { title: it.title, sh: shingles(it.title), kw: keyWords(it.title), qt: quotedTitles(it.title)[0] };
      const story = stories.find((st) => st.members.some((m) => sameStory(m, me)));
      if (story) {
        story.members.push(me);
        story.related = Math.max(story.related, it.related);
      } else {
        stories.push({ ...it, tag: s.tag, minRelated: s.minRelated || 0, members: [me] });
      }
    }
  }
  // 관련 N = Google's related-coverage count (capped at 5 by Google) plus every
  // other copy of the story we saw across feeds and outlets. The second half is
  // what ranks the search results, which carry no coverage list at all.
  for (const st of stories) st.coverage = st.related + st.members.length - 1;
  const items = [];
  for (const s of [...NEWS_SECTIONS].sort((a, b) => a.show - b.show)) {
    items.push(
      ...stories
        .filter((st) => st.tag === s.tag && st.related >= st.minRelated)
        .sort((a, b) => b.coverage - a.coverage || b.pub - a.pub)
        .slice(0, s.cap),
    );
  }
  for (const it of items) {
    it.line = `(${kstDayLabel(Math.floor(it.pub / 1000))} 기사 · 관련 ${it.coverage}) [${it.tag}] ${it.title}`;
    // NEWS_DEBUG=1: show what each line absorbed, to check the merging.
    if (process.env.NEWS_DEBUG) console.log(`${it.line}\n${it.members.slice(1).map((m) => `      + ${m.title}`).join('\n')}`);
  }
  const total = results.reduce((n, r) => n + (r?.length || 0), 0);
  const kept = stories.reduce((n, st) => n + st.members.length, 0);
  console.log(
    `news: ${results.filter(Boolean).length}/${jobs.length} feeds ok, ${total} items → ${stories.length} stories → ${items.length} lines ` +
    `(dropped ${drop.stale} older than 36h, ${drop.block} politics/crime/accident, ${drop.private} private life, ` +
    `${drop.notNews} not news, ${drop.offTopic} off-topic search hits; merged ${kept - stories.length} duplicates)`,
  );
  return items.length ? items : null;
}

// Concrete market signals (keyless Yahoo Finance) so the 경제 topic can talk
// specifics on big-move days — e.g. "삼성전자가 어제 5% 올랐다던데" — instead of
// permanently generic 물가 talk. Numbers come from HERE, never from the model.
const MARKET_SYMBOLS = [
  ['005930.KS', '삼성전자'],
  ['000660.KS', 'SK하이닉스'],
  ['^KS11', '코스피'],
  ['KRW=X', '원/달러 환율'],
  ['BTC-USD', '비트코인(달러)'],
];

// "어제 종가"라고 뭉뚱그리면 안 된다. 주식·코스피는 주말·공휴일에 쉬어서 일요일
// 아침의 마지막 종가는 금요일 것이고, 비트코인·환율은 주말에도 움직여 항목마다
// 기준일이 다르다. (일요일 주제에 "어제 떨어졌다"고 나간 사고: 2026-08-17)
// → 각 줄에 실제 기준일을 한국어로 박아 넣고, 모델은 그 표현만 쓰게 한다.
function kstDayLabel(epochSec) {
  const d = new Date((epochSec + 9 * 3600) * 1000); // KST 기준 날짜
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  const todayKey = `${kst.getUTCFullYear()}-${kst.getUTCMonth() + 1}-${kst.getUTCDate()}`;
  const key = `${y}-${m}-${day}`;
  if (key === todayKey) return '오늘';
  const yest = new Date(kst.getTime() - 86400000);
  if (key === `${yest.getUTCFullYear()}-${yest.getUTCMonth() + 1}-${yest.getUTCDate()}`) return '어제';
  return `${m}월 ${day}일(${wd})`;
}

async function getMarkets() {
  const lines = [];
  for (const [sym, name] of MARKET_SYMBOLS) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) },
      );
      if (!r.ok) continue;
      const j = await r.json();
      const res = j.chart?.result?.[0];
      const ts = res?.timestamp || [];
      // Pair each close with its own timestamp BEFORE dropping nulls, so the
      // date we report belongs to the close we report.
      const pts = (res?.indicators?.quote?.[0]?.close || [])
        .map((c, i) => ({ c, t: ts[i] }))
        .filter((p) => p.c != null && p.t != null);
      if (pts.length < 2) continue;
      const prev = pts[pts.length - 2];
      const last = pts[pts.length - 1];
      const pct = ((last.c - prev.c) / prev.c) * 100;
      const big = Math.abs(pct) >= (sym === '^KS11' ? 1.5 : sym === 'KRW=X' ? 1 : 3);
      // Spell the direction out in Korean and quote the size unsigned. Handing
      // the model a signed number meant it had to infer 올랐/내렸 itself, and it
      // got 환율 backwards — reported a big DROP as a rise (2026-08-31).
      const dir = pct > 0.05 ? '올랐어요' : pct < -0.05 ? '내렸어요' : '거의 그대로예요';
      // 환율 is the one line where the number's direction and the everyday
      // meaning are opposite, so say what it means as well as which way it went.
      const note =
        sym === 'KRW=X'
          ? pct > 0.05
            ? ' → 원화 약세(해외여행·직구에 불리)'
            : pct < -0.05
              ? ' → 원화 강세(해외여행·직구에 유리)'
              : ''
          : '';
      lines.push(
        `${name}: ${Math.round(last.c).toLocaleString()} — ${kstDayLabel(last.t)} 종가 기준, 직전 거래일(${kstDayLabel(prev.t)}) 대비 ${Math.abs(pct).toFixed(1)}% ${dir}${note}${big ? ' ★큰 변동' : ''}`,
      );
    } catch {
      // skip symbol on failure
    }
  }
  return lines.length ? lines : null;
}

const [weather, news, markets] = await Promise.all([getWeather(), getNews(), getMarkets()]);

// Last few days' topics — fed to the model so it stops repeating the same
// picks (3 straight days of 장마+우산/삼계탕/물가 with near-identical copy).
function getRecentTopics(days = 5) {
  try {
    const files = readdirSync('content/archive').filter((f) => f.endsWith('.json')).sort().slice(-days);
    const lines = [];
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(`content/archive/${f}`, 'utf8'));
        for (const t of j.topics || []) lines.push(`- [${f.replace('.json', '')}] ${t.label}: ${String(t.title).replace(/\n/g, ' ')}`);
      } catch {}
    }
    return lines;
  } catch {
    return [];
  }
}
const recent = getRecentTopics();

// Curated Korean special days — the model does NOT know these dates reliably
// (it once called 7/8 "초복" and then missed the real 초복 on 7/15). Verified
// manually; refresh this table around every New Year.
const SPECIAL_DAYS = {
  '2026-07-15': '초복 — 삼계탕 등 보양식 챙겨 먹는 날',
  '2026-07-23': '대서 — 1년 중 가장 덥다는 절기',
  '2026-07-25': '중복',
  '2026-08-07': '입추 — 가을의 문턱이라는 절기',
  '2026-08-14': '말복',
  '2026-08-15': '광복절(공휴일)',
  '2026-08-23': '처서 — 더위가 꺾인다는 절기',
  '2026-09-23': '추분 — 밤이 길어지기 시작',
  '2026-09-24': '추석 연휴 시작',
  '2026-09-25': '추석',
  '2026-10-03': '개천절(공휴일)',
  '2026-10-09': '한글날(공휴일)',
  '2026-10-31': '핼러윈',
  '2026-11-07': '입동 — 겨울의 시작이라는 절기',
  '2026-11-11': '빼빼로데이',
  '2026-11-19': '수능일',
  '2026-12-22': '동지 — 팥죽 먹는 가장 긴 밤',
  '2026-12-24': '크리스마스 이브',
  '2026-12-25': '크리스마스(공휴일)',
  '2026-12-31': '한 해의 마지막 날',
  '2027-01-01': '새해 첫날(공휴일)',
  '2027-02-04': '입춘',
  '2027-02-06': '설날(공휴일)',
  '2027-02-14': '밸런타인데이',
  '2027-03-01': '삼일절(공휴일)',
  '2027-03-03': '삼겹살데이',
  '2027-03-14': '화이트데이',
  '2027-05-05': '어린이날(공휴일)',
  '2027-05-08': '어버이날',
};

function specialDayLines() {
  const lines = [];
  for (let offset = 0; offset <= 3; offset++) {
    const d = new Date(kst.getTime() + offset * 86400000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (SPECIAL_DAYS[key]) lines.push(offset === 0 ? `오늘: ${SPECIAL_DAYS[key]}` : `${offset}일 뒤: ${SPECIAL_DAYS[key]}`);
  }
  return lines;
}
const specials = specialDayLines();
// Today's once-a-year special day, if any (exact-date match only — the
// "다가온다" angle for +1~3일 stays as-is and is NOT pinned to the front).
const todaySpecial = SPECIAL_DAYS[isoDate] || null;

const brief =
  `날씨: ${weather ?? '정보 없음'}\n` +
  `계절: ${SEASON[month]}\n` +
  (specials.length
    ? `\n[한국의 특별한 날 — 확정 정보]\n${specials.join('\n')}\n★오늘이 특별한 날이면 반드시 그 소재로 주제 1개를 만드세요(예: 초복 → 보양식). 1~3일 뒤라면 "다가온다"는 앵글로 써도 좋아요.\n`
    : '\n[한국의 특별한 날] 오늘~3일 내 없음. ★주의: 이 목록에 없는 날을 초복·명절·절기라고 지어내지 마세요(과거에 아닌 날을 초복이라고 쓴 사고 있음).\n') +
  (markets ? `\n[시장 시그널 — 실제 수치. ★각 줄에 적힌 기준일을 그대로 쓰세요]\n- ${markets.join('\n- ')}\n` : '') +
  (news
    ? `\n[오늘의 화제 뉴스 후보 — 실제 헤드라인. ★각 줄 앞 (…기사)는 그 기사가 나온 날이고, 헤드라인 속 '오늘·오늘 밤·내일'은 오늘이 아니라 그 발행일 기준입니다. '관련 N'은 같은 소식을 다룬 기사 수(클수록 많이 보도된 소식), [ ]는 분야. [경제] 줄은 경제 카드용 참고 자료예요. 무거운 정치·범죄·재난·사망 소식이 섞여 있으면 무시하세요]\n- ${news.map((n) => n.line).join('\n- ')}\n`
    : '') +
  (recent.length ? `\n[최근 며칠간 이미 나간 주제 — 소재·질문·문구가 겹치면 안 됩니다]\n${recent.join('\n')}\n` : '');
console.log('--- brief ---\n' + brief);
if (BRIEF_ONLY) {
  console.log('--brief-only: stopping before the API call (nothing written)');
  process.exit(0);
}

// Sub-topics: what "비슷한 주제를 덜 보기" actually keys off. The category alone
// is too blunt — disliking one 주식 card shouldn't bury 물가·환율·부동산 too.
// Fixed vocabulary (not free text) so the same subject gets the same tag every
// day; free-form Korean drifts (주식/증시/코스피) and stops matching.
const SUBTOPICS = {
  '시즌': ['명절', '절기', '기념일', '연말연시'],
  '날씨': ['더위', '추위', '비·장마', '눈', '미세먼지', '일교차'],
  '음식': ['맛집', '배달·외식', '집밥·요리', '커피·음료', '디저트', '제철음식'],
  '일상': ['집안일', '잠·수면', '주말계획', '정리·미니멀', '아침루틴'],
  '여행': ['국내여행', '해외여행', '당일치기', '숙소', '여행준비'],
  '문화': ['드라마', '영화', '음악', '예능', '공연·전시', '웹툰·책'],
  '건강': ['운동', '다이어트', '수면', '컨디션·피로', '건강검진'],
  // 스포츠 / 신제품·테크 came with the 오늘의 화제 news cards (경기 결과, 신차·
  // 신제품 공개). The app doesn't validate subtopics, so older builds just
  // treat them as new strings.
  '취미': ['게임', '독서', '사진', '배우기', '수집', '반려식물', '스포츠'],
  '쇼핑': ['온라인쇼핑', '패션', '생활용품', '중고거래', '세일·할인', '신제품·테크'],
  '경제': ['주식·투자', '물가', '환율', '부동산', '월급·저축', '소비습관'],
  '커리어': ['출퇴근', '업무방식', '이직', '회사생활', '자기계발'],
  '관계': ['친구', '가족', '연애', '반려동물', '이웃·동료'],
};
const ALL_SUBTOPICS = Object.values(SUBTOPICS).flat();
const SUBTOPIC_GUIDE = Object.entries(SUBTOPICS)
  .map(([c, subs]) => `${c}: ${subs.join(' / ')}`)
  .join('\n');

const moodTip = { type: 'object', additionalProperties: false, properties: { opener: { type: 'string' }, follow: { type: 'string' }, caution: { type: 'string' } }, required: ['opener', 'follow', 'caution'] };
const topic = {
  type: 'object', additionalProperties: false,
  properties: {
    // Categories double as the app's "관심 주제" picker, so keep them short
    // (they render as a chip on the cover) and broad enough that any of them
    // can carry a universally relatable small-talk question.
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '여행', '문화', '건강', '취미', '쇼핑', '경제', '커리어', '관계'] },
    // Must belong to the chosen cat — see SUBTOPIC_GUIDE in the prompt.
    subtopic: { type: 'string', enum: ALL_SUBTOPICS },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    special: { type: 'boolean', description: '오늘이 [한국의 특별한 날](초복·중복·말복·명절·기념일 등)이고 이 주제가 바로 그 날을 소재로 만든 주제일 때만 true. 그런 주제는 정확히 1개. 오늘이 특별한 날이 아니거나 이 주제가 그 소재가 아니면 false.' },
    // Internal (dropped before writing): which cards are the day's 오늘의 화제
    // news cards, so the code can put the strongest one first (it becomes the
    // 09:00 push headline) — the deck is shuffled after generation.
    news: { type: 'string', enum: ['none', 'first', 'second'], description: "[오늘의 화제 뉴스 후보]의 헤드라인으로 만든 '오늘의 화제' 카드면 가장 강한 것은 'first', 두 번째는 'second'. 그 밖의 모든 카드(시장 시그널·[경제] 줄로 만든 경제 카드 포함)는 'none'. 'first'와 'second'는 각각 최대 1개." },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
    // NOTE: structured outputs only support minItems 0/1 — don't add
    // minItems/maxItems here (a 3/3 constraint 400'd the whole run on
    // 2026-07-12). "Exactly 3" lives in the description + slice(0,3) below.
    imageQueries: { type: 'array', items: { type: 'string' }, description: 'EXACTLY 3 DIFFERENT concrete, photographable scenes for this topic, each 2-5 generic English words — a real object, food, weather phenomenon, or visible action/place a stock photographer could literally shoot. Vary the subject across the 3 (e.g. for sleeping in: "cat sleeping blanket", "unmade bed pillows", "alarm clock nightstand"). Never an abstract mood, time-of-day, or feeling. Good: "chicken soup bowl", "rainy street umbrella", "person relaxing sofa blanket". Bad (too abstract, will fail): "weekend afternoon", "cozy feeling". No Korean, no brand/proper nouns. For a news card, shoot the generic thing the story is about — a car launch → "red electric sports car road", "electric car charging station"; avoid showrooms, shops, expos and signage — they usually show another company logo; a drama → "tv remote sofa living room"; baseball → "baseball stadium night crowd" — never a celebrity, athlete or any real person.' },
  },
  required: ['id', 'cat', 'subtopic', 'label', 'color', 'title', 'desc', 'reason', 'special', 'news', 'questions', 'tips', 'imageQueries'],
};
const schema = { type: 'object', additionalProperties: false, properties: { topics: { type: 'array', items: topic } }, required: ['topics'] };

// Streamed, not a plain create(): the SDK refuses a non-streaming request whose
// max_tokens could take over 10 minutes, and 8 topics need the headroom.
// finalMessage() hands back the same shape create() would.
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — stopping before the API call (use --brief-only to just print the brief)');
  process.exit(1);
}
// Imported here, not at the top, so --brief-only and the run guard's skip need
// no installed dependencies.
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic();
const gen = await client.messages.stream({
  model: MODEL,
  // 8 topics × (3 questions + 3 moods × 3 tips + imageQueries + subtopic).
  // 12k truncated once the deck grew from 5 to 8; 20k truncated again on
  // 2026-09-03, so leave real headroom.
  max_tokens: 32000,
  output_config: { format: { type: 'json_schema', schema } },
  messages: [{
    role: 'user',
    content:
      `너는 "데일리 스몰토크" 앱의 오늘의 주제 5개 에디터야. 오늘: ${dateLabel}.\n\n[오늘의 실시간 맥락]\n${brief}\n[요구사항]\n` +
      `- 정확히 8개 주제, 카테고리 겹치지 않게. 각 필드는 1~2문장으로 간결하게. 날씨 주제는 최대 1개까지만, 순서는 자유롭게(날씨가 꼭 첫 번째일 필요 없음).` + (isWeekend ? ' 주말 소재 하나 포함 가능.' : '') + `\n` +
      (todaySpecial
        ? `- ★오늘은 "${todaySpecial}" — 1년에 한 번뿐인 날이에요. 이 날을 소재로 한 주제를 정확히 1개 만들고 그 주제에만 special:true를 설정하세요(나머지 주제는 모두 false). 그 주제가 덱 맨 앞(첫 카드)에 놓입니다.\n`
        : `- 오늘은 [한국의 특별한 날] 목록에 있는 날이 아니에요. 모든 주제의 special은 false로 두세요.\n`) +
      `- 카테고리는 시즌/날씨/음식/일상/여행/문화/건강/취미/쇼핑/경제/커리어/관계 중에서 고르고, 5개가 서로 달라야 해요. 앱에서 사용자가 '관심 주제'로 고르는 값이라 매일 같은 조합만 나오면 안 됩니다 — 최근에 안 나온 카테고리도 적극적으로 섞어 주세요(단, 아래 '스몰토크 적합성' 기준은 그대로 지키세요).\n` +
      `- subtopic은 반드시 그 카테고리에 속한 것으로 고르세요:\n${SUBTOPIC_GUIDE}\n` +
      `- 같은 subtopic이 하루에 두 번 나오면 안 되고, [최근 며칠간 이미 나간 주제]에서 자주 보인 subtopic은 피하세요.\n` +
      `- 카테고리 감: 여행=휴가·나들이·가보고 싶은 곳 / 문화=드라마·영화·음악·공연(화제의 작품·컴백 포함) / 건강=운동·수면·컨디션 / 취미=게임·독서·수집·배우는 것·스포츠 경기 보기 / 쇼핑=요즘 산 것·패션·생활용품·신제품·테크 / 커리어=일하는 방식·출퇴근·이직 고민(가볍게) / 관계=친구·가족·주변 사람 이야기(사생활 캐묻기 금지).\n` +
      `- ★위 [최근 며칠간 이미 나간 주제]와 겹치지 마세요. 같은 소재(장마, 삼계탕, 물가 등)를 또 쓰려면 각도를 완전히 바꾸세요(예: 장마 → 우산 얘기 대신 빗소리·제습·빨래·출퇴근길 / 보양식 → 삼계탕 대신 냉면·수박·팥빙수). 제목·질문 문구가 비슷해도 안 됩니다.\n` +
      `- ★답이 뻔한 예/아니오 질문 금지: 비 오는 날 "우산 챙기셨어요?"처럼 누구나 답이 정해진 질문은 대화가 한 마디로 끝나요. 취향·경험·이야기를 끌어내는 열린 질문으로 쓰세요(예: "비 오는 날엔 어떤 노래 들으세요?", "장마철 최악의 출근길 썰 있으세요?").\n` +
      `- 모든 문장 존댓말 ~요체(단 친구 팁은 반말도 자연스러우면 허용). 친근하고 구체적, 살짝 위트.\n` +
      `- ★스몰토크 적합성이 최우선: 좋은 주제는 "누구나 자기 경험으로 바로 대답할 수 있는 것"이에요. 아래 '오늘의 화제' 카드 1~2개를 뺀 나머지는 날씨, 음식/식사, 주말·퇴근 후 시간, 요즘 보는 드라마·영상, 물가·생활비 체감, 계절 변화, 여행·휴가처럼 대다수가 공감하는 일상 소재로 채우세요. 화제 카드의 질문도 그 소식을 몰랐던 사람까지 자기 취향·경험으로 대답할 수 있게 쓰세요.\n` +
      `- ★★오늘의 화제(뉴스 카드) 1~2개: [오늘의 화제 뉴스 후보]에서 오늘 한국 사람 대부분이 들어 봤을 법하거나 이야기하기 재밌는 소식을 1~2개 골라, 각각 따로 주제 카드 1장으로 만드세요. '관련' 숫자가 크고 (오늘 기사)·(어제 기사)인 것을 우선하세요. 후보 중 쓸 만한 게 정말 하나도 없을 때만 0개, 3개 이상은 절대 안 돼요. [시장 시그널]이나 [경제] 줄로 만든 경제 카드는 이 1~2개에 세지 않습니다. 두 화제 카드도 카테고리는 서로 달라야 해요.\n` +
      `- 화제 카드는 그 소식의 주인공(작품명·인물·제품명·팀)을 제목에 구체적으로 밝히세요. 예: "테슬라가 새 로드스터를 공개했다던데, 전기 스포츠카 한번 타 보고 싶으세요?" — "화제의 신차", "요즘 뜨는 드라마"처럼 뭉뚱그리면 안 돼요.\n` +
      `- ★화제 카드의 사실은 헤드라인에 적힌 것만 쓰세요. 헤드라인에 없는 가격·날짜·사양·순위·수치·발언 인용은 지어내지 말고, 헤드라인이 애매하면 확실한 부분까지만 다루세요.\n` +
      `- ★사람이 나오는 소식은 공개 활동(작품, 컴백, 공연, 수상, 경기 결과, 출연)만 다루세요. 사생활·연애·결혼·가족·건강·루머는 금지, 그 사람을 평가하거나 품평하는 것도 금지예요. 질문은 연예인·선수의 사생활이 아니라 듣는 사람의 취향·경험을 물어보세요(예: "'○○' 보세요? 요즘 빠져 있는 드라마 있으세요?").\n` +
      `- 화제 카드의 시제: 어제·오늘 나온 소식이니 "~했다던데", "~공개됐다는데"처럼 이미 일어난 일로 쓰세요. [한국의 특별한 날] 표에 있는 게 아니면 행사·경기·방송이 "오늘/오늘 밤" 있다고 쓰지 마세요(아래 ★★규칙).\n` +
      `- 화제 카드의 카테고리: 연예·작품 → 문화(드라마/영화/음악/예능/공연·전시/웹툰·책 중 맞는 것), 신제품·가젯·자동차 공개 → 쇼핑 '신제품·테크', 스포츠 → 취미 '스포츠', 그 밖의 가벼운 시사 → 가장 잘 맞는 카테고리.\n` +
      `- 지역 축제, 선수 부상, 업계 내부 소식처럼 관심 있는 소수만 아는 뉴스와 정치·범죄·사고·재난·사망 소식은 후보에 있어도 화제 카드로 쓰지 마세요.\n` +
      `- news 필드: 가장 강한 화제 카드에 "first", 두 번째에 "second", 나머지(경제 카드 포함)는 모두 "none". 덱 순서는 코드가 정해요 — 특별한 날 카드가 있으면 그게 맨 앞, 없으면 "first" 카드가 맨 앞에 놓이고 그 제목이 아침 9시 알림 문구가 되니, 알림으로 받았을 때 가장 눌러 보고 싶을 소식을 "first"로 고르세요.\n` +
      `- ★특정 작품·영화·드라마·인물을 소재로 쓸 거면 반드시 그 제목/이름을 구체적으로 밝히세요. "화제의 한국 영화가 베일을 벗었다", "여름 극장가 기대작", "뜨거운 관심을 모은 그 드라마"처럼 무엇을 말하는지 알 수 없는 두루뭉술한 표현은 금지예요 — 알맹이가 없어 대화가 안 이어져요. [오늘의 화제 뉴스 후보]에 구체적 제목이 없어 무엇인지 특정할 수 없으면, 그 소재는 아예 쓰지 말고 "요즘 극장에서 뭐 보셨어요?", "요새 정주행하는 드라마 있으세요?"처럼 작품을 특정하지 않는 완전 보편 질문으로 바꾸세요. 브리프에 없는 제목·이름을 지어내는 건 금지.\n` +
      `- ★★행사·공연·경기가 "오늘" 열린다고 절대 단정하지 마세요. 헤드라인의 '오늘 저녁', '오늘 밤', '1시간 뒤'는 그 기사 발행일 기준이라 오늘과 다릅니다 — 어제 끝난 불꽃축제를 오늘 아침에 "오늘 밤 열린다"고 안내한 사고가 있었습니다. 날짜가 확실한 건 위 [한국의 특별한 날] 표뿐이에요. 지난 행사는 "어제 ~했다던데 다녀오셨어요?"처럼 지난 일로 쓰거나, 시점을 빼고 "불꽃축제 좋아하세요?"처럼 취향 질문으로 바꾸세요. 시작 시각·남은 시간을 지어내는 것도 금지.\n` +
      `- 요즘 주식·재테크에 관심이 많은 분위기라, '경제' 카테고리로 생활경제 주제를 하나 넣어주세요. 기본은 "요즘 주식이나 재테크 하세요?", "월급 모으기 참 어렵죠", "물가 체감"처럼 누구나 자기 얘기로 대답할 수 있는 소재로.\n` +
      `- ★단, [시장 시그널]에 '큰 변동' 표시가 있거나 [오늘의 화제 뉴스 후보]의 [경제] 줄에 기준금리 인상/인하 같은 굵직한 경제 뉴스가 있으면, 그날의 경제 주제는 두루뭉술한 물가 얘기 대신 그 사실을 구체적으로 다루세요. 수치도 브리프에 있는 그대로 인용해도 좋아요(예: "삼성전자가 금요일에 9% 가까이 빠졌다던데, 뒤숭숭하지 않으세요?", "기준금리가 0.25%p 올랐다는데 대출 이자 걱정되시죠?"). 브리프에 없는 수치·날짜를 지어내는 건 금지.\n` +
      `- ★★오르내림은 [시장 시그널]에 적힌 '올랐어요/내렸어요'를 그대로 쓰세요. 숫자만 보고 방향을 추측하지 마세요 — 환율이 크게 내렸는데 "올랐다"고 쓴 사고가 있었습니다. 환율은 숫자가 내려가면 원화 강세(해외여행·직구에 유리), 올라가면 원화 약세예요. 브리프에 '→ 원화 강세/약세'가 적혀 있으면 그 해석을 따르세요.\n` +
      `- ★★시장 수치를 언급할 땐 [시장 시그널] 각 줄에 적힌 기준일 표현을 그대로 쓰세요. 주식·코스피는 주말·공휴일에 쉬기 때문에, 기준일이 "8월 15일(금)"인데 "어제"라고 쓰면 날짜가 틀립니다(일요일 주제에 금요일 등락을 "어제"라고 쓴 사고 있음). 기준일이 '어제'라고 적혀 있을 때만 "어제"라고 쓰고, 아니면 "지난 금요일" 같은 실제 요일이나 "최근"으로 쓰세요.\n` +
      `- 이때도 매수/매도 추천·목표가·시황분석·전망은 절대 금지 — "다들 얘기하더라"며 화제로 가볍게 나누는 톤만. 삼성전자·SK하이닉스·코스피·환율·비트코인처럼 다들 아는 것만 다루고, 소수만 아는 종목은 피하세요.\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개.\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지.\n` +
      `- imageQueries: 이 주제의 커버 사진을 찾기 위한 검색어 3개(서로 다른 피사체/장면으로). 반드시 사진으로 실제 찍을 수 있는 구체적 대상(사물·음식·날씨·장소·행동)으로 쓰세요. "주말", "느낌", "분위기" 같은 추상적 시간/기분 표현은 금지 — 대신 그 시간에 실제 보이는 장면으로 바꾸세요(예: "비 오는 일요일 집에서" → "person relaxing sofa blanket" / "rain drops window" / "umbrella wet street"). 한국 고유 음식/지명은 일반적인 영어 표현으로(예: 삼계탕→"chicken soup bowl", 냉면→"cold noodles bowl"). 브랜드명·고유명사·한국어 금지. 화제 카드도 마찬가지로 그 소식의 일반적인 사물·장면으로 쓰세요(예: 신차 공개 → "red electric sports car road", "electric car charging station" / 드라마 → "tv remote sofa living room" / 야구 → "baseball stadium night crowd"). 전시장·매장·박람회·간판처럼 다른 회사 로고가 찍히기 쉬운 장면은 피하세요. 연예인·선수 등 실존 인물 이름은 절대 금지.\n` +
      `- reason은 오늘 날짜·날씨·맥락 반영. JSON만 출력.`,
  }],
}).finalMessage();

// Log usage so cost is visible in the Actions log (claude-sonnet-5-5: $2 in /
// $10 out per 1M tokens; output includes thinking tokens).
{
  const u = gen.usage;
  const cost = (u.input_tokens * 2 + (u.cache_creation_input_tokens || 0) * 2.5
    + (u.cache_read_input_tokens || 0) * 0.2 + u.output_tokens * 10) / 1e6;
  console.log(`tokens: in ${u.input_tokens} / out ${u.output_tokens} (stop=${gen.stop_reason}) → ~$${cost.toFixed(3)}`);
}

const raw = gen.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
// A truncated response surfaces as a confusing JSON syntax error several
// hundred lines into the log — say what actually happened instead.
if (gen.stop_reason === 'max_tokens') {
  throw new Error(
    `model hit max_tokens (${gen.usage.output_tokens} out) and the JSON is cut off — raise max_tokens`,
  );
}
const data = JSON.parse(raw);
data.topics = (data.topics || []).filter((t) => Array.isArray(t.questions) && t.questions.length === 3).slice(0, 8);
if (data.topics.length < 3) throw new Error('not enough valid topics');

// Shuffle so the deck order varies day to day — the model tends to emit the
// same category sequence (날씨→음식→일상→문화→경제), which made every morning
// open on the weather card.
for (let i = data.topics.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [data.topics[i], data.topics[j]] = [data.topics[j], data.topics[i]];
}

// A once-a-year special day (초복/중복/말복/명절 등) should always OPEN the deck:
// the shuffle above can otherwise bury it (today's 중복 topic landed last), and
// the 09:00 push uses topics[0] as the headline. Pin the model-flagged special
// topic to the front, then drop the internal flag (not part of the app's Topic
// shape).
if (todaySpecial) {
  const si = data.topics.findIndex((t) => t.special);
  if (si > 0) data.topics.unshift(data.topics.splice(si, 1)[0]);
}
// Keep `special: true` on the pinned topic (the app re-orders the deck by the
// user's 관심 주제 and must know which card stays first); drop the noisy
// `special: false` from the rest.
for (const t of data.topics) if (!t.special) delete t.special;

// 오늘의 화제: the strongest news card opens the deck — topics[0] becomes the
// 09:00 push headline — unless today's special-day card holds that spot, in
// which case it goes right behind it. The second news card lands somewhere in
// the first four. Only the model's first 'first' and first 'second' count, so
// the deck never pins more than two; a lone 'second' is promoted.
{
  const pool = data.topics.filter((t) => !t.special);
  const picks = [pool.find((t) => t.news === 'first'), pool.find((t) => t.news === 'second')].filter(Boolean);
  if (picks.length) {
    const head = data.topics[0]?.special ? 1 : 0;
    const rest = data.topics.filter((t) => !picks.includes(t));
    rest.splice(head, 0, picks[0]);
    if (picks[1]) {
      const lo = head + 1;
      const hi = Math.min(3, rest.length);
      rest.splice(lo + Math.floor(Math.random() * (hi - lo + 1)), 0, picks[1]);
    }
    data.topics = rest;
  }
}

// One line per run saying which cards really came from the news candidates —
// matched on distinctive headline terms (a quoted title, two key words, or one
// key word of 3+ characters found in the card's title/desc), independently of
// the model's own `news` flag, which is shown alongside.
{
  const matchHeadline = (t) => {
    if (!news) return null;
    const text = `${t.title} ${t.desc}`.toLowerCase().replace(/\s+/g, '');
    let best = null;
    for (const n of news) {
      const quoted = quotedTitles(n.title).filter((q) => text.includes(q));
      const words = [...keyWords(n.title)].filter((w) => text.includes(w));
      if (!quoted.length && words.length < 2 && !words.some((w) => w.length >= 3)) continue;
      const score = quoted.length * 10 + words.reduce((sum, w) => sum + w.length, 0);
      if (!best || score > best.score) best = { n, score };
    }
    return best?.n ?? null;
  };
  const describe = (t, n, flag = true) =>
    `'${t.id}' ← ${n ? `"${n.line}"` : '(no headline match)'}` +
    (flag ? (t.news && t.news !== 'none' ? ` [${t.news}]` : ' [unflagged]') : '');
  const slot = [];
  const econ = [];
  for (const t of data.topics) {
    const n = matchHeadline(t);
    if (n && n.tag === '경제' && t.news !== 'first' && t.news !== 'second') econ.push(describe(t, n, false));
    else if (n || (t.news && t.news !== 'none')) slot.push(describe(t, n));
  }
  console.log(
    `news slot: ${news ? `${slot.length} card(s)${slot.length ? ': ' + slot.join(', ') : ''}` : 'no candidates in the brief'}` +
    (econ.length ? `; 경제 card from a headline: ${econ.join(', ')}` : ''),
  );
}
for (const t of data.topics) delete t.news; // internal only — not part of the app's Topic shape

// --- cover photos: Openverse, CC0 only (no attribution required), keyless ---
// SEVERAL fallbacks per category, tried in random order. One fixed phrase per
// category meant the same photo every time the model's own queries missed —
// 경제 shipped the identical stock-conference photo on 8 of 13 days (2026-08).
//
// Keep each phrase SHORT (1-2 words). These are matched against Commons file
// titles, where "stock market" hits plenty of CC0 files but a descriptive
// phrase like "stock market chart screen" hits nothing.
// NOTE: 'korean culture city' returned ~0 usable results and silently killed
// the fallback (2026-07-08) — verify a phrase before adding it here.
const CAT_FALLBACK_QUERIES = {
  '시즌': ['landscape season', 'nature field', 'sky clouds'],
  '날씨': ['weather sky', 'clouds rain', 'city street'],
  '음식': ['food dish', 'noodles bowl', 'fruit table', 'restaurant meal'],
  '일상': ['coffee cup', 'living room', 'morning table', 'sofa blanket'],
  '문화': ['cinema theatre', 'concert stage', 'music guitar', 'city street'],
  // 경제: 삼성·하이닉스 사진은 Commons에 CC BY-SA뿐이라 (저작자 표시 필요) 못 쓴다.
  // 대신 반도체·증시·지폐처럼 같은 이야기를 하는 CC0 소재로 돌린다.
  // Verified against Commons on 2026-08-30 (CC0/PD + ≥600x400 + keyword match):
  // stock market 8 / semiconductor 6 / banknote 16 / financial chart 8 /
  // stock exchange 8 / currency 5 — about 50 distinct photos to rotate through.
  // ('coins' and 'bank building' both returned 0 — don't put them back.)
  '경제': ['stock market', 'semiconductor', 'banknote', 'financial chart', 'stock exchange', 'currency'],
  '여행': ['airport terminal', 'train station', 'suitcase travel', 'beach sea'],
  '건강': ['running', 'gym', 'vegetables healthy', 'sleeping bed'],
  '취미': ['guitar music', 'books reading', 'camera photography', 'board game'],
  '쇼핑': ['supermarket', 'shopping', 'clothes shop', 'market stall'],
  '커리어': ['office desk', 'laptop computer', 'subway commuters', 'notebook pen'],
  '관계': ['friends talking', 'cafe table', 'family dinner', 'people walking'],
};

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'with', 'of', 'in', 'on', 'at']);

// STRICT relevance: at least one query keyword must appear (word-prefix
// match) in the candidate's text, or it's rejected. Accepting zero-overlap
// hits shipped a sushi photo on a 늦잠 card (2026-07-11) — an unrelated
// photo is worse than the gradient fallback.
function relevanceScorer(query, minHits) {
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  // One shared word is not a match. "collection shelf items" hit an archive
  // series called "…van Achterberg Collection…" (a mud hut), and a 다이어트
  // query landed on "Rib Room, Somerset Hotel" through "room". Demand two hits
  // whenever the query has two words to offer.
  const need = minHits ?? Math.min(2, keywords.length);
  return (text) => {
    const hay = text.toLowerCase();
    const hits = keywords.reduce((n, k) => n + (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay) ? 1 : 0), 0);
    return hits >= need ? hits : 0;
  };
}

// Public-domain pools skew hard to museum scans — a 무굴 세밀화 of fireworks
// beat real festival photos on 2026-09-06. Score how likely a file is to be an
// ordinary modern photograph so artwork loses to it.
const ARTWORK =
  /painting|drawing|engraving|etching|lithograph|woodcut|manuscript|illustration|sketch|fresco|tapestry|miniature|portrait of|still life|watercolou?r|oil on canvas|museum|gallery|sculpture|statue|relief|coin|stamp|map of|folio|codex|scroll|album leaf/i;
// Museum uploads are catalogue scans of objects, and they name the institution
// rather than saying "museum" — "Shelf_Clock_MET_202371.jpg" filled a 수집 card.
const MUSEUM_UPLOAD =
  /\bMET\b|rijksmuseum|wellcome|smithsonian|getty|louvre|\bNGA\b|\bBnF\b|BAnQ|nypl|library of congress|LC-[A-Z]|ASC Leiden|Tropenmuseum|Bundesarchiv|Nationaal Archief|KITLV|archief|\barchives?\b|collectie|\bDPLA\b|europeana|internet archive|\bLACMA\b|\bYCBA\b|cleveland museum/i;
// Maps, charts and logos are files, not photographs — a PIIGS eurozone map
// (.png) fronted an 증시 card. Photos on Commons are overwhelmingly JPEG.
const NOT_A_PHOTO = /\bmap\b|chart|diagram|graph\b|logo|icon|flag|emblem|coat of arms|infographic|screenshot|\.(png|svg|gif)\b/i;
// Scans of printed matter read as "old" instantly — a 1900s Brimham Rocks
// postcard fronted 수집 because the query said "postcard collection".
const PRINTED_SCAN = /postcard|poster|passbook|certificate|ticket|document|book cover|title page|\bpage \d|advertisement|brochure|pamphlet|leaflet|newspaper|magazine cover/i;
const OLD_YEAR = /\b(1[0-8]\d{2}|19[0-5]\d)\b/;

// Category names that mark a file as artwork, a scan, or a historical photo.
// "X in art of Y" and "… in the <Whatever> Museum" are how Commons files any
// depicted-in-artwork or museum-held object, whatever the medium — a lacquer
// tsuba filed under "Insects in art of Japan" / "Tsuba in the Walters Art
// Museum" fronted 가을밤 (2026-09-10). Matching the phrasing beats listing museums.
const BAD_CATEGORY =
  /paintings|drawings|watercolou?r|engravings|etchings|lithographs|prints\b|artworks|illustrations|manuscripts|\bmaps\b|postcards|posters|black and white|monochrome|photographs (from|of|taken in) the (18|19[0-6])|\b(18\d\d|19[0-5]\d)s?\b|scans?\b|sculptures|statues|coins|stamps|\bin art\b|\bart of\b|\bmuseum\b|art gallery|decorative arts|arms and armou?r|antiquities|artifacts?\b/i;
const GOOD_CATEGORY = /images from unsplash|unsplash|pexels|pixabay|featured pictures|quality images/i;

function photoScore(text, categories = '') {
  let q = 0;
  if (BAD_CATEGORY.test(categories)) q -= 6;
  if (GOOD_CATEGORY.test(categories)) q += 4;
  if (/\(unsplash\)/i.test(text)) q += 3; // Unsplash donations: modern photos
  if (ARTWORK.test(text) || MUSEUM_UPLOAD.test(text)) q -= 5;
  if (NOT_A_PHOTO.test(text)) q -= 4;
  if (PRINTED_SCAN.test(text)) q -= 4;
  if (OLD_YEAR.test(text)) q -= 3;
  return q;
}

// Cover images used in the last few days — so a recurring category (경제/주식,
// 날씨 등) doesn't keep showing the exact same photo. We skip these when a fresh
// alternative exists.
function getRecentImages(days = 7) {
  try {
    const files = readdirSync('content/archive').filter((f) => f.endsWith('.json')).sort().slice(-days);
    const urls = new Set();
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(`content/archive/${f}`, 'utf8'));
        for (const t of j.topics || []) if (t.image) urls.add(t.image);
      } catch {}
    }
    return urls;
  } catch {
    return new Set();
  }
}
const recentImages = getRecentImages();

// Pick with variety: drop images shown in the last few days, then choose
// RANDOMLY among the top-scored candidates instead of always the single best —
// so the same query/category stops returning an identical cover every day.
// All candidates already passed the strict keyword-relevance filter, so a
// random top pick stays on-topic. `sorted` is [{ url, ... }] best-first.
function pickVaried(sorted) {
  if (!sorted.length) return null;
  const fresh = sorted.filter((c) => !recentImages.has(c.url));
  const pool = fresh.length ? fresh : sorted; // all seen recently → allow reuse
  // Rotate only among candidates as good as the best one. Picking uniformly
  // across the whole top-6 is what let a painting win over real photos.
  const best = pool[0];
  const tier = pool.filter(
    (c) => (c.q ?? 0) === (best.q ?? 0) && (best.s ?? 0) - (c.s ?? 0) <= 1,
  );
  const top = (tier.length ? tier : pool).slice(0, 6);
  return top[Math.floor(Math.random() * top.length)];
}

// Strip the HTML Commons wraps author/licence fields in, and decode the few
// entities that survive it (an author literally rendered as
// "Aussie Clotheslines &amp; Letterboxes" on 2026-08-30).
function plain(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Commons Artist fields are often boilerplate rather than a name, e.g.
// "The original uploader was Foo at English Wikipedia." Pull the actual name
// out so the credit line reads like a credit and not a sentence.
function creditName(raw) {
  let a = plain(raw);
  const uploader = a.match(/original uploader was\s+(.+?)\s+at\s+\S/i);
  if (uploader) a = uploader[1];
  a = a.replace(/\s*\(talk\|contribs\)\s*/gi, ' ')
       .replace(/\s*\bat (English |German |French )?Wikipedia\b\.?/i, '')
       .replace(/\s*[.,;]\s*$/, '')
       .trim();
  return a.slice(0, 50);
}

// Both searches return an ARRAY of candidates:
//   { url, s, free, credit }
// `free` = attribution-free (CC0 / public domain) → safe for every app version.
// Anything else carries `credit` and may only be shown by app builds that
// render a credit line (see `imageAttributed` below).
async function searchOpenverse(query) {
  try {
    // Pull a wider page (30) so pickVaried has more distinct candidates.
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0,pdm,by,by-sa&page_size=30`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json();
    const results = (j.results || []).filter((it) => (it.width ?? 0) >= 600 && (it.height ?? 0) >= 400 && it.url);
    const score = relevanceScorer(query);
    const hay = (it) => `${it.title || ''} ${(it.tags || []).map((t) => t.name || t).join(' ')}`;
    return results
      .map((it) => {
        const lic = String(it.license || '').toLowerCase();
        const free = lic === 'cc0' || lic === 'pdm';
        return {
          url: it.url,
          s: score(hay(it)),
          q: photoScore(hay(it)),
          free,
          credit: free ? null : {
            author: it.creator || '(unknown)',
            license: `CC ${lic.toUpperCase()}${it.license_version ? ' ' + it.license_version : ''}`,
            licenseUrl: it.license_url || '',
            sourceUrl: it.foreign_landing_url || it.url,
          },
        };
      })
      .filter((c) => c.s > 0)
      // Photo-likeness first, then relevance. Attribution-free no longer wins
      // outright — it was pulling old public-domain scans to the top.
      .sort((a, b) => b.q - a.q || b.s - a.s);
  } catch (e) {
    console.log(`openverse search failed for "${query}":`, e.message);
    return [];
  }
}

// Wikimedia Commons, keyless. Same strict keyword rule (Commons full-text
// search alone returns loose matches like paintings for "sleeping bed").
// CC0/PD are attribution-free; CC BY / BY-SA come back with credit metadata.

let lastCommonsCall = 0;
// 1.2s still drew 429s once the cascade (correctly) kept going past
// artwork-only results — more Commons calls per run. 2s keeps it under.
const COMMONS_GAP_MS = 2000;
async function commonsJson(params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCommonsCall + COMMONS_GAP_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastCommonsCall = Date.now();
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': 'daily-smalltalk-content/1.0 (github.com/realkose1/daily-smalltalk-support)' },
      signal: AbortSignal.timeout(10000),
    });
    const txt = await r.text();
    try {
      const j = JSON.parse(txt);
      if (!j.error) return j;
      console.log(`commons api error: ${JSON.stringify(j.error).slice(0, 120)}`);
    } catch {
      console.log(`commons non-JSON (${r.status}): ${txt.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    if (attempt < 2) {
      // One 8s pause wasn't enough on 2026-09-11 — the limit was still up
      // when it retried. Wait 10s, then 20s.
      const back = attempt === 0 ? 10000 : 20000;
      console.log(`commons: rate-limited — backing off ${back / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise((res) => setTimeout(res, back));
    }
  }
  return null;
}

async function searchCommons(query) {
  try {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'search', gsrsearch: `filetype:bitmap ${query}`, gsrnamespace: '6', gsrlimit: '20',
      // Categories are curated by editors and say "Paintings" / "Black and
      // white photographs" / "Images from Unsplash" outright — far more
      // reliable than sniffing the filename.
      prop: 'imageinfo|categories', cllimit: '30', clshow: '!hidden',
      iiprop: 'url|size|extmetadata', iiurlwidth: '1280',
    });
    // Commons rate-limits bursts, and it does so QUIETLY: the body becomes
    // "You are making too many requests" (non-JSON), which used to be caught
    // and returned as "no candidates" — the last three topics of a run came
    // back imageless in 0.3s each (2026-09-10). Space calls out, and when the
    // limit does hit, wait and retry once.
    const j = await commonsJson(params);
    if (!j) return [];
    const score = relevanceScorer(query);
    const titleHit = relevanceScorer(query, 1);
    return Object.values(j.query?.pages || {})
      .map((p) => {
        const ii = p.imageinfo?.[0];
        if (!ii) return null;
        const lic = plain(ii.extmetadata?.LicenseShortName?.value);
        const free = /cc0|public domain/i.test(lic);
        // Only CC BY / CC BY-SA beyond that — no NC/ND, which we can't use.
        if (!free && !/^cc by(-sa)? /i.test(lic)) return null;
        if ((ii.width ?? 0) < 600 || (ii.height ?? 0) < 400) return null;
        const desc = plain(ii.extmetadata?.ImageDescription?.value);
        const hay = `${p.title} ${desc}`;
        const s = score(hay);
        if (s <= 0) return null;
        // Descriptions are long and noisy; "thumbnail.jpeg" got through on its
        // description alone. The filename itself must carry a keyword.
        if (titleHit(p.title) <= 0) return null;
        const cats = (p.categories || []).map((c) => c.title || '').join(' | ');
        const author = creditName(ii.extmetadata?.Artist?.value);
        // An attributed file with no usable author line can't be credited
        // properly, so treat it as unusable rather than crediting "unknown".
        if (!free && !author) return null;
        return {
          url: ii.thumburl || ii.url,
          s,
          q: photoScore(hay, cats),
          free,
          cc0: /cc0/i.test(lic),
          credit: free ? null : {
            author,
            license: lic,
            licenseUrl: plain(ii.extmetadata?.LicenseUrl?.value),
            sourceUrl: ii.descriptionurl || ii.url,
          },
        };
      })
      .filter(Boolean)
      // Photo-likeness first, then CC0 over PD (modern Unsplash donations
      // rather than dated scans), then relevance. Attribution-free is no longer
      // the top key — the CC0/PD pool is where the museum scans live, and the
      // free pick is taken separately anyway.
      .sort((a, b) => b.q - a.q || (b.cc0 - a.cc0) || (b.s - a.s));
  } catch (e) {
    console.log(`commons search failed for "${query}":`, e.message);
    return [];
  }
}

for (const t of data.topics) {
  const queries = (Array.isArray(t.imageQueries) ? t.imageQueries : []).filter(Boolean).slice(0, 3);
  // Cascade: the model's own queries on Openverse, then on Commons, then the
  // shuffled category fallback on both. Stop at the first query that yields
  // candidates. Gradient only if the whole cascade misses.
  // Judge usability INSIDE the cascade. It used to break on the raw candidate
  // count and only drop artwork/museum scans afterwards, so a query that came
  // back with 20 condemned files "succeeded", the loop stopped, and the topic
  // shipped with no cover — 4 gradients on 2026-09-10 and 3 on 09-11, each
  // decided in ~1.3s without ever reaching the fallbacks.
  const usableOnly = (list) => list.filter((c) => (c.q ?? 0) > -5);
  let usable = [];
  for (const q of queries) { usable = usableOnly(await searchOpenverse(q)); if (usable.length) break; }
  if (!usable.length) for (const q of queries) { usable = usableOnly(await searchCommons(q)); if (usable.length) break; }
  if (!usable.length) {
    // At most three fallbacks per topic — a hard topic used to walk every
    // phrase on both sources and exhaust the rate budget for the topics after it.
    for (const q of shuffled(CAT_FALLBACK_QUERIES[t.cat] || ['lifestyle']).slice(0, 3)) {
      usable = usableOnly(await searchOpenverse(q));
      if (!usable.length) usable = usableOnly(await searchCommons(q));
      if (usable.length) break;
    }
  }

  // Two picks from the SAME candidate list (no extra API calls):
  //   image            — attribution-free only. Every app version renders this,
  //                      including builds shipped before the credit line existed.
  //   imageAttributed  — best pick regardless of licence, shown only by builds
  //                      that display `imageCredit`. This is what unlocks the
  //                      big CC BY-SA pool (e.g. 삼성 사진은 전부 BY-SA).
  // Anything the photo scoring has condemned (artwork, museum object, scan) is
  // worse on a small-talk card than the app's plain gradient — `usable` above
  // already excludes it, so the gradient is only ever a true last resort.
  const best = pickVaried(usable);
  const free = pickVaried(usable.filter((c) => c.free));

  if (free) { t.image = free.url; recentImages.add(free.url); }
  if (best && !best.free) {
    t.imageAttributed = best.url;
    t.imageCredit = best.credit;
    recentImages.add(best.url);
  }

  delete t.imageQueries; // internal only — not part of the app's Topic shape
  // Say what the CARD gets, not just the CC0 slot: "image=none +attributed"
  // read as "no cover" and sent a whole investigation after a non-problem.
  const cover = t.imageAttributed
    ? `attributed(${t.imageCredit.license})`
    : t.image
      ? 'cc0'
      : 'NONE → gradient';
  console.log(`${t.id}: cover=${cover}; cc0-for-old-builds=${t.image ? 'yes' : 'no'}`);
}

const out = { date: isoDate, dateLabel, generatedAt: now.toISOString(), topics: data.topics };
mkdirSync('content/archive', { recursive: true });
writeFileSync('today.json', JSON.stringify(out, null, 2));
writeFileSync(`content/archive/${isoDate}.json`, JSON.stringify(out, null, 2));
console.log(`Wrote today.json (${out.topics.length} topics) for ${isoDate}`);

// Sync today's headline to Supabase so the 09:00 push (sent by Supabase
// pg_cron — GitHub's cron runs hours late, see push.yml) has the topic title.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (SB_URL && SB_KEY) {
  try {
    const headline = String(out.topics[0].title).replace(/\n/g, ' ');
    const r = await fetch(`${SB_URL}/rest/v1/daily_content?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 1, date_label: out.dateLabel, headline, updated_at: new Date().toISOString() }),
    });
    console.log(`headline sync: ${r.status} "${headline}"`);
  } catch (e) {
    console.log('headline sync failed (push falls back to generic title):', e.message);
  }
}
console.log(`gen tokens: in=${gen.usage.input_tokens} out=${gen.usage.output_tokens} (${MODEL})`);
