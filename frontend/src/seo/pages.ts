/** Indexable pages. Titles get " | FeePilot" appended by <Seo> unless `rawTitle` is set. */
export type SeoPage = {
  path: string;
  title: string;
  description: string;
  rawTitle?: boolean;
};

export const PAGES: SeoPage[] = [
  {
    path: '/',
    title: 'FeePilot: unstick a Bitcoin transaction',
    rawTitle: true,
    description:
      'Paste a stuck Bitcoin transaction. FeePilot compares replace-by-fee, child-pays-for-parent and waiting, then builds an unsigned PSBT for you to sign.',
  },
  {
    path: '/how-it-works',
    title: 'How FeePilot works',
    description:
      'From a stuck txid to a signed fix: FeePilot reads your node, recommends RBF, CPFP or waiting with the cost, and you sign in your own wallet.',
  },
  {
    path: '/safety',
    title: 'Safety and limits',
    description:
      'FeePilot never holds your keys and never broadcasts without your approval. What it checks, what it cannot promise, and why confirmation is never guaranteed.',
  },
];

/** The page entry for a path. Throws on a typo so a bad path fails the build, not production. */
export function pageFor(path: string): SeoPage {
  const page = PAGES.find((p) => p.path === path);
  if (!page) throw new Error(`No SEO entry for ${path} in src/seo/pages.ts`);
  return page;
}
