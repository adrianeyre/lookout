import { expect, test, type Page } from '@playwright/test';
import { E2E_PORT, dockerControl, login, openDockerStreams, sitePort } from './server.ts';

async function openContainers(page: Page) {
  await login(page);
  await page.getByRole('link', { name: 'Containers', exact: true }).click();
  await expect(page.getByTestId('container-row').first()).toBeVisible();
}

/** Whether the log view is scrolled to its newest line. */
const logAtBottom = (page: Page) =>
  page
    .getByTestId('log-view')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 24);

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="container-row"][data-name="${name}"]`);

test.describe('Containers', () => {
  test.afterEach(async () => {
    await dockerControl(E2E_PORT, 'reset');
  });

  test('groups by Compose Project, with Standalone, and shows every state', async ({ page }) => {
    await openContainers(page);
    await expect(page.getByTestId('group-name')).toHaveText(['blog', 'shop', 'Standalone']);
    await expect(
      page.getByRole('region', { name: 'shop' }).getByTestId('container-name'),
    ).toHaveText(['shop-db-1', 'shop-web-1', 'shop-worker-1']);
    const states: Record<string, string> = {
      'shop-web-1': 'running',
      'shop-worker-1': 'restarting',
      'blog-ghost-1': 'paused',
      migrate: 'exited',
      backup: 'exited',
      fresh: 'created',
      zombie: 'dead',
    };
    for (const [name, state] of Object.entries(states)) {
      await expect(row(page, name).getByTestId('container-state')).toHaveText(state);
    }
    await expect(row(page, 'shop-web-1').getByTestId('container-health')).toHaveText('healthy');
    await expect(row(page, 'shop-web-1').getByTestId('container-status')).toHaveText(/^Up 3h/);
    await expect(row(page, 'shop-web-1').getByTestId('container-ports')).toHaveText(
      `${sitePort(E2E_PORT)}→80/tcp`,
    );
    await expect(row(page, 'migrate').getByTestId('container-status')).toHaveText(
      /^Exited \(1\) 1h/,
    );
  });

  test('"Flagged only" shows exactly the Flagged Containers', async ({ page }) => {
    await openContainers(page);
    await page.getByLabel('Flagged only').check();
    await expect(page.getByTestId('container-name')).toHaveText([
      'shop-db-1',
      'shop-worker-1',
      'migrate',
    ]);
    await expect(page.getByTestId('container-flag')).toHaveCount(3);
    // A clean exit (backup, exit 0) is not Flagged.
    await expect(row(page, 'backup')).toHaveCount(0);
  });

  test('a Docker event updates the list and summary without a reload', async ({ page }) => {
    await openContainers(page);
    await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true));
    await expect(page.getByTestId('summary-containers')).toHaveText(
      'Containers: 2 running · 3 flagged',
    );
    await dockerControl(E2E_PORT, 'upsert', {
      container: {
        id: 'c0ffee000001',
        name: 'shop-web-1',
        image: 'nginx:1.29',
        composeProject: 'shop',
        labels: { 'com.docker.compose.project': 'shop' },
        state: 'exited',
        exitCode: 137,
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now(),
      },
      action: 'die',
    });
    await expect(row(page, 'shop-web-1').getByTestId('container-state')).toHaveText('exited', {
      timeout: 2000,
    });
    await expect(row(page, 'shop-web-1')).toHaveAttribute('data-flagged', 'true');
    await expect(page.getByTestId('summary-containers')).toHaveText(
      'Containers: 1 running · 4 flagged',
    );
    expect(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker)).toBe(
      true,
    );
  });

  test('shows Docker unavailable while the Host page keeps working, then recovers', async ({
    page,
  }) => {
    await openContainers(page);
    await dockerControl(E2E_PORT, 'available', { available: false });
    await expect(page.getByTestId('docker-unavailable')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('summary-containers')).toHaveText(
      'Containers: Docker unavailable',
    );

    await page.getByRole('link', { name: 'Host', exact: true }).click();
    await expect(page.getByTestId('memory-card')).toBeVisible();
    await expect(page.getByTestId('hostname')).toHaveText('harbour');

    await page.getByRole('link', { name: 'Containers', exact: true }).click();
    await dockerControl(E2E_PORT, 'available', { available: true });
    await expect(page.getByTestId('container-row')).toHaveCount(8, { timeout: 5000 });
    await expect(page.getByTestId('docker-unavailable')).toHaveCount(0);
  });

  test('stats streams are open only while the Containers page is', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('memory-card')).toBeVisible();
    expect(await openDockerStreams(E2E_PORT, 'stats')).toBe(0);
    await page.getByRole('link', { name: 'Containers', exact: true }).click();
    // Two running Containers in the fixtures.
    await expect.poll(() => openDockerStreams(E2E_PORT, 'stats')).toBe(2);
    await page.getByRole('link', { name: 'Host', exact: true }).click();
    await expect.poll(() => openDockerStreams(E2E_PORT, 'stats')).toBe(0);
  });
});

test.describe('Container detail', () => {
  test.afterEach(async () => {
    await dockerControl(E2E_PORT, 'reset');
  });

  test('has its own URL and reveals one environment value at a time', async ({ page }) => {
    await openContainers(page);
    await row(page, 'shop-web-1').getByRole('link').click();
    await expect(page).toHaveURL(/\/containers\/c0ffee000001$/);
    await expect(page.getByTestId('detail-name')).toHaveText('shop-web-1');
    await expect(page.getByTestId('detail-container')).toContainText('/docker-entrypoint.sh');
    await expect(page.getByTestId('detail-mounts')).toContainText('read-only');
    await expect(page.getByTestId('detail-networks')).toContainText('172.18.0.2');
    await expect(page.getByTestId('detail-lifecycle')).toContainText('unless-stopped');

    await expect(page.getByTestId('env-name')).toHaveText(['NGINX_HOST', 'API_TOKEN']);
    await expect(page.getByTestId('env-value')).toHaveText(['••••••••', '••••••••']);
    await expect(page.getByText('tok-e2e-secret')).toHaveCount(0);

    await page.getByRole('button', { name: 'Reveal API_TOKEN' }).click();
    await expect(page.getByTestId('env-value')).toHaveText(['••••••••', 'tok-e2e-secret']);
    await expect(page.getByText('shop.example')).toHaveCount(0);

    // Reloading the URL opens the same view.
    await page.reload();
    await expect(page.getByTestId('detail-name')).toHaveText('shop-web-1');
  });

  test('tails logs live, pauses follow on scroll up, and closes the stream on leaving', async ({
    page,
  }) => {
    await openContainers(page);
    await row(page, 'shop-web-1').getByRole('link').click();
    const lines = page.getByTestId('log-line');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(1)).toHaveAttribute('data-stream', 'stderr');
    expect(await openDockerStreams(E2E_PORT, 'logs')).toBe(1);

    // Enough new lines to scroll.
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        stream: 'stdout',
        timestamp: Date.now(),
        text: `request ${from + i}`,
      }));
    await dockerControl(E2E_PORT, 'logs', { id: 'c0ffee000001', lines: batch(0, 200) });
    await expect(lines).toHaveCount(203);
    const view = page.getByTestId('log-view');
    await expect(view).toHaveAttribute('data-follow', 'true');
    await expect(page.getByTestId('log-view').getByText('request 199')).toBeVisible();
    await expect.poll(() => logAtBottom(page)).toBe(true);

    // Scrolling up pauses follow; new lines do not pull the view down.
    await view.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(view).toHaveAttribute('data-follow', 'false');
    await expect(page.getByTestId('logs-state')).toHaveText('Paused');
    await dockerControl(E2E_PORT, 'logs', { id: 'c0ffee000001', lines: batch(200, 50) });
    await expect(lines).toHaveCount(253);
    expect(await view.evaluate((el) => el.scrollTop)).toBe(0);

    await page.getByTestId('jump-to-latest').click();
    await expect(view).toHaveAttribute('data-follow', 'true');
    await expect.poll(() => logAtBottom(page)).toBe(true);

    // A fast burst does not freeze the UI.
    // (Sent in chunks only to stay under the server's request body limit.)
    for (let from = 1000; from < 4000; from += 100) {
      await dockerControl(E2E_PORT, 'logs', { id: 'c0ffee000001', lines: batch(from, 100) });
    }
    await expect(lines.last()).toHaveText('request 3999', { timeout: 5000 });
    await expect.poll(() => logAtBottom(page)).toBe(true);
    await page.getByLabel('Timestamps').check();
    await expect(page.getByLabel('Timestamps')).toBeChecked();

    // Leaving the detail view closes the server's Docker log stream.
    await page.getByRole('link', { name: '← All Containers' }).click();
    await expect.poll(() => openDockerStreams(E2E_PORT, 'logs')).toBe(0);
  });
});
