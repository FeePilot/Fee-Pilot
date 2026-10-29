import { renderToString } from 'react-dom/server';
import type { HelmetServerState } from 'react-helmet-async';
import { StaticRouter } from 'react-router';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from './routes';

/** Render one route to HTML for prerendering. Used by `scripts/prerender.mjs` at build time. */
export function render(url: string): {
  html: string;
  helmet: HelmetServerState | undefined;
} {
  const helmetContext: { helmet?: HelmetServerState } = {};
  const html = renderToString(
    <AppProviders helmetContext={helmetContext}>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </AppProviders>,
  );
  return { html, helmet: helmetContext.helmet };
}

/** Pages to prerender with their title and description. Read by `scripts/prerender.mjs`. */
export { PAGES } from '@/seo/pages';
