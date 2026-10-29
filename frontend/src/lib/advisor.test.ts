import { describe, it, expect } from 'vitest';
import {
  freshness,
  sourceLabel,
  ageSecs,
  formatAge,
  totalFee,
  advise,
  parseCacheEntry,
  toCacheEntry,
  DEFAULT_POLICY,
  type SnapshotLike,
} from './advisor';

const snap = (over: Partial<SnapshotLike> = {}): SnapshotLike => ({
  fetched_at: 1000,
  estimates: [
    { blocks: 2, sat_per_vb: 25, source: 'node' },
    { blocks: 6, sat_per_vb: 12.5, source: 'node' },
    { blocks: 144, sat_per_vb: 2, source: 'node' },
  ],
  ...over,
});

describe('advisor', () => {
  it('freshness follows simulated snapshot ages', () => {
    const s = snap();
    expect(freshness(s, 1000)).toBe('recent');
    expect(freshness(s, 1600)).toBe('recent'); // exactly the window
    expect(freshness(s, 1601)).toBe('past_window');
    expect(freshness(s, 4600)).toBe('past_window');
    expect(freshness(s, 4601)).toBe('very_stale');
    expect(freshness(null, 1000)).toBe('missing');
  });

  it('windows are configuration, not constants', () => {
    const tight = { recent_secs: 5, stale_secs: 10 };
    expect(freshness(snap(), 1006, tight)).toBe('past_window');
    expect(freshness(snap(), 1006, DEFAULT_POLICY)).toBe('recent');
  });

  it('a clock that ran backwards does not give a negative age', () => {
    expect(ageSecs(snap(), 900)).toBe(0);
  });

  it('age formatting', () => {
    expect(formatAge(2)).toBe('just now');
    expect(formatAge(45)).toBe('45 s');
    expect(formatAge(240)).toBe('4 min');
    expect(formatAge(7500)).toBe('2 h 5 min');
    expect(formatAge(3 * 86400)).toBe('3 d');
  });

  it('total fee is rate x size rounded up, or null when size is unknown', () => {
    expect(totalFee(12.5, 141)).toBe(1763);
    expect(totalFee(1, 141)).toBe(141);
    expect(totalFee(12.5, null)).toBeNull();
    expect(totalFee(12.5, 0)).toBeNull();
    expect(totalFee(null, 141)).toBeNull();
  });

  it('urgency picks the matching target', () => {
    const now = 1100;
    expect(
      advise({ snapshot: snap(), urgency: 'high', nowSecs: now }).rate,
    ).toBe(25);
    expect(
      advise({ snapshot: snap(), urgency: 'normal', nowSecs: now }).rate,
    ).toBe(12.5);
    expect(
      advise({ snapshot: snap(), urgency: 'low', nowSecs: now }).rate,
    ).toBe(2);
  });

  it('recent data gives good confidence and a total when the size is known', () => {
    const a = advise({
      snapshot: snap(),
      urgency: 'normal',
      vsize: 200,
      nowSecs: 1100,
    });
    expect(a.confidence).toBe('good');
    expect(a.total_sats).toBe(2500);
    expect(a.notes).toEqual([]);
  });

  it('unknown size says so instead of guessing a total', () => {
    const a = advise({ snapshot: snap(), urgency: 'normal', nowSecs: 1100 });
    expect(a.total_sats).toBeNull();
    expect(a.notes.join(' ')).toMatch(/size unknown/i);
  });

  it('stale data lowers confidence but does not change the rate', () => {
    const a = advise({
      snapshot: snap(),
      urgency: 'normal',
      nowSecs: 1000 + 7200,
    });
    expect(a.freshness).toBe('very_stale');
    expect(a.confidence).toBe('low');
    expect(a.rate).toBe(12.5);
    expect(a.notes.join(' ')).toMatch(/refresh/i);
  });

  it('high urgency with stale data is flagged', () => {
    const a = advise({
      snapshot: snap(),
      urgency: 'high',
      nowSecs: 1000 + 1200,
    });
    expect(a.freshness).toBe('past_window');
    expect(a.notes.join(' ')).toMatch(/high urgency/i);
    const normal = advise({
      snapshot: snap(),
      urgency: 'normal',
      nowSecs: 1000 + 1200,
    });
    expect(normal.notes.join(' ')).not.toMatch(/high urgency/i);
  });

  it('a fallback rate is labelled and never reads as a market estimate', () => {
    const s = snap({
      estimates: [{ blocks: 6, sat_per_vb: 20, source: 'fallback' }],
    });
    const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
    expect(a.source).toBe('fallback');
    expect(a.confidence).toBe('low');
    expect(a.notes.join(' ')).toMatch(/fallback/i);
  });

  it('missing snapshot or estimate yields no number', () => {
    const none = advise({ snapshot: null, urgency: 'normal', nowSecs: 5 });
    expect([none.rate, none.freshness, none.confidence]).toEqual([
      null,
      'missing',
      'none',
    ]);
    const gap = advise({
      snapshot: snap({
        estimates: [{ blocks: 6, sat_per_vb: null, source: 'unavailable' }],
      }),
      urgency: 'normal',
      nowSecs: 1001,
    });
    expect(gap.rate).toBeNull();
  });

  it('cache entries survive a round trip and reject garbage', () => {
    const entry = toCacheEntry({
      snapshot: snap(),
      policy: { recent_secs: 1, stale_secs: 2 },
    });
    expect(parseCacheEntry(JSON.stringify(entry))).toEqual(entry);
    expect(parseCacheEntry('not json')).toBeNull();
    expect(parseCacheEntry('{"snapshot":{"fetched_at":"x"}}')).toBeNull();
    expect(parseCacheEntry(null)).toBeNull();
    expect(toCacheEntry({ snapshot: null })).toBeNull();
    expect(
      parseCacheEntry(JSON.stringify({ snapshot: snap() }))?.policy,
    ).toEqual(DEFAULT_POLICY);
  });

  it('the clock offset is kept in the cache entry when valid', () => {
    const entry = toCacheEntry({ snapshot: snap() }, -42.5);
    expect(parseCacheEntry(JSON.stringify(entry))?.clockOffsetSecs).toBe(-42.5);
    expect(
      toCacheEntry({ snapshot: snap() }, Number.NaN)?.clockOffsetSecs,
    ).toBeUndefined();
  });

  it('a third-party estimate is named, capped at reduced confidence and flags approximation', () => {
    const s = snap({
      source: 'mempool.space',
      estimates: [
        { blocks: 6, sat_per_vb: 3, source: 'third_party', approximate: true },
      ],
    });
    const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
    expect(a.freshness).toBe('recent');
    expect(a.confidence).toBe('reduced');
    expect(a.approximate).toBe(true);
    const text = a.notes.join(' ');
    expect(text).toMatch(/mempool\.space/);
    expect(text).toMatch(/not from your own node/i);
    expect(text).toMatch(/nearest level/i);
  });

  it('an exact third-party estimate is not flagged approximate; stale stays low', () => {
    const s = snap({
      source: 'esplora',
      estimates: [
        { blocks: 6, sat_per_vb: 3, source: 'third_party', approximate: false },
      ],
    });
    const a = advise({ snapshot: s, urgency: 'normal', nowSecs: 1001 });
    expect(a.approximate).toBe(false);
    expect(a.notes.join(' ')).not.toMatch(/nearest level/i);
    expect(
      advise({ snapshot: s, urgency: 'normal', nowSecs: 1000 + 7200 })
        .confidence,
    ).toBe('low');
  });

  it('source labels', () => {
    expect(sourceLabel({ source: 'node' })).toBe('node');
    expect(sourceLabel({ source: 'third_party', approximate: true })).toBe(
      'third party (approximate)',
    );
    expect(sourceLabel({ source: 'unavailable' })).toBe('none');
    expect(sourceLabel({ source: 'fallback' })).toBe('fallback rate');
  });
});
