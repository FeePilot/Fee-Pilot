import { SITE_NAME, SITE_URL } from './Seo';

/** schema.org SoftwareApplication for the home page. Makes no claims about ratings or pricing. */
export function softwareApplicationLd(): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Any (web)',
    description:
      'Unstick a Bitcoin transaction. FeePilot compares replace-by-fee, child-pays-for-parent and waiting, and builds an unsigned PSBT you sign in your own wallet.',
    ...(SITE_URL ? { url: SITE_URL } : {}),
  };
}

export type Faq = { q: string; a: string };

/** schema.org FAQPage. The text must match what the page shows, so build it from the same data. */
export function faqLd(items: Faq[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a },
    })),
  };
}
