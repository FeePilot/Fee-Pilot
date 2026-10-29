// Prerenders the marketing pages from the SSR bundle into the client build (dist/).
// Run after: vite build && vite build --ssr src/entry-server.tsx --outDir dist-ssr
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ssrDir = join(root, 'dist-ssr');
// Same source as the client build: the process environment first, then the repository's .env.
const env = loadEnv('production', resolve(root, '..'), 'VITE_');
const siteUrl = (process.env.VITE_SITE_URL ?? env.VITE_SITE_URL ?? '')
  .trim()
  .replace(/\/$/, '');

const problems = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => console.warn(`prerender: WARNING ${msg}`);

async function loadBundle() {
  for (const name of ['entry-server.js', 'entry-server.mjs']) {
    try {
      return await import(pathToFileURL(join(ssrDir, name)).href);
    } catch (e) {
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    }
  }
  throw new Error(
    `SSR bundle not found in ${ssrDir}; run "vite build --ssr src/entry-server.tsx --outDir dist-ssr" first`,
  );
}

const escapeHtml = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Remove tags from the template that the page's own head will supply, so none appear twice. */
function stripDuplicates(head) {
  return head
    .replace(/<title[\s\S]*?<\/title>\s*/gi, '')
    .replace(/<meta\s+name="(?:description|robots)"[^>]*>\s*/gi, '');
}

function helmetHead(helmet) {
  if (!helmet) return '';
  return ['title', 'priority', 'meta', 'link', 'script', 'style']
    .map((k) => helmet[k]?.toString() ?? '')
    .join('');
}

function build(template, html, headExtra) {
  const touch = template.includes('apple-touch-icon')
    ? ''
    : '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  const withHead = stripDuplicates(template).replace(
    '</head>',
    `${touch}${headExtra}</head>`,
  );
  if (!withHead.includes('<div id="root"></div>'))
    throw new Error('template has no empty <div id="root"></div>');
  return withHead.replace(
    '<div id="root"></div>',
    `<div id="root">${html}</div>`,
  );
}

function ensureNoindex(headExtra) {
  const h = headExtra
    .replace(/<meta[^>]*name="robots"[^>]*>/gi, '')
    .replace(/<link[^>]*rel="canonical"[^>]*>/gi, '');
  return `${h}<meta name="robots" content="noindex, nofollow" data-rh="true">`;
}

function check(label, out, { expectIndexable }) {
  const m = out.match(/<div id="root">([\s\S]*)<\/div>\s*(?:<script|<\/body>)/);
  if (!m || m[1].trim().length < 50) fail(`${label}: rendered #root is empty`);
  const titles = out.match(/<title[\s>]/g) ?? [];
  if (titles.length !== 1)
    fail(`${label}: expected 1 <title>, found ${titles.length}`);
  else if (!/<title[^>]*>[^<]+<\/title>/.test(out))
    fail(`${label}: <title> is empty`);
  const descs = out.match(/<meta[^>]*name="description"[^>]*>/g) ?? [];
  if (expectIndexable) {
    if (descs.length !== 1)
      fail(`${label}: expected 1 meta description, found ${descs.length}`);
    else if (!/content="[^"]{20,}"/.test(descs[0]))
      fail(`${label}: meta description is empty or too short`);
    if (!/<h1[\s>]/.test(out)) fail(`${label}: no <h1>`);
    if (/name="robots"[^>]*noindex/.test(out))
      fail(`${label}: indexable page is marked noindex`);
  } else if (!/name="robots"[^>]*noindex/.test(out))
    fail(`${label}: should be noindex`);
  if ((out.match(/<meta[^>]*name="robots"/g) ?? []).length > 1)
    fail(`${label}: duplicate robots meta`);
}

const bundle = await loadBundle();
const { render, PAGES } = bundle;
if (!Array.isArray(PAGES) || PAGES.length === 0)
  throw new Error('entry-server must export PAGES');
// dist/index.html is overwritten below, so keep the pristine client template next to the SSR bundle
// and reuse it when this script is run again without rebuilding.
const templateCopy = join(ssrDir, 'index.template.html');
let template = await readFile(join(dist, 'index.html'), 'utf8');
if (template.includes('<div id="root"></div>'))
  await writeFile(templateCopy, template);
else template = await readFile(templateCopy, 'utf8');

async function write(rel, content) {
  const file = join(dist, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  console.log(`prerender: wrote dist/${rel} (${content.length} bytes)`);
}

for (const page of PAGES) {
  const { html, helmet } = render(page.path);
  const out = build(template, html, helmetHead(helmet));
  check(page.path, out, { expectIndexable: true });
  const title = out.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? '';
  const desc =
    out.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)?.[1] ?? '';
  if (
    page.rawTitle
      ? !title.includes(escapeHtml(page.title))
      : !title.startsWith(escapeHtml(page.title))
  ) {
    warn(
      `${page.path}: rendered title "${title}" differs from src/seo/pages.ts (the page should import PAGES)`,
    );
  }
  if (desc !== escapeHtml(page.description))
    warn(
      `${page.path}: rendered description differs from src/seo/pages.ts (the page should import PAGES)`,
    );
  if (desc.length > 160)
    warn(
      `${page.path}: description is ${desc.length} chars; search engines cut it near 160`,
    );
  await write(
    page.path === '/'
      ? 'index.html'
      : `${page.path.replace(/^\//, '')}/index.html`,
    out,
  );
}

// 404: render a path that matches no route so NotFound shows. Always noindex.
{
  const { html, helmet } = render('/__not-found__');
  const out = build(template, html, ensureNoindex(helmetHead(helmet)));
  check('404', out, { expectIndexable: false });
  await write('404.html', out);
}

// App shell: the empty client template, used by the service worker for /app/* navigations offline.
{
  const head =
    '<title>FeePilot app</title><meta name="robots" content="noindex, nofollow">';
  await write('app-shell.html', build(template, '', head));
}

// robots.txt always; sitemap only with an absolute site URL.
const robots = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /app/',
  'Disallow: /v1/',
  'Disallow: /v2/',
];
if (siteUrl) {
  if (!/^https?:\/\/[^/\s]+/.test(siteUrl))
    throw new Error(
      `VITE_SITE_URL must be absolute (https://...), got "${siteUrl}"`,
    );
  robots.push('', `Sitemap: ${siteUrl}/sitemap.xml`);
  const urls = PAGES.map(
    (p) =>
      `  <url><loc>${escapeHtml(siteUrl + (p.path === '/' ? '/' : `${p.path.replace(/\/+$/, '')}/`))}</loc></url>`,
  ).join('\n');
  await write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
} else {
  console.warn(
    'prerender: WARNING VITE_SITE_URL is not set: no sitemap.xml, canonical, og:url or og:image were produced. Set it (e.g. https://your-domain) for a production build.',
  );
}
await write('robots.txt', robots.join('\n') + '\n');

if (problems.length) {
  console.error('\nprerender FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('prerender: ok');
