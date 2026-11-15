// node --test scripts/cover-reports.test.mjs
// Checks for the pure cover helpers in cover-reports.mjs (generate.mjs has
// top-level side effects, so it is never imported here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  coverFileKey, coverBlocklist, isCoverBlocked, shippedCovers, groupCoverReports,
  handBlocklistKeys, loadHandBlocklist, mergeBlocklists, sensitiveProvenance,
  wikimediaThumb, judgeCandidates, coverFromVerdict, judgeStatus, mediaTitleCore,
  coverSlotsOf, applyCoverSlots, cleanRetryQueries, interleave, retryTargets, mergeRetryCover,
  parseCoverPool, loadCoverPool, poolMatches,
} from './cover-reports.mjs';

const EFTA_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/EFTA00000980_-_Wooden_closet_holds_several_winter_coats_hanging_on_hooks_with_folded_blankets_on_the_shelf_above.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail_unscaled';
const MELON = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/Les_melons_01.jpg/1280px-Les_melons_01.jpg?utm_source=commons.wikimedia.org';

test('provenance: the DOJ Epstein-files photo is rejected on each of its fields', () => {
  // Real metadata of the file that fronted the 2026-11-14 한파 card.
  const title = 'File:EFTA00000980 - Wooden closet holds several winter coats hanging on hooks with folded blankets on the shelf above.jpg';
  const desc = 'Part of Epstein Files released by the DOJ on December 19 2025';
  const cats = "Category:2019 FBI raid on Epstein's townhouse";
  const allCats = "Uploaded with pattypan|Media by the Federal Bureau of Investigation|2019 FBI raid on Epstein's townhouse";
  const artist = 'Federal Bureau of Investigation';
  const credit = 'https://www.justice.gov/epstein/doj-disclosures';
  assert.match(sensitiveProvenance(title, desc, cats, allCats, artist, credit), /Epstein/);
  assert.ok(sensitiveProvenance(title), 'EFTA id alone');
  assert.ok(sensitiveProvenance('', desc), 'description alone');
  assert.ok(sensitiveProvenance('', '', cats), 'category alone');
  assert.ok(sensitiveProvenance('', '', '', 'Media by the Federal Bureau of Investigation'), 'hidden category alone');
  assert.ok(sensitiveProvenance('', '', '', '', artist), 'author alone');
  assert.ok(sensitiveProvenance('', '', '', '', '', credit), 'credit alone');
});

test('provenance: ordinary photos pass', () => {
  assert.equal(sensitiveProvenance('File:Snowy street in Seoul (Unsplash).jpg', 'Snow falling on a street in Jongno, Seoul', 'Category:Snow in Seoul | Category:Images from Unsplash'), null);
  // The EFTA file's own description of the picture is harmless without its provenance.
  assert.equal(sensitiveProvenance('Wooden closet holds several winter coats hanging on hooks with folded blankets'), null);
  assert.equal(sensitiveProvenance('File:Police car in Gangnam.jpg', 'A patrol car parked on a street', 'Category:Police cars of South Korea'), null);
  assert.equal(sensitiveProvenance('File:Fire truck Seoul.jpg', '', 'Category:Fire engines'), null);
  assert.equal(sensitiveProvenance('File:Melon field.jpg', 'Dea and friends', 'Category:Melons'), null); // "Dea" is a name, not the agency
  assert.equal(sensitiveProvenance(), null);
});

test('provenance: evidence, disaster and atrocity sources are rejected', () => {
  for (const s of [
    'Crime scene tape at the house', 'Mugshot of the suspect', 'Evidence photo 12', 'Prisoners in the yard',
    'Holocaust memorial', 'Victims of the flood', 'Aftermath of the earthquake', 'Bombing of the city',
    'Autopsy room', 'DEA drug bust', 'Typhoon damage in Busan', 'Category:Disasters in Japan',
  ]) assert.ok(sensitiveProvenance(s), s);
});

test('hand blocklist: keys, missing / invalid file, merge with reader reports', () => {
  const keys = handBlocklistKeys({ files: [{ url: EFTA_THUMB, date: '2026-11-14', topic: '한파', reason: 'Epstein files' }, { url: '' }, 'https://example.org/x.jpg?a=1'] });
  assert.deepEqual([...keys].sort(), [coverFileKey(EFTA_THUMB), 'https://example.org/x.jpg'].sort());
  assert.equal(handBlocklistKeys(null).size, 0);

  const dir = mkdtempSync(join(tmpdir(), 'cover-bl-'));
  const missing = loadHandBlocklist(join(dir, 'nope.json'));
  assert.equal(missing.ok, true);
  assert.equal(missing.missing, true);
  assert.equal(missing.keys.size, 0);

  writeFileSync(join(dir, 'bad.json'), '{ files: [');
  const bad = loadHandBlocklist(join(dir, 'bad.json'));
  assert.equal(bad.ok, false);
  assert.equal(bad.keys.size, 0);

  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ files: [{ url: EFTA_THUMB, date: '2026-11-14', topic: '한파·대설 대응', reason: 'DOJ Epstein files' }] }));
  const ok = loadHandBlocklist(join(dir, 'ok.json'));
  assert.equal(ok.ok, true);
  assert.equal(ok.entries, 1);

  const reported = coverBlocklist([{ key: coverFileKey(MELON) }]);
  const merged = mergeBlocklists(reported, ok.keys);
  assert.equal(merged.size, 2);
  // Any URL shape of the same Commons file is blocked: original, 1280px thumb, 330px thumb.
  assert.ok(isCoverBlocked(merged, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/EFTA00000980_-_Wooden_closet_holds_several_winter_coats_hanging_on_hooks_with_folded_blankets_on_the_shelf_above.jpg/1280px-thumbnail.jpg'));
  assert.ok(isCoverBlocked(merged, 'https://upload.wikimedia.org/wikipedia/commons/5/59/Les_melons_01.jpg'));
  assert.ok(!isCoverBlocked(merged, 'https://upload.wikimedia.org/wikipedia/commons/1/15/Something_else.jpg'));
  assert.equal(reported.size, 1, 'merge does not mutate its inputs');
});

test('shippedCovers counts imageReplaced, so a report on the swapped-out photo still counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-arch-'));
  mkdirSync(join(dir, 'archive'));
  const NEW = 'https://upload.wikimedia.org/wikipedia/commons/1/11/Snow_in_Seoul.jpg';
  writeFileSync(join(dir, 'archive', '2026-11-14.json'), JSON.stringify({
    date: '2026-11-14',
    topics: [
      { title: '한파·대설 대응이 시작된대요', image: NEW, imageReplaced: [EFTA_THUMB, 42, null] },
      { title: 'AI가 부른 노래가 멜론 1위', image: MELON },
    ],
  }));
  const shipped = shippedCovers(join(dir, 'archive'));
  assert.ok(shipped.has(coverFileKey(NEW)));
  assert.ok(shipped.has(coverFileKey(EFTA_THUMB)), 'replaced URL counts as shipped');
  assert.equal(shipped.get(coverFileKey(EFTA_THUMB))[0].title, '한파·대설 대응이 시작된대요');

  const { groups, ignored } = groupCoverReports([
    { created_at: '2026-11-14T01:00:00Z', date: '2026-11-14', topic_title: 'x', image_url: EFTA_THUMB, note: '', install_id: 'a' },
    { created_at: '2026-11-14T01:05:00Z', date: '2026-11-14', topic_title: 'x', image_url: 'https://upload.wikimedia.org/wikipedia/commons/9/99/Never_shipped.jpg', install_id: 'b' },
  ], shipped);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, coverFileKey(EFTA_THUMB));
  assert.equal(ignored, 1);
});

test('wikimediaThumb: the 330px step for every Commons URL shape', () => {
  assert.equal(wikimediaThumb(MELON), 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/Les_melons_01.jpg/330px-Les_melons_01.jpg');
  assert.equal(
    wikimediaThumb(EFTA_THUMB),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a1/EFTA00000980_-_Wooden_closet_holds_several_winter_coats_hanging_on_hooks_with_folded_blankets_on_the_shelf_above.jpg/330px-EFTA00000980_-_Wooden_closet_holds_several_winter_coats_hanging_on_hooks_with_folded_blankets_on_the_shelf_above.jpg',
  );
  assert.equal(
    wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Name.tif/lossy-page1-1280px-Name.tif.jpg'),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Name.tif/lossy-page1-330px-Name.tif.jpg',
  );
  assert.equal(
    wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Long_name.jpg/1280px-thumbnail.jpg'),
    'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Long_name.jpg/330px-thumbnail.jpg',
  );
  assert.equal(wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/a/ab/Scan.tiff'), 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Scan.tiff/lossy-page1-330px-Scan.tiff.jpg');
  assert.equal(wikimediaThumb('https://upload.wikimedia.org/wikipedia/commons/a/ab/Doc.pdf'), null);
  assert.equal(wikimediaThumb('https://live.staticflickr.com/1/2_3_b.jpg'), null);
  assert.equal(wikimediaThumb('https://image.tmdb.org/t/p/original/abc.jpg'), null);
});

const WORDS = ['', 'Apple', 'Birch', 'Cedar', 'Daisy', 'Elm', 'Fern', 'Grove', 'Hazel', 'Iris'];
const C = (n, free, name = `${WORDS[n]} photo`) => ({ url: `https://upload.wikimedia.org/wikipedia/commons/0/0${n % 10}/${name.replace(/ /g, '_')}.jpg`, free, credit: free ? null : { author: `A${n}`, license: 'CC BY-SA 4.0' } });

test('judgeCandidates: today\'s picks first, then alternating free / attributed, distinct, capped', () => {
  const [a1, f1, a2, f2, f3, a3] = [C(1, false), C(2, true), C(3, false), C(4, true), C(5, true), C(6, false)];
  const pool = [a1, f1, a2, f2, f3, a3];
  const out = judgeCandidates([a1, f1], pool, { max: 4 });
  assert.deepEqual(out.map((c) => c.url), [a1, f1, f2, a2].map((c) => c.url));
  // Duplicates (another URL shape of the same file) are dropped.
  const dup = { ...f1, url: f1.url.replace('/commons/0/02/Birch_photo.jpg', '/commons/thumb/0/02/Birch_photo.jpg/1280px-Birch_photo.jpg') };
  assert.notEqual(dup.url, f1.url);
  assert.equal(judgeCandidates([a1, dup], pool, { max: 4 }).filter((c) => coverFileKey(c.url) === coverFileKey(f1.url)).length, 1);
  // Poster card: free only.
  assert.deepEqual(judgeCandidates([f1], pool, { max: 3, freeOnly: true }).map((c) => c.free), [true, true, true]);
  // Recently shown files go last; another card's pick never appears.
  const out2 = judgeCandidates([a1], pool, { max: 4, recent: new Set([f1.url]), exclude: new Set([coverFileKey(f2.url)]) });
  assert.ok(!out2.some((c) => c.url === f2.url));
  assert.equal(out2[1].url, f3.url);
  assert.deepEqual(judgeCandidates([], [], {}), []);
  // One upload series counts once while other choices are left.
  const s1 = C(7, true, 'Korea Viper 26 1 - V16 Training (1)');
  const s2 = C(8, true, 'Korea Viper 26 1 - V16 Training (2)');
  const s3 = C(9, true, 'Korea Viper 26 1 - V16 Training (3)');
  assert.deepEqual(judgeCandidates([s1], [s1, s2, s3, f2], { max: 3 }).map((c) => c.url), [s1, f2, s2].map((c) => c.url));
});

test('coverFromVerdict: fills both slots from the ranked fits, none → gradient', () => {
  const [a1, f1, a2, f2] = [C(1, false), C(2, true), C(3, false), C(4, true)];
  const shown = [a1, f1, a2, f2];
  assert.deepEqual(coverFromVerdict(shown, [1, 2]), { image: f1, attributed: a1 });
  assert.deepEqual(coverFromVerdict(shown, [4, 1]), { image: f2, attributed: null }, 'best fit is free → image carries it');
  assert.deepEqual(coverFromVerdict(shown, [3]), { image: null, attributed: a2 }, 'only an attributed photo fits');
  assert.deepEqual(coverFromVerdict(shown, []), { image: null, attributed: null }, 'nothing fits → gradient');
  assert.deepEqual(coverFromVerdict(shown, [9, 0, -1, 2.5, '2']), { image: null, attributed: null }, 'out-of-range / malformed indices ignored');
  assert.deepEqual(coverFromVerdict(shown, [2, 2, 1]), { image: f1, attributed: null });
  assert.deepEqual(coverFromVerdict([f1, f2], [2], { poster: true }), { image: f2, attributed: undefined });
  assert.deepEqual(coverFromVerdict([f1], [], { poster: true }), { image: null, attributed: undefined });
  assert.deepEqual(coverFromVerdict(shown, null), { image: null, attributed: null });
});

test('mediaTitleCore: 극장판 / the Movie markers off, the title itself untouched', () => {
  assert.equal(mediaTitleCore('극장판 치이카와'), '치이카와');
  assert.equal(mediaTitleCore('극장판 치이카와: 인어 섬의 비밀'), '치이카와: 인어 섬의 비밀');
  assert.equal(mediaTitleCore('Chiikawa the Movie'), 'Chiikawa');
  assert.equal(mediaTitleCore('Chiikawa the Movie: The Secret of the Mermaid Island'.slice(0, 'Chiikawa the Movie'.length)), 'Chiikawa');
  assert.equal(mediaTitleCore('劇場版 ちいかわ'), 'ちいかわ');
  assert.equal(mediaTitleCore('짱구는 못말려 극장판'), '짱구는 못말려');
  assert.equal(mediaTitleCore('극장판'), '극장판', 'never empties a title');
  assert.equal(mediaTitleCore('영화가 좋다'), '영화가 좋다');
  assert.equal(mediaTitleCore('Bee Movie'), 'Bee Movie', 'a bare "Movie" is part of the title');
  assert.equal(mediaTitleCore('치이카와'), '치이카와');
  assert.equal(mediaTitleCore(null), '');
});

test('judgeStatus: names what the visible cover did', () => {
  const P = 'https://image.tmdb.org/t/p/original/p.jpg';
  assert.equal(judgeStatus({ image: 'a', attributed: 'b' }, { image: 'a', attributed: 'b' }), 'kept');
  assert.equal(judgeStatus({ image: 'a', attributed: 'b' }, { image: undefined, attributed: undefined }), 'rejected');
  assert.equal(judgeStatus({ image: 'a', attributed: P }, { image: undefined, attributed: P }), 'kept (old-build photo dropped)', 'poster card');
  assert.equal(judgeStatus({ image: 'a', attributed: 'b' }, { image: 'c', attributed: 'b' }), 'kept (old-build photo changed)');
  assert.equal(judgeStatus({ image: 'a', attributed: 'b' }, { image: 'a', attributed: undefined }), 'changed');
  assert.equal(judgeStatus({ image: 'a' }, { image: 'c' }), 'changed');
});

// --- cover pool + judge round 2 ---------------------------------------------
// A small sample of content/cover-pool.json (same format as the real file).
const T = (name) => `https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/${name}/1280px-${name}`;
const SAMPLE_POOL = {
  note: 'test fixture',
  photos: [
    { url: T('Bungeoppang.jpg'), file: 'Bungeoppang.jpg', free: true, credit: null,
      tags: ['붕어빵', '길거리 간식', 'bungeoppang', 'street food'], desc: 'Fish-shaped pastries on a street stall grill in Seoul', added: '2026-11-15' },
    { url: T('Pajeon.jpg'), file: 'Pajeon.jpg', free: false,
      credit: { author: "Jane O'Neil", license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0' },
      tags: ['파전', '비 오는 날', '막걸리', 'pajeon', 'rain'], desc: 'Seafood pajeon with makgeolli', added: '2026-11-15' },
    { url: T('Goguma_street_vendor.jpg'), file: 'Goguma street vendor.jpg', free: true, credit: null,
      tags: ['군고구마', '길거리 간식', '겨울', 'sweet potato'], desc: 'Roasted sweet potatoes sold from a drum stove', added: '2026-11-15' },
    { url: T('Boiler_room_dial.jpg'), file: 'Boiler room dial.jpg', free: true, credit: null,
      tags: ['보일러', '난방', '비', 'heating'], desc: 'Korean home heating controller', added: '2026-11-15' },
    // Malformed: dropped at load.
    { url: T('No_credit.jpg'), file: 'No credit.jpg', free: false, credit: null, tags: ['파전'] },
    { url: 'http://example.org/insecure.jpg', free: true, tags: ['붕어빵'] },
    { url: T('No_tags.jpg'), free: true, tags: [] },
    { url: T('Bungeoppang.jpg').replace('1280px', '640px'), file: 'Bungeoppang.jpg', free: true, tags: ['붕어빵'] }, // same file again
    'not an object',
  ],
};

test('cover pool: load fail-soft, malformed entries dropped, tags normalised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cover-pool-'));
  const missing = loadCoverPool(join(dir, 'nope.json'));
  assert.deepEqual([missing.ok, missing.missing, missing.photos.length], [true, true, 0]);
  writeFileSync(join(dir, 'bad.json'), '{ "photos": [');
  const bad = loadCoverPool(join(dir, 'bad.json'));
  assert.equal(bad.ok, false);
  assert.equal(bad.photos.length, 0);
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ files: [] }));
  assert.equal(loadCoverPool(join(dir, 'shape.json')).ok, false);

  writeFileSync(join(dir, 'pool.json'), JSON.stringify(SAMPLE_POOL));
  const pool = loadCoverPool(join(dir, 'pool.json'));
  assert.equal(pool.ok, true);
  assert.deepEqual(pool.photos.map((p) => p.name), ['Bungeoppang.jpg', 'Pajeon.jpg', 'Goguma street vendor.jpg', 'Boiler room dial.jpg']);
  assert.equal(pool.dropped, 5);
  assert.ok(pool.photos.every((p) => p.pool === true));
  const pajeon = pool.photos[1];
  assert.equal(pajeon.free, false);
  assert.deepEqual(pajeon.credit, {
    author: "Jane O'Neil", license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Pajeon.jpg',
  }, 'credit kept as given, source page filled in');
  assert.equal(pool.photos[0].credit, null);
  // A one-syllable Korean tag would substring-match 비트코인 / 준비: dropped.
  assert.deepEqual(pool.photos[3].tags, ['보일러', '난방', 'heating']);
  assert.deepEqual(parseCoverPool(null), { photos: [], dropped: 0 });
});

test('cover pool: Korean substring + English word matching, scored, recent / blocked / taken skipped', () => {
  const { photos } = parseCoverPool(SAMPLE_POOL);
  const card = (title, desc, queries = []) => [title, desc, ...queries];
  // 2026-11-15's street-snack card: 붕어빵 inside "붕어빵 하나에", 군고구마 inside "군고구마까지".
  const snack = poolMatches(photos, { texts: card('겨울 길거리 간식, 요즘 뭐 사 드세요?', '붕어빵 하나에 군고구마까지 찾는 계절이에요.') });
  assert.deepEqual(snack.map((p) => p.name), ['Goguma street vendor.jpg', 'Bungeoppang.jpg'], '3 Korean hits beat 2; max 2');
  assert.deepEqual(snack[0].poolHits, ['군고구마', '길거리 간식', '겨울']);
  assert.equal(snack[0].poolScore, 6);
  // Spaces optional inside a Korean tag; an English tag matches a plural / -y form, not a longer word.
  assert.equal(poolMatches(photos, { texts: card('비오는 날엔 뭐 드세요?', '') })[0]?.name, 'Pajeon.jpg');
  // One English word is not enough on its own (score 1 < 2); two are; "rainbow" is not "rain".
  assert.equal(poolMatches(photos, { texts: card('', '', ['rainy street seoul']) }).length, 0);
  assert.equal(poolMatches(photos, { texts: card('', '', ['rainy street seoul', 'pajeon plate']) })[0]?.name, 'Pajeon.jpg');
  assert.equal(poolMatches(photos, { texts: card('', '', ['rainbow over hills', 'pajeon plate']) }).length, 0);
  assert.equal(poolMatches(photos, { texts: card('', '', ['korean street foods market']) })[0]?.name, 'Bungeoppang.jpg');
  // The dropped one-syllable tag no longer fires on 비트코인.
  assert.equal(poolMatches(photos, { texts: card('비트코인이 4.3% 내렸대요', '') }).length, 0);
  assert.deepEqual(poolMatches(photos, { texts: card('올겨울 보일러는 언제부터 돌리실 거예요?', '') }).map((p) => p.name), ['Boiler room dial.jpg', 'Goguma street vendor.jpg']);
  // Recently shown (any URL shape of the file, query string included), blocked, or taken → skipped.
  const bungeo = photos[0];
  const recentShape = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1a/Bungeoppang.jpg/1280px-Bungeoppang.jpg?utm_source=commons.wikimedia.org';
  const texts = card('붕어빵 철이에요', '');
  assert.equal(poolMatches(photos, { texts }).length, 1);
  assert.equal(poolMatches(photos, { texts, recent: new Set([recentShape]) }).length, 0, 'recent');
  assert.equal(poolMatches(photos, { texts, blocked: new Set([coverFileKey(bungeo.url)]) }).length, 0, 'blocked');
  assert.equal(poolMatches(photos, { texts, exclude: new Set([coverFileKey(bungeo.url)]) }).length, 0, 'taken by another card');
  // A poster card's spare slot takes free photos only.
  assert.equal(poolMatches(photos, { texts: card('파전에 막걸리', '') }).length, 1);
  assert.equal(poolMatches(photos, { texts: card('파전에 막걸리', ''), freeOnly: true }).length, 0);
  assert.deepEqual(poolMatches(photos, { texts: [] }), []);
  assert.deepEqual(poolMatches([], { texts }), []);
});

test('cover pool: a single sense-blind English word ("market" in "stock market") offers nothing', () => {
  // 2026-11-15 dry run: the SK하이닉스 card was shown a bungeoppang photo whose
  // only hit was its tag "market" — from the imageQuery "stock market chart screen".
  const { photos } = parseCoverPool({ photos: [
    { url: T('시장_2.jpg'), file: '시장_2.jpg', free: true, credit: null,
      tags: ['붕어빵', '시장', '재래시장', '붕어빵 굽기', '길거리 간식', '겨울 간식', '간식', 'bungeoppang', 'market', 'street food'] },
  ] });
  const hynix = ['SK하이닉스가 금요일에 3.0% 내렸다던데요', '종가는 121만 6천 원이고, 코스피도 1.0% 내렸어요.',
    'stock market chart screen', 'smartphone stock app', 'korean investor looking phone'];
  assert.deepEqual(poolMatches(photos, { texts: hynix }), []);
  // The same photo still reaches the card it is for.
  const m = poolMatches(photos, { texts: ['겨울 길거리 간식, 요즘 뭐 사 드세요?', '붕어빵 하나에 군고구마까지 찾는 계절이에요.'] });
  assert.equal(m[0]?.name, '시장_2.jpg');
  assert.ok(m[0].poolHits.includes('붕어빵'));
  // An English phrase tag counts like a Korean one.
  assert.equal(poolMatches(photos, { texts: ['', '', 'korean street food stall'] })[0]?.poolScore, 2);
});

test('provenance: Korean scandal / apology / crime / death file names are rejected; 사과 the fruit is not', () => {
  // The Wikidata P18 photo of 김윤석 the 2026-11-15 dry run picked for a film card.
  assert.ok(sensitiveProvenance('File:(TV10) 김윤석 무릎 담요 성희롱 발언 공개 사과 (영화 당신, 거기 있어줄래요 언론시사회) 김윤석 58s.jpg'));
  for (const s of [
    '배우 OOO 성추행 의혹 해명.jpg', '대국민 사과 기자회견.jpg', '사과문 발표하는 대표.jpg', '고개 숙여 사과하는 가수.jpg',
    '음주운전 논란 후 첫 공식석상.jpg', '학폭 의혹', '법정 출석하는 OOO.jpg', '검찰 압수수색 현장.jpg', '경찰 조사 출석.jpg',
    '구속 영장 심사.jpg', '교통사고 현장.jpg', '사고 현장 사진.jpg', '피해자 기자회견.jpg', '빈소 조문.jpg', '영결식.jpg',
    '이태원 참사 추모 공간.jpg', '화재 진압 중인 소방관.jpg', '마약 투약 혐의.jpg', '불법 도박 사이트.jpg', 'Category:재난',
    'Kim at a public apology over a scandal', 'sexual harassment allegations',
  ]) assert.ok(sensitiveProvenance(s), s);
  for (const s of [
    '사과 과수원.jpg', '사과.jpg', '빨간 사과 한 바구니.jpg', '사과나무 꽃.jpg', '청송 사과 축제.jpg', 'Apple fruit on a tree.jpg',
    '법정 공휴일 한글날 광화문.jpg', '경찰차 강남.jpg', '김윤석 언론시사회.jpg', '폭설 내린 기차역.jpg', '폭포 설악산.jpg',
    '부산 해운대 사진.jpg', '사고방식', '서울 시장 풍경.jpg', '붕어빵 노점.jpg',
  ]) assert.equal(sensitiveProvenance(s), null, s);
});

test('cleanRetryQueries: ≤2 plain, short, new queries', () => {
  assert.deepEqual(cleanRetryQueries(['bungeoppang street stall Seoul', 'Korean street food stall', 'third one']), ['bungeoppang street stall seoul', 'korean street food stall']);
  assert.deepEqual(
    cleanRetryQueries(['"Mississippi River" paddlewheel riverboat', 'intitle:riverboat -Nile OR cruise*'], { max: 2 }),
    ['mississippi river paddlewheel riverboat', 'riverboat nile or cruise'],
    'quotes, keywords, leading - and * stripped; lower-case so OR is a word',
  );
  assert.deepEqual(cleanRetryQueries(['붕어빵', '붕어빵 bungeoppang', 'Huế riverboat']), ['bungeoppang', 'hue riverboat'], 'Hangul dropped, diacritics folded');
  assert.deepEqual(cleanRetryQueries(['one two three four five six seven']), ['one two three four five']);
  assert.deepEqual(cleanRetryQueries(['on a', '', 42, null, 'TV', 'tv sofa']), ['tv sofa'], 'needs a keyword the relevance rule can use');
  assert.deepEqual(cleanRetryQueries(['Rainy street Seoul', 'rainy  street  seoul', 'umbrella seoul'], { skip: ['rainy street seoul'] }), ['umbrella seoul'], 'skips the queries the cascade already ran');
  assert.deepEqual(cleanRetryQueries(null), []);
  assert.deepEqual(cleanRetryQueries('bungeoppang'), []);
});

test('interleave: round-robin, uneven lengths', () => {
  assert.deepEqual(interleave([1, 2, 3], ['a'], [], null, ['x', 'y']), [1, 'a', 'x', 2, 'y', 3]);
  assert.deepEqual(interleave(), []);
});

test('retryTargets: photo-less cards first, then weak fits; posters and unanswered cards skipped; capped', () => {
  const v = { fits: [] };
  const cards = [
    { id: 'kept', verdict: { fits: [1] }, fits: [1], hasCover: true, retry: [] },
    { id: 'weak', verdict: { fits: [2] }, fits: [2], hasCover: true, retry: ['korea exchange seoul'] },
    { id: 'none-q', verdict: v, fits: [], hasCover: false, retry: ['bungeoppang'] },
    { id: 'none-pool', verdict: v, fits: [], hasCover: false, retry: [], poolCount: 1 },
    { id: 'none-nothing', verdict: v, fits: [], hasCover: false, retry: [], poolCount: 0 },
    { id: 'poster', poster: true, verdict: v, fits: [], hasCover: true, retry: ['tv drama'] },
    { id: 'unanswered', fits: [], hasCover: false, retry: ['x y z'] },
  ];
  const { picked, skipped } = retryTargets(cards);
  assert.deepEqual(picked.map((c) => [c.id, c.kind]), [['none-q', 'none'], ['none-pool', 'none'], ['weak', 'weak']]);
  assert.deepEqual(skipped, []);
  const capped = retryTargets(cards, { max: 2 });
  assert.deepEqual(capped.picked.map((c) => c.id), ['none-q', 'none-pool']);
  assert.deepEqual(capped.skipped.map((c) => c.id), ['weak']);
  assert.deepEqual(retryTargets(null), { picked: [], skipped: [] });
});

test('coverFromVerdict: a fresh search result beats a pool photo when both fit; the pool fills when it alone fits', () => {
  const { photos } = parseCoverPool(SAMPLE_POOL);
  const [poolFree, poolPaid] = photos;
  const [a1, f1] = [C(1, false), C(2, true)];
  const shown = [f1, a1, poolFree, poolPaid];
  assert.deepEqual(coverFromVerdict(shown, [3, 1]), { image: f1, attributed: null }, 'judge ranked the pool photo first; fresh wins');
  assert.deepEqual(coverFromVerdict(shown, [4, 2]), { image: null, attributed: a1 });
  assert.deepEqual(coverFromVerdict(shown, [3]), { image: poolFree, attributed: null }, 'free pool photo → image');
  assert.deepEqual(coverFromVerdict(shown, [4]), { image: null, attributed: poolPaid }, 'non-free pool photo → attributed');
  assert.deepEqual(coverFromVerdict(shown, [4, 3]), { image: poolFree, attributed: poolPaid }, 'judge order kept among pool photos');
});

test('round 2 merge: fills a photo-less card with the same field rules as round 1, never drops round 1', () => {
  const { photos } = parseCoverPool(SAMPLE_POOL);
  const [poolFree, poolPaid] = photos;
  const credit = { author: 'A9', license: 'CC BY 4.0' };
  const apply = (t, shown, fits) => {
    const m = mergeRetryCover(coverSlotsOf(t), coverFromVerdict(shown, fits));
    if (m.changed) applyCoverSlots(t, m);
    return { t, changed: m.changed };
  };

  // Rejected in round 1 (no fields) → a free pool photo fills `image` only.
  let r = apply({ id: 'bungeoppang' }, [poolFree], [1]);
  assert.equal(r.changed, true);
  assert.deepEqual(r.t, { id: 'bungeoppang', image: poolFree.url });
  // → a non-free pool photo fills imageAttributed + imageCredit with ITS credit.
  r = apply({ id: 'pajeon' }, [poolPaid], [1]);
  assert.deepEqual(r.t, { id: 'pajeon', imageAttributed: poolPaid.url, imageCredit: poolPaid.credit });
  assert.equal(r.t.imageCredit.author, "Jane O'Neil");
  // → nothing fits: still nothing (gradient), no stray fields.
  r = apply({ id: 'boiler' }, [poolFree], []);
  assert.deepEqual([r.changed, r.t], [false, { id: 'boiler' }]);

  // A weak round-1 cover is kept when round 2 finds nothing better…
  const weak = () => ({ id: 'hynix', image: 'https://upload.wikimedia.org/wikipedia/commons/a/ac/Old.jpg', imageAttributed: 'https://upload.wikimedia.org/wikipedia/commons/a/ad/Weak.jpg', imageCredit: credit });
  r = apply(weak(), [C(3, false), C(4, true)], []);
  assert.deepEqual([r.changed, r.t], [false, weak()]);
  // …replaced by a better attributed one (older builds keep round 1's free photo)…
  const better = C(3, false);
  r = apply(weak(), [better], [1]);
  assert.deepEqual(r.t, { ...weak(), imageAttributed: better.url, imageCredit: better.credit });
  // …or by a better free one, which then is the cover for every build.
  const betterFree = C(4, true);
  r = apply(weak(), [betterFree], [1]);
  assert.deepEqual(r.t, { id: 'hynix', image: betterFree.url });

  // applyCoverSlots: attributed only as a pair; a poster card's slot untouched.
  assert.deepEqual(applyCoverSlots({ image: 'x', imageAttributed: 'y', imageCredit: credit }, { image: null, attributed: { url: 'z' } }), {});
  const P = 'https://image.tmdb.org/t/p/original/p.jpg';
  assert.deepEqual(applyCoverSlots({ image: 'x', imageAttributed: P, imageCredit: credit }, { image: poolFree, attributed: undefined }, { poster: true }), { image: poolFree.url, imageAttributed: P, imageCredit: credit });
  assert.deepEqual(coverSlotsOf({}), { image: null, attributed: null });
});
