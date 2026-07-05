// Daily Small Talk — content generator.
// Runs daily at 09:00 KST (00:00 UTC) via GitHub Actions.
// 1) Researches "today in Korea" with Claude + web search.
// 2) Turns that brief into 5 conversation topics in the app's JSON schema.
// Writes public/today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'node:fs';

const MODEL = 'claude-opus-4-8';
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// --- date in KST (workflow fires at 00:00 UTC = 09:00 KST) ---
const now = new Date();
const kst = new Date(now.getTime() + 9 * 3600 * 1000);
const yyyy = kst.getUTCFullYear();
const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
const dd = String(kst.getUTCDate()).padStart(2, '0');
const isoDate = `${yyyy}-${mm}-${dd}`;
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const dateLabel = `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일 ${weekdays[kst.getUTCDay()]}요일`;

// Categories the app has cover art / colors for. Keep the generator on-palette.
const CATS = ['시즌', '날씨', '음식', '일상', '뉴스', '문화'];

function textOf(msg) {
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Run a request that may use server-side web search, resolving pause_turn.
async function createWithTools(params) {
  let messages = params.messages;
  for (let i = 0; i < 6; i++) {
    const res = await client.messages.create({ ...params, messages });
    if (res.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: res.content }];
      continue;
    }
    return res;
  }
  throw new Error('web search did not settle');
}

const research = await createWithTools({
  model: MODEL,
  max_tokens: 2500,
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
  messages: [
    {
      role: 'user',
      content:
        `오늘은 ${isoDate} (${dateLabel}), 대한민국 기준이야.\n` +
        `오늘 사람들이 스몰토크로 나누기 좋은 소재를 찾기 위해 오늘의 맥락을 조사해줘:\n` +
        `- 오늘/이번 주 한국 날씨 (기온, 비/눈, 미세먼지, 장마·폭염·한파 등)\n` +
        `- 계절/절기, 오늘 날짜의 기념일·공휴일·시즌 이벤트\n` +
        `- 요즘 한국에서 화제인 것 (스포츠, 신작 드라마/영화/음악, 축제, 밈 등 — 정치·사건사고는 피해)\n` +
        `- 제철 음식이나 이 시기 일상 소재\n\n` +
        `한국어로 5~8줄의 간결한 브리핑만 써줘. 대화 주제 후보가 될 만한 구체적 사실 위주로.`,
    },
  ],
});
const brief = textOf(research);
console.log('--- research brief ---\n' + brief + '\n');

// --- structured output schema (matches the app's Topic + MoodTip shape) ---
const moodTip = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opener: { type: 'string' },
    follow: { type: 'string' },
    caution: { type: 'string' },
  },
  required: ['opener', 'follow', 'caution'],
};
const topic = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'lowercase ascii slug, e.g. "vacation"' },
    cat: { type: 'string', enum: CATS },
    label: { type: 'string', description: '커버에 크게 들어갈 1~4글자 단어, 예: "휴가"' },
    color: { type: 'string', description: 'hex, e.g. #2d46b9' },
    title: { type: 'string' },
    desc: { type: 'string' },
    reason: { type: 'string', description: '왜 오늘 이 주제인지 (오늘 맥락 반영)' },
    questions: { type: 'array', items: { type: 'string' }, description: '시작 질문 정확히 3개' },
    tips: {
      type: 'object',
      additionalProperties: false,
      properties: { work: moodTip, friend: moodTip, date: moodTip },
      required: ['work', 'friend', 'date'],
    },
  },
  required: ['id', 'cat', 'label', 'color', 'title', 'desc', 'reason', 'questions', 'tips'],
};
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { topics: { type: 'array', items: topic } },
  required: ['topics'],
};

const gen = await client.messages.create({
  model: MODEL,
  max_tokens: 8000,
  output_config: { format: { type: 'json_schema', schema } },
  messages: [
    {
      role: 'user',
      content:
        `너는 "데일리 스몰토크" 앱의 오늘의 주제 5개를 만드는 에디터야. 오늘은 ${dateLabel}.\n\n` +
        `[오늘의 맥락 브리핑]\n${brief}\n\n` +
        `[요구사항]\n` +
        `- 주제 5개. 첫 번째는 위 브리핑에서 뽑은 "오늘 가장 시의성 있는" 주제. 나머지는 카테고리를 겹치지 않게 다양하게.\n` +
        `- 톤: 친근한 ~요체, 구체적, 살짝 위트. 정치·사건사고·민감 주제 금지.\n` +
        `- label: 커버에 크게 넣을 1~4글자 핵심 단어. color: 그 무드에 맞는 진한 hex.\n` +
        `- questions: 바로 쓸 수 있는 시작 질문 정확히 3개.\n` +
        `- tips: 각 상황(work=직장/동료, friend=친구/지인, date=소개팅/새 만남)마다 opener(첫 멘트, 예문 포함)/follow(이어가는 법)/caution(피할 것). date 팁에 상사·업무 얘기 금지.\n` +
        `- reason은 오늘 날짜·맥락을 실제로 반영할 것.\n` +
        `JSON만 출력.`,
    },
  ],
});

const raw = textOf(gen);
const data = JSON.parse(raw);
if (!Array.isArray(data.topics) || data.topics.length < 3) {
  throw new Error('generation produced too few topics');
}
// keep only topics with exactly 3 questions; clamp to 5
data.topics = data.topics.filter((t) => Array.isArray(t.questions) && t.questions.length === 3).slice(0, 5);
if (data.topics.length < 3) throw new Error('not enough valid topics after filtering');

const out = { date: isoDate, dateLabel, generatedAt: now.toISOString(), topics: data.topics };

mkdirSync('content/archive', { recursive: true });
// Served by GitHub Pages at /daily-smalltalk-support/today.json (Pages source = repo root).
writeFileSync('today.json', JSON.stringify(out, null, 2));
writeFileSync(`content/archive/${isoDate}.json`, JSON.stringify(out, null, 2));
console.log(`Wrote today.json (${out.topics.length} topics) for ${isoDate}`);
