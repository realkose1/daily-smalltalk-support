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

async function fetchTitles(query, take) {
  try {
    const q = encodeURIComponent(`${query} when:2d`);
    const r = await fetch(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`, { signal: AbortSignal.timeout(8000) });
    const xml = await r.text();
    return [...xml.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)]
      .map((m) => m[1]).slice(1) // drop feed title
      .map((t) => t.replace(/\s*-\s*[^-]+$/, '').trim()) // strip trailing " - 매체명"
      .filter((t) => t.length > 4).slice(0, take);
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
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '문화'] },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
    imageQuery: { type: 'string', description: '2-4 generic English words for a stock-photo search, e.g. "chicken soup bowl", "rainy street umbrella", "summer beach vacation". No Korean, no brand/proper nouns.' },
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
      `- 5개 중 1~2개는 위 '요즘 화제'를 반영한 대중적 소재(연예·문화 화제, 물가/경제 같은 생활 시사, 가벼운 연예 이슈)로 넣어주세요. 단 무거운 정치·범죄·재난·특정인 비방은 금지.\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개.\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지.\n` +
      `- imageQuery: 이 주제의 커버 사진을 찾기 위한 2~4개의 일반적인 영어 단어(스톡사진 검색어). 한국 고유 음식/지명은 일반적인 영어 표현으로(예: 삼계탕→"chicken soup bowl", 냉면→"cold noodles bowl"). 브랜드명·고유명사·한국어 금지.\n` +
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
};

async function searchOpenverse(query) {
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0&page_size=6`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const results = j.results || [];
    const decent = results.find((it) => (it.width ?? 0) >= 600 && (it.height ?? 0) >= 400 && it.url);
    return decent?.url ?? results[0]?.url ?? null;
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
