import { expect, test } from '@playwright/test';
import { login } from './server.ts';

test('the Content Security Policy allows the whole SPA and blocks nothing it needs', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  await login(page);
  await expect(page.getByTestId('memory-card')).toBeVisible();
  await expect(page.locator('.sparkline').first()).toBeVisible();
  await page.getByRole('link', { name: 'Containers', exact: true }).click();
  await expect(page.getByTestId('container-row').first()).toBeVisible();
  await page.getByRole('link', { name: 'Websites', exact: true }).click();
  await expect(page.getByTestId('site-sparkline').first()).toBeVisible();
  await page.goto('/containers/c0ffee000001');
  await expect(page.getByTestId('log-line').first()).toBeVisible();
  await expect(page.getByTestId('detail-sites')).toBeVisible();
  await page.getByTestId('action-stop').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(violations).toEqual([]);
});

test('the dashboard cannot be framed by another site', async ({ page, request }) => {
  const response = await request.get('/login');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await page.setContent('<iframe src="http://127.0.0.1:7788/login"></iframe>');
  const frame = page.frames().find((f) => f.url().includes('/login'));
  // A blocked frame never loads the login form.
  await expect
    .poll(async () =>
      frame
        ? await frame
            .locator('input')
            .count()
            .catch(() => 0)
        : 0,
    )
    .toBe(0);
});
