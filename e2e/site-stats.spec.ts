import { expect, test, type Page } from '@playwright/test';
import { E2E_PORT, login, siteUrl } from './server.ts';

/**
 * Site Stats (#10, #11). The e2e server seeds an access log with today's requests for the
 * shop site: 3 human visitors with 5 page views between them, and 2 bot requests.
 */

const row = (page: Page, url: string) =>
  page.locator(`[data-testid="site-row"][data-url="${url}"]`);

test.describe('Site Stats', () => {
  test("the Websites list shows today's visitors, and the row opens its Stats page", async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'Websites' }).click();
    await expect(page).toHaveURL(/\/websites$/);

    const shop = row(page, siteUrl(E2E_PORT));
    await expect(shop.getByTestId('site-visitors-today')).toHaveText('3');
    await expect(shop.getByTestId('site-visitors-sparkline')).toHaveAttribute('data-points', '7');

    await shop.getByTestId('site-stats-link').click();
    await expect(page).toHaveURL(/\/websites\/[0-9a-f]{16}$/);
    await expect(page.getByTestId('site-stats-title')).toHaveText(siteUrl(E2E_PORT));
    // The Websites section stays current in the header.
    await expect(page.getByRole('link', { name: 'Websites', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // 7 days by default; today is the last point.
    const visitors = page.getByTestId('site-visitors');
    await expect(visitors).toBeVisible();
    await expect(page.getByTestId('site-visitors-latest')).toHaveText('3');
    await expect(page.getByTestId('site-visitors-chart')).toHaveAttribute('data-points', '7');

    for (const [name, points] of [
      ['Last 24 hours', '24'],
      ['Last 7 days', '7'],
      ['Last 90 days', '90'],
    ] as const) {
      await page.getByRole('radio', { name }).check();
      await expect(page.getByTestId('site-visitors-chart')).toHaveAttribute('data-points', points);
    }
    await expect(page.getByTestId('site-visitors')).toContainText('3 in last 90 days');

    await page.getByRole('link', { name: /All Websites/ }).click();
    await expect(page).toHaveURL(/\/websites$/);
    await expect(row(page, siteUrl(E2E_PORT))).toBeVisible();
  });

  test('an unknown site says so, with a way back', async ({ page }) => {
    await login(page);
    await page.goto('/websites/ffffffffffffffff');
    await expect(page.getByTestId('site-stats-error')).toContainText('no Hosted Site');
    await page.getByRole('link', { name: /All Websites/ }).click();
    await expect(page).toHaveURL(/\/websites$/);
  });
});
