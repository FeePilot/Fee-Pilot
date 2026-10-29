// Renders public/og.png and the PWA icons with the system Chrome. Run: node scripts/make-og.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
const tmp = mkdtempSync(join(tmpdir(), 'feepilot-og-'));
const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
const svgUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

function shot(html, out, w, h, scale = 1) {
  const file = join(tmp, `${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--screenshot=${out}`,
      `--window-size=${w},${h}`,
      `--force-device-scale-factor=${scale}`,
      `file://${file}`,
    ],
    { stdio: 'pipe' },
  );
  console.log(`make-og: wrote ${out.replace(root + '/', '')}`);
}

const og = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;background:#0a0a0c;font-family:Inter,'Helvetica Neue',Arial,sans-serif;color:#f4f1ea;overflow:hidden}
body{position:relative;padding:84px 96px;display:flex;flex-direction:column;justify-content:center;gap:34px;
background:radial-gradient(900px 500px at 85% 0%,rgba(247,147,26,.28),transparent 60%),#0a0a0c}
.brand{display:flex;align-items:center;gap:22px}
.brand img{width:84px;height:84px}
.brand span{font-size:60px;font-weight:700;letter-spacing:-1px}
h1{font-size:92px;line-height:1.02;letter-spacing:-2.5px;font-weight:750;max-width:960px}
h1 em{font-style:normal;color:#f7931a}
p{font-size:30px;color:#a39f95;max-width:900px;line-height:1.35}
.bar{position:absolute;left:0;bottom:0;height:10px;width:100%;background:linear-gradient(90deg,#ffb347,#f7931a)}
</style><body>
<div class="brand"><img src="${svgUri}"><span>FeePilot</span></div>
<h1>Unstick a <em>Bitcoin</em> transaction</h1>
<p>Compare RBF, CPFP and waiting. You sign in your own wallet; FeePilot never holds your keys.</p>
<div class="bar"></div></body>`;
shot(og, join(pub, 'og.png'), 1200, 630);

// Chrome's headless window has a minimum size, so exact small icons come from playwright-core's
// viewport emulation (same system Chrome).
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({
  executablePath: chrome,
  args: ['--no-sandbox'],
});
async function icon(size, name, bg) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  });
  await page.setContent(
    `<!doctype html><style>*{margin:0}html,body{width:${size}px;height:${size}px;background:${bg ?? 'transparent'}}img{width:${size}px;height:${size}px;display:block}</style><img src="${svgUri}">`,
  );
  await page.screenshot({ path: join(pub, name), omitBackground: !bg });
  await page.close();
  console.log(`make-og: wrote public/${name}`);
}
await icon(192, 'icon-192.png');
await icon(512, 'icon-512.png');
// iOS fills transparency with black: give the touch icon a solid accent background behind the rounded tile.
await icon(180, 'apple-touch-icon.png', '#f7931a');
await browser.close();
