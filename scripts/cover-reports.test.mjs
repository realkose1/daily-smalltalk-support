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
