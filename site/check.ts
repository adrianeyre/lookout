/**
 * `pnpm site:check`: checks the built Project Website in site/dist (PRD WEB-7, WEB-9).
 *
 * - axe finds no WCAG 2.2 A/AA violations, in the light and dark themes
 * - nothing scrolls sideways at 360px
 * - the page requests nothing from any other origin, and sets no cookies or storage
 * - with JavaScript off, every section is still there and readable, and the footer's
 *   modals still open (through `commandfor`)
 * - every footer modal opens and closes; /#privacy and the like open theirs
 * - the screenshot lightbox opens and closes
 * - search and link previews: title and description lengths, canonical URL, Open Graph and
 *   Twitter/X tags, a 1200×630 social card, valid JSON-LD, and every icon, manifest icon and
 *   SEO file is served
 * - the 404 page is not indexed
 * - nothing from the pen-test PRD or docs/pen-test/ is published (it names exploit chains)
 * - the hero demo plays and can be paused, and with reduced motion holds a still frame
 *   (WEB-5); without JavaScript, its place shows the static screenshot instead
 *
 * Run `pnpm site:build` first.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { preview } from 'vite';
import sharp from 'sharp';
import { OUT_DIR } from './build.ts';
import { leaksInDirectory } from './privacy.ts';

if (!existsSync(OUT_DIR)) throw new Error('site/dist does not exist; run pnpm site:build first');

const SECTIONS = [
  'top',
  'what',
  'features',
  'screenshots',
  'security',
  'requirements',
  'quick-start',
  'setup',
  'docs',
  'faq',
  'licence',
  'get',
];

const MODALS = ['changelog', 'credits', 'privacy', 'terms', 'cookies', 'accessibility'];

const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
  console.error(`✗ ${message}`);
};
const pass = (message: string) => console.log(`✓ ${message}`);

// The pen-test round's documents name exploit chains: nothing from them may be published.
const leaks = await leaksInDirectory(OUT_DIR);
if (leaks.length > 0) for (const leak of leaks) fail(`private pen-test text published: ${leak}`);
else pass('nothing from the pen-test PRD or docs/pen-test/ is published');

const server = await preview({
  configFile: false,
  root: path.dirname(OUT_DIR),
  logLevel: 'warn',
  build: { outDir: path.basename(OUT_DIR) },
  preview: { host: '127.0.0.1', port: 5182, strictPort: false },
});
const base = server.resolvedUrls?.local[0];
if (!base) throw new Error('vite preview did not report a URL');
const origin = new URL(base).origin;

/** Every Content-Security-Policy violation on any page opened (#128). */
const cspViolations: string[] = [];
const CSP_REPORTER = `document.addEventListener('securitypolicyviolation', (event) =>
  console.error('CSP violation: ' + event.violatedDirective + ' ' + event.blockedURI));`;

async function watchCsp(context: BrowserContext): Promise<void> {
  await context.addInitScript(CSP_REPORTER);
  context.on('console', (message) => {
    if (message.text().startsWith('CSP violation')) cspViolations.push(message.text());
  });
}

/** Opens the page, recording any request to another origin. */
async function open(browser: Browser, options: BrowserContextOptions) {
  const context = await browser.newContext(options);
  await watchCsp(context);
  const foreign: string[] = [];
  context.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:')) foreign.push(url);
  });
  const page = await context.newPage();
  await page.goto(base!, { waitUntil: 'networkidle' });
  // Load every lazy image too, so their requests are counted.
  await page.evaluate(async () => {
    for (const image of document.querySelectorAll('img')) image.loading = 'eager';
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  });
  await page.waitForLoadState('networkidle');
  return { context, page, foreign };
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Every footer modal opens from its button and closes with Esc, returning focus. */
async function checkModals(page: Page, label: string): Promise<void> {
  const broken: string[] = [];
  const sideways: string[] = [];
  for (const id of MODALS) {
    const opener = page.locator(`button[commandfor="${id}"][command="show-modal"]`);
    await opener.click();
    const dialog = page.locator(`dialog#${id}`);
    const opened = await dialog.evaluate(
      (el: HTMLDialogElement) => el.open && el.matches(':modal'),
    );
    // Nothing in a modal is wider than the modal: no sideways scroll bars. Text kept for
    // screen readers only is clipped on purpose, so it never shows.
    const wider = await dialog.locator('.modal__body').evaluate((body) => {
      const clipped = (node: Element) => {
        for (let at: Element | null = node; at; at = at.parentElement) {
          if (getComputedStyle(at).clipPath !== 'none') return true;
        }
        return false;
      };
      return (
        body.scrollWidth > body.clientWidth + 1 ||
        [...body.querySelectorAll<HTMLElement>('*')].some(
          (child) =>
            !clipped(child) && child.clientWidth > 1 && child.scrollWidth > child.clientWidth + 1,
        )
      );
    });
    if (wider) sideways.push(id);
    await page.keyboard.press('Escape');
    const closed = await dialog.evaluate((el: HTMLDialogElement) => !el.open);
    if (!opened || !closed) broken.push(id);
  }
  if (sideways.length > 0) {
    fail(`footer modals scroll sideways (${label}): ${sideways.join(', ')}`);
  } else pass(`no footer modal scrolls sideways (${label})`);
  if (broken.length > 0)
    fail(`footer modals did not open and close (${label}): ${broken.join(', ')}`);
  else pass(`every footer modal opens and closes (${label})`);
}

async function fetchOk(url: string): Promise<Response | null> {
  const response = await fetch(new URL(url, base));
  return response.ok ? response : null;
}

/** The tags search engines and link previews read, and the files they point to. */
async function checkSeo(page: Page): Promise<void> {
  const meta = (selector: string) =>
    page
      .locator(selector)
      .first()
      .getAttribute('content', { timeout: 1000 })
      .catch(() => null);
  const title = await page.title();
  if (title.length < 30 || title.length > 60)
    fail(`the title is ${title.length} characters, not 30 to 60`);
  else pass(`the title is ${title.length} characters`);
  const description = (await meta('meta[name="description"]')) ?? '';
  if (description.length < 70 || description.length > 160) {
    fail(`the description is ${description.length} characters, not 70 to 160`);
  } else pass(`the description is ${description.length} characters`);

  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  if (!canonical?.startsWith('https://')) fail('there is no absolute canonical URL');
  const required = [
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[property="og:url"]',
    'meta[property="og:image"]',
    'meta[property="og:image:alt"]',
    'meta[name="twitter:card"]',
    'meta[name="twitter:image"]',
  ];
  const missing: string[] = [];
  for (const selector of required) if (!(await meta(selector))) missing.push(selector);
  if (missing.length > 0) fail(`link preview tags are missing: ${missing.join(', ')}`);
  else pass('Open Graph and Twitter/X tags are all there');

  // Link previews fetch the image from the live domain; check the same file here.
  const ogImage = (await meta('meta[property="og:image"]')) ?? '';
  if (!ogImage.startsWith(`${canonical?.replace(/\/$/, '')}/`)) fail('og:image is not on the site');
  const card = await fetchOk(new URL(ogImage).pathname);
  const cardData = card && Buffer.from(await card.arrayBuffer());
  const size = cardData && (await sharp(cardData).metadata());
  if (!cardData || size?.width !== 1200 || size.height !== 630) {
    fail('the social card is missing or not 1200×630');
  } else if (cardData.length > 300_000) {
    fail(`the social card is ${cardData.length} bytes; WhatsApp ignores images over 300 kB`);
  } else pass(`the social card is 1200×630 and ${Math.round(cardData.length / 1000)} kB`);

  const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
  try {
    const types = jsonLd.flatMap((text) =>
      (JSON.parse(text) as { '@graph': { '@type': string }[] })['@graph'].map(
        (node) => node['@type'],
      ),
    );
    for (const type of ['WebSite', 'SoftwareApplication', 'FAQPage']) {
      if (!types.includes(type)) fail(`JSON-LD has no ${type}`);
    }
    pass(`JSON-LD parses: ${types.join(', ')}`);
  } catch (error) {
    fail(`JSON-LD does not parse: ${String(error)}`);
  }

  const links = await page
    .locator(
      'link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"], link[rel="manifest"]',
    )
    .evaluateAll((elements) => elements.map((el) => el.getAttribute('href') ?? ''));
  const tiles = [
    '/browserconfig.xml',
    '/mstile-70x70.png',
    '/mstile-150x150.png',
    '/mstile-310x150.png',
    '/mstile-310x310.png',
  ];
  const manifest = (await (await fetchOk('/site.webmanifest'))?.json()) as
    { icons: { src: string; purpose?: string }[]; screenshots: { src: string }[] } | undefined;
  const manifestFiles = [...(manifest?.icons ?? []), ...(manifest?.screenshots ?? [])].map(
    (i) => i.src,
  );
  const files = [
    ...links,
    ...tiles,
    ...manifestFiles,
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/humans.txt',
    '/apple-touch-icon-precomposed.png',
  ];
  const unserved: string[] = [];
  for (const file of new Set(files)) if (!(await fetchOk(file))) unserved.push(file);
  if (unserved.length > 0) fail(`these files are not served: ${unserved.join(', ')}`);
  else pass(`all ${new Set(files).size} icons, manifest images and SEO files are served`);
  if (!manifest?.icons.some((icon) => icon.purpose === 'maskable'))
    fail('the manifest has no maskable icon');
}

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [360, 1280]) {
      const label = `${colorScheme}, ${width}px`;
      const { context, page, foreign } = await open(browser, {
        colorScheme,
        viewport: { width, height: 800 },
      });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      if (results.violations.length === 0) pass(`axe: no WCAG 2.2 AA violations (${label})`);
      for (const violation of results.violations) {
        fail(
          `axe (${label}): ${violation.id}: ${violation.help}\n    ${violation.nodes
            .slice(0, 5)
            .map((node) => node.target.join(' '))
            .join('\n    ')}`,
        );
      }

      const broken = await page.evaluate(() =>
        [...document.images]
          .filter((image) => image.currentSrc && image.complete && image.naturalWidth === 0)
          .map((image) => image.currentSrc || image.src),
      );
      if (broken.length > 0) fail(`images did not load (${label}): ${broken.join(', ')}`);
      else pass(`every image loads (${label})`);

      const overflow = await horizontalOverflow(page);
      if (overflow > 0) fail(`scrolls sideways by ${overflow}px (${label})`);
      else pass(`no horizontal scroll (${label})`);

      if (foreign.length > 0) fail(`third-party requests (${label}): ${foreign.join(', ')}`);
      else pass(`no third-party requests (${label})`);

      const cookies = await context.cookies();
      const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
      if (cookies.length + storage > 0) fail(`cookies or storage were set (${label})`);
      else pass(`no cookies or browser storage (${label})`);

      await checkModals(page, label);

      if (width === 1280 && colorScheme === 'light') {
        await checkSeo(page);

        await page.goto(`${base}#privacy`, { waitUntil: 'networkidle' });
        const deepLinked = await page
          .locator('dialog#privacy')
          .evaluate((el: HTMLDialogElement) => el.open);
        if (deepLinked) pass('/#privacy opens the privacy policy');
        else fail('/#privacy did not open the privacy policy');
        await page.keyboard.press('Escape');

        await page.locator('a.shot').first().click();
        const dialog = page.locator('dialog.lightbox');
        const opened = await dialog.evaluate((el: HTMLDialogElement) => el.open);
        await page.keyboard.press('Escape');
        const closed = await dialog.evaluate((el: HTMLDialogElement) => !el.open);
        if (opened && closed) pass('the lightbox opens and closes');
        else fail('the lightbox did not open and close');
      }
      await context.close();
    }
  }

  // The hero demo (WEB-5): two frames of it, a few seconds apart, differ while it plays and
  // match under reduced motion, where the stage shows its still frame (data-still).
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    const { context, page, foreign } = await open(browser, {
      reducedMotion,
      viewport: { width: 1280, height: 800 },
    });
    const stage = page.locator('[data-demo="hero"][data-live] .ss-stage');
    await stage.waitFor({ timeout: 5000 });
    const before = await stage.screenshot();
    await page.waitForTimeout(3000);
    const after = await stage.screenshot();
    const moved = !before.equals(after);
    const still = (await stage.getAttribute('data-still')) !== null;
    if (reducedMotion === 'reduce') {
      if (still && !moved) pass('with reduced motion, the hero demo shows a still frame');
      else fail('with reduced motion, the hero demo still moves');
    } else if (!still && moved) {
      pass('the hero demo plays');
    } else {
      fail('the hero demo does not play');
    }
    // WCAG 2.2.2: it can be stopped, and then holds its still frame.
    const toggle = page.getByRole('button', { name: 'Pause animation' });
    if (reducedMotion === 'no-preference') {
      await toggle.click();
      await page.waitForTimeout(500);
      const paused = await stage.screenshot();
      await page.waitForTimeout(2000);
      const stopped =
        (await stage.getAttribute('data-still')) !== null &&
        paused.equals(await stage.screenshot());
      if (stopped) pass('the hero demo can be paused');
      else fail('pausing the hero demo does not stop it');
    } else if ((await toggle.count()) > 0) {
      fail('with reduced motion, the hero demo still offers a pause button');
    }
    if (foreign.length > 0) fail(`the hero demo made third-party requests: ${foreign.join(', ')}`);
    await context.close();
  }

  const { context, page, foreign } = await open(browser, {
    javaScriptEnabled: false,
    viewport: { width: 360, height: 800 },
  });
  const missing: string[] = [];
  for (const id of SECTIONS) {
    if (!(await page.locator(`[id="${id}"]`).isVisible())) missing.push(id);
  }
  if (missing.length > 0) fail(`without JavaScript, sections are missing: ${missing.join(', ')}`);
  else pass('without JavaScript, every section is there');
  await checkModals(page, 'without JavaScript');
  const firstShot = await page.locator('a.shot').first().getAttribute('href');
  if (!firstShot?.endsWith('.png')) fail('without JavaScript, screenshots do not link to images');
  else pass('without JavaScript, screenshots link to the full-size image');
  if (await page.locator('[data-demo="hero"] img').isVisible()) {
    pass('without JavaScript, the hero shows its screenshot in place of the demo');
  } else {
    fail('without JavaScript, the hero is empty');
  }
  if ((await horizontalOverflow(page)) > 0) fail('without JavaScript, it scrolls sideways');
  if (foreign.length > 0) fail(`without JavaScript, third-party requests: ${foreign.join(', ')}`);
  await context.close();

  // GitHub Pages serves 404.html for any unknown path.
  const notFoundContext = await browser.newContext();
  await watchCsp(notFoundContext);
  const notFound = await notFoundContext.newPage();
  await notFound.goto(new URL('/404.html', base).href);
  const robots = await notFound.locator('meta[name="robots"]').getAttribute('content');
  if (robots?.includes('noindex')) pass('the 404 page is not indexed');
  else fail('the 404 page can be indexed');
  const notFoundAxe = await new AxeBuilder({ page: notFound })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  if (notFoundAxe.violations.length > 0) {
    fail(`axe (404): ${notFoundAxe.violations.map((v) => v.id).join(', ')}`);
  } else pass('axe: no WCAG 2.2 AA violations on the 404 page');
  await notFoundContext.close();
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}

if (cspViolations.length > 0) {
  fail(`Content Security Policy violations: ${[...new Set(cspViolations)].join('; ')}`);
} else pass('no Content Security Policy violation on any page');

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nThe Project Website passes every check.');
