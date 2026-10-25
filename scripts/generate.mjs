// Daily Small Talk — content generator (real-time from FREE sources, cheap).
// Runs via GitHub Actions at 04:47 / 05:47 / 06:47 KST (three tries because
// GitHub's cron lands hours late — see daily.yml); the first run that starts
// builds the deck and the others skip (see the run guard below), so the deck
// is in place before the 09:00 push.
// Real-time signals come from free APIs (no Anthropic web search — that injects
// ~100k tokens of page content and costs ~$10/mo). One Sonnet call turns the
// compact brief into 8 topics — the deck went 5 → 8 so that the app's 관심 주제
// picker has enough categories present each day to actually re-order anything.
// A second, small call runs only when the copy lint (repairCopy) finds a field
// that breaks the card's limits or reads like stock AI copy — a title over 32
// chars, a desc over 50, a "~이야기해 보세요" closer — and rewrites just those
// fields. Most days it should not run. Cost ≈ $1.5/month.
//   - Weather: Open-Meteo (free, keyless)
//   - News: Google News KR RSS (free, keyless) — section feeds (top stories,
//     연예, 테크, 스포츠, 경제) plus a product-launch search and a 생활경제
//     search, filtered and deduped into ≤19 headlines. The model turns 1–2 of
//     them into named "오늘의 화제" cards.
//   - Cover photos: Openverse (free, keyless, CC0-only so no attribution is
//     required) — the model also writes 3 generic English `imageQueries` per
//     topic, which we search after generation. No image found → the app
//     falls back to a solid color-gradient cover (never a broken image).
//   - Subject photos: Wikidata → Wikipedia → Commons (free, keyless) — a
//     오늘의 화제 card about one named person / group / team / brand / product /
//     place gets a real photo of THAT subject (CC0/PD, or CC BY / BY-SA with a
//     credit) instead of a generic mood photo. Nothing usable → the cascade above.
//   - Posters: TMDB (free API key) — a 오늘의 화제 card about one specific
//     film or TV programme gets its official poster as the cover, credited to
//     TMDB. Optional: without TMDB_READ_TOKEN every card keeps its photo.
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY (not needed for --brief-only)
// Optional env: TMDB_READ_TOKEN (TMDB v4 read access token, for posters)
// Flags / env:
//   --brief-only  gather weather/markets/news, print the brief the model would
//                 get, and exit — no API call, no files written.
//   FORCE=1       regenerate even if today.json is already from today (KST).
//   DRY_RUN=1     call the model and run the copy lint/repair as usual, print
//                 the whole deck and the cost, then stop: no covers, nothing
//                 written to the repo, no Supabase sync (the deck goes to a
//                 temp file). Skips the run guard, like FORCE.
//   EFFORT=<lvl>  main call's output_config.effort for this run (low|medium|
//                 high|xhigh|max); unset = DEFAULT_EFFORT below.
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'claude-sonnet-5-5'; // reliable "exactly 5 + concise"; bump to opus for max quality

const BRIEF_ONLY = process.argv.includes('--brief-only');
const FORCE = process.env.FORCE === '1';
const DRY_RUN = process.env.DRY_RUN === '1';

// Thinking depth of the main call. Thinking is always on for claude-sonnet-5-5
// ({type:'disabled'} and budget_tokens both 400), so output_config.effort is the
// dial; max_tokens only cuts the answer off. '' = send none (API default 'high').
// Dry runs on 2026-10-26, same brief, de-burdened prompt: 'high' 18.1k in /
// 20.5k out = $0.24; 'medium' 18.2k / 4.8k = $0.085 — the deck's visible JSON
// is ~4.5k tokens, so 'medium' thinks very little and 'low' could save at
// most ~$0.005 more. The copy lint + repair catch what the thinking used to.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';
const EFFORT = (process.env.EFFORT || '').trim() || DEFAULT_EFFORT;
if (EFFORT && !EFFORTS.includes(EFFORT)) {
  console.error(`EFFORT="${EFFORT}" is not one of ${EFFORTS.join('|')}`);
  process.exit(1);
}
// claude-sonnet-5-5, $ per 1M tokens. Output includes thinking.
const PRICE = { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 };
const costOf = (u) => ((u?.input_tokens || 0) * PRICE.in + (u?.cache_creation_input_tokens || 0) * PRICE.cacheWrite
  + (u?.cache_read_input_tokens || 0) * PRICE.cacheRead + (u?.output_tokens || 0) * PRICE.out) / 1e6;
const spend = { main: 0, repair: 0 };

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
  if (DRY_RUN) {
    console.log(`DRY_RUN=1 — generating ${isoDate} to the log only (effort ${EFFORT || 'API default'}); nothing is written or synced`);
  } else if (FORCE) {
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
// 시위 moved to the protest rule below; 김정은's 방중 and a 정청래 / 신천지
// spat got through as [경제] / [주요] lines on 2026-10-25, hence the tail.
const HARD_NEWS = /국힘|민주|여권|야권|당대표|원내|국정|국무|국감|총리|차관|청장(?!년)|지자체장|시장직|도지사|출마|공천|비대위|전작권|북한|北|안보(?![다여이인고])|국방|군사|미군|(?<!급)부상|중상(?!위)|중태|무기(?!한)|군수|백악관|크렘린|폭동|내전|분쟁|공습|휴전|테러|약탈|털려|털렸|털어|도난|절도|강도|방화|흉기|난동|칼부림|범행|범죄|용의자|피의자|수사|혐의|재판|판결|선고|실형|징역|유죄|무죄|피해|유족|희생|순직|사고(?!\s*싶)|붕괴|침몰|추락|실신|이송|응급|심정지|비극|해킹|인종차별|카지노|바카라|블랙잭|김정은|방중|방북|대북|정상회담|최고위원|대변인|정청래|신천지|초토화|쑥대밭|아수라장/;
// People news is fine when it is about public work (작품·컴백·공연·수상·경기),
// never about private life. The ♥/근황/자택/가족 markers are how Korean
// entertainment desks flag relationship and family gossip — on 2026-10-18 the
// 연예 feed's top items included a pregnancy, a ♥ family outing at a theme park
// and an 80th-birthday party at home.
const PRIVATE_BLOCK = /임신|출산|결혼|이혼|열애|결별|파경|불화|폭로|논란|해명|사과문|갑질|학폭|투병|수술|입원|건강 이상|별세|부고|빈소|사생활|루머|의혹|소송|고발|저격|♥|♡|❤|근황|셀카|자택|(?<![가-힣])아내|남편|부부|여친|남친|연인|신혼|태교|D라인|육아|엄마|아빠|(?<![가-힣])딸(?!기)|(?<![가-힣])아들|모친|부친|[장빙][인모]상|비보(?!이)|노브라|몸매|비키니|노출|성형|병역|복무|무단이탈|악플|스토커|팔순|칠순|백수연|고백/;
// Not news at all: photo/video desks, ads and events, horoscopes, opinion
// columns, coin and stock-tip chatter (the 경제 card gets real numbers from
// [시장 시그널]). Detailed weather is WEATHER_DETAIL below.
const NOT_NEWS = /^\s*[[【(]\s*(포토|사진|영상|화보|포토뉴스|카드뉴스|만평|광고|AD|PR|이벤트|사설|칼럼|기고|오피니언|시론|기자수첩|인사|동정|부고)\s*[\]】)]|광고|응모|경품|운세|띠별|별자리|사주|비트코인|이더리움|리플(?!레)|XRP|시바이누|도지코인|솔라나|가상자산|가상화폐|암호화폐|알트코인|밈코인|스테이블코인|특징주|목표가|목표주가|급등주/;
// Forecast copy (the brief already has real weather) — unless the headline
// names a weather EVENT that people bring up for days: "남해 바깥먼바다도
// '태풍경보'…역대 가장 늦은 태풍" went out with the forecasts on 2026-10-25.
// Damage and casualties still go: 피해·사망·실종 are in HARD_NEWS / BLOCK.
const WEATHER_DETAIL = /날씨|기상청|예보|주의보|경보|특보|강수량|㎜/;
const WEATHER_EVENT = /태풍|한파|폭설|첫눈|첫서리|첫얼음|폭염|열대야|황사|오로라|유성우|슈퍼문|월식|일식/;
// Protests. A domestic 시위·집회 is politics and stays out. A foreign one
// with nothing violent in the headline is world news that people saw clips of
// ("프랑스 시위 제한에도 41만명 거리로", 2026-10-25), so it passes — the
// prompt keeps the card to what happened, never which side is right.
const PROTEST = /시위|집회|농성/;
const FOREIGN_PLACE = /프랑스|파리|영국|런던|독일|베를린|이탈리아|로마|스페인|바르셀로나|마드리드|유럽|그리스|네덜란드|벨기에|포르투갈|스위스|오스트리아|폴란드|체코|미국|뉴욕|일본|도쿄|오사카|대만|타이베이|홍콩|태국|방콕|베트남|필리핀|인도네시아|호주|캐나다|멕시코|브라질|아르헨티나|칠레|페루|해외|[美日英佛獨]/;
const PROTEST_VIOLENCE = /폭동|폭력|충돌|최루|진압|연행|유혈|총격|격화|사상자|과격/;
// The WORLD feed is mostly war and summitry; BLOCK / HARD_NEWS catch the
// words they share with domestic hard news, this catches the rest.
const FOREIGN_HARD = /(?<![가-힣])이란(?![가-힣])|이스라엘|가자지구|하마스|헤즈볼라|후티|우크라|푸틴|시진핑|네타냐후|젤렌스키|핵(무기|실험|협상|시설|잠수함|위협|보유)|제재|쿠데타|계엄|난민|탈레반|교전|폭격|포격|인질|항공모함|벙커버스터|국경|피격|격침|나포|호르무즈|흑해|주[한일중미러]\s?\S{0,3}\s?대사|인도·?태평양|공산당|중전회|당정|지도부|외무|의회|상원|하원/;
// Animals with a name or a nickname ('부캉이', 푸바오) are what a whole office
// ends up talking about; the 동물 search below looks for them.
const ANIMAL = /상어|돌고래|(?<!알)고래(?!싸움)|상괭이|판다|푸바오|루이바오|후이바오|물범|바다사자|물개|수달|펭귄|반달가슴곰|북극곰|아기 (사자|호랑이|코끼리|기린|판다)/;
// A story whose other coverage keeps counting casualties is about them, even
// when its own headline isn't (a typhoon line is fine; the typhoon's death toll
// is not small talk). Checked across the story's related titles, ≥2 to veto.
const CASUALTY = /사망|숨진|숨져|사상자|실종|희생|부상자|중상자|중태|목숨/;
// Why a headline stays out of the brief, or null when it may go in. Shared by
// the feed items and their related-coverage titles (`details`).
function dropReason(title, source = '') {
  const hit = (re) => (title.match(re) || [])[0];
  if (title.length <= 6 || SENTENCE_TITLE.test(title) || SOURCE_BLOCK.test(source)) return 'notNews';
  if (NOT_NEWS.test(title)) return `notNews:${hit(NOT_NEWS)}`;
  if (WEATHER_DETAIL.test(title) && !WEATHER_EVENT.test(title)) return `notNews:${hit(WEATHER_DETAIL)}`;
  for (const re of [BLOCK, HARD_NEWS, FOREIGN_HARD]) if (re.test(title)) return `block:${hit(re)}`;
  if (PROTEST.test(title) && (!FOREIGN_PLACE.test(title) || PROTEST_VIOLENCE.test(title))) return `block:${hit(PROTEST)}${FOREIGN_PLACE.test(title) ? `+${hit(PROTEST_VIOLENCE)}` : '(국내)'}`;
  if (PRIVATE_BLOCK.test(title)) return `private:${hit(PRIVATE_BLOCK)}`;
  return null;
}
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
// a brand and a launch verb, and must not be about sport. Postseason headlines
// rarely say 야구: "[공식발표] '삼성 이렇게 안 풀릴 수가' … KIA 그대로 간다"
// became a 테크 line on 2026-10-25 and, through "태풍 '참피'에 프로야구
// 플레이오프 1차전 취소", soaked up every typhoon story (관련 74).
const LAUNCH_TITLE = new RegExp(`(?=.*(${LAUNCH_BRANDS}))(?=.*(${LAUNCH_VERBS}))`, 'i');
const SPORT_WORDS = /KBO|프로야구|야구|축구|농구|배구|골프|골든글러브|감독|선수|구단|리그|라이온즈|타이거즈|썬더스|플레이오프|포스트시즌|한국시리즈|\d차전|(?<![A-Za-z])PO(?![A-Za-z])|선발|출격/;
const NEWS_SECTIONS = [
  { tag: '연예', cap: 6, show: 0, feeds: [['ENTERTAINMENT', topicFeed('ENTERTAINMENT')]] },
  { tag: '스포츠', cap: 3, show: 1, feeds: [['SPORTS', topicFeed('SPORTS')]] },
  {
    tag: '테크', cap: 3, show: 2, feeds: [
      ['TECHNOLOGY', topicFeed('TECHNOLOGY')],
      [
        'launch search',
        searchFeed(`(${LAUNCH_VERBS.split('|').join(' OR ')}) (${LAUNCH_BRANDS.split('|').join(' OR ')})`),
        (t) => LAUNCH_TITLE.test(t) && !SPORT_WORDS.test(t),
      ],
    ],
  },
  {
    tag: '경제', cap: 3, show: 7, feeds: [
      ['BUSINESS', topicFeed('BUSINESS')],
      ['경제 search', searchFeed('(물가 OR 경제 OR 주식 OR 부동산 OR 금리 OR 월급)')],
    ],
  },
  // What the office talks about besides 연예·스포츠·테크 (added 2026-10-25,
  // when the deck went to 4–5 화제 cards): a named weather event, world news
  // people saw clips of, an animal with a nickname. Search results carry no
  // related-coverage list, so `minCoverage` asks for the same story from at
  // least two outlets instead.
  {
    tag: '날씨', cap: 2, show: 3, minCoverage: 2, feeds: [
      ['weather search', searchFeed('(태풍 OR 한파 OR 폭설 OR 첫눈 OR 폭염 OR 황사 OR 오로라 OR 유성우)'), (t) => WEATHER_EVENT.test(t)],
    ],
  },
  { tag: '해외', cap: 2, show: 4, minRelated: 1, feeds: [['WORLD', topicFeed('WORLD')]] },
  {
    tag: '동물', cap: 2, show: 5, minCoverage: 2, feeds: [
      ['animal search', searchFeed('(상어 OR 돌고래 OR 고래 OR 상괭이 OR 판다 OR 푸바오 OR 물범 OR 바다사자 OR 수달 OR 펭귄)'), (t) => ANIMAL.test(t)],
    ],
  },
  // Top stories without a related-coverage list are the feed's niche filler
  // (a CO₂-capture explainer, one company's drug recall) — not "top".
  { tag: '주요', cap: 4, show: 6, minRelated: 1, feeds: [['top stories', `https://news.google.com/rss?${GN}`]] },
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
      // <description> is an HTML list of the same story's coverage (escaped
      // in the raw XML). Google caps it at 5; 0 = a lone article. Those other
      // outlets' headlines carry the details the card needs ("상어 '부캉이'
      // 이틀 연속 부산항 … 관측" under a headline about an oil spill), so keep them.
      const desc = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      // Entities only — plain() would strip the very tags parsed here (the
      // list arrives escaped, or as real tags inside CDATA).
      const html = desc.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
      const alts = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>(?:\s*<font[^>]*>([\s\S]*?)<\/font>)?/g)]
        .map((a) => stripOutlet(plain(a[1]).replace(/\\(['"])/g, '$1'), plain(a[2] || '')))
        .filter(Boolean);
      return {
        title: stripOutlet(xmlField(item, 'title'), source),
        source,
        pub: Number.isFinite(pub) ? pub : null,
        related: (item.match(/&lt;li&gt;|<li>/g) || []).length,
        alts,
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

// Other outlets' headlines for the same story that add something the line
// doesn't say — the number, the place, the nickname. Up to `max`, each passing
// the same filters as a feed item and sharing a key word or quoted name with
// the story (Google's related list sometimes strays: a 'AI 영상복제' piece sat
// under 이수만's 골든벨 on 2026-10-25).
const PROMO = /전격|혜택|증정|이벤트|할인|프로모션|사은품|기념|선착순/;
function pickDetails(st, max = 2) {
  const words = new Set(st.members.flatMap((m) => [...m.kw]));
  const quotes = new Set(st.members.flatMap((m) => quotedTitles(m.title)));
  const pool = [...new Set([...st.members.slice(1).map((m) => m.title), ...st.members.flatMap((m) => m.alts || [])])]
    .filter((t) => t !== st.title && t.length <= 70 && !dropReason(t))
    .filter((t) => [...keyWords(t)].some((w) => words.has(w)) || quotedTitles(t).some((q) => quotes.has(q)));
  const seen = new Set(shingles(st.title));
  const out = [];
  while (out.length < max) {
    let best = null;
    for (const t of pool) {
      if (out.includes(t)) continue;
      // New wording counts up to a point (a long headline isn't a better one);
      // a number or a name the line lacks is the detail a card can use (the
      // group under 이수만's 골든벨 is only named in a related title: "A2O
      // LITE"); promo copy isn't news.
      const fresh = [...shingles(t)].filter((x) => !seen.has(x)).length;
      const latinName = (t.match(/[A-Za-z][A-Za-z0-9]+/g) || []).some((w) => !st.title.includes(w));
      const quoteName = quotedTitles(t).some((q) => !quotes.has(q));
      const score = Math.min(fresh, 12) + (/\d/.test(t) ? 4 : 0) + (latinName ? 5 : 0) + (quoteName ? 2 : 0) - (PROMO.test(t) ? 6 : 0);
      if (fresh >= 4 && (!best || score > best.score)) best = { t, score };
    }
    if (!best) break;
    out.push(best.t);
    for (const x of shingles(best.t)) seen.add(x);
  }
  return out;
}

// How likely most coworkers have already heard of it: coverage, plus showing
// up in more than one feed, being from today, and carrying a quoted name or
// nickname ('부캉이', '참피') — the hook people repeat.
const buzzOf = (st) =>
  st.coverage + (st.feeds.size > 1 ? 2 : 0) + (kstDayLabel(Math.floor(st.pub / 1000)) === '오늘' ? 1 : 0) + (quotedTitles(st.title).length ? 1 : 0);
const BUZZ_STARS = 6; // ★ on the top few non-경제 lines

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
  const dropped = new Map(); // NEWS_DEBUG=2: title → reason
  const stories = []; // all sections, so cross-feed duplicates merge
  for (const s of NEWS_SECTIONS) {
    const pool = jobs
      .flatMap((j, i) => (j.s === s ? (results[i] || []).map((it) => ({ ...it, feed: j.label })) : []).filter((it) => !j.keep || j.keep(it.title) || (drop.offTopic++, false)))
      .filter((it) => {
        if (!it.pub || now - it.pub > NEWS_MAX_AGE_MS || it.pub - now > 3600e3) return drop.stale++, false;
        const why = dropReason(it.title, it.source);
        if (why) {
          drop[why.split(':')[0]]++;
          dropped.set(it.title, `${why} [${it.feed}]`);
          return false;
        }
        return true;
      })
      // Best-covered, then newest, becomes the story's representative.
      .sort((a, b) => b.related - a.related || b.pub - a.pub);
    for (const it of pool) {
      const me = { title: it.title, sh: shingles(it.title), kw: keyWords(it.title), qt: quotedTitles(it.title)[0], alts: it.alts };
      const story = stories.find((st) => st.members.some((m) => sameStory(m, me)));
      if (story) {
        story.members.push(me);
        story.related = Math.max(story.related, it.related);
        story.feeds.add(it.feed);
      } else {
        stories.push({ ...it, tag: s.tag, minRelated: s.minRelated || 0, minCoverage: s.minCoverage || 0, members: [me], feeds: new Set([it.feed]) });
      }
    }
  }
  // 관련 N = Google's related-coverage count (capped at 5 by Google) plus every
  // other copy of the story we saw across feeds and outlets. The second half is
  // what ranks the search results, which carry no coverage list at all.
  for (const st of stories) {
    st.coverage = st.related + st.members.length - 1;
    st.buzz = buzzOf(st);
    const toll = new Set(st.members.flatMap((m) => m.alts || []).filter((t) => CASUALTY.test(t)));
    if (toll.size >= 2) {
      st.vetoed = true;
      drop.block += st.members.length;
      dropped.set(st.title, `block:casualty coverage ×${toll.size} [story]`);
    }
  }
  const items = [];
  for (const s of [...NEWS_SECTIONS].sort((a, b) => a.show - b.show)) {
    items.push(
      ...stories
        .filter((st) => !st.vetoed && st.tag === s.tag && st.related >= st.minRelated && st.coverage >= st.minCoverage)
        .sort((a, b) => b.buzz - a.buzz || b.pub - a.pub)
        .slice(0, s.cap),
    );
  }
  const stars = new Set(items.filter((it) => it.tag !== '경제').sort((a, b) => b.buzz - a.buzz || b.pub - a.pub).slice(0, BUZZ_STARS));
  // Details cost input tokens on every run: two for a ★ line, one for the
  // rest, none for 경제 (those lines only steer the 경제 card).
  for (const it of items) {
    it.details = it.tag === '경제' ? [] : pickDetails(it, stars.has(it) ? 2 : 1);
    it.line =
      `(${kstDayLabel(Math.floor(it.pub / 1000))} 기사 · 관련 ${it.coverage}) ${stars.has(it) ? '★' : ''}[${it.tag}] ${it.title}` +
      (it.details.length ? `\n    · 같은 소식: ${it.details.join(' / ')}` : '');
    // NEWS_DEBUG=1: show what each line absorbed, to check the merging.
    if (process.env.NEWS_DEBUG) console.log(`${it.line}  {buzz ${it.buzz}, feeds ${[...it.feeds].join('+')}}\n${it.members.slice(1).map((m) => `      + ${m.title}`).join('\n')}`);
  }
  // NEWS_DEBUG=2: also list every fresh headline a filter dropped, and why.
  if (process.env.NEWS_DEBUG === '2') for (const [t, why] of dropped) console.log(`  drop ${why.padEnd(28)} ${t}`);
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
// The third field is the unit the value is quoted in (see marketValue).
const MARKET_SYMBOLS = [
  ['005930.KS', '삼성전자', 'won'],
  ['000660.KS', 'SK하이닉스', 'won'],
  ['^KS11', '코스피', 'index'],
  ['KRW=X', '원/달러 환율', 'krw'],
  ['BTC-USD', '비트코인', 'usd'],
];

// Values in the brief are written the way a person says them, because the
// model copies them verbatim: "SK하이닉스: 1,277,000" went onto a card as
// "1,277,000으로" (2026-10-25). Share prices → "127만 7천 원" / "21만 5,500원",
// the exchange rate → "1,325원", bitcoin → "80,276달러", the index stays a plain
// number of points.
function wonText(n) {
  const v = Math.round(n);
  if (v < 10000) return `${v.toLocaleString()}원`;
  const man = Math.floor(v / 10000).toLocaleString();
  const rest = v % 10000;
  if (!rest) return `${man}만 원`;
  return rest % 1000 === 0 ? `${man}만 ${rest / 1000}천 원` : `${man}만 ${rest.toLocaleString()}원`;
}
function marketValue(unit, v) {
  if (unit === 'won') return wonText(v);
  const n = Math.round(v).toLocaleString();
  return unit === 'krw' ? `${n}원` : unit === 'usd' ? `${n}달러` : n;
}

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
  for (const [sym, name, unit] of MARKET_SYMBOLS) {
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
        `${name}: ${marketValue(unit, last.c)} — ${kstDayLabel(last.t)} 종가 기준, 직전 거래일(${kstDayLabel(prev.t)}) 대비 ${Math.abs(pct).toFixed(1)}% ${dir}${note}${big ? ' ★큰 변동' : ''}`,
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
    const cards = [];
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(`content/archive/${f}`, 'utf8'));
        for (const t of j.topics || []) cards.push({ day: f.replace('.json', ''), label: t.label, title: String(t.title).replace(/\n/g, ' ') });
      } catch {}
    }
    return cards;
  } catch {
    return [];
  }
}
const recentCards = getRecentTopics();
const recent = recentCards.map((c) => `- [${c.day}] ${c.label}: ${c.title}`);

// How strongly a news line is about the same thing as `text` (lowercased, no
// spaces): a quoted name from the headline or its '같은 소식' found in it
// counts 10, each of the headline's key words its length. null = no match:
// no quoted name and fewer than two key words (with `loose`, one key word of
// 3+ characters is enough — what the news-slot log uses on a card's own copy).
function headlineScore(n, text, loose = false) {
  const quoted = [...new Set(quotedTitles([n.title, ...(n.details || [])].join(' ')))].filter((q) => text.includes(q));
  const words = [...keyWords(n.title)].filter((w) => text.includes(w));
  if (!quoted.length && words.length < 2 && !(loose && words.some((w) => w.length >= 3))) return null;
  return quoted.length * 10 + words.reduce((sum, w) => sum + w.length, 0);
}
// A story the last few decks already made a card of. Checking 40 recent titles
// against 20 headlines is work the model did (or skipped) while thinking: at
// effort 'medium' the 2026-10-26 dry run brought back 부캉이, 식스센스 and 아이폰
// 듀오, each carded in the previous two days. The code marks them instead, and
// the prompt says not to pick them; they also stop counting toward NEWS_TARGET.
// [경제] lines are reference for the daily 경제 card and are never marked.
for (const n of news || []) {
  if (n.tag === '경제') continue;
  const hit = recentCards.find((c) => headlineScore(n, `${c.label} ${c.title}`.toLowerCase().replace(/\s+/g, '')) != null);
  if (!hit) continue;
  n.seen = hit.day;
  n.line = n.line.replace(/^(\([^)]*\) )/, `$1[이미 다룸 ${hit.day.slice(5)}] `);
}
const seenNews = (news || []).filter((n) => n.seen);
if (seenNews.length) console.log(`news: ${seenNews.length} line(s) already carded in the last ${new Set(recentCards.map((c) => c.day)).size} decks — ${seenNews.map((n) => `${n.seen.slice(5)} "${n.title}"`).join(', ')}`);

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
    ? `\n[오늘의 화제 뉴스 후보 — 실제 헤드라인. ★줄 앞 (…기사)는 기사가 나온 날이라, 헤드라인 속 '오늘·오늘 밤·내일'은 오늘이 아니라 그 발행일 기준이에요. '관련 N'(같은 소식을 다룬 기사 수, 클수록 많이 보도됨)과 ★(여러 매체·분야가 함께 다뤄 오늘 가장 많이 들어 봤을 소식)는 고를 때만 쓰고 카드 문구에는 쓰지 마세요. [ ]는 분야, '· 같은 소식'은 같은 사건을 다른 매체가 쓴 제목이라 카드에 쓸 사실을 여기서 골라도 돼요. [경제] 줄은 경제 카드용 참고 자료. 무거운 정치·범죄·재난·사망 소식은 무시하세요]\n- ${news.map((n) => n.line).join('\n- ')}\n`
    : '') +
  (recent.length ? `\n[최근 며칠간 이미 나간 주제 — 소재·질문·문구가 겹치면 안 됩니다]\n${recent.join('\n')}\n` : '');
// How many 오늘의 화제 cards to ask for. Most of the deck when the brief has
// enough stories most people will have heard of (관련 ≥ 5 outside 경제): what
// people actually bring up at work is the typhoon, the shark with a nickname,
// the idol debut — 가을 디저트 and 가족 단톡방 are filler (user, 2026-10-25).
const strongNews = (news || []).filter((n) => n.tag !== '경제' && !n.seen && n.coverage >= 5).length;
const NEWS_TARGET = !news ? '0' : strongNews >= 6 ? '4~5' : strongNews >= 4 ? '3~4' : strongNews >= 2 ? '2~3' : '1~2';
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
  '날씨': ['더위', '추위', '비·장마', '눈', '미세먼지', '일교차', '태풍'],
  '음식': ['맛집', '배달·외식', '집밥·요리', '커피·음료', '디저트', '제철음식'],
  // 동물 / 해외소식 came with the 날씨·해외·동물 news sections (2026-10-25).
  '일상': ['집안일', '잠·수면', '주말계획', '정리·미니멀', '아침루틴', '동물', '해외소식'],
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

// --- card copy: limits, examples, lint, and the one-call repair --------------
// Title length. The app shows `title` as the card headline at 28pt (~15–17
// Korean chars a line); the news-card rule ("<소식 한 문장>던데, <질문>?") pushed
// titles to 36–58 chars = 4–5 lines (2026-10-20). The prompt asks for ≤ TITLE_MAX
// (2–3 lines), but models overshoot Korean char limits, so anything over
// TITLE_LIMIT is rewritten by repairCopy before the rest of the pipeline reads
// `title` — news matching, the push headline and Supabase sync all see the
// final text. Chars are counted with [...str] (a syllable = 1, spaces included).
const TITLE_MAX = 30;
const TITLE_LIMIT = 32; // repair only above this; 1–2 over still fits 3 lines
// `desc` sits under the headline at 12.5pt with numberOfLines={2} (Cover.tsx):
// ~45 chars on a 375pt phone, then "…". Over the 30 days to 2026-10-25 the
// median desc was 56 chars and 167 of 240 ran past 45; once the 10-20 title
// rule moved "the details" into desc, decks averaged 60–95. `reason` gets two
// lines in a narrower box on the card face (TopicCard.tsx, ~40 chars) and the
// full text on the detail page, so its limit only rides along (see lintCopy).
const DESC_MAX = 45;
const DESC_LIMIT = 50;
const REASON_MAX = 40;
const REASON_LIMIT = 48;
const charLen = (s) => [...String(s ?? '')].length;
const TITLE_DESC = `공백 포함 ${TITLE_MAX}자 이내(앱 화면에서 2~3줄), 문장 하나에 질문은 하나까지. 화제 카드는 소식을 전하는 말 한 문장("<주인공>이 <무슨 일>했대요")이나 "<주인공>이 <무슨 일>했다던데, <짧은 질문>?" 꼴로, 누가 무슨 일을 했는지(결승 진출·신차 공개·4.4% 상승)가 보여야 한다 — "'○○' 얘기했다던데", "소식이 있다던데"처럼 무슨 일인지 안 보이는 말은 금지. 제목에 못 넣은 사실 하나는 desc로.`;
const DESC_DESC = `공백 포함 ${DESC_MAX}자 이내 한 문장(카드 제목 밑 2줄 — 넘치면 "…"로 잘린다). 제목에 없는 사실이나 장면 하나만: 화제·경제 카드는 브리프의 사실·수치 그대로(수치는 2개까지), 일상 카드는 오늘 날씨·계절·날짜에서 나온 구체적인 사실. 제목을 다른 말로 되풀이하지 않고, "~이야기해 보세요", "~나눠 보세요", "~이어가기 좋아요" 같은 권유·마무리는 붙이지 않는다(질문과 팁이 그 역할을 한다).`;
// A reason is about the reader's day, never about the news coverage: the
// 2026-10-25 deck said "오늘 하루 부캉이 관련 기사가 39건 나왔어요", "오늘 기사가
// 여섯 건 나온 야구 소식이에요" and "오늘 종가 기준으로 집계된 최신 환율이에요"
// (the brief's '관련 N' and the old examples invited it). LINT 'meta-reason'.
const REASON_DESC = `한 문장, ${REASON_MAX}자 안팎(카드 앞면에 2줄). '왜 오늘인가요'에 답하는, 읽는 사람의 오늘과 이어지는 실제 사정 하나: 오늘 날씨·기온, 요일(주말이 끝난 월요일, 퇴근을 앞둔 금요일), 오늘·이번 주에 열리거나 이어지는 일, 날짜·계절. 기사·보도·헤드라인·기사 수·집계·기준일 같은 출처 얘기는 쓰지 않는다("관련 기사가 39건 나왔어요", "오늘 종가 기준으로 집계된 환율이에요" ×). "<요일·날씨>(이)라 ~얘기가 잘 어울려요/꺼내기 좋아요/자연스러워요"처럼 평가로 끝내지 않고, desc와 같은 말을 되풀이하지 않는다.`;
// Shown to the model with their lengths computed here (it counts Korean badly).
// The facts in them are made up for illustration, and the prompt says so.
const COPY_GOOD = [
  { title: '테슬라가 새 로드스터를 공개했다던데, 타 보실래요?', desc: '공개 당일 테슬라 주가는 오히려 내렸대요.', reason: '이번 주말부터 국내 매장에서 실물을 볼 수 있대요.' },
  { title: '삼성전자가 금요일에 9% 빠졌다던데, 주식 하세요?', desc: '종가는 8만 1,200원이고, 코스피도 2% 내렸어요.', reason: '금요일 마감 뒤 처음 장이 열리는 월요일이에요.' },
  { title: '아침저녁 쌀쌀한데, 요즘 겉옷 뭐 입고 다니세요?', desc: '출근길엔 경량 패딩, 점심엔 반팔 차림도 보여요.', reason: '서울은 아침 9°에서 낮 21°까지 올라가요.' },
];
const COPY_BAD = {
  desc: '테슬라가 새 로드스터를 공개했어요. 전기 스포츠카 이야기로 가볍게 이어가 보세요.',
  reason: '선선한 일요일이라 신차 얘기가 잘 어울려요.',
  reasonMeta: '어제 공개된 뒤 관련 기사가 열 건 넘게 나왔어요.',
};
const TITLE_GOOD = COPY_GOOD.map((c) => c.title);
// A 화제 card reads like passing the news on to a coworker (the user's model
// deck, 2026-10-25): a hook as the title, one checkable detail as the desc,
// the opener / follow as lines you'd actually say. Format only — the prompt
// says the facts are not to be reused.
const NEWS_GOOD = [
  { title: '한강에 나타난 물범이 사흘째 안 떠났대요', desc: '반포대교 아래 바위에서 자는 모습이 찍혔대요.',
    opener: '한강에 물범 나온 거 보셨어요? 바다로 갈 줄 알았는데 아직 있대요.', follow: '구청에서 이름 공모까지 한대요.' },
  { title: "태풍 '도담'이 역대 가장 늦은 가을 태풍이래요", desc: '제주엔 내일까지 100mm 넘게 온대요.',
    opener: '태풍 때문에 며칠째 날씨가 안 좋네요.', follow: '11월에 오는 태풍은 처음이래요.' },
];
const TITLE_BAD = '테슬라가 새 로드스터를 공개했다던데, 전기 스포츠카를 한 번쯤 타 보고 싶으셨던 적 있으세요?';
// Fine once, a tell when the deck leans on them. Archive, 30 days to
// 2026-10-25, title+desc+reason+questions: 나만의 81, 가볍게 60, 선선한 54
// (+선선해 26), 완연한 32 (30 of them in reasons), 슬슬 20, 딱 좋 18.
const STOCK_WORDS = ['가볍게', '편하게', '자연스럽게', '나만의', '소소한', '완연한', '선선한', '슬슬', '딱 좋은'];

// Copy lint — the deterministic half of the 문체 rules in the prompt, picked
// from that archive count: 100 of 240 descs ended in a closer ("나눠 보세요" 14,
// "나눠 봐요" 13, "이야기해 보세요" 9, …; all 8 on 10-25), half the reasons ended
// in a verdict ("잘 어울려요", "꺼내기 좋아요", "좋은 날이에요"), and 美 and
// "1,277,000" reached cards. Bracketed codes are the Toss UX-writing G6 items.
// `hard` hits (and a title over TITLE_LIMIT / a desc over DESC_LIMIT) start the
// repair call; `soft` ones only ride along when it runs anyway, so a deck that
// is merely a bit stock-ish never costs an extra call.
const LINT = [
  { id: 'closer', hard: true, fields: ['desc'],
    // The bare "~요" forms need their talk-noun: "5연승을 이어가요" is a fact.
    re: /(보세요|봐요|볼까요|나눠요|끌어내요|(이야기|얘기)해요|(얘기|이야기)[가-힣]*\s?이어\s?가요|(이어\s?가|꺼내|나누|시작하|얘기하|이야기하)기 좋아요|(얘기|이야기)(예요|에요))[.!]?$/,
    why: '끝에 붙은 권유·마무리("~이야기해 보세요", "~나눠 보세요", "~이어가기 좋아요")를 빼고 사실 한 문장만' },
  { id: 'vague-news', hard: true, fields: ['title'],
    re: /(얘기|이야기)(를|을)?\s?했(다던데|다는데|대요)|소식이 (있|나왔)다(던데|는데)|화제(라|였)?던데/,
    why: '무슨 일이 있었는지 안 보여요 — 실제로 한 일·한 말을 구체적으로' },
  { id: 'hype', hard: true, fields: ['title', 'desc', 'reason'], // G6-3
    re: /세계 최강|역대급|신드롬|열풍|대박|베일을 벗|화제의|뜨거운 (관심|반응)/,
    why: '과장·홍보 수식(세계 최강·역대급·화제의 등)을 빼고 사실만' },
  { id: 'feeling', hard: true, fields: ['title', 'desc'], // G6-7, G6-6
    re: /뒤숭숭|싱숭생숭|심란|울적|기분을 달래|마음이 (무거|복잡|싱숭)|(걱정|부담)되(시죠|죠|지 않)|설레(시죠|죠|지 않)|놓치면/,
    why: '읽는 사람의 기분을 대신 정하거나 불안을 부추기지 말고 확인할 수 있는 사실로' },
  { id: 'hanja', hard: true, fields: ['title', 'desc', 'reason'], // G6-4
    re: /[美中日英獨佛韓北]/,
    why: '한자 약어 대신 한국어로(美 → 미국)' },
  { id: 'raw-number', hard: true, fields: ['title', 'desc', 'reason'], // G6-1
    re: /\d{1,3}(,\d{3}){2,}/,
    why: '큰 금액은 "127만 7천 원"처럼 한국어 단위로' },
  // Coverage / provenance talk in a reason (REASON_DESC). Not the 기사 of
  // 운전기사·기사님·기사식당·기사회생, not 횡단보도·보도블록·홍보도·정보도, and a
  // count of 건 only when it is a count of articles ("39건 나왔어요"), so
  // "청약이 3건 몰려 있어요" — a real event this week — still passes.
  { id: 'meta-reason', hard: true, fields: ['reason'],
    re: /(?<!운전|택시|버스|정비|배달|대리)기사(?!님|식당|회생)|(?<![가-힣])보도(?!블[록럭])|헤드라인|관련 ?\d|(\d+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|수십|수백|여러) ?건(이나|이|도)? ?(넘게|이상|가까이)? ?(나왔|나온|쏟아|올라|보도|다뤄|다룬|실렸|실린)|집계|기준일|(종가|마감) ?기준|(최근|최신) ?(수치|시세|종가)/,
    why: '기사·보도·기사 수·집계·기준일 같은 출처 얘기 대신, 오늘 날씨·요일·열리는 일처럼 읽는 사람의 오늘과 이어지는 사실로' },
  { id: 'stock', hard: false, fields: ['desc', 'reason'],
    re: /기 마련이에요|(좋은|딱 좋은) (날|때|시기|시점|타이밍|계절)(이에요|예요)|잘 (어울려요|맞아요)|(얘기|이야기)(가|도)? (잘 )?(어울려요|자연스러워요|나와요)|(꺼내|나누|공감하)기 좋아요|궁금해요[.!]?$|(하|되|이|있|많)죠[.!]?$/,
    why: '상투적인 평가·추측("잘 어울려요", "좋은 날이에요", "~하죠", "궁금해요") 대신 근거가 되는 사실로' },
];
const COPY_FIELDS = [['title', TITLE_MAX, TITLE_LIMIT], ['desc', DESC_MAX, DESC_LIMIT], ['reason', REASON_MAX, REASON_LIMIT]];
const sentenceCount = (s) => String(s ?? '').split(/(?<=[.?!])\s+/).filter((x) => x.trim()).length;
const lastWord = (s) => String(s ?? '').replace(/[.?!…\s]+$/, '').split(/\s+/).at(-1) || '';
const fieldLint = (field, text) => LINT.filter((r) => r.fields.includes(field) && r.re.test(String(text ?? '').trim()));

// → Map(topic → { field: { hard, why: [...] } }). Per card: length and LINT.
// Per deck (soft): a STOCK_WORD used again, three or more reasons ending on the
// same word, a desc of more than one sentence.
function lintCopy(topics) {
  const issues = new Map();
  const add = (t, f, hard, why) => {
    if (!issues.has(t)) issues.set(t, {});
    const e = (issues.get(t)[f] ||= { hard: false, why: [] });
    e.hard ||= hard;
    if (!e.why.includes(why)) e.why.push(why);
  };
  for (const t of topics) {
    for (const [f, max, limit] of COPY_FIELDS) {
      const n = charLen(t[f]);
      if (n > limit) add(t, f, f !== 'reason', `${n}자 — 공백 포함 ${max}자 이내로`);
      for (const r of fieldLint(f, t[f])) add(t, f, r.hard, r.why);
    }
    if (sentenceCount(t.desc) > 1) add(t, 'desc', false, '한 문장으로');
  }
  const used = new Map();
  for (const t of topics) {
    for (const [f] of COPY_FIELDS) {
      for (const w of STOCK_WORDS) {
        if (!String(t[f] ?? '').includes(w)) continue;
        if (used.has(w)) add(t, f, false, `'${w}'는 덱에서 이미 썼어요 — 빼거나 구체적인 말로`);
        else used.set(w, t);
      }
    }
  }
  const endings = new Map();
  for (const t of topics) {
    const e = lastWord(t.reason);
    if (!endings.has(e)) endings.set(e, []);
    endings.get(e).push(t);
  }
  for (const [e, ts] of endings) {
    if (ts.length >= 3) for (const t of ts.slice(1)) add(t, 'reason', false, `reason ${ts.length}개가 '${e}'로 끝나요 — 다른 문장 모양으로`);
  }
  return issues;
}

// A rewrite may drop, restate or re-unit a number from its own card (1,277,000
// → 127만 7천 원), never add one: every digit run in it must occur in the card's
// original text (or in `known`, today's date) with thousands separators removed.
const digitRuns = (s) => String(s ?? '').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || [];
const cardText = (t) => [t.title, t.desc, t.reason, ...(t.questions || []), ...Object.values(t.tips || {}).flatMap((m) => Object.values(m || {}))].join(' ');
function rewriteProblem(t, field, text, known = '') {
  const n = charLen(text);
  const limit = COPY_FIELDS.find(([f]) => f === field)[2];
  if (n < 8 || n > limit) return `${n} chars`;
  const hits = fieldLint(field, text);
  if (hits.length) return `lint ${hits.map((r) => r.id).join('+')}`;
  const src = `${cardText(t)} ${known}`.replace(/(\d),(?=\d{3})/g, '$1');
  const added = digitRuns(text).find((d) => !src.includes(d));
  if (added) return `new number ${added}`;
  if (field === 'title') {
    const norm = text.toLowerCase().replace(/\s+/g, '');
    const lost = quotedTitles(t.title).find((q) => !norm.includes(q));
    if (lost) return `dropped '${lost}'`;
  }
  return null;
}

const copyFixSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    fixes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          field: { type: 'string', enum: ['title', 'desc', 'reason'] },
          text: { type: 'string' },
        },
        required: ['id', 'field', 'text'],
      },
    },
  },
  required: ['fixes'],
};

// Lints the deck and, only when a hard rule fires, rewrites the flagged fields
// (hard and soft) in place with ONE small structured-output call. Never throws:
// a failed call, or a rewrite that is still too long, still lints, or brings a
// number the card didn't have, keeps the original and logs a warning — stock
// copy is ugly, a failed run means no deck at all.
// `today` is the date and weather line: the facts a rewritten reason may use
// besides the card's own (its numbers pass rewriteProblem through `known`).
async function repairCopy(client, topics, { known = '', today = '' } = {}) {
  const issues = lintCopy(topics);
  const summary = [...issues].map(([t, m]) => `${t.id} ${Object.entries(m).map(([f, e]) => (e.hard ? f : `${f}(soft)`)).join('+')}`).join(', ');
  if (![...issues.values()].some((m) => Object.values(m).some((e) => e.hard))) {
    console.log(`copy: lint ${issues.size ? `soft only, no repair call — ${summary}` : 'clean'}`);
    return;
  }
  console.log(`copy: lint — ${summary}`);
  const items = [...issues].map(([t, m]) => ({
    id: t.id, title: t.title, desc: t.desc, reason: t.reason,
    fix: Object.fromEntries(Object.entries(m).map(([f, e]) => [f, e.why])),
  }));
  const wanted = new Map([...issues].map(([t, m]) => [t.id, { t, fields: new Set(Object.keys(m)) }]));
  try {
    const res = await client.messages.create({
      model: MODEL,
      // A few one-line fields; the headroom is for adaptive thinking, which
      // can't be switched off on this model — effort 'low' keeps it brief.
      max_tokens: 6000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: copyFixSchema } },
      messages: [{
        role: 'user',
        content:
          `"데일리 스몰토크" 앱 카드 문구 중 규칙에 걸린 필드만 다시 써 주세요. 카드마다 fix에 고칠 필드와 이유가 적혀 있어요.\n` +
          `- title: ${TITLE_DESC}\n- desc: ${DESC_DESC}\n- reason: ${REASON_DESC}\n` +
          `- 글자 수는 공백까지 세고, 쓴 뒤 다시 세어 넘으면 더 줄이세요.\n` +
          `- 사실·수치·이름은 그 카드의 원문(title·desc·reason)에 있는 것만 쓰세요(reason은 아래 [오늘]의 날짜·요일·날씨도 돼요). 새 사실·수치·날짜·발언·감정을 지어내지 말고, 줄일 때는 덜어 내세요. "~했다던데" 같은 시제와 "금요일"·"어제" 같은 기준일 표현, 작품명·인물·제품명은 그대로 두세요. 수치는 한 문장에 2개까지, 큰 금액은 "127만 7천 원"처럼, 美 같은 한자 약어는 "미국"으로.\n` +
          `- 존댓말 ~요체로, 사람이 동료에게 말하듯 자연스럽게. 읽는 사람의 기분을 대신 정하지 말고, 과장 수식도 빼세요. 상투어를 다른 상투어로 바꿔 끼우거나(가볍게 → 편하게) 문장을 명사 토막으로 끊지 마세요.\n` +
          `- fix에 적힌 필드만 카드 id·필드 이름과 함께 출력하세요.\n` +
          (today ? `[오늘] ${today}\n` : '') +
          `예) desc "${COPY_BAD.desc}" → "${COPY_GOOD[0].desc}" / reason "${COPY_BAD.reasonMeta}", "${COPY_BAD.reason}" → "${COPY_GOOD[2].reason}"(오늘 날씨처럼 [오늘]이나 카드 원문에 있는 사실로) / title "${TITLE_BAD}" → "${TITLE_GOOD[0]}"\n\n` +
          `[고칠 카드]\n${JSON.stringify(items, null, 1)}\n\nJSON만 출력.`,
      }],
    });
    const u = res.usage;
    spend.repair = costOf(u);
    if (u) console.log(`copy fix tokens: in ${u.input_tokens} / out ${u.output_tokens} (stop=${res.stop_reason}) → ~$${spend.repair.toFixed(4)}`);
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') throw new Error(`stop_reason ${res.stop_reason}`);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const done = [];
    const seen = new Set();
    for (const x of JSON.parse(text).fixes || []) {
      const w = wanted.get(x?.id);
      const key = `${x?.id}.${x?.field}`;
      if (!w || !w.fields.has(x.field) || seen.has(key)) continue;
      seen.add(key);
      const t = w.t;
      const fixed = String(x.text ?? '').replace(/\s+/g, ' ').trim();
      const was = charLen(t[x.field]);
      const why = rewriteProblem(t, x.field, fixed, known);
      if (why) {
        console.log(`copy: WARN '${key}' rewrite rejected (${why}): "${fixed}" — keeping the original ${was}`);
        continue;
      }
      console.log(`copy:   '${key}' ${was}→${charLen(fixed)}: "${t[x.field]}" → "${fixed}"`);
      t[x.field] = fixed;
      done.push(`${key} ${was}→${charLen(fixed)}`);
    }
    const missing = [...wanted.values()].flatMap(({ t, fields }) => [...fields].filter((f) => !seen.has(`${t.id}.${f}`)).map((f) => `${t.id}.${f}`));
    if (missing.length) console.log(`copy: WARN no rewrite came back for ${missing.join(', ')} — kept as is`);
    console.log(`copy: rewrote ${done.length} field(s)${done.length ? ` (${done.join(', ')})` : ''}`);
  } catch (e) {
    console.log(`copy: WARN repair failed (${e.message}) — keeping the ${issues.size} flagged card(s) as they were`);
  }
}

// Spelling slips the spoken-share style invites ("~더라구요", "~거에요"),
// fixed in every string of the card without a call. Only forms that are wrong
// wherever they occur — "친구요"/"야구요" must not turn into "친고요".
const SPELLING = [
  [/더라구(?=요|[\s.,!?…]|$)/g, '더라고'],
  [/(하|있|없|했|됐|갔|왔|봤|좋|싶|많|같|그렇|되|였|이었|겠)구요/g, '$1고요'],
  [/([았었였했됐겠])다구요/g, '$1다고요'],
  [/(?<=[가-힣])(냐|라)구요/g, '$1고요'],
  [/거에요/g, '거예요'],
  [/뭐에요/g, '뭐예요'],
  [/됬/g, '됐'],
  [/되요(?![가-힣])/g, '돼요'],
  [/되서(?![가-힣])/g, '돼서'],
  // "할께요" → "할게요" only after a ㄹ-final syllable: "부모님께요" is right.
  [/([가-힣])께요/g, (m, c) => ((c.charCodeAt(0) - 0xac00) % 28 === 8 ? `${c}게요` : m)],
  [/몇일/g, '며칠'],
];
function fixSpelling(topics) {
  const fixed = [];
  const fix = (s, where) => {
    let out = s;
    for (const [re, to] of SPELLING) out = out.replace(re, to);
    if (out !== s) fixed.push(`${where}: "${s}" → "${out}"`);
    return out;
  };
  for (const t of topics) {
    for (const f of ['title', 'desc', 'reason']) if (typeof t[f] === 'string') t[f] = fix(t[f], `${t.id}.${f}`);
    if (Array.isArray(t.questions)) t.questions = t.questions.map((q, i) => (typeof q === 'string' ? fix(q, `${t.id}.q${i + 1}`) : q));
    for (const [mood, tip] of Object.entries(t.tips || {})) {
      for (const k of ['opener', 'follow', 'caution']) if (typeof tip?.[k] === 'string') tip[k] = fix(tip[k], `${t.id}.${mood}.${k}`);
    }
  }
  if (fixed.length) console.log(`spelling: fixed ${fixed.length}\n  ${fixed.join('\n  ')}`);
}

// What a 화제 card can be a photo OF — the keys of SUBJECT_P31 further down.
const SUBJECT_KINDS = ['person', 'group', 'team', 'brand', 'product', 'place'];

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
    // title / desc / reason / special / news / media / subjects are spelled out
    // once, in the prompt's [요구사항] — a schema description is input too, and
    // until 2026-10-26 most of these rules were sent twice.
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    special: { type: 'boolean' },
    // Internal (dropped before writing): which cards are the day's 오늘의 화제
    // news cards, so the code can put the strongest one first (it becomes the
    // 09:00 push headline) — the deck is shuffled after generation.
    news: { type: 'string', enum: ['none', 'first', 'second', 'more'] },
    // Internal (dropped before writing): the film / TV programme a 화제 card is
    // about, so the code can look up its official poster on TMDB.
    media: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['movie', 'tv', 'none'] },
        title: { type: 'string' },
        year: { type: 'integer' },
      },
      required: ['kind', 'title', 'year'],
    },
    // Internal (dropped before writing): the real person / group / team /
    // company / product / place a 화제 card is about, so the code can find a
    // photo of THAT subject on Wikidata + Commons instead of a generic one.
    // An array (not one object) so a second named subject can back up the first
    // when the first has no usable free photo. No maxItems — see the NOTE below.
    subjects: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name_ko: { type: 'string' },
          name_en: { type: 'string' },
          kind: { type: 'string', enum: SUBJECT_KINDS, description: 'person=개인, group=가수·밴드 그룹, team=스포츠 팀·구단, brand=기업·브랜드·서비스, product=제품·차종·기기, place=장소·건물·관광지.' },
        },
        required: ['name_ko', 'name_en', 'kind'],
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
    // NOTE: structured outputs only support minItems 0/1 — don't add
    // minItems/maxItems here (a 3/3 constraint 400'd the whole run on
    // 2026-07-12). "Exactly 3" lives in the description + slice(0,3) below.
    // The one place the image-query rules live (the prompt only points here).
    imageQueries: { type: 'array', items: { type: 'string' }, description: 'EXACTLY 3 DIFFERENT concrete, photographable scenes for this topic\'s cover photo search, each 2-5 generic English words — a real object, food, weather phenomenon, or visible action/place a stock photographer could literally shoot. Vary the subject across the 3 (e.g. for sleeping in: "cat sleeping blanket", "unmade bed pillows", "alarm clock nightstand"). Never an abstract mood, time-of-day, or feeling. Good: "chicken soup bowl", "rainy street umbrella", "person relaxing sofa blanket". Bad (too abstract, will fail): "weekend afternoon", "cozy feeling". No Korean, no brand/proper nouns; Korean dishes and places in generic English (삼계탕 → "chicken soup bowl", 냉면 → "cold noodles bowl"). For a news card, shoot the generic thing the story is about — a car launch → "red electric sports car road", "electric car charging station"; a drama → "tv remote sofa living room"; baseball → "baseball stadium night crowd"; a music record → "headphones listening music"; avoid showrooms, shops, expos and signage — they usually show another company logo; never a celebrity, athlete or any real person. Fill these on news cards with subjects too — they are the fallback when no photo of the subject is found.' },
  },
  required: ['id', 'cat', 'subtopic', 'label', 'color', 'title', 'desc', 'reason', 'special', 'news', 'media', 'subjects', 'questions', 'tips', 'imageQueries'],
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
// The rules, once each. Until 2026-10-26 the prompt asked the model to count
// every title/desc/reason after writing it and to keep each stock word to one
// use across the deck; lintCopy measures both after the fact and repairCopy
// rewrites what fails, so the prompt now says the limits are targets — at
// effort 'high' the counting showed up as ~13k thinking tokens a run.
const gen = await client.messages.stream({
  model: MODEL,
  // 8 topics × (3 questions + 3 moods × 3 tips + imageQueries + subtopic).
  // 12k truncated once the deck grew from 5 to 8; 20k truncated again on
  // 2026-09-03, so leave real headroom. A backstop, not a cost dial: thinking
  // counts toward it, and hitting it throws the whole deck away.
  max_tokens: 32000,
  output_config: { ...(EFFORT && { effort: EFFORT }), format: { type: 'json_schema', schema } },
  messages: [{
    role: 'user',
    content:
      `너는 "데일리 스몰토크" 앱의 오늘의 주제 8개 에디터야. 오늘: ${dateLabel}.\n\n[오늘의 실시간 맥락]\n${brief}\n[요구사항]\n` +
      `■ 덱 구성\n` +
      `- 정확히 8개 주제. 카테고리는 시즌/날씨/음식/일상/여행/문화/건강/취미/쇼핑/경제/커리어/관계 중에서 8개 모두 다르게 고르세요. 앱에서 사용자가 '관심 주제'로 고르는 값이라 매일 같은 조합만 나오면 안 돼요 — 최근에 안 나온 카테고리도 적극적으로 섞어 주세요(아래 스몰토크 적합성은 그대로). 날씨 주제는 최대 1개, 순서는 상관없어요(덱 순서는 코드가 정해요).` + (isWeekend ? ' 주말 소재 하나 포함 가능.' : '') + `\n` +
      (todaySpecial
        ? `- ★오늘은 "${todaySpecial}" — 1년에 한 번뿐인 날이에요. 이 날을 소재로 한 주제를 정확히 1개 만들고 그 주제에만 special:true를 설정하세요(나머지 주제는 모두 false). 그 주제가 덱 맨 앞(첫 카드)에 놓입니다.\n`
        : `- 오늘은 [한국의 특별한 날] 목록에 있는 날이 아니에요. 모든 주제의 special은 false로 두세요.\n`) +
      `- subtopic은 반드시 그 카테고리에 속한 것으로, 하루에 같은 subtopic은 한 번만, [최근 며칠간 이미 나간 주제]에서 자주 보인 subtopic은 피하세요:\n${SUBTOPIC_GUIDE}\n` +
      `- 카테고리 감: 여행=휴가·나들이·가보고 싶은 곳 / 문화=드라마·영화·음악·공연(요즘 나온 작품·컴백 포함) / 건강=운동·수면·컨디션 / 취미=게임·독서·수집·배우는 것·스포츠 경기 보기 / 쇼핑=요즘 산 것·패션·생활용품·신제품·테크 / 커리어=일하는 방식·출퇴근·이직 고민(무겁지 않게) / 관계=친구·가족·주변 사람 이야기(사생활 캐묻기 금지).\n` +
      `- ★스몰토크 적합성이 최우선: 좋은 주제는 "동료 대부분이 이미 들었거나, 듣자마자 한마디 보탤 수 있는 것"이에요. 화제 카드를 뺀 나머지는 날씨, 음식/식사, 주말·퇴근 후 시간, 요즘 보는 드라마·영상, 물가·생활비 체감, 계절 변화, 여행·휴가처럼 대다수가 공감하는 일상 소재로 채우세요.\n` +
      `- ★[최근 며칠간 이미 나간 주제]와 소재·제목·질문 문구가 겹치면 안 돼요. 같은 소재(장마, 삼계탕, 물가 등)를 또 쓰려면 각도를 완전히 바꾸세요(장마 → 우산 얘기 대신 빗소리·제습·빨래·출퇴근길 / 보양식 → 삼계탕 대신 냉면·수박·팥빙수).\n` +
      `- ★답이 뻔한 예/아니오 질문 금지: 비 오는 날 "우산 챙기셨어요?"처럼 답이 정해진 질문은 대화가 한 마디로 끝나요. 취향·경험·이야기를 끌어내는 열린 질문으로(예: "비 오는 날엔 어떤 노래 들으세요?", "장마철 최악의 출근길 썰 있으세요?").\n` +
      `■ 문구 — 사람이 동료에게 말하듯. AI가 쓴 티가 나면 안 돼요\n` +
      `- 모든 문장 존댓말 ~요체(단 친구 팁은 반말도 자연스러우면 허용). 친근하고 구체적, 살짝 위트. 각 필드는 1~2문장으로 간결하게.\n` +
      `- title: ${TITLE_DESC} 카드 맨 위에 큰 글씨로 나오고 아침 9시 알림 문구도 돼요. 보기·예시 나열은 questions로.\n` +
      `- desc: ${DESC_DESC}\n` +
      `- reason: ${REASON_DESC}\n` +
      `- title·desc·reason은 서로 다른 정보를 담으세요. desc가 제목을 풀어 쓰거나 reason이 desc를 되풀이하면 안 돼요.\n` +
      `- 상투어(${STOCK_WORDS.join('·')})는 되도록 피하고, "~기 마련이에요", "~하는 시기예요", "좋은 날이에요", "잘 어울려요", "꺼내기 좋아요"는 쓰지 마세요. 상투어를 다른 상투어로 바꿔 끼우는 것도 안 돼요.\n` +
      `- 과장·홍보 수식(세계 최강·역대급·신드롬·열풍·화제의·성큼) 없이 사실만. 읽는 사람의 기분·사정을 대신 정하지 말고("뒤숭숭하시죠?", "기분을 달래는", "~로 가득하죠"), 불안·손해를 부추기는 말도 쓰지 마세요.\n` +
      `- 한 문장에 수치는 2개까지. 표기는 한국어로: 美 → 미국, 1,277,000 → 127만 7천 원(브리프에 적힌 표기 그대로).\n` +
      `- 8장의 문장 모양을 섞으세요. 제목이 줄줄이 "~있으세요?"로 끝나거나 desc·reason이 같은 어미·같은 틀로 이어지면 기계가 쓴 티가 나요. reason도 8장이 다 요일 얘기로 몰리지 않게 날씨·열리는 일·날짜를 섞으세요.\n` +
      `- ★지어내지 마세요: 브리프에 없는 사실·수치·날짜·발언·감정(헤드라인에 없는 "뿌듯했다" 같은 말)이나 경험담("저도 그래요")은 넣지 않아요. 리듬을 만들려고 문장을 명사 토막으로 끊지도 마세요.\n` +
      `- 맞춤법은 표준으로: ~더라고요(×더라구요), ~거예요(×거에요), 돼요(×되요).\n` +
      `- 좋은 예(사실·수치는 지어낸 것 — 형식만 참고하고 문장을 그대로 옮기지 마세요): ${COPY_GOOD.map((c) => `title "${c.title}"(${charLen(c.title)}자) / desc "${c.desc}"(${charLen(c.desc)}자) / reason "${c.reason}"(${charLen(c.reason)}자)`).join(' ‖ ')}.\n` +
      `- 나쁜 예: desc "${COPY_BAD.desc}"(${charLen(COPY_BAD.desc)}자) — 제목을 되풀이하고 권유 문장을 붙였어요. reason "${COPY_BAD.reason}" — 요일·날씨 + "잘 어울려요" 틀이에요. reason "${COPY_BAD.reasonMeta}" — 읽는 사람의 오늘이 아니라 기사 얘기예요. title "${TITLE_BAD}"(${charLen(TITLE_BAD)}자) — 너무 길고 질문에 군더더기가 붙었어요.\n` +
      `- 글자 수와 상투어는 코드가 재요: 위 글자 수는 목표치예요. 다 쓴 뒤 코드가 필드마다 글자 수, 덱 전체에서 반복된 상투어, 권유 어미·과장 수식·출처 얘기를 검사해서 걸린 필드만 따로 고쳐 써요. 그러니 글자를 하나씩 세거나 덱 전체를 다시 훑어 집계하지 말고, 대략 그 길이로 한 번에 쓰세요. 코드가 못 보는 건 사실이 브리프와 맞는지예요 — 그것만은 꼭 지키세요.\n` +
      `■ 오늘의 화제(뉴스 카드) ${NEWS_TARGET}장\n` +
      `- [오늘의 화제 뉴스 후보]에서 "내일 아침 동료 대부분이 이미 봤거나 들었을 소식"을 골라 각각 카드 1장으로. 이름 붙은 날씨 사건(태풍 '○○'), 별명이 붙은 동물·동네 소식, 영상으로 퍼진 해외 소식, 아이돌 데뷔·컴백·작품처럼 구체적인 이름 하나가 걸린 소식이 좋아요. ★ 표시, '관련' 숫자가 큰 것, (오늘 기사)·(어제 기사)를 우선하세요. 같은 사건은 한 장만. [이미 다룸 MM-DD]가 붙은 줄은 최근 덱에서 이미 카드로 나간 소식이라 고르지 마세요(같은 주인공의 다른 소식이어도요). 쓸 만한 후보가 모자라면 적게 만들어도 되지만 5장을 넘기면 안 돼요. [시장 시그널]·[경제] 줄로 만든 경제 카드는 이 수에 세지 않고, 화제 카드끼리도 카테고리는 서로 달라야 해요.\n` +
      `- 지역 축제, 선수 부상, 업계 내부 소식처럼 관심 있는 소수만 아는 뉴스와 정치·범죄·사고·재난·사망 소식은 후보에 있어도 화제 카드로 쓰지 마세요.\n` +
      `- ★사실은 헤드라인과 그 아래 '같은 소식'에 적힌 것만 쓰세요. 거기에 없는 가격·날짜·사양·순위·수치·발언 인용은 지어내지 말고, 헤드라인이 애매하면 확실한 부분까지만 다루세요. 물음표로 끝나거나 추측하는 헤드라인('맛집 가짜?', '~할까')은 확정된 일로 쓰지 않아요.\n` +
      `- ★사람이 나오는 소식은 공개 활동(작품, 컴백, 공연, 수상, 경기 결과, 출연)만. 사생활·연애·결혼·가족·건강·루머는 금지, 그 사람을 평가하거나 품평하는 것도 금지예요. 질문은 연예인·선수의 사생활이 아니라 그 소식(무대·경기·작품)이나 듣는 사람의 경험으로 이어지게(예: "'○○' 무대 보셨어요?", "요즘 듣는 신인 노래 있어요?").\n` +
      `- 해외 시위처럼 편이 갈리는 소식은 무슨 일이 있었는지(규모·장소)만 쓰고 어느 쪽이 옳은지는 말하지 않아요. 사상자·피해 얘기는 쓰지 않아요.\n` +
      `- 시제: 어제·오늘 나온 소식이니 "~했대요", "~했다던데", "~공개됐다는데"처럼 이미 일어난 일로 쓰세요(아래 ★★"오늘" 단정 금지).\n` +
      `- 문구는 동료에게 소식을 전하듯(예시의 사실은 지어낸 것 — 형식만 참고):\n` +
      `  · title: 소식의 고리 하나 — 주인공(작품명·인물·제품명·팀·별명)과 무슨 일이 있었는지. 질문이 아니어도 돼요("~래요/~대요"로 끝나는 말 한 문장). "화제의 신차", "○○가 '△△' 얘기했다던데"처럼 무슨 일인지 안 보이면 안 돼요.\n` +
      `  · desc: 헤드라인이나 그 아래 '같은 소식'에 적힌 흥미로운 사실 하나만 덧붙여요.\n` +
      `  · tips의 opener·follow: 실제로 할 말로. opener는 소식을 전하는 말(~래요·~대요, ~던데요, ~더라고요, ~네요)에 가벼운 반응이나 "보셨어요?", follow는 사실 하나를 더 꺼내는 다음 말이에요. "~얘기로 이어가 보세요" 같은 지시문이 아니에요. friend는 반말로.\n` +
      `  · 반응은 opener·follow에서만, 말하는 사람 자신의 흔하고 가벼운 반응으로("신기하더라고요", "좀 무섭더라고요"). 듣는 사람의 기분을 대신 정하거나("걱정되시죠?"), 브리프에 없는 사실·경험("영상 보니까")을 지어내지 마세요.\n` +
      `  · questions: 그 소식에서 자연스럽게 이어지는 질문 3개(예: "태풍 오는 날엔 출근 어떻게 하세요?", "한강 가면 물범 보러 가 보실래요?"). 소식과 상관없는 인터뷰 질문("즐겨 보는 종목은?")은 안 돼요.\n` +
      `  · 예: ${NEWS_GOOD.map((c) => `title "${c.title}"(${charLen(c.title)}자) / desc "${c.desc}"(${charLen(c.desc)}자) / opener "${c.opener}" / follow "${c.follow}"`).join(' ‖ ')}\n` +
      `- 카테고리: 연예·작품 → 문화(드라마/영화/음악/예능/공연·전시/웹툰·책 중 맞는 것), 신제품·가젯·자동차 공개 → 쇼핑 '신제품·테크', 스포츠 → 취미 '스포츠', 태풍 같은 날씨 사건 → 날씨 '태풍' 등 맞는 것, 동물 소식 → 일상 '동물', 해외 소식 → 일상 '해외소식', 그 밖의 가벼운 시사 → 가장 잘 맞는 카테고리.\n` +
      `- news 필드: 가장 강한 화제 카드에 "first", 두 번째에 "second"(각각 1장만), 나머지 화제 카드는 "more", 그 밖의 카드(시장 시그널·[경제] 줄로 만든 경제 카드 포함)는 모두 "none". 특별한 날 카드가 있으면 그게 덱 맨 앞, 없으면 "first" 카드가 맨 앞에 놓이고 그 제목이 아침 9시 알림 문구가 되니, 알림으로 받았을 때 가장 눌러 보고 싶을 소식을 "first"로 고르세요.\n` +
      `- media 필드: 화제 카드(news가 "none"이 아닌 카드) 중 헤드라인에 제목이 나온 영화 한 편이나 TV 프로그램(드라마·예능) 하나를 다루는 카드만 채우세요 — 공식 포스터를 커버로 찾는 데 씁니다. 영화면 kind "movie", 드라마·예능이면 "tv". title은 헤드라인에 적힌 한국어 제목 그대로(제목을 감싼 따옴표·괄호 ' ' " " 「 」 < > 만 빼고, 철자를 바꾸거나 번역하지 말고), year는 헤드라인에서 개봉·방영 연도가 드러나면 그 연도, 아니면 올해(${kst.getUTCFullYear()}). 신제품·스포츠·음악(앨범·컴백·공연)·인물 소식, 여러 작품을 묶은 소식, 화제 카드가 아닌 모든 카드는 kind "none", title "", year 0.\n` +
      `- subjects 필드: 화제 카드의 헤드라인이 실존하는 구체적인 인물·그룹·팀·기업(브랜드)·제품·장소를 다룰 때 채우세요 — 스톡 사진으로는 누구 얘긴지 알 수 없어서, 그 대상의 실제 사진을 커버로 찾는 데 씁니다. 사진으로 가장 잘 알아볼 수 있는 대상을 맨 앞에 쓰고, 헤드라인에 함께 나온 다른 구체적 대상이 있으면 두 번째로(최대 2개). 예: "BTS가 스포티파이 연간 100억 스트리밍을 넘겼다" → [방탄소년단(group), 스포티파이(brand)] / "머스크가 어린이에게 스페이스X 주식을 준다" → [일론 머스크(person), 스페이스X(brand)] / "현대차가 아반떼 N 모노크롬을 공개" → [현대 아반떼 N(product), 현대자동차(brand)] / "손흥민 해트트릭" → [손흥민(person)]. name_ko·name_en은 각 언어 위키백과 문서 제목처럼 정식 표기로 쓰세요(BTS → "방탄소년단"/"BTS", "삼성"이 아니라 "삼성전자"/"Samsung Electronics", 신차는 한정판·색상명을 뺀 모델명 → "현대 아반떼 N"/"Hyundai Elantra N"). 헤드라인에 없는 대상을 지어내지 말고, 영화·드라마·예능 한 편이 중심인 카드(media를 채운 카드), 여러 대상을 뭉뚱그린 소식, 화제 카드가 아닌 모든 카드는 빈 배열 [].\n` +
      `■ 이름과 날짜\n` +
      `- ★특정 작품·영화·드라마·인물을 소재로 쓸 거면 반드시 그 제목/이름을 구체적으로 밝히세요. "화제의 한국 영화가 베일을 벗었다", "여름 극장가 기대작", "뜨거운 관심을 모은 그 드라마"처럼 무엇을 말하는지 알 수 없는 두루뭉술한 표현은 금지예요 — 알맹이가 없어 대화가 안 이어져요. 브리프에 구체적 제목이 없어 무엇인지 특정할 수 없으면 그 소재는 아예 쓰지 말고 "요즘 극장에서 뭐 보셨어요?", "요새 정주행하는 드라마 있으세요?"처럼 작품을 특정하지 않는 완전 보편 질문으로 바꾸세요. 브리프에 없는 제목·이름을 지어내는 건 금지.\n` +
      `- ★★행사·공연·경기가 "오늘" 열린다고 절대 단정하지 마세요. 헤드라인의 '오늘 저녁', '오늘 밤', '1시간 뒤'는 그 기사 발행일 기준이라 오늘과 다릅니다 — 어제 끝난 불꽃축제를 오늘 아침에 "오늘 밤 열린다"고 안내한 사고가 있었습니다. 날짜가 확실한 건 [한국의 특별한 날] 표뿐이에요. 지난 행사는 "어제 ~했다던데 다녀오셨어요?"처럼 지난 일로 쓰거나, 시점을 빼고 "불꽃축제 좋아하세요?"처럼 취향 질문으로 바꾸세요. 시작 시각·남은 시간을 지어내는 것도 금지.\n` +
      `■ 경제 카드\n` +
      `- 요즘 주식·재테크에 관심이 많은 분위기라, '경제' 카테고리로 생활경제 주제를 하나 넣어주세요. 기본은 "요즘 주식이나 재테크 하세요?", "월급 관리 어떻게 하세요?", "물가 체감"처럼 누구나 자기 얘기로 대답할 수 있는 소재로.\n` +
      `- ★단, [시장 시그널]에 '큰 변동' 표시가 있거나 [오늘의 화제 뉴스 후보]의 [경제] 줄에 기준금리 인상/인하 같은 굵직한 경제 뉴스가 있으면, 그날의 경제 주제는 두루뭉술한 물가 얘기 대신 그 사실을 구체적으로 다루세요. 수치도 브리프에 있는 그대로 인용해도 좋아요(예: "${TITLE_GOOD[1]}", "기준금리가 0.25%p 올랐다는데, 적금 드세요?"). 브리프에 없는 수치·날짜를 지어내는 건 금지.\n` +
      `- ★★오르내림은 [시장 시그널]에 적힌 '올랐어요/내렸어요'를 그대로 쓰세요. 숫자만 보고 방향을 추측하지 마세요 — 환율이 크게 내렸는데 "올랐다"고 쓴 사고가 있었습니다. 환율은 숫자가 내려가면 원화 강세(해외여행·직구에 유리), 올라가면 원화 약세예요. 브리프에 '→ 원화 강세/약세'가 적혀 있으면 그 해석을 따르세요.\n` +
      `- ★★title·desc에서 시장 수치를 언급할 땐 [시장 시그널] 각 줄에 적힌 기준일 표현을 그대로 쓰세요. 주식·코스피는 주말·공휴일에 쉬기 때문에, 기준일이 "8월 15일(금)"인데 "어제"라고 쓰면 날짜가 틀립니다(일요일 주제에 금요일 등락을 "어제"라고 쓴 사고 있음). 기준일이 '어제'라고 적혀 있을 때만 "어제", 아니면 "지난 금요일" 같은 실제 요일이나 "최근"으로 쓰세요.\n` +
      `- 매수/매도 추천·목표가·시황분석·전망은 절대 금지 — "다들 얘기하더라"며 화제로 나누는 톤만. 삼성전자·SK하이닉스·코스피·환율·비트코인처럼 다들 아는 것만 다루고, 소수만 아는 종목은 피하세요.\n` +
      `■ 나머지 필드\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개(화제 카드는 위 규칙대로 소식에서 이어지는 질문).\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지. follow를 매번 "~얘기로 이어가 보세요"로 끝내지 말고, 다음에 던질 말이나 물어볼 거리를 구체적으로 쓰세요.\n` +
      `- imageQueries: 스키마 설명대로 커버 사진 검색용 영어 검색어 3개(화제 카드도, subjects를 채운 카드도).\n` +
      `- JSON만 출력.`,
  }],
}).finalMessage();

// Log usage so cost is visible in the Actions log (output includes thinking).
spend.main = costOf(gen.usage);
console.log(`tokens: in ${gen.usage.input_tokens} / out ${gen.usage.output_tokens} (effort=${EFFORT || 'default'}, stop=${gen.stop_reason}) → ~$${spend.main.toFixed(3)}`);

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

// Settle the copy NOW, before anything reads it: the push headline (topics[0])
// and the Supabase sync use the final title. The news-card matching below also
// keeps the draft title + desc, since a repair can drop a headline term from
// them. See repairCopy.
const draftCopy = new Map(data.topics.map((t) => [t, `${t.title} ${t.desc}`]));
await repairCopy(client, data.topics, {
  known: `${isoDate} ${dateLabel} ${weather ?? ''}`,
  today: `${dateLabel}${weather ? ` · ${weather}` : ''}`,
});
fixSpelling(data.topics);

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
// key word of 3+ characters found in the card's text), independently of the
// model's own `news` flag, which is shown alongside. The card's text is the
// title + desc, draft and final: a repair can drop a headline term, and a desc
// capped at 45 chars no longer carries every one the old two-sentence desc did.
// A quoted name may also come from the line's '같은 소식' details (the card's
// one detail often does); key words only from the headline itself — taking
// them from details and tips too matched a dessert card to 이수만's 골든벨
// through "요즘" + "많이" in the 2026-10-25 dry run.
{
  const matchHeadline = (t) => {
    if (!news) return null;
    const text = [draftCopy.get(t), t.title, t.desc].join(' ').toLowerCase().replace(/\s+/g, '');
    let best = null;
    for (const n of news) {
      const score = headlineScore(n, text, true);
      if (score != null && (!best || score > best.score)) best = { n, score };
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
    if (n && n.tag === '경제' && (!t.news || t.news === 'none')) econ.push(describe(t, n, false));
    else if (n || (t.news && t.news !== 'none')) slot.push(describe(t, n));
  }
  console.log(
    `news slot: ${news ? `${slot.length} card(s)${slot.length ? ': ' + slot.join(', ') : ''}` : 'no candidates in the brief'}` +
    (econ.length ? `; 경제 card from a headline: ${econ.join(', ')}` : ''),
  );
}
// DRY_RUN=1: the deck in final order with its copy settled, the lint left after
// the repair, and what the run cost — then stop before covers, today.json, the
// archive and the Supabase headline. The JSON goes to the runner's temp dir,
// outside the checkout, so the workflow's commit step couldn't see it anyway.
if (DRY_RUN) {
  const left = lintCopy(data.topics);
  const n = (s) => `(${charLen(s)}자)`;
  console.log(`\n--- dry run deck (${data.topics.length} cards, effort ${EFFORT || 'default'}) ---`);
  data.topics.forEach((t, i) => {
    const media = t.media?.kind && t.media.kind !== 'none' ? ` · media ${t.media.kind} "${t.media.title}" ${t.media.year}` : '';
    const subj = (t.subjects || []).length ? ` · subjects ${t.subjects.map((s) => `${s.name_ko}/${s.name_en}(${s.kind})`).join(', ')}` : '';
    const lint = left.get(t);
    console.log(
      `\n[${i + 1}] ${t.id} · ${t.cat}/${t.subtopic} · "${t.label}" · news=${t.news}${t.special ? ' · SPECIAL' : ''}${media}${subj}\n` +
      `  title  ${n(t.title)} ${t.title}\n  desc   ${n(t.desc)} ${t.desc}\n  reason ${n(t.reason)} ${t.reason}\n` +
      `  q      ${(t.questions || []).join(' | ')}\n` +
      ['work', 'friend', 'date'].map((m) => `  ${m.padEnd(6)} ${t.tips?.[m]?.opener} → ${t.tips?.[m]?.follow} (× ${t.tips?.[m]?.caution})`).join('\n') +
      `\n  images ${(t.imageQueries || []).join(' / ')}` +
      (lint ? `\n  LINT   ${Object.entries(lint).map(([f, e]) => `${f}${e.hard ? '' : '(soft)'}: ${e.why.join('; ')}`).join(' / ')}` : ''),
    );
  });
  console.log(`\nlint after repair: ${left.size ? `${left.size} card(s) still flagged` : 'clean'}`);
  console.log(`cost: main $${spend.main.toFixed(4)} + repair $${spend.repair.toFixed(4)} = $${(spend.main + spend.repair).toFixed(4)} (effort ${EFFORT || 'default'})`);
  const path = join(process.env.RUNNER_TEMP || tmpdir(), `dry-run-${isoDate}.json`);
  writeFileSync(path, JSON.stringify({ date: isoDate, dateLabel, generatedAt: now.toISOString(), effort: EFFORT || 'default', spend, topics: data.topics }, null, 2));
  console.log(`DRY_RUN=1 — deck written to ${path} only; no covers, no today.json/archive, no headline sync`);
  process.exit(0);
}

// Remembered past the delete below: only these cards may take a TMDB poster.
const newsCards = new Set(data.topics.filter((t) => t.news && t.news !== 'none'));
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
        // `imageAttributed` too: subject photos are often attributed (CC BY-SA)
        // and the same BTS photo two mornings in a row reads as a bug.
        for (const t of j.topics || []) {
          if (t.image) urls.add(t.image);
          if (t.imageAttributed) urls.add(t.imageAttributed);
        }
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
// Every Wikimedia API call — Commons, Wikidata, Wikipedia — goes through here
// and shares ONE pacing clock, so the subject-photo lookups (see below) add
// calls but never a burst. Wikidata 429'd a 2 s-spaced loop of ~8 searches too.
const WIKI_LABEL = { 'commons.wikimedia.org': 'commons', 'www.wikidata.org': 'wikidata' };
// JSON errors worth waiting out; anything else (bad id, bad param…) is a bug
// or a miss that a retry cannot fix and 30 s of sleeping would only hide.
const WIKI_RETRY_CODE = /^(ratelimited|maxlag|readonly|internal_api_error.*|cirrussearch-too-busy-error)$/i;
let wikiGaveUp = 0; // calls that stayed rate-limited through all 3 attempts
async function wikiJson(host, params, timeoutMs = 10000) {
  const label = WIKI_LABEL[host] || host;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCommonsCall + COMMONS_GAP_MS - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastCommonsCall = Date.now();
    const r = await fetch(`https://${host}/w/api.php?${params}`, {
      headers: { 'User-Agent': 'daily-smalltalk-content/1.0 (github.com/realkose1/daily-smalltalk-support)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    let retry = true; // a non-JSON body is the "too many requests" page
    try {
      const j = JSON.parse(txt);
      if (!j.error) return j;
      console.log(`${label} api error: ${JSON.stringify(j.error).slice(0, 120)}`);
      retry = WIKI_RETRY_CODE.test(String(j.error.code));
    } catch {
      console.log(`${label} non-JSON (${r.status}): ${txt.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    if (!retry) return null;
    if (attempt < 2) {
      // One 8s pause wasn't enough on 2026-09-11 — the limit was still up
      // when it retried. Wait 10s, then 20s.
      const back = attempt === 0 ? 10000 : 20000;
      console.log(`${label}: rate-limited — backing off ${back / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise((res) => setTimeout(res, back));
    }
  }
  wikiGaveUp++;
  return null;
}
const commonsJson = (params) => wikiJson('commons.wikimedia.org', params);

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

// --- subject photos: Wikidata → (Wikipedia) → Commons, for 화제 news cards ---
// A news card is about SOMEONE, and a mood photo can't say who: BTS passing 10
// billion Spotify streams shipped a generic record player (2026-10-20). For the
// 오늘의 화제 cards the model names the subject(s) (`subjects` in the schema);
// this finds a real, freely licensed photo of exactly that.
//
//  1. Wikidata wbsearchentities by the Korean name, then the English one. Only
//     items NAMED exactly that count (the search is prefix-based: "BTS" also
//     brings BTS Skytrain and an airport) and only items of the right TYPE: P31
//     "instance of" on the kind's list, or failing that a description that
//     reads like one. "테슬라" is also a unit of measure, a film and a GPU.
//  2. Several items of the right type with the same name (a dozen 김민수) is
//     ambiguity, not a pick — unless one has ≥ 4× the Wikipedia sitelinks of the
//     next (Spotify the service vs. its two holding-company stubs). No clear
//     winner → no photo, never a guess.
//  3. The winner's P18 photos, preferred rank first. If none is good, the lead
//     image of its ko/en Wikipedia article joins them.
//  4. Commons imageinfo vets every file: licence (CC0/PD = free; CC BY / BY-SA
//     get a credit), size, mime, logo/map/scan-like names and categories, and
//     photoScore. People, groups and teams prefer photos from the last ~10 years.
// Never throws; nothing usable → null and the generic cascade runs as before.
const SUBJECT_MAX = 2; // subjects tried per card, in the model's order
const SUBJECT_MIN_SITELINKS = 3; // below this the item is too obscure to be today's news subject
const SUBJECT_MIN_W = 800;
const SUBJECT_MIN_H = 600;
const SUBJECT_MAX_BYTES_NON_JPEG = 3 * 1024 * 1024; // PNG thumbs stay PNG — keep the download sane

// Wikidata classes ("instance of") accepted per kind. Direct P31 values only, no
// subclass walk: a miss means "no subject photo" (the generic cover stays),
// never a wrong one. Every id was checked against its English label.
const SUBJECT_P31 = {
  person: ['Q5'], // human
  group: ['Q215380', 'Q216337', 'Q641066', 'Q2088357', 'Q5741069', 'Q16334295'], // musical group, boy band, girl group, musical ensemble, rock band, group of humans
  team: ['Q12973014', 'Q847017', 'Q476028', 'Q13027888', 'Q13393265', 'Q6979593', 'Q1194951', 'Q4438121'], // sports team/club, football club, baseball/basketball team, national (football) team, sports organization
  brand: ['Q431289', 'Q4830453', 'Q783794', 'Q167037', 'Q6881511', 'Q891723', 'Q43229', 'Q167270', 'Q15590336', 'Q620615', 'Q7397', 'Q40056'], // brand, business, company, corporation, enterprise, public company, organization, trademark, music streaming service, mobile app, software, computer program
  product: ['Q3231690', 'Q1420', 'Q2424752', 'Q15056993'], // car model, car, product, aircraft family
  place: [], // any item with coordinates (P625) — see subjectType
};
// When P31 has nothing from the list (items are often sparsely typed), a
// description that reads like the kind (Korean or English) is enough.
const SUBJECT_DESC = {
  group: /그룹|밴드|듀오|트리오|boy band|girl group|\bband\b|\bduo\b|\btrio\b|musical group|ensemble/i,
  team: /팀|구단|클럽|축구단|야구단|농구단|배구단|\bteam\b|\bclub\b|franchise/i,
  brand: /기업|회사|브랜드|서비스|제조|플랫폼|\bcompany\b|brand|corporation|business|manufacturer|\bservice\b|platform|retailer|conglomerate/i,
  product: /자동차|전기차|세단|스마트폰|제품|모델|차량|기기|게임기|\bcar\b|automobile|vehicle|\bmodel\b|smartphone|\bphone\b|device|console|\bproduct\b|motorcycle|tablet|laptop/i,
};
// Never a subject: disambiguation pages, lists, categories, templates, names.
const SUBJECT_NEVER_P31 = new Set(['Q4167410', 'Q13406463', 'Q4167836', 'Q11266439', 'Q101352', 'Q202444']);
const SUBJECT_NEVER_DESC = /위키미디어|위키백과|wikimedia|disambiguation|family name|given name|identifier/i;
// Files that are logos, signatures, maps, posters and the like, by name…
const SUBJECT_FILE_NOT_PHOTO =
  /\b(logos?|logotype|wordmark|signature|autograph|flags?|maps?|locator|coat of arms|emblem|icons?|diagram|chart|infographic|screenshot|banner|sticker|poster|stamp)\b/i;
// …and by category.
const SUBJECT_BAD_CATEGORY = /\blogos?\b|signatures?\b|\bflags?\b|\bmaps?\b|diagrams?|\bicons?\b|\bsvg\b|screenshots?|\bposters?\b|album covers|wordmarks?/i;

const subjectEntities = new Map(); // Wikidata id → entity | null, for this run
// "Exactly that name" — for teams, companies and products also without the
// legal / club suffix Wikidata labels carry ("Tottenham Hotspur F.C.",
// "Samsung Electronics Co., Ltd.", "토트넘 홋스퍼 FC"). People and groups stay exact.
const SUBJECT_NAME_SUFFIX = /(fc|afc|cf|inc|corp|corporation|ltd|co|주식회사|축구단|야구단|농구단|배구단|구단)$/;
function subjectNameKey(kind, s) {
  let k = normTitle(s);
  if (kind !== 'team' && kind !== 'brand' && kind !== 'product') return k;
  for (let i = 0; i < 3; i++) {
    const next = k.replace(SUBJECT_NAME_SUFFIX, '').replace(/^(fc|afc)/, '');
    if (next === k || next.length < 3) break;
    k = next;
  }
  return k;
}
const normFile = (s) => String(s ?? '').replace(/^File:/i, '').replace(/_/g, ' ').trim().toLowerCase();

// Statement values for a property: deprecated dropped, preferred rank first.
function claimValues(e, prop) {
  return (e?.claims?.[prop] || [])
    .filter((c) => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value')
    .sort((a, b) => (b.rank === 'preferred') - (a.rank === 'preferred'))
    .map((c) => c.mainsnak.datavalue?.value);
}

async function wikidataEntities(ids) {
  const need = ids.filter((id) => !subjectEntities.has(id));
  if (need.length) {
    const j = await wikiJson('www.wikidata.org', new URLSearchParams({
      action: 'wbgetentities', format: 'json', origin: '*', ids: need.join('|'),
      props: 'claims|sitelinks|labels|descriptions', languages: 'ko|en',
    }), 30000); // big items (Tesla, Musk) carry ~1 MB of claims
    if (!j) return null;
    for (const id of need) subjectEntities.set(id, j.entities?.[id] ?? null);
  }
  return ids.map((id) => subjectEntities.get(id));
}

// Is this item plausibly a `kind`? → { ok, how | why }
function subjectType(kind, e, searchDesc) {
  const ids = claimValues(e, 'P31').map((v) => v?.id).filter(Boolean);
  const desc = `${e.descriptions?.ko?.value || ''} | ${e.descriptions?.en?.value || ''} | ${searchDesc || ''}`;
  if (ids.some((id) => SUBJECT_NEVER_P31.has(id)) || SUBJECT_NEVER_DESC.test(desc)) {
    return { ok: false, why: 'a list / disambiguation / name entry' };
  }
  if (kind === 'person') return ids.includes('Q5') ? { ok: true, how: 'human' } : { ok: false, why: 'not a human' };
  if (kind === 'place') return claimValues(e, 'P625').length ? { ok: true, how: 'has coordinates' } : { ok: false, why: 'no coordinates' };
  if (SUBJECT_P31[kind].some((id) => ids.includes(id))) return { ok: true, how: `P31 ${ids.filter((id) => SUBJECT_P31[kind].includes(id))[0]}` };
  if (SUBJECT_DESC[kind]?.test(desc)) return { ok: true, how: 'description' };
  return { ok: false, why: `not a ${kind}` };
}

// Lead image of the item's ko (else en) Wikipedia article — editors choose it
// as THE picture of the subject, and it is often newer than P18. null if none.
async function wikipediaLeadImage(e) {
  for (const wiki of ['ko', 'en']) {
    const title = e.sitelinks?.[`${wiki}wiki`]?.title;
    if (!title) continue;
    const j = await wikiJson(`${wiki}.wikipedia.org`, new URLSearchParams({
      action: 'query', format: 'json', origin: '*', redirects: '1', titles: title,
      prop: 'pageimages', piprop: 'name',
    }));
    const name = Object.values(j?.query?.pages || {})[0]?.pageimage;
    if (name) return name;
  }
  return null;
}

// Vets Commons files in ONE imageinfo call. → { ok: [candidate], bad: [reason] }
// or null when Commons could not be reached.
async function subjectFiles(kind, names) {
  const j = await commonsJson(new URLSearchParams({
    action: 'query', format: 'json', origin: '*', redirects: '1',
    titles: names.map((n) => `File:${String(n).replace(/^File:/i, '')}`).join('|'),
    prop: 'imageinfo|categories', cllimit: 'max', clshow: '!hidden',
    iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1280',
  }));
  if (!j) return null;
  const order = new Map(names.map((n, i) => [normFile(n), i]));
  const from = new Map((j.query?.redirects || []).map((r) => [normFile(r.to), normFile(r.from)]));
  const Y = Number(isoDate.slice(0, 4));
  const people = kind === 'person' || kind === 'group' || kind === 'team';
  const ok = [];
  const bad = [];
  for (const p of Object.values(j.query?.pages || {})) {
    const name = String(p.title || '').replace(/^File:/, '');
    const no = (why) => bad.push(`${name}: ${why}`);
    const ii = p.imageinfo?.[0];
    if (!ii) { no('not on Commons'); continue; }
    if (!/^image\/(jpeg|png|webp|tiff)$/.test(ii.mime || '')) { no(ii.mime || 'unknown type'); continue; }
    const stem = name.replace(/\.[a-z0-9]+$/i, '');
    const cats = (p.categories || []).map((c) => c.title || '').join(' | ');
    if (SUBJECT_FILE_NOT_PHOTO.test(stem)) { no('logo/map/poster-like name'); continue; }
    if (SUBJECT_BAD_CATEGORY.test(cats)) { no('logo/map/poster-like category'); continue; }
    const lic = plain(ii.extmetadata?.LicenseShortName?.value);
    const free = /cc0|public domain/i.test(lic);
    if (!free && !/^cc by(-sa)? /i.test(lic)) { no(`licence "${lic || 'unknown'}"`); continue; }
    if ((ii.width ?? 0) < SUBJECT_MIN_W || (ii.height ?? 0) < SUBJECT_MIN_H) { no(`too small ${ii.width}×${ii.height}`); continue; }
    const ratio = ii.width / ii.height;
    if (ratio > 3 || ratio < 0.4) { no(`odd shape ${ii.width}×${ii.height}`); continue; }
    if (ii.mime !== 'image/jpeg' && (ii.size ?? 0) > SUBJECT_MAX_BYTES_NON_JPEG) { no(`${ii.mime} of ${(ii.size / 1048576).toFixed(1)} MB`); continue; }
    const author = creditName(ii.extmetadata?.Artist?.value);
    if (!free && !author) { no('no author to credit'); continue; }
    // "Portrait of …" is how people photos are named, but ARTWORK reads it as a painting.
    let q = photoScore(stem.replace(/portrait of/gi, ''), cats);
    if (ii.mime === 'image/png') q -= 1; // PNGs are mostly cut-outs and screenshots
    if (people) {
      const when = plain(ii.extmetadata?.DateTimeOriginal?.value);
      const yr = Number((when.match(/\b(?:19|20)\d{2}\b/) || stem.match(/\b(?:19|20)\d{2}\b/) || [])[0]);
      if (yr && yr <= Y) q += Y - yr <= 10 ? 1 : Y - yr <= 20 ? -1 : -3;
    }
    if (q <= -5) { no(`looks like a scan/artwork (score ${q})`); continue; }
    ok.push({
      url: ii.thumburl || ii.url,
      name, w: ii.width, h: ii.height, lic, free,
      // free wins ties: it works in every app version and needs no credit line
      q: q + (free ? 0.5 : 0),
      order: order.get(normFile(p.title)) ?? order.get(from.get(normFile(p.title))) ?? 99,
      credit: free ? null : {
        author,
        license: lic,
        licenseUrl: plain(ii.extmetadata?.LicenseUrl?.value),
        sourceUrl: ii.descriptionurl || ii.url,
      },
    });
  }
  ok.sort((a, b) => b.q - a.q || a.order - b.order);
  return { ok, bad };
}

// Photos of one resolved item. → { photo, note } | { why }
async function subjectPhotoOf(kind, id, e) {
  const p18 = [...new Set(claimValues(e, 'P18').filter((v) => typeof v === 'string'))].slice(0, 5);
  let cands = [];
  const bad = [];
  let note = '';
  if (p18.length) {
    const r = await subjectFiles(kind, p18);
    if (!r) return { why: `${id}: Commons lookup failed` };
    cands = r.ok;
    bad.push(...r.bad);
  }
  if (!cands.some((c) => c.q >= 0)) { // no P18, or only dated/shaky ones
    const lead = await wikipediaLeadImage(e);
    if (lead && !p18.some((n) => normFile(n) === normFile(lead))) {
      const r = await subjectFiles(kind, [lead]);
      if (r) {
        if (r.ok.length) note = ' [Wikipedia lead image]';
        cands = cands.concat(r.ok).sort((a, b) => b.q - a.q || a.order - b.order);
        bad.push(...r.bad);
      }
    }
  }
  if (!cands.length) {
    return { why: `${id}: no usable photo (${p18.length} P18; ${bad.slice(0, 3).join('; ') || 'no P18 and no Wikipedia lead image'})` };
  }
  const pick = pickVaried(cands);
  if (cands.length > 1) note += ` [1 of ${cands.length} usable]`;
  return { photo: pick, note };
}

// One name (ko or en) → { photo, qid, note } | { why }. `tried` holds item ids
// an earlier attempt already ended on, so the English pass does not redo them.
async function subjectByName(kind, lang, text, tried) {
  const j = await wikiJson('www.wikidata.org', new URLSearchParams({
    action: 'wbsearchentities', format: 'json', origin: '*', search: text,
    language: lang, uselang: lang, strictlanguage: '1', type: 'item', limit: '8',
  }));
  if (!j) return { why: `${lang}: Wikidata search failed` };
  const want = subjectNameKey(kind, text);
  const hits = (j.search || []).filter((r) => (subjectNameKey(kind, r.match?.text) === want || subjectNameKey(kind, r.label) === want)
    && !SUBJECT_NEVER_DESC.test(r.description || ''));
  if (!hits.length) {
    return { why: `${lang}: ${(j.search || []).length ? `${j.search.length} result(s), none named exactly "${text}"` : `no Wikidata item "${text}"`}` };
  }
  const ents = await wikidataEntities(hits.slice(0, 4).map((r) => r.id));
  if (!ents) return { why: `${lang}: Wikidata lookup failed` };
  const typed = [];
  const rejected = [];
  hits.slice(0, 4).forEach((r, i) => {
    const e = ents[i];
    if (!e) return;
    const t = subjectType(kind, e, r.description);
    if (t.ok) typed.push({ id: r.id, e, desc: r.description || e.descriptions?.en?.value || '', sl: Object.keys(e.sitelinks || {}).length, how: t.how });
    else rejected.push(`${r.id} ${r.description || '(no description)'}: ${t.why}`);
  });
  if (!typed.length) return { why: `${lang}: ${hits.length} item(s) named "${text}", none a ${kind} (${rejected.slice(0, 3).join('; ')})` };
  typed.sort((a, b) => b.sl - a.sl);
  if (typed.length > 1 && !(typed[0].sl >= 10 && typed[0].sl >= 4 * typed[1].sl)) {
    return { ambiguous: true, why: `${lang}: ambiguous — ${typed.length} ${kind}s are named "${text}" (${typed.slice(0, 3).map((x) => `${x.id} ${x.desc} [${x.sl} sitelinks]`).join('; ')})` };
  }
  const w = typed[0];
  if (w.sl < SUBJECT_MIN_SITELINKS) return { why: `${lang}: ${w.id} ${w.desc} is too obscure (${w.sl} sitelink(s))` };
  if (tried.has(w.id)) return { why: `${lang}: ${w.id} again` };
  tried.add(w.id);
  const r = await subjectPhotoOf(kind, w.id, w.e);
  return r.photo ? { photo: r.photo, qid: w.id, note: `${r.note || ''}${typed.length > 1 ? ` [of ${typed.length} same-named, ${w.sl} sitelinks]` : ''}` } : { why: `${lang}: ${r.why}` };
}

// { name_ko, name_en, kind } → { photo, qid, note } | { why }. Korean name first
// (what the news says), English as the second chance.
async function resolveSubject(s) {
  // A call that stayed throttled through its 10 s + 20 s backoffs means the
  // limit is still up; every further lookup would burn another ~30 s for nothing.
  if (wikiGaveUp) return { why: 'Wikimedia kept rate-limiting this run — lookup skipped' };
  const tried = new Set();
  const whys = [];
  const tries = [];
  if (s.name_ko) tries.push(['ko', s.name_ko]);
  if (s.name_en && normTitle(s.name_en) !== normTitle(s.name_ko)) tries.push(['en', s.name_en]);
  for (const [lang, text] of tries) {
    const r = await subjectByName(s.kind, lang, text, tried);
    if (r.photo) return r;
    whys.push(r.why);
    // Many people share the name → the English spelling can't tell them apart
    // either, and its one exact hit may be somebody else. Stop.
    if (r.ambiguous) break;
  }
  return { why: whys.join(' | ') };
}

// The model's `subjects` → at most SUBJECT_MAX well-formed, distinct entries.
function cleanSubjects(raw) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const name_ko = String(s?.name_ko ?? '').trim().slice(0, 60);
    const name_en = String(s?.name_en ?? '').trim().slice(0, 80);
    const key = normTitle(name_ko || name_en);
    if (!key || !Object.hasOwn(SUBJECT_P31, s?.kind)) continue;
    if (out.some((o) => normTitle(o.name_ko || o.name_en) === key)) continue;
    out.push({ name_ko, name_en, kind: s.kind });
  }
  return out.slice(0, SUBJECT_MAX);
}

// The cover for one card, or null: { url, free, credit } — logs one line per card.
async function coverFromSubject(t, isNews) {
  const subjects = cleanSubjects(t.subjects);
  const names = (s) => `${s.name_ko || s.name_en} (${[s.name_en, s.kind].filter(Boolean).join(', ')})`;
  if (!isNews) {
    if (subjects.length) console.log(`subject: '${t.id}' not a news card — ignoring ${subjects.map(names).join(', ')}`);
    return null;
  }
  if (!subjects.length) {
    console.log(`subject: '${t.id}' none — no single named subject on this news card`);
    return null;
  }
  const misses = [];
  for (const s of subjects) {
    let r;
    try {
      r = await resolveSubject(s);
    } catch (e) {
      r = { why: `lookup failed: ${e.message}` };
    }
    if (r.photo) {
      const p = r.photo;
      console.log(
        `subject: '${t.id}' ← ${names(s)} → ${r.qid} File:${p.name} (${p.lic}, ${p.w}×${p.h})${r.note || ''}` +
        (misses.length ? `; first ${misses.join('; ')}` : ''),
      );
      return { url: p.url, free: p.free, credit: p.credit };
    }
    misses.push(`${names(s)} → none (${r.why})`);
  }
  console.log(`subject: '${t.id}' ← ${misses.join('; ')}`);
  return null;
}

for (const t of data.topics) {
  // A real photo of the news card's own subject beats any mood photo. Free
  // (CC0/PD) → it IS the cover for every app version and the generic search is
  // skipped; attributed (CC BY / BY-SA) → it goes to imageAttributed, and the
  // generic search still runs below to give builds that predate credit lines
  // their CC0 `image`. No subject / nothing usable → null, cascade as before.
  const subj = await coverFromSubject(t, newsCards.has(t));
  const skipGeneric = !!subj?.free;
  const queries = skipGeneric ? [] : (Array.isArray(t.imageQueries) ? t.imageQueries : []).filter(Boolean).slice(0, 3);
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
  if (!usable.length && !skipGeneric) {
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
  if (subj) {
    // Same conventions as any other cover: CC0/PD → `image`; otherwise the pair
    // imageAttributed + imageCredit (the app shows them strictly together).
    if (subj.free) {
      t.image = subj.url;
    } else {
      t.imageAttributed = subj.url;
      t.imageCredit = subj.credit;
    }
    recentImages.add(subj.url);
  } else if (best && !best.free) {
    t.imageAttributed = best.url;
    t.imageCredit = best.credit;
    recentImages.add(best.url);
  }

  delete t.imageQueries; // internal only — not part of the app's Topic shape
  delete t.subjects; // internal only
  // Say what the CARD gets, not just the CC0 slot: "image=none +attributed"
  // read as "no cover" and sent a whole investigation after a non-problem.
  const cover = t.imageAttributed
    ? `attributed(${t.imageCredit.license})`
    : t.image
      ? 'cc0'
      : 'NONE → gradient';
  console.log(`${t.id}: cover=${cover}${subj ? ' (subject photo)' : ''}; cc0-for-old-builds=${t.image ? 'yes' : 'no'}`);
}

// --- posters: TMDB, for 오늘의 화제 cards about one film or TV programme ---
// A stock photo can't say WHICH film a news card is about — a cinema-seats
// photo under "연상호 감독의 '실낙원'" is anyone's film. The official poster can.
// The app is free (no ads, no IAP), which TMDB's API terms allow with credit.
// This runs AFTER the photo cascade on purpose: `image` stays the generic CC0
// photo for builds that predate credit lines, and the poster goes only into
// `imageAttributed` + `imageCredit`, which the app shows strictly as a pair.
// A missing token or any TMDB failure leaves the card's photo as it was.
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
// `original` posters run ~0.1–1.5 MB; the rare huge one drops to w780.
const TMDB_POSTER_MAX_BYTES = 2.5 * 1024 * 1024;

// "'100일의 거짓말'" / "100일의 거짓말!" / "암살자(들)" → letters and digits only,
// so quote marks, brackets, spacing and punctuation never decide a match.
function normTitle(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// v3 endpoint with a v4 read token as Bearer. 8 s timeout; one retry on 429,
// 5xx or a network error/timeout.
async function tmdbGet(path, params, token) {
  const url = `${TMDB_API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      if (attempt === 0) continue;
      throw new Error(`TMDB ${path} failed: ${e.message}`);
    }
    if ((r.status === 429 || r.status >= 500) && attempt === 0) {
      const after = Number(r.headers.get('retry-after'));
      await new Promise((res) => setTimeout(res, Math.min(Number.isFinite(after) && after > 0 ? after : 2, 10) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`TMDB ${path}: HTTP ${r.status}`);
    return r.json();
  }
}

// 200 + image/* or it isn't a cover. HEAD first; GET (body discarded) only if
// HEAD itself isn't supported or errors.
async function probeImage(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, { method, signal: AbortSignal.timeout(8000) });
      if (method === 'GET') r.body?.cancel().catch(() => {});
      if (method === 'HEAD' && (r.status === 405 || r.status === 501)) continue;
      const type = r.headers.get('content-type') || '';
      const len = Number(r.headers.get('content-length'));
      if (r.status === 200 && type.startsWith('image/')) return { ok: true, bytes: len > 0 ? len : null };
      return { ok: false, why: `HTTP ${r.status} ${type || '(no content-type)'}` };
    } catch (e) {
      if (method === 'GET') return { ok: false, why: e.message };
    }
  }
}

// Matching rules (TMDB search returns everything that merely CONTAINS the
// words — "실낙원" also brings back three "Paradise Lost" documentaries):
//  1. Exact title only: the normalised Korean `title`/`name` or the original
//     title must equal the headline's title. With a poster.
//  2. Prefer works dated within [today − 2 y, today + 1 y] — the news is
//     almost always about something new — closest year to `media.year` first,
//     then popularity. "실낙원" has TWO exact matches in that window: 연상호's
//     2026 film and a 2025 English-language film whose Korean title is also
//     실낙원 (which is MORE popular), so year beats popularity.
//     A stub — released over 60 days ago and still without a single vote —
//     gets no window preference: "올드보이" has an unrated 68-minute 2026
//     entry that would otherwise beat 박찬욱's 2003 film. (Unreleased films
//     legitimately have 0 votes; 실낙원 had none three days before release.)
//  3. Nothing usable in the window → an older work is fine when it is the
//     only exact match ('기생충' 2019, '나 혼자 산다' 2013), or ≥10× as popular
//     as the next one ('런닝맨': the 2010 variety show vs a 2017 cartoon of the
//     same name). Failing that, the same test among works whose ORIGINAL title
//     is the headline's — a Korean headline's '올드보이' is the 2003 film, not
//     the 2013 US remake that is merely translated that way. Otherwise no
//     poster — a wrong poster is worse than a stock photo.
async function findPoster(media, { token, today }) {
  const kind = media?.kind;
  if (kind !== 'movie' && kind !== 'tv') return { why: 'not about one film/TV programme' };
  const want = normTitle(media.title);
  if (!want) return { why: `${kind} with an empty title` };
  const name = (it) => (kind === 'movie' ? it.title : it.name) || '';
  const orig = (it) => (kind === 'movie' ? it.original_title : it.original_name) || '';
  const date = (it) => (kind === 'movie' ? it.release_date : it.first_air_date) || '';

  const params = { query: String(media.title).trim(), language: 'ko-KR', include_adult: 'false' };
  if (kind === 'movie') params.region = 'KR';
  const results = (await tmdbGet(`/search/${kind}`, params, token)).results || [];
  const exact = results.filter((it) => normTitle(name(it)) === want || normTitle(orig(it)) === want);
  if (!exact.length) {
    const near = results.slice(0, 3).map((it) => `"${name(it)}"`).join(', ');
    return { why: `no exact ${kind} title match for "${media.title}" among ${results.length} result(s)${near ? ` (${near})` : ''}` };
  }
  const usable = exact.filter((it) => it.poster_path);
  if (!usable.length) return { why: `${exact.length} exact match(es) for "${media.title}", none with a poster` };

  const Y = Number(today.slice(0, 4));
  const lo = `${Y - 2}${today.slice(4)}`;
  const hi = `${Y + 1}${today.slice(4)}`;
  const year = Number.isInteger(media.year) && media.year > 1900 ? media.year : Y;
  const yearGap = (it) => (date(it) ? Math.abs(Number(date(it).slice(0, 4)) - year) : Infinity);
  const pop = (it) => it.popularity || 0;
  const stub = (it) => !it.vote_count && date(it) && (Date.parse(today) - Date.parse(date(it))) / 86400e3 > 60;
  const inWindow = usable.filter((it) => date(it) >= lo && date(it) <= hi && !stub(it));
  let pick;
  let note = '';
  if (inWindow.length) {
    pick = inWindow.sort((a, b) => yearGap(a) - yearGap(b) || pop(b) - pop(a))[0];
    if (inWindow.length > 1) note = ` [${inWindow.length} exact matches in window, closest to ${year}]`;
  } else {
    const clearly = (list) => {
      const byPop = [...list].sort((a, b) => pop(b) - pop(a));
      if (byPop.length === 1) return { it: byPop[0], why: 'the only exact match' };
      if (pop(byPop[0]) > 0 && pop(byPop[0]) >= 10 * pop(byPop[1])) {
        return { it: byPop[0], why: `${Math.round(pop(byPop[0]) / Math.max(pop(byPop[1]), 0.01))}× as popular as the other ${byPop.length - 1}` };
      }
      return null;
    };
    const own = usable.filter((it) => normTitle(orig(it)) === want);
    let c = clearly(usable);
    if (!c && own.length && own.length < usable.length) {
      c = clearly(own);
      if (c) c.why += ` of ${own.length} originally titled "${media.title}"`;
    }
    if (!c) {
      const list = [...usable].sort((a, b) => pop(b) - pop(a)).slice(0, 4).map((it) => `${it.id} ${date(it) || 'undated'}`).join(', ');
      return { why: `${usable.length} exact matches for "${media.title}", none usable in ${lo}…${hi} and none clearly the one (${list})` };
    }
    pick = c.it;
    note = ` [nothing recent and rated in ${lo}…${hi}; ${c.why}]`;
  }

  // `original` unless it is oversized or its size is unknown; then w780.
  let url = `${TMDB_IMG}original${pick.poster_path}`;
  let probe = await probeImage(url);
  if (!probe.ok || probe.bytes == null || probe.bytes > TMDB_POSTER_MAX_BYTES) {
    const small = `${TMDB_IMG}w780${pick.poster_path}`;
    const p2 = await probeImage(small);
    if (p2.ok) {
      note += ` [w780: original ${probe.ok ? `${probe.bytes == null ? 'size unknown' : `${(probe.bytes / 1048576).toFixed(1)} MB`}` : probe.why}]`;
      url = small;
      probe = p2;
    } else if (!probe.ok) {
      return { why: `poster for ${kind} ${pick.id} not reachable (${probe.why}; w780 ${p2.why})` };
    }
  }
  return {
    kind, id: pick.id, title: name(pick), date: date(pick), url, bytes: probe.bytes, note,
    sourceUrl: `https://www.themoviedb.org/${kind}/${pick.id}`,
  };
}

{
  const token = (process.env.TMDB_READ_TOKEN || '').trim();
  if (!token) {
    console.log('poster: skipped (TMDB_READ_TOKEN not set)');
  } else {
    for (const t of data.topics) {
      const m = t.media;
      const isMedia = m && (m.kind === 'movie' || m.kind === 'tv');
      let res;
      if (!newsCards.has(t)) {
        res = { why: isMedia ? `not a news card — ignoring media ${m.kind} "${m.title}"` : 'not a news card' };
      } else {
        try {
          res = await findPoster(m, { token, today: isoDate });
        } catch (e) {
          res = { why: e.message };
        }
      }
      if (res.url) {
        t.imageAttributed = res.url;
        t.imageCredit = { author: 'TMDB', license: '포스터', text: '포스터: TMDB', sourceUrl: res.sourceUrl };
        t.imageKind = 'poster';
        console.log(`poster: '${t.id}' ← TMDB ${res.kind} ${res.id} "${res.title}" (${res.date || 'undated'})${res.note}`);
      } else {
        console.log(`poster: '${t.id}' none — ${res.why}`);
      }
    }
  }
  for (const t of data.topics) delete t.media; // internal only — not part of the app's Topic shape
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
console.log(`gen tokens: in=${gen.usage.input_tokens} out=${gen.usage.output_tokens} (${MODEL}, effort ${EFFORT || 'default'})`);
console.log(`cost: main $${spend.main.toFixed(4)} + repair $${spend.repair.toFixed(4)} = $${(spend.main + spend.repair).toFixed(4)}`);
