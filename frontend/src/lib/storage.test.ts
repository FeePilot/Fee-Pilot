import { afterEach, describe, expect, it, vi } from 'vitest';
import { readItem, removeItem, writeItem } from './storage';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('storage', () => {
  it('round-trips and removes values', () => {
    expect(writeItem('k', 'v')).toBe(true);
    expect(readItem('k')).toBe('v');
    removeItem('k');
    expect(readItem('k')).toBeNull();
  });

  it('never throws when storage is blocked or full', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readItem('k')).toBeNull();
    expect(writeItem('k', 'v')).toBe(false);
    expect(() => removeItem('k')).not.toThrow();
  });
});
