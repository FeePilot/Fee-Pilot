import { describe, expect, it } from 'vitest';
import { canonicalUrl } from './Seo';

describe('canonicalUrl', () => {
  it('ends every non-root path in a slash, matching the static server', () => {
    expect(canonicalUrl('https://x.test', '/safety')).toBe(
      'https://x.test/safety/',
    );
    expect(canonicalUrl('https://x.test', '/safety/')).toBe(
      'https://x.test/safety/',
    );
    expect(canonicalUrl('https://x.test', '/how-it-works')).toBe(
      'https://x.test/how-it-works/',
    );
  });

  it('uses the bare origin with a slash for the home page', () => {
    expect(canonicalUrl('https://x.test', '/')).toBe('https://x.test/');
    expect(canonicalUrl('https://x.test', '')).toBe('https://x.test/');
  });
});
