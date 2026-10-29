import { describe, it, expect } from 'vitest';
import { formatAge, formatRate, formatSats, isTxid, shortId } from './format';

describe('format', () => {
  it('formats sats with grouping and a dash for unknown', () => {
    expect(formatSats(12345)).toBe('12,345');
    expect(formatSats(null)).toBe('–');
    expect(formatSats(undefined)).toBe('–');
  });
  it('formats rates', () => {
    expect(formatRate(1.234)).toBe('1.2');
    expect(formatRate(250.4)).toBe('250');
    expect(formatRate(null)).toBe('–');
    expect(formatRate(Number.NaN)).toBe('–');
  });
  it('formats ages', () => {
    expect(formatAge(2)).toBe('just now');
    expect(formatAge(45)).toBe('45 s');
    expect(formatAge(240)).toBe('4 min');
    expect(formatAge(7500)).toBe('2 h 5 min');
    expect(formatAge(7200)).toBe('2 h');
    expect(formatAge(3 * 86400)).toBe('3 d');
  });
  it('shortens long ids only', () => {
    expect(shortId('a'.repeat(64))).toBe(`${'a'.repeat(10)}…${'a'.repeat(8)}`);
    expect(shortId('short')).toBe('short');
    expect(shortId(null)).toBe('');
  });
  it('validates txids', () => {
    expect(isTxid('a'.repeat(64))).toBe(true);
    expect(isTxid('xyz')).toBe(false);
  });
});
