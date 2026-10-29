import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freshness, sourceLabel, ageSecs, formatAge, totalFee, advise, parseCacheEntry, toCacheEntry, DEFAULT_POLICY,
} from './advisor.js';

const snap = (over = {}) => ({
  fetched_at: 1000,
  estimates: [
    { blocks: 2, sat_per_vb: 25, source: 'node' },
    { blocks: 6, sat_per_vb: 12.5, source: 'node' },
    { blocks: 144, sat_per_vb: 2, source: 'node' },
  ],
  ...over,
});

test('freshness follows simulated snapshot ages', () => {
  const s = snap();
  assert.equal(freshness(s, 1000), 'recent');
  assert.equal(freshness(s, 1600), 'recent'); // exactly the window
  assert.equal(freshness(s, 1601), 'past_window');
  assert.equal(freshness(s, 4600), 'past_window');
  assert.equal(freshness(s, 4601), 'very_stale');
  assert.equal(freshness(null, 1000), 'missing');
});

test('windows are configuration, not constants', () => {
  const tight = { recent_secs: 5, stale_secs: 10 };
  assert.equal(freshness(snap(), 1006, tight), 'past_window');
  assert.equal(freshness(snap(), 1006, DEFAULT_POLICY), 'recent');
});

test('a clock that ran backwards does not give a negative age', () => {
  assert.equal(ageSecs(snap(), 900), 0);
});

test('age formatting', () => {
  assert.equal(formatAge(2), 'just now');
  assert.equal(formatAge(45), '45 s');
  assert.equal(formatAge(240), '4 min');
  assert.equal(formatAge(7500), '2 h 5 min');
  assert.equal(formatAge(3 * 86400), '3 d');
});

test('total fee is rate x size rounded up, or null when size is unknown', () => {
  assert.equal(totalFee(12.5, 141), 1763);
  assert.equal(totalFee(1, 141), 141);
  assert.equal(totalFee(12.5, null), null);
  assert.equal(totalFee(12.5, 0), null);
  assert.equal(totalFee(null, 141), null);
});

test('urgency picks the matching target', () => {
  const now = 1100;
  assert.equal(advise({ snapshot: snap(), urgency: 'high', nowSecs: now }).rate, 25);
  assert.equal(advise({ snapshot: snap(), urgency: 'normal', nowSecs: now }).rate, 12.5);
  assert.equal(advise({ snapshot: snap(), urgency: 'low', nowSecs: now }).rate, 2);
});

test('recent data gives good confidence and a total when the size is known', () => {
  const a = advise({ snapshot: snap(), urgency: 'normal', vsize: 200, nowSecs: 1100 });
  assert.equal(a.confidence, 'good');
  assert.equal(a.total_sats, 2500);
  assert.deepEqual(a.notes, []);
});

test('unknown size says so instead of guessing a total', () => {
  const a = advise({ snapshot: snap(), urgency: 'normal', nowSecs: 1100 });
  assert.equal(a.total_sats, null);
  assert.match(a.notes.join(' '), /size unknown/i);
});

test('stale data lowers confidence but does not change the rate', () => {
  const a = advise({ snapshot: snap(), urgency: 'normal', nowSecs: 1000 + 7200 });
  assert.equal(a.freshness, 'very_stale');
  assert.equal(a.confidence, 'low');
  assert.equal(a.rate, 12.5);
  assert.match(a.notes.join(' '), /refresh/i);
});

test('high urgency with stale data is flagged', () => {
  const a = advise({ snapshot: snap(), urgency: 'high', nowSecs: 1000 + 1200 });
  assert.equal(a.freshness, 'past_window');
  assert.match(a.notes.join(' '), /high urgency/i);
  const normal = advise({ snapshot: snap(), urgency: 'normal', nowSecs: 1000 + 1200 });
  assert.doesNotMatch(normal.notes.join(' '), /high urgency/i);
});

test('a fallback rate is labelled and never reads as a market estimate', () => {
  const s = snap({ estimates: [{ blocks: 6, sat_per_vb: 20, source: 'fallback' }] });
  const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
  assert.equal(a.source, 'fallback');
  assert.equal(a.confidence, 'low');
  assert.match(a.notes.join(' '), /fallback/i);
});

test('missing snapshot or estimate yields no number', () => {
  const none = advise({ snapshot: null, urgency: 'normal', nowSecs: 5 });
  assert.deepEqual([none.rate, none.freshness, none.confidence], [null, 'missing', 'none']);
  const gap = advise({
    snapshot: snap({ estimates: [{ blocks: 6, sat_per_vb: null, source: 'unavailable' }] }),
    urgency: 'normal', nowSecs: 1001,
  });
  assert.equal(gap.rate, null);
});

test('cache entries survive a round trip and reject garbage', () => {
  const entry = toCacheEntry({ snapshot: snap(), policy: { recent_secs: 1, stale_secs: 2 } });
  assert.deepEqual(parseCacheEntry(JSON.stringify(entry)), entry);
  assert.equal(parseCacheEntry('not json'), null);
  assert.equal(parseCacheEntry('{"snapshot":{"fetched_at":"x"}}'), null);
  assert.equal(toCacheEntry({ snapshot: null }), null);
  assert.deepEqual(parseCacheEntry(JSON.stringify({ snapshot: snap() })).policy, DEFAULT_POLICY);
});

test('a third-party estimate is named, capped at reduced confidence and flags approximation', () => {
  const s = snap({
    source: 'mempool.space',
    estimates: [{ blocks: 6, sat_per_vb: 3, source: 'third_party', approximate: true }],
  });
  const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
  assert.equal(a.freshness, 'recent');
  assert.equal(a.confidence, 'reduced', 'recent data from a third party is still not "good"');
  assert.equal(a.approximate, true);
  const text = a.notes.join(' ');
  assert.match(text, /mempool\.space/);
  assert.match(text, /not from your own node/i);
  assert.match(text, /nearest level/i);
});

test('an exact third-party estimate is not flagged approximate; stale stays low', () => {
  const s = snap({ source: 'esplora', estimates: [{ blocks: 6, sat_per_vb: 3, source: 'third_party', approximate: false }] });
  const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
  assert.equal(a.approximate, false);
  assert.doesNotMatch(a.notes.join(' '), /nearest level/i);
  assert.equal(advise({ snapshot: s, urgency: 'normal', nowSecs: 1000 + 7200 }).confidence, 'low');
});

test('source labels', () => {
  assert.equal(sourceLabel({ source: 'node' }), 'node');
  assert.equal(sourceLabel({ source: 'third_party', approximate: true }), 'third party (approximate)');
  assert.equal(sourceLabel({ source: 'unavailable' }), 'none');
  assert.equal(sourceLabel({ source: 'fallback' }), 'fallback rate');
});
