// Daily Small Talk — content generator (real-time from FREE sources, cheap).
// Runs daily at 09:00 KST (00:00 UTC) via GitHub Actions.
// Real-time signals come from free APIs (no Anthropic web search — that injects
// ~100k tokens of page content and costs ~$10/mo). One Sonnet call turns the
// compact brief into 5 topics. Cost ≈ $1/month.
//   - Weather: Open-Meteo (free, keyless)
//   - Culture trends: Google News search RSS (free, light-topic query)
//   - Cover photos: Openverse (free, keyless, CC0-only so no attribution is
//     required) — the model also writes a generic English `imageQuery` per
//     topic, which we search after generation. No image found → the app
//     falls back to a solid color-gradient cover (never a broken image).
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'node:fs';

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

const [weather, trends] = await Promise.all([getWeather(), getTrends()]);
const brief =
  `날씨: ${weather ?? '정보 없음'}\n` +
  `계절: ${SEASON[month]}\n` +
  (trends ? `요즘 화제(참고용 — 대중적으로 다들 알 만한 연예·문화 화제, 물가·경제 같은 생활 시사를 골라 쓰세요. 무거운 정치·범죄·재난·사망 등은 무시):\n- ${trends.join('\n- ')}\n` : '');
console.log('--- brief ---\n' + brief);

const moodTip = { type: 'object', additionalProperties: false, properties: { opener: { type: 'string' }, follow: { type: 'string' }, caution: { type: 'string' } }, required: ['opener', 'follow', 'caution'] };
const topic = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '문화', '경제'] },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
    imageQuery: { type: 'string', description: 'A CONCRETE, PHOTOGRAPHABLE scene in 2-5 generic English words — a real object, food, weather phenomenon, or visible action/place a stock photographer could literally shoot. Never an abstract mood, time-of-day, or feeling. Good: "chicken soup bowl", "rainy street umbrella", "person relaxing sofa blanket", "friends laughing cafe", "night city lights summer". Bad (too abstract, will fail): "weekend afternoon", "cozy feeling", "nostalgic mood". No Korean, no brand/proper nouns.' },
  },
  required: ['id', 'cat', 'label', 'color', 'title', 'desc', 'reason', 'questions', 'tips', 'imageQuery'],
};
const schema = { type: 'object', additionalProperties: false, properties: { topics: { type: 'array', items: topic } }, required: ['topics'] };

const gen = await client.messages.create({
  model: MODEL,
  max_tokens: 12000,
  output_config: { format: { type: 'json_schema', schema } },
  messages: [{
    role: 'user',
    content:
      `너는 "데일리 스몰토크" 앱의 오늘의 주제 5개 에디터야. 오늘: ${dateLabel}.\n\n[오늘의 실시간 맥락]\n${brief}\n[요구사항]\n` +
      `- 정확히 5개 주제, 카테고리 겹치지 않게. 각 필드는 1~2문장으로 간결하게. 첫 번째는 위 날씨를 반영한 시의성 있는 것.` + (isWeekend ? ' 주말 소재 하나 포함 가능.' : '') + `\n` +
      `- 모든 문장 존댓말 ~요체(단 친구 팁은 반말도 자연스러우면 허용). 친근하고 구체적, 살짝 위트.\n` +
      `- ★스몰토크 적합성이 최우선: 좋은 주제는 "누구나 자기 경험으로 바로 대답할 수 있는 것"이에요. 날씨, 음식/식사, 주말·퇴근 후 시간, 요즘 보는 드라마·영상, 물가·생활비 체감, 계절 변화, 여행·휴가처럼 대다수가 공감하는 일상 소재로 대부분 채우세요.\n` +
      `- 개별 스포츠 선수 부상, 지역 축제, 특정 연예인 가십처럼 "관심 있는 소수만 아는 뉴스"는 대화가 안 이어지니 주제로 쓰지 마세요.\n` +
      `- '요즘 화제'는 주제가 아니라 관점의 힌트일 뿐이에요. 정말 대다수가 알 수준(전 국민이 보는 인기 드라마/예능, 폭염·한파, 물가 급등 등)일 때만 최대 1개 넣되, 뉴스 사건이 아니라 누구나 대답할 수 있는 보편적 질문으로 바꾸세요(예: 물가 뉴스 → "요즘 장 보기 좀 부담되지 않으세요?"). 애매하면 트렌드 없이 일상·계절 소재로만 구성하세요.\n` +
      `- 요즘 주식·재테크에 관심이 많은 분위기라, '경제' 카테고리로 생활경제 주제를 하나 넣어주세요. 단 특정 종목·시황·투자조언이 아니라 "요즘 주식이나 재테크 하세요?", "월급 모으기 참 어렵죠", "물가 체감" 처럼 누구나 가볍게 자기 얘기로 대답할 수 있는 수준으로만.\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개.\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지.\n` +
      `- imageQuery: 이 주제의 커버 사진을 찾기 위한 검색어. 반드시 사진으로 실제 찍을 수 있는 구체적 대상(사물·음식·날씨·장소·행동)으로 쓰세요. "주말", "느낌", "분위기" 같은 추상적 시간/기분 표현은 금지 — 대신 그 시간에 실제 보이는 장면으로 바꾸세요(예: "비 오는 일요일 집에서" → "person relaxing sofa blanket rain window"). 한국 고유 음식/지명은 일반적인 영어 표현으로(예: 삼계탕→"chicken soup bowl", 냉면→"cold noodles bowl"). 브랜드명·고유명사·한국어 금지.\n` +
      `- reason은 오늘 날짜·날씨·맥락 반영. JSON만 출력.`,
  }],
});

const raw = gen.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
const data = JSON.parse(raw);
data.topics = (data.topics || []).filter((t) => Array.isArray(t.questions) && t.questions.length === 3).slice(0, 5);
if (data.topics.length < 3) throw new Error('not enough valid topics');

// --- cover photos: Openverse, CC0 only (no attribution required), keyless ---
const CAT_FALLBACK_QUERY = {
  '시즌': 'season nature landscape',
  '날씨': 'weather sky city',
  '음식': 'food dish table',
  '일상': 'daily life lifestyle',
  '문화': 'korean culture city',
  '경제': 'money coins savings finance',
};

const STOPWORDS = new Set(['a', 'an', 'the', 'with', 'of', 'in', 'on', 'at']);

async function searchOpenverse(query) {
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0&page_size=10`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const results = (j.results || []).filter((it) => (it.width ?? 0) >= 600 && (it.height ?? 0) >= 400 && it.url);
    if (!results.length) return null;

    // Soft relevance: score by how many query keywords appear in the result's
    // title/tags. Openverse titles are often sparse, so this only re-ranks —
    // it never rejects down to zero candidates.
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
    const score = (it) => {
      const hay = `${it.title || ''} ${(it.tags || []).map((t) => t.name || t).join(' ')}`.toLowerCase();
      return keywords.reduce((n, k) => n + (hay.includes(k) ? 1 : 0), 0);
    };
    results.sort((a, b) => score(b) - score(a));
    return results[0].url;
  } catch (e) {
    console.log(`openverse search failed for "${query}":`, e.message);
    return null;
  }
}

for (const t of data.topics) {
  let image = t.imageQuery ? await searchOpenverse(t.imageQuery) : null;
  if (!image) image = await searchOpenverse(CAT_FALLBACK_QUERY[t.cat] || 'lifestyle');
  if (image) t.image = image;
  delete t.imageQuery; // internal only — not part of the app's Topic shape
  console.log(`${t.id}: image=${image ? 'found' : 'none (color gradient fallback)'}`);
}

const out = { date: isoDate, dateLabel, generatedAt: now.toISOString(), topics: data.topics };
mkdirSync('content/archive', { recursive: true });
writeFileSync('today.json', JSON.stringify(out, null, 2));
writeFileSync(`content/archive/${isoDate}.json`, JSON.stringify(out, null, 2));
console.log(`Wrote today.json (${out.topics.length} topics) for ${isoDate}`);
console.log(`gen tokens: in=${gen.usage.input_tokens} out=${gen.usage.output_tokens} (${MODEL})`);
