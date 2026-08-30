// Daily Small Talk — content generator (real-time from FREE sources, cheap).
// Runs daily at 09:00 KST (00:00 UTC) via GitHub Actions.
// Real-time signals come from free APIs (no Anthropic web search — that injects
// ~100k tokens of page content and costs ~$10/mo). One Sonnet call turns the
// compact brief into 8 topics — the deck went 5 → 8 so that the app's 관심 주제
// picker has enough categories present each day to actually re-order anything.
// Cost ≈ $1.5/month.
//   - Weather: Open-Meteo (free, keyless)
//   - Culture trends: Google News search RSS (free, light-topic query)
//   - Cover photos: Openverse (free, keyless, CC0-only so no attribution is
//     required) — the model also writes 3 generic English `imageQueries` per
//     topic, which we search after generation. No image found → the app
//     falls back to a solid color-gradient cover (never a broken image).
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';

const MODEL = 'claude-sonnet-5'; // reliable "exactly 5 + concise"; bump to opus for max quality
const client = new Anthropic();

const now = new Date();
const kst = new Date(now.getTime() + 9 * 3600 * 1000);
const month = kst.getUTCMonth() + 1;
const day = kst.getUTCDate();
const isoDate = `${kst.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const wd = kst.getUTCDay();
const dateLabel = `${month}월 ${day}일 ${weekdays[wd]}요일`;
const isWeekend = wd === 0 || wd === 6;

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

async function fetchTitles(query, take) {
  try {
    const q = encodeURIComponent(`${query} when:2d`);
    const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`, { signal: AbortSignal.timeout(8000) });
    const xml = await r.text();
    return [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => m[1]).slice(1) // drop feed title
      .map((t) => t.replace(/\s*-\s*[^-]+$/, '').trim()) // strip trailing " - 매체명"
      .filter((t) => t.length > 4 && !BLOCK.test(t)) // drop sensitive/political
      .slice(0, take);
  } catch { return []; }
}

async function getTrends() {
  try {
    // Mainstream mix: entertainment/gossip + light economy/생활시사 + popular culture.
    const [ent, econ, pop] = await Promise.all([
      fetchTitles('(연예 OR 열애 OR 아이돌 OR 배우 OR 예능 OR 드라마)', 3),
      fetchTitles('(물가 OR 경제 OR 주식 OR 부동산 OR 금리 OR 월급)', 3),
      fetchTitles('(화제 OR 인기 OR 유행 OR 축제 OR 영화 OR 콘서트)', 3),
    ]);
    const titles = [...new Set([...ent, ...econ, ...pop])].slice(0, 9);
    return titles.length ? titles : null;
  } catch (e) {
    console.log('trends fetch failed:', e.message);
    return null;
  }
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
      lines.push(
        `${name}: ${Math.round(last.c).toLocaleString()} — ${kstDayLabel(last.t)} 종가 기준, 직전 거래일(${kstDayLabel(prev.t)}) 대비 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%${big ? ' ★큰 변동' : ''}`,
      );
    } catch {
      // skip symbol on failure
    }
  }
  return lines.length ? lines : null;
}

const [weather, trends, markets] = await Promise.all([getWeather(), getTrends(), getMarkets()]);

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
  (trends ? `요즘 화제(참고용 — 대중적으로 다들 알 만한 연예·문화 화제, 물가·경제 같은 생활 시사를 골라 쓰세요. 무거운 정치·범죄·재난·사망 등은 무시):\n- ${trends.join('\n- ')}\n` : '') +
  (recent.length ? `\n[최근 며칠간 이미 나간 주제 — 소재·질문·문구가 겹치면 안 됩니다]\n${recent.join('\n')}\n` : '');
console.log('--- brief ---\n' + brief);

const moodTip = { type: 'object', additionalProperties: false, properties: { opener: { type: 'string' }, follow: { type: 'string' }, caution: { type: 'string' } }, required: ['opener', 'follow', 'caution'] };
const topic = {
  type: 'object', additionalProperties: false,
  properties: {
    // Categories double as the app's "관심 주제" picker, so keep them short
    // (they render as a chip on the cover) and broad enough that any of them
    // can carry a universally relatable small-talk question.
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '여행', '문화', '건강', '취미', '쇼핑', '경제', '커리어', '관계'] },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    special: { type: 'boolean', description: '오늘이 [한국의 특별한 날](초복·중복·말복·명절·기념일 등)이고 이 주제가 바로 그 날을 소재로 만든 주제일 때만 true. 그런 주제는 정확히 1개. 오늘이 특별한 날이 아니거나 이 주제가 그 소재가 아니면 false.' },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
    // NOTE: structured outputs only support minItems 0/1 — don't add
    // minItems/maxItems here (a 3/3 constraint 400'd the whole run on
    // 2026-07-12). "Exactly 3" lives in the description + slice(0,3) below.
    imageQueries: { type: 'array', items: { type: 'string' }, description: 'EXACTLY 3 DIFFERENT concrete, photographable scenes for this topic, each 2-5 generic English words — a real object, food, weather phenomenon, or visible action/place a stock photographer could literally shoot. Vary the subject across the 3 (e.g. for sleeping in: "cat sleeping blanket", "unmade bed pillows", "alarm clock nightstand"). Never an abstract mood, time-of-day, or feeling. Good: "chicken soup bowl", "rainy street umbrella", "person relaxing sofa blanket". Bad (too abstract, will fail): "weekend afternoon", "cozy feeling". No Korean, no brand/proper nouns.' },
  },
  required: ['id', 'cat', 'label', 'color', 'title', 'desc', 'reason', 'special', 'questions', 'tips', 'imageQueries'],
};
const schema = { type: 'object', additionalProperties: false, properties: { topics: { type: 'array', items: topic } }, required: ['topics'] };

const gen = await client.messages.create({
  model: MODEL,
  // 8 topics × (3 questions + 3 moods × 3 tips + imageQueries) — 12k truncated
  // the JSON mid-object once the deck grew from 5 to 8.
  max_tokens: 20000,
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
      `- 카테고리 감: 여행=휴가·나들이·가보고 싶은 곳 / 문화=드라마·영화·음악·공연 / 건강=운동·수면·컨디션 / 취미=게임·독서·수집·배우는 것 / 쇼핑=요즘 산 것·패션·생활용품 / 커리어=일하는 방식·출퇴근·이직 고민(가볍게) / 관계=친구·가족·주변 사람 이야기(사생활 캐묻기 금지).\n` +
      `- ★위 [최근 며칠간 이미 나간 주제]와 겹치지 마세요. 같은 소재(장마, 삼계탕, 물가 등)를 또 쓰려면 각도를 완전히 바꾸세요(예: 장마 → 우산 얘기 대신 빗소리·제습·빨래·출퇴근길 / 보양식 → 삼계탕 대신 냉면·수박·팥빙수). 제목·질문 문구가 비슷해도 안 됩니다.\n` +
      `- ★답이 뻔한 예/아니오 질문 금지: 비 오는 날 "우산 챙기셨어요?"처럼 누구나 답이 정해진 질문은 대화가 한 마디로 끝나요. 취향·경험·이야기를 끌어내는 열린 질문으로 쓰세요(예: "비 오는 날엔 어떤 노래 들으세요?", "장마철 최악의 출근길 썰 있으세요?").\n` +
      `- 모든 문장 존댓말 ~요체(단 친구 팁은 반말도 자연스러우면 허용). 친근하고 구체적, 살짝 위트.\n` +
      `- ★스몰토크 적합성이 최우선: 좋은 주제는 "누구나 자기 경험으로 바로 대답할 수 있는 것"이에요. 날씨, 음식/식사, 주말·퇴근 후 시간, 요즘 보는 드라마·영상, 물가·생활비 체감, 계절 변화, 여행·휴가처럼 대다수가 공감하는 일상 소재로 대부분 채우세요.\n` +
      `- 개별 스포츠 선수 부상, 지역 축제, 특정 연예인 가십처럼 "관심 있는 소수만 아는 뉴스"는 대화가 안 이어지니 주제로 쓰지 마세요.\n` +
      `- ★특정 작품·영화·드라마·인물을 소재로 쓸 거면 반드시 그 제목/이름을 구체적으로 밝히세요. "화제의 한국 영화가 베일을 벗었다", "여름 극장가 기대작", "뜨거운 관심을 모은 그 드라마"처럼 무엇을 말하는지 알 수 없는 두루뭉술한 표현은 금지예요 — 알맹이가 없어 대화가 안 이어져요. 위 '요즘 화제'에 구체적 제목이 없어 무엇인지 특정할 수 없으면, 그 소재는 아예 쓰지 말고 "요즘 극장에서 뭐 보셨어요?", "요새 정주행하는 드라마 있으세요?"처럼 작품을 특정하지 않는 완전 보편 질문으로 바꾸세요. 브리프에 없는 제목·이름을 지어내는 건 금지.\n` +
      `- '요즘 화제'는 주제가 아니라 관점의 힌트일 뿐이에요. 정말 대다수가 알 수준(전 국민이 보는 인기 드라마/예능, 폭염·한파, 물가 급등 등)일 때만 최대 1개 넣되, 뉴스 사건이 아니라 누구나 대답할 수 있는 보편적 질문으로 바꾸세요(예: 물가 뉴스 → "요즘 장 보기 좀 부담되지 않으세요?"). 애매하면 트렌드 없이 일상·계절 소재로만 구성하세요.\n` +
      `- 요즘 주식·재테크에 관심이 많은 분위기라, '경제' 카테고리로 생활경제 주제를 하나 넣어주세요. 기본은 "요즘 주식이나 재테크 하세요?", "월급 모으기 참 어렵죠", "물가 체감"처럼 누구나 자기 얘기로 대답할 수 있는 소재로.\n` +
      `- ★단, [시장 시그널]에 '큰 변동' 표시가 있거나 '요즘 화제'에 기준금리 인상/인하 같은 굵직한 경제 뉴스가 있으면, 그날의 경제 주제는 두루뭉술한 물가 얘기 대신 그 사실을 구체적으로 다루세요. 수치도 브리프에 있는 그대로 인용해도 좋아요(예: "삼성전자가 금요일에 9% 가까이 빠졌다던데, 뒤숭숭하지 않으세요?", "기준금리가 0.25%p 올랐다는데 대출 이자 걱정되시죠?"). 브리프에 없는 수치·날짜를 지어내는 건 금지.\n` +
      `- ★★시장 수치를 언급할 땐 [시장 시그널] 각 줄에 적힌 기준일 표현을 그대로 쓰세요. 주식·코스피는 주말·공휴일에 쉬기 때문에, 기준일이 "8월 15일(금)"인데 "어제"라고 쓰면 날짜가 틀립니다(일요일 주제에 금요일 등락을 "어제"라고 쓴 사고 있음). 기준일이 '어제'라고 적혀 있을 때만 "어제"라고 쓰고, 아니면 "지난 금요일" 같은 실제 요일이나 "최근"으로 쓰세요.\n` +
      `- 이때도 매수/매도 추천·목표가·시황분석·전망은 절대 금지 — "다들 얘기하더라"며 화제로 가볍게 나누는 톤만. 삼성전자·SK하이닉스·코스피·환율·비트코인처럼 다들 아는 것만 다루고, 소수만 아는 종목은 피하세요.\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개.\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지.\n` +
      `- imageQueries: 이 주제의 커버 사진을 찾기 위한 검색어 3개(서로 다른 피사체/장면으로). 반드시 사진으로 실제 찍을 수 있는 구체적 대상(사물·음식·날씨·장소·행동)으로 쓰세요. "주말", "느낌", "분위기" 같은 추상적 시간/기분 표현은 금지 — 대신 그 시간에 실제 보이는 장면으로 바꾸세요(예: "비 오는 일요일 집에서" → "person relaxing sofa blanket" / "rain drops window" / "umbrella wet street"). 한국 고유 음식/지명은 일반적인 영어 표현으로(예: 삼계탕→"chicken soup bowl", 냉면→"cold noodles bowl"). 브랜드명·고유명사·한국어 금지.\n` +
      `- reason은 오늘 날짜·날씨·맥락 반영. JSON만 출력.`,
  }],
});

const raw = gen.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
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
function relevanceScorer(query) {
  const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return (text) => {
    const hay = text.toLowerCase();
    return keywords.reduce((n, k) => n + (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay) ? 1 : 0), 0);
  };
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
  const top = pool.slice(0, Math.min(6, pool.length));
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
      .sort((a, b) => (b.free - a.free) || (b.s - a.s));
  } catch (e) {
    console.log(`openverse search failed for "${query}":`, e.message);
    return [];
  }
}

// Wikimedia Commons, keyless. Same strict keyword rule (Commons full-text
// search alone returns loose matches like paintings for "sleeping bed").
// CC0/PD are attribution-free; CC BY / BY-SA come back with credit metadata.
async function searchCommons(query) {
  try {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'search', gsrsearch: `filetype:bitmap ${query}`, gsrnamespace: '6', gsrlimit: '20',
      prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1280',
    });
    const r = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': 'daily-smalltalk-content/1.0 (github.com/realkose1/daily-smalltalk-support)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const score = relevanceScorer(query);
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
        const s = score(`${p.title} ${desc}`);
        if (s <= 0) return null;
        const author = creditName(ii.extmetadata?.Artist?.value);
        // An attributed file with no usable author line can't be credited
        // properly, so treat it as unusable rather than crediting "unknown".
        if (!free && !author) return null;
        return {
          url: ii.thumburl || ii.url,
          s,
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
      // Attribution-free first (usable by every app version), then CC0 over PD
      // (modern Unsplash donations rather than dated scans), then relevance.
      .sort((a, b) => (b.free - a.free) || (b.cc0 - a.cc0) || (b.s - a.s));
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
  let cands = [];
  for (const q of queries) { cands = await searchOpenverse(q); if (cands.length) break; }
  if (!cands.length) for (const q of queries) { cands = await searchCommons(q); if (cands.length) break; }
  if (!cands.length) {
    for (const q of shuffled(CAT_FALLBACK_QUERIES[t.cat] || ['lifestyle'])) {
      cands = await searchOpenverse(q);
      if (!cands.length) cands = await searchCommons(q);
      if (cands.length) break;
    }
  }

  // Two picks from the SAME candidate list (no extra API calls):
  //   image            — attribution-free only. Every app version renders this,
  //                      including builds shipped before the credit line existed.
  //   imageAttributed  — best pick regardless of licence, shown only by builds
  //                      that display `imageCredit`. This is what unlocks the
  //                      big CC BY-SA pool (e.g. 삼성 사진은 전부 BY-SA).
  const best = pickVaried(cands);
  const free = pickVaried(cands.filter((c) => c.free));

  if (free) { t.image = free.url; recentImages.add(free.url); }
  if (best && !best.free) {
    t.imageAttributed = best.url;
    t.imageCredit = best.credit;
    recentImages.add(best.url);
  }

  delete t.imageQueries; // internal only — not part of the app's Topic shape
  console.log(
    `${t.id}: image=${t.image ? 'cc0' : 'none'}${t.imageAttributed ? ` +attributed(${t.imageCredit.license})` : ''}`,
  );
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
