// Daily Small Talk — content generator (real-time, cost-optimized).
// Runs daily at 09:00 KST (00:00 UTC) via GitHub Actions.
// Split roles to keep cost low while keeping live weather/trends:
//   1) RESEARCH_MODEL (Sonnet) + web search  → concise brief  (capped searches)
//   2) GEN_MODEL (Haiku)     + structured out → 5 topics       (cheap long output)
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'node:fs';

const RESEARCH_MODEL = 'claude-sonnet-5'; // supports web search; cheaper than Opus
const GEN_MODEL = 'claude-sonnet-5'; // reliable at 'exactly 5, concise' where Haiku over-generated
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

function textOf(msg) {
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
async function createWithTools(params) {
  let messages = params.messages;
  for (let i = 0; i < 5; i++) {
    const res = await client.messages.create({ ...params, messages });
    if (res.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: res.content }]; continue; }
    return res;
  }
  throw new Error('web search did not settle');
}

// --- 1) research (Sonnet + web search, capped) ---
const research = await createWithTools({
  model: RESEARCH_MODEL,
  max_tokens: 1500,
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
  messages: [{
    role: 'user',
    content:
      `오늘은 ${dateLabel} (${isoDate}), 대한민국. 스몰토크 소재를 위해 오늘의 실시간 맥락을 빠르게 조사해줘:\n` +
      `- 오늘/이번 주 서울·한국 날씨(기온, 비/눈, 미세먼지, 장마·폭염 등)\n` +
      `- 요즘 한국에서 가볍게 화제인 것(신작 드라마/영화/음악, 스포츠, 축제 등 — 정치·사건사고 제외)\n` +
      `계절 참고: ${SEASON[month]}\n` +
      `한국어 5~7줄 간결한 브리핑만. 구체적 사실 위주.`,
  }],
});
const brief = textOf(research);
console.log('--- brief ---\n' + brief + '\n');

// --- 2) generate topics (Haiku + structured output) ---
const moodTip = { type: 'object', additionalProperties: false, properties: { opener: { type: 'string' }, follow: { type: 'string' }, caution: { type: 'string' } }, required: ['opener', 'follow', 'caution'] };
const topic = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '문화'] },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' }, desc: { type: 'string' }, reason: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    tips: { type: 'object', additionalProperties: false, properties: { work: moodTip, friend: moodTip, date: moodTip }, required: ['work', 'friend', 'date'] },
  },
  required: ['id', 'cat', 'label', 'color', 'title', 'desc', 'reason', 'questions', 'tips'],
};
const schema = { type: 'object', additionalProperties: false, properties: { topics: { type: 'array', items: topic } }, required: ['topics'] };

const gen = await client.messages.create({
  model: GEN_MODEL,
  max_tokens: 16000,
  output_config: { format: { type: 'json_schema', schema } },
  messages: [{
    role: 'user',
    content:
      `너는 "데일리 스몰토크" 앱의 오늘의 주제 5개 에디터야. 오늘: ${dateLabel}.\n\n[오늘의 맥락]\n${brief}\n\n[요구사항]\n` +
      `- 정확히 5개 주제, 카테고리 겹치지 않게. 각 필드(reason·desc·팁)는 1~2문장으로 간결하게. 첫 번째는 위 맥락에서 가장 시의성 있는 것(실시간 날씨/화제 반영).` + (isWeekend ? ' 주말 소재 하나 포함 가능.' : '') + `\n` +
      `- 모든 문장 존댓말 ~요체. 친근하고 구체적, 살짝 위트. 정치·사건사고·민감 주제 금지.\n` +
      `- label: 커버용 1~4글자 핵심 단어. color: 진한 hex.\n` +
      `- questions: 바로 쓸 시작 질문 정확히 3개.\n` +
      `- tips: work(직장)/friend(친구)/date(소개팅)마다 opener(첫 멘트, 예문)/follow(이어가기)/caution(피할 것). date에 상사·업무 얘기 금지.\n` +
      `- reason은 오늘 날짜·맥락 반영. JSON만 출력.`,
  }],
});

const data = JSON.parse(textOf(gen));
data.topics = (data.topics || []).filter((t) => Array.isArray(t.questions) && t.questions.length === 3).slice(0, 5);
if (data.topics.length < 3) throw new Error('not enough valid topics');

const out = { date: isoDate, dateLabel, generatedAt: now.toISOString(), topics: data.topics };
mkdirSync('content/archive', { recursive: true });
writeFileSync('today.json', JSON.stringify(out, null, 2));
writeFileSync(`content/archive/${isoDate}.json`, JSON.stringify(out, null, 2));
console.log(`Wrote today.json (${out.topics.length} topics) for ${isoDate}`);
console.log(`research tokens: in=${research.usage.input_tokens} out=${research.usage.output_tokens} (${RESEARCH_MODEL})`);
console.log(`gen tokens: in=${gen.usage.input_tokens} out=${gen.usage.output_tokens} (${GEN_MODEL})`);
