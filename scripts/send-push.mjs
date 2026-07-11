// Daily 9am push sender.
//
// Reads registered device tokens from Supabase + today's headline topic from
// the freshly generated today.json, then sends one push per device through the
// Expo Push API (https://docs.expo.dev/push-notifications/sending-notifications/).
//
// Env (set as GitHub Actions secrets):
//   SUPABASE_URL              e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY service_role key (server-side only, bypasses RLS)
//
// No Apple credentials here: Expo's push service holds the APNs key and does
// the actual APNs delivery.

import { readFileSync } from 'node:fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  // Not configured yet — exit cleanly so the scheduled run isn't a red failure.
  console.log('Supabase secrets not set; push sender is inactive (no-op).');
  process.exit(0);
}

// Weekend rule mirrors the app: KST day-of-week decides whether weekend-off
// devices are skipped. 0=Sun … 6=Sat.
const kst = new Date(Date.now() + 9 * 3600 * 1000);
const isWeekend = kst.getUTCDay() === 0 || kst.getUTCDay() === 6;

// Today's headline (first card) drives the notification body.
let headline = '오늘의 스몰토크 주제가 도착했어요';
try {
  const today = JSON.parse(readFileSync('today.json', 'utf8'));
  const first = today.topics?.[0];
  if (first?.title) headline = String(first.title).replace(/\n/g, ' ');
} catch (e) {
  console.log('could not read today.json, using default headline:', e.message);
}

async function fetchTokens() {
  const cols = 'token,weekend';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/push_tokens?select=${cols}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase read ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sendChunk(messages) {
  const r = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate' },
    body: JSON.stringify(messages),
  });
  const body = await r.json().catch(() => null);
  return body?.data ?? [];
}

// Expo returns per-message receipts; DeviceNotRegistered means the user
// uninstalled — prune those so the table doesn't grow stale.
async function pruneTokens(tokens) {
  if (!tokens.length) return;
  const inList = tokens.map((t) => `"${t}"`).join(',');
  await fetch(`${SUPABASE_URL}/rest/v1/push_tokens?token=in.(${encodeURIComponent(inList)})`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

const rows = await fetchTokens();
const recipients = rows.filter((row) => row.weekend || !isWeekend);
console.log(`tokens=${rows.length} weekend=${isWeekend} recipients=${recipients.length}`);

const messages = recipients.map((row) => ({
  to: row.token,
  title: '오늘의 스몰토크 ☀️',
  body: headline,
  sound: 'default',
}));

const dead = [];
for (let i = 0; i < messages.length; i += 100) {
  const chunk = messages.slice(i, i + 100);
  const receipts = await sendChunk(chunk);
  receipts.forEach((rec, j) => {
    if (rec.status === 'error') {
      console.log('push error:', rec.message, rec.details?.error);
      if (rec.details?.error === 'DeviceNotRegistered') dead.push(chunk[j].to);
    }
  });
}
await pruneTokens(dead);
console.log(`sent=${messages.length - dead.length} pruned=${dead.length} headline="${headline}"`);
