import { describe, expect, it } from 'vitest';
import { faqLd, softwareApplicationLd } from './jsonld';
import { PAGES } from './pages';
import { jsonLdString } from './Seo';

describe('PAGES', () => {
  it('covers the three indexable routes', () => {
    expect(PAGES.map((p) => p.path)).toEqual(['/', '/how-it-works', '/safety']);
  });
  it('has unique titles and descriptions', () => {
    expect(new Set(PAGES.map((p) => p.title)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.description)).size).toBe(PAGES.length);
  });
  it('keeps descriptions within 160 characters and titles within 70 with the site name', () => {
    for (const p of PAGES) {
      expect(p.description.length).toBeGreaterThan(50);
      expect(p.description.length).toBeLessThanOrEqual(160);
      const full = p.rawTitle ? p.title : `${p.title} | FeePilot`;
      expect(full.length).toBeLessThanOrEqual(70);
    }
  });
  it('makes no guarantee claims', () => {
    for (const p of PAGES)
      expect(`${p.title} ${p.description}`).not.toMatch(
        /guarantee(d|s)? (to )?confirm|instant|always confirm/i,
      );
  });
});

describe('jsonld', () => {
  it('builds a FAQPage with one Question per item', () => {
    const ld = faqLd([
      { q: 'Q1?', a: 'A1' },
      { q: 'Q2?', a: 'A2' },
    ]) as {
      '@type': string;
      mainEntity: {
        '@type': string;
        name: string;
        acceptedAnswer: { '@type': string; text: string };
      }[];
    };
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity).toHaveLength(2);
    expect(ld.mainEntity[0]).toEqual({
      '@type': 'Question',
      name: 'Q1?',
      acceptedAnswer: { '@type': 'Answer', text: 'A1' },
    });
  });
  it('describes the app without ratings or prices', () => {
    const ld = softwareApplicationLd() as Record<string, unknown>;
    expect(ld['@type']).toBe('SoftwareApplication');
    expect(ld).not.toHaveProperty('aggregateRating');
    expect(ld).not.toHaveProperty('offers');
  });
});

describe('jsonLdString', () => {
  it('escapes < so a value cannot close the script tag', () => {
    const s = jsonLdString({ a: '</script><script>alert(1)</script>' });
    expect(s).not.toContain('<');
    expect(JSON.parse(s)).toEqual({ a: '</script><script>alert(1)</script>' });
  });
});
