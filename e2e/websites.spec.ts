import type { ChildProcess } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  E2E_PORT,
  SITE_CHECK_INTERVAL_MS,
  dockerControl,
  login,
  secureSiteUrl,
  setSiteMode,
  siteUrl,
  startServer,
  stopServer,
} from './server.ts';

const row = (page: Page, url: string) =>
  page.locator(`[data-testid="site-row"][data-url="${url}"]`);

async function openWebsites(page: Page, baseURL?: string) {
  await login(page, baseURL);
  await page.getByRole('link', { name: 'Websites' }).click();
  await expect(page).toHaveURL(/\/websites$/);
}

test.describe('Websites', () => {
  test.afterEach(async () => {
    await dockerControl(E2E_PORT, 'reset');
  });

  test('a Hosted Site turns down within one check interval of its target failing', async ({
    page,
  }) => {
    await openWebsites(page);
    const shop = row(page, siteUrl(E2E_PORT));
    await expect(shop).toHaveAttribute('data-status', 'up');
    await expect(shop.getByTestId('site-result')).toHaveText('200');
    await expect(shop.getByTestId('site-container')).toContainText('shop-web-1');

    await setSiteMode(E2E_PORT, 'http', 'error');
    const switched = Date.now();
    // Within one interval, plus the time the browser takes to hear about it.
    await expect(shop).toHaveAttribute('data-status', 'down', {
      timeout: SITE_CHECK_INTERVAL_MS + 1000,
    });
    expect(Date.now() - switched).toBeLessThanOrEqual(SITE_CHECK_INTERVAL_MS + 1000);
    await expect(shop.getByTestId('site-result')).toHaveText('503');
    await expect(shop.getByTestId('site-since')).toHaveText(/^Down for/);
    await expect(shop.getByTestId('site-flag')).toHaveText(/Flagged: Down/);

    await setSiteMode(E2E_PORT, 'http', 'refuse');
    await expect(shop.getByTestId('site-result')).toHaveText('Connection refused');

    await setSiteMode(E2E_PORT, 'http', 'slow');
    await expect(shop).toHaveAttribute('data-status', 'slow');

    await setSiteMode(E2E_PORT, 'http', 'ok');
    await expect(shop).toHaveAttribute('data-status', 'up');
    await expect(shop.getByTestId('site-sparkline')).not.toHaveAttribute('data-points', '0');
  });

  test('a certificate that expires in 5 days shows red', async ({ page }) => {
    await openWebsites(page);
    const secure = row(page, secureSiteUrl(E2E_PORT));
    await expect(secure).toHaveAttribute('data-status', 'up');
    await expect(secure.getByTestId('site-tls')).toHaveAttribute('data-level', 'critical');
    await expect(secure.getByTestId('site-tls')).toHaveText(/Expires in 5 days/);
    await expect(secure.getByTestId('site-flag')).toHaveText('⚑Flagged: Certificate expiring');
    // Flagged Hosted Sites come first.
    await expect(page.getByTestId('site-row').first()).toHaveAttribute(
      'data-url',
      secureSiteUrl(E2E_PORT),
    );
    await expect(row(page, siteUrl(E2E_PORT)).getByTestId('site-tls')).toHaveText('No TLS');
  });

  test('a Container with Traefik labels adds its Hosted Site live', async ({ page }) => {
    await openWebsites(page);
    await expect(page.getByTestId('site-row')).toHaveCount(2);
    await dockerControl(E2E_PORT, 'upsert', {
      container: {
        id: 'c0ffee0000a1',
        name: 'blog-web-1',
        image: 'ghost:6',
        composeProject: 'blog',
        labels: {
          'com.docker.compose.project': 'blog',
          'traefik.enable': 'true',
          'traefik.http.routers.blog.rule': 'Host(`blog.example`) || Host(`www.blog.example`)',
          'traefik.http.routers.blog.entrypoints': 'websecure',
          'traefik.http.routers.blog.tls.certresolver': 'letsencrypt',
          'traefik.http.routers.blog-api.rule': 'PathPrefix(`/ghost/api`)',
        },
      },
      action: 'start',
    });
    await expect(page.getByTestId('site-row')).toHaveCount(4);
    await expect(row(page, 'https://blog.example/').getByTestId('site-container')).toContainText(
      'blog-web-1',
    );
    await expect(row(page, 'https://www.blog.example/')).toBeVisible();
  });

  test('stopping the Container behind a Hosted Site shows both as Flagged, linked to each other', async ({
    page,
  }) => {
    await openWebsites(page);
    const shop = row(page, siteUrl(E2E_PORT));
    await expect(shop).toHaveAttribute('data-status', 'up');

    // The Container is killed, so its website stops answering.
    await dockerControl(E2E_PORT, 'upsert', {
      container: {
        id: 'c0ffee000001',
        name: 'shop-web-1',
        image: 'nginx:1.29',
        composeProject: 'shop',
        labels: { 'com.docker.compose.project': 'shop', 'lookout.url': siteUrl(E2E_PORT) },
        state: 'exited',
        exitCode: 137,
        finishedAt: Date.now(),
      },
      action: 'die',
    });
    await setSiteMode(E2E_PORT, 'http', 'refuse');

    await expect(shop).toHaveAttribute('data-flagged', 'true');
    await expect(shop.getByTestId('site-flag')).toHaveText(/Flagged: Down/);
    const container = shop.getByTestId('site-container');
    await expect(container.getByTestId('container-state')).toHaveText('exited');
    await expect(container.getByTestId('container-flag')).toHaveText(/Exited with code 137/);

    await page.getByLabel('Flagged only').check();
    await expect(page.getByTestId('site-row')).toHaveCount(2);

    await container.getByRole('link', { name: 'shop-web-1' }).click();
    await expect(page).toHaveURL(/\/containers\/c0ffee000001$/);
    await expect(page.getByTestId('container-flag')).toHaveText(/Exited with code 137/);
    const served = page.getByTestId('detail-sites').getByTestId('detail-site');
    await expect(served).toHaveAttribute('data-url', siteUrl(E2E_PORT));
    await expect(served).toContainText('Flagged: Down');
    await served.getByRole('link').click();
    await expect(page).toHaveURL(/\/websites$/);
  });

  test('filters fit 360px with no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openWebsites(page);
    await page.getByRole('searchbox').fill('shop-web');
    await expect(page.getByTestId('site-row')).toHaveCount(1);
    await page.getByRole('searchbox').fill('');
    await page.getByLabel('Status').selectOption('up');
    await page.getByLabel('Flagged only').check();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('Check now', () => {
  // A server that checks once an hour, so only Check now can update a row quickly.
  const PORT = E2E_PORT + 2;
  let server: ChildProcess;

  test.beforeAll(async () => {
    server = await startServer(PORT, true, { LOOKOUT_SITE_CHECK_INTERVAL_SECONDS: '3600' });
  });

  test.afterAll(async () => {
    await stopServer(server);
  });

  test('updates a row straight away, without waiting for the interval', async ({ page }) => {
    const base = `http://127.0.0.1:${PORT}`;
    await openWebsites(page, base);
    const shop = row(page, siteUrl(PORT));
    await expect(shop).toHaveAttribute('data-status', 'up');

    await setSiteMode(PORT, 'http', 'error');
    await shop.getByTestId('site-check-now').click();
    await expect(shop).toHaveAttribute('data-status', 'down', { timeout: 2000 });

    // A second Check now within 5 s is refused.
    await shop.getByTestId('site-check-now').click();
    await expect(shop.getByTestId('site-check-error')).toHaveText(/checked moments ago/);
  });
});
