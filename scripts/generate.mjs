// Daily Small Talk — content generator (low-cost).
// Runs daily at 09:00 KST (00:00 UTC) via GitHub Actions.
// Single Haiku call, no web search — seasonal/date awareness comes from the
// date + a light season hint, which keeps cost to roughly $1/month.
// Writes today.json (served via GitHub Pages) + an archive copy.
//
// Requires env: ANTHROPIC_API_KEY
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'node:fs';

const MODEL = 'claude-haiku-4-5'; // cheap + plenty for this task. Bump to claude-opus-4-8 for max quality.
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// --- date in KST (workflow fires at 00:00 UTC = 09:00 KST) ---
const now = new Date();
const kst = new Date(now.getTime() + 9 * 3600 * 1000);
const yyyy = kst.getUTCFullYear();
const month = kst.getUTCMonth() + 1;
const day = kst.getUTCDate();
const isoDate = `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const wd = kst.getUTCDay();
const dateLabel = `${month}월 ${day}일 ${weekdays[wd]}요일`;
const isWeekend = wd === 0 || wd === 6;

// Light Korean seasonal hint by month so the model is on-context without web search.
const SEASON = {
  1: '한겨울, 신정·설 준비, 붕어빵·귤·군고구마, 새해 다짐',
  2: '늦겨울~초봄, 설 연휴, 졸업·개학, 꽃샘추위',
  3: '초봄, 봄나들이·벚꽃 시작, 새 학기·입사, 미세먼지',
  4: '완연한 봄, 벚꽃·봄꽃, 나들이·소풍, 환절기',
  5: '늦봄~초여름, 어린이날·어버이날, 가정의 달, 나들이',
  6: '초여름, 장마 시작 전후, 여름 준비, 제철 참외·수박',
  7: '한여름, 장마·폭염, 초복·중복, 여름휴가 시즌, 냉면·삼계탕·수박',
  8: '한여름 절정, 말복·처서, 늦여름 휴가, 열대야, 물놀이',
  9: '초가을, 추석 전후, 선선한 날씨, 독서·산책, 전어·햇과일',
  10: '완연한 가을, 단풍·나들이, 환절기, 하늘·날씨 좋음',
  11: '늦가을~초겨울, 김장철, 첫추위, 수능, 붕어빵 시작',
  12: '한겨울, 연말·크리스마스, 송년회, 눈·귤·붕어빵, 한 해 마무리',
};

const moodTip = {
  type: 'object', additionalProperties: false,
  properties: { opener: { type: 'string' }, follow: { type: 'string' }, caution: { type: 'string' } },
  required: ['opener', 'follow', 'caution'],
};
const topic = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, cat: { type: 'string', enum: ['시즌', '날씨', '음식', '일상', '문화'] },
    label: { type: 'string' }, color: { type: 'string' }, title: { type: 'string' },
    desc: { type: 'string' }, reason: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
    tips: {
      type: 'object', additionalProperties: false,
      properties: { work: moodTip, friend: moodTip, date: moodTip },
      required: ['work', 'friend', 'date'],
    },
  },
  required: ['id', 'cat', 'label', 'color', 'title', 'desc', 'reason', 'questions', 'tips'],
};
const schema = {
  type: 'object', additionalProperties: false,
  properties: { topics: { type: 'array', items: topic } }, required: ['topics'],
};

const res = await client.messages.create({
  model: MODEL,
  max_tokens: 12000,
  output_config: { format: { type: 'json_schema', schema } },
  messages: [
    {
      role: 'user',
      content:
        `너는 "데일리 스몰토크" 앱의 오늘의 주제 5개를 만드는 에디터야.\n` +
        `오늘: ${dateLabel} (${isoDate}), 대한민국.\n` +
        `이 달의 계절/시즌 힌트: ${SEASON[month]}\n` +
        (isWeekend ? `오늘은 주말이야 — 주말/휴식 소재를 하나 넣어도 좋아.\n` : '') +
        `\n[요구사항]\n` +
        `- 주제 5개, 카테고리를 겹치지 않게 다양하게. 위 계절 힌트와 오늘 날짜(요일 포함)를 실제로 반영할 것.\n` +
        `- 톤: 친근한 ~요체, 구체적, 살짝 위트. 정치·사건사고·민감 주제 금지.\n` +
        `- label: 커버에 크게 넣을 1~4글자 핵심 단어. color: 그 무드에 맞는 진한 hex(예 #2e5c7a).\n` +
        `- questions: 바로 쓸 수 있는 시작 질문 정확히 3개.\n` +
        `- tips: 각 상황(work=직장/동료, friend=친구/지인, date=소개팅/새 만남)마다 opener(첫 멘트, 예문 포함)/follow(이어가는 법)/caution(피할 것). date 팁에 상사·업무 얘기 금지.\n` +
        `- reason은 오늘 날짜·계절 맥락을 실제로 반영.\n` +
        `JSON만 출력.`,
    },
  ],
});

const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
const data = JSON.parse(raw);
data.topics = (data.topics || []).filter((t) => Array.isArray(t.questions) && t.questions.length === 3).slice(0, 5);
if (data.topics.length < 3) throw new Error('not enough valid topics');

const out = { date: isoDate, dateLabel, generatedAt: now.toISOString(), topics: data.topics };
mkdirSync('content/archive', { recursive: true });
writeFileSync('today.json', JSON.stringify(out, null, 2));
writeFileSync(`content/archive/${isoDate}.json`, JSON.stringify(out, null, 2));
const u = res.usage;
console.log(`Wrote today.json (${out.topics.length} topics) for ${isoDate}`);
console.log(`tokens: in=${u.input_tokens} out=${u.output_tokens}`);
