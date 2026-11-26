import { expect, test, type Page } from '@playwright/test';
import { login } from './server.ts';

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [360, 1280]) {
    test(`every page fits ${width}px in the ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 800 });
      await login(page);
      await expect(page.getByTestId('memory-card')).toBeVisible();
      await expectNoHorizontalScroll(page);

      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).toBe(colorScheme === 'dark' ? 'rgb(13, 17, 23)' : 'rgb(246, 248, 250)');

      await page.getByRole('link', { name: 'Docker', exact: true }).click();
      await expect(page).toHaveURL(/\/containers$/);
      await expect(page.getByRole('heading', { name: 'Containers' })).toBeVisible();
      await expectNoHorizontalScroll(page);

      await page.getByRole('link', { name: 'Websites' }).click();
      await expect(page).toHaveURL(/\/websites$/);
      await expect(page.getByTestId('site-row').first()).toBeVisible();
      await expectNoHorizontalScroll(page);

      // A Site Stats page, with its charts, fits too.
      await page.getByTestId('site-stats-link').first().click();
      await expect(page.getByTestId('site-stats-title')).toBeVisible();
      await expect(page.getByTestId('site-visitors')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.getByRole('link', { name: /All Websites/ }).click();
      await expect(page).toHaveURL(/\/websites$/);
      await expect(page.getByTestId('site-status').first()).not.toHaveText('checking');
      await page.getByLabel('Flagged only').check();
      await expectNoHorizontalScroll(page);
      await page.getByLabel('Flagged only').uncheck();

      // The detail view, with its Container Actions, log search and a confirmation dialog.
      await page.goto('/containers/c0ffee000001');
      await expect(page.getByTestId('log-line').first()).toBeVisible();
      await page.getByLabel('Search log').fill('nginx');
      await expectNoHorizontalScroll(page);
      await page.getByTestId('action-stop').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }
}

test('the login page fits 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/login');
  await expectNoHorizontalScroll(page);
});

test('logging out returns to login and ends the session', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  const response = await page.request.get('/api/session');
  expect(response.status()).toBe(401);
});

test('an expired session sends the user to login', async ({ page, baseURL }) => {
  await login(page);
  await expect(page.getByTestId('memory-card')).toBeVisible();
  // End the session from outside the page, as an idle expiry would: the open stream is
  // closed at its next heartbeat, and the reconnect finds no session.
  const response = await page.request.post('/api/logout', { headers: { origin: baseURL! } });
  expect(response.status()).toBe(204);
  await expect(page).toHaveURL(/\/login$/, { timeout: 5000 });
});
