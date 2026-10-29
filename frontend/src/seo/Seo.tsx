import { Helmet } from 'react-helmet-async';

export const SITE_NAME = 'FeePilot';

/**
 * The public origin, e.g. `https://feepilot.example`, set at build time with VITE_SITE_URL.
 * Without it, tags that need an absolute URL (canonical, og:url, og:image, sitemap) are left out
 * instead of pointing at a made-up domain.
 */
const rawSiteUrl =
  (import.meta.env.VITE_SITE_URL as string | undefined)?.replace(/\/$/, '') ??
  '';
export const SITE_URL: string | undefined =
  rawSiteUrl === '' ? undefined : rawSiteUrl;

/**
 * The static server serves `/safety/index.html` and redirects `/safety` to `/safety/`, so the
 * canonical form of every non-root path ends in a slash. The sitemap uses the same form.
 */
export function canonicalUrl(origin: string, path: string): string {
  const clean = path.replace(/\/+$/, '');
  return clean === '' ? `${origin}/` : `${origin}${clean}/`;
}

/** JSON-LD goes inside a <script>, so `<` must never appear raw or a value could close the tag. */
export function jsonLdString(data: object | object[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export type SeoProps = {
  /** Page title without the site name; the site name is appended. */
  title: string;
  description: string;
  /** Route path, e.g. `/safety`. Used for the canonical URL. */
  path: string;
  /** Keeps the page out of search results. Always set for app and user-specific pages. */
  noindex?: boolean;
  /** Use the title as is, without " | FeePilot" (the home page). */
  rawTitle?: boolean;
  /** Structured data to embed. */
  jsonLd?: object | object[];
};

export function Seo({
  title,
  description,
  path,
  noindex = false,
  rawTitle = false,
  jsonLd,
}: SeoProps) {
  const fullTitle = rawTitle ? title : `${title} | ${SITE_NAME}`;
  const url = SITE_URL ? canonicalUrl(SITE_URL, path) : undefined;
  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta
        name="robots"
        content={noindex ? 'noindex, nofollow' : 'index, follow'}
      />
      {url && !noindex ? <link rel="canonical" href={url} /> : null}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      {url && !noindex ? <meta property="og:url" content={url} /> : null}
      {SITE_URL && !noindex ? (
        <meta property="og:image" content={`${SITE_URL}/og.png`} />
      ) : null}
      <meta
        name="twitter:card"
        content={SITE_URL && !noindex ? 'summary_large_image' : 'summary'}
      />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
      {SITE_URL && !noindex ? (
        <meta name="twitter:image" content={`${SITE_URL}/og.png`} />
      ) : null}
      <meta name="theme-color" content="#0a0a0c" />
      {jsonLd ? (
        <script type="application/ld+json">{jsonLdString(jsonLd)}</script>
      ) : null}
    </Helmet>
  );
}
