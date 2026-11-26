/**
 * `pnpm screenshots`: serves the screenshot harness with Vite and captures every view, in
 * light and dark themes, at desktop and phone widths, into docs/images/ (PRD WEB-6).
 *
 * The harness renders the real UI from made-up fixtures (fixtures.ts). The clock, time zone
 * and locale are fixed, so the images change only when the UI does.
 */
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { LOGS, LOG_SEARCH, NOW } from './fixtures.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../../../docs/images/', import.meta.url));

interface View {
  name: string;
  page: 'host' | 'containers' | 'detail' | 'websites' | 'site' | 'settings';
  /** Waits until the view is fully drawn, and sets up anything the screenshot shows. */
  prepare(page: Page): Promise<void>;
}

const VIEWS: View[] = [
  {
    name: 'host',
    page: 'host',
    prepare: async (page) => {
      await page.getByTestId('memory-card').waitFor();
      await page.locator('.sparkline').first().waitFor();
    },
  },
  {
    name: 'containers',
    page: 'containers',
    prepare: async (page) => {
      await page.getByTestId('container-row').first().waitFor();
      await page.getByTestId('container-cpu').first().waitFor();
    },
  },
  {
    name: 'container-detail',
    page: 'detail',
    prepare: async (page) => {
      await page.getByTestId('detail-name').waitFor();
      await page.getByTestId('container-cpu').first().waitFor();
    },
  },
  {
    name: 'container-logs',
    page: 'detail',
    prepare: async (page) => {
      await page
        .getByTestId('log-line')
        .nth(LOGS.length - 1)
        .waitFor();
      await page.getByLabel('Search log').fill(LOG_SEARCH);
      await page.getByLabel('Timestamps').check();
      await page.getByTestId('logs').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'largest-folders',
    page: 'host',
    prepare: async (page) => {
      await page.getByTestId('folder').first().waitFor();
      await page
        .getByTestId('folders-card')
        .evaluate((el) => el.closest('.widget')!.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'websites',
    page: 'websites',
    prepare: async (page) => {
      await page.getByTestId('site-row').nth(3).waitFor();
    },
  },
  {
    name: 'docker-disk',
    page: 'host',
    prepare: async (page) => {
      await page.getByTestId('docker-disk-chart').waitFor();
      await page
        .getByTestId('docker-disk-card')
        .evaluate((el) => el.closest('.widget')!.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'volumes',
    page: 'containers',
    prepare: async (page) => {
      await page.getByTestId('container-volume').first().waitFor();
      await page.getByTestId('unused-volume').first().waitFor();
      await page
        .getByTestId('unused-volumes')
        .evaluate((el) => el.closest('.widget')!.scrollIntoView({ block: 'end' }));
    },
  },
  {
    name: 'site-stats',
    page: 'site',
    prepare: async (page) => {
      await page.getByTestId('site-visitors-chart').waitFor();
      await page.getByTestId('site-size-total').waitFor();
    },
  },
  {
    name: 'site-stats-uptime',
    page: 'site',
    prepare: async (page) => {
      await page.getByTestId('site-uptime').waitFor();
      await page.getByTestId('site-size-total').waitFor();
      await page
        .getByTestId('site-top-pages')
        .evaluate((el) => el.closest('.widget')!.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'settings',
    page: 'settings',
    prepare: async (page) => {
      await page.getByRole('heading', { name: 'Settings' }).waitFor();
    },
  },
];

const SIZES = [
  { name: 'desktop', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, mobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, mobile: true },
] as const;

const THEMES = ['light', 'dark'] as const;

const server = await createServer({
  root: webRoot,
  configFile: path.join(webRoot, 'vite.config.ts'),
  logLevel: 'warn',
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const base = server.resolvedUrls?.local[0];
if (!base) throw new Error('Vite did not report a URL');

await mkdir(outDir, { recursive: true });
// Start clean, so a view that is removed here does not leave a stale image behind.
for (const file of await readdir(outDir)) {
  if (file.endsWith('.png')) await rm(path.join(outDir, file));
}

const browser = await chromium.launch();
const written: string[] = [];
try {
  for (const size of SIZES) {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: size.viewport,
        deviceScaleFactor: size.deviceScaleFactor,
        isMobile: size.mobile,
        hasTouch: size.mobile,
        colorScheme: theme,
        reducedMotion: 'reduce',
        timezoneId: 'UTC',
        locale: 'en-GB',
      });
      // Nothing but the harness itself is ever loaded.
      await context.route(
        (url) => !url.href.startsWith(base),
        (route) => route.abort(),
      );
      for (const view of VIEWS) {
        const page = await context.newPage();
        await page.clock.setFixedTime(NOW);
        await page.goto(new URL(`screenshots/index.html?page=${view.page}`, base).href);
        await view.prepare(page);
        await page.evaluate(() => document.fonts.ready);
        const file = path.join(outDir, `${view.name}-${theme}-${size.name}.png`);
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
        written.push(path.relative(process.cwd(), file));
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`Wrote ${written.length} screenshots:\n  ${written.join('\n  ')}`);
