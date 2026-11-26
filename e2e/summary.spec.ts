import { expect, test } from '@playwright/test';
import { E2E_PORT, login, meminfoWithUsage, writeHostFile } from './server.ts';

test.afterEach(async () => {
  await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(36));
});

test('the header summary updates live on both pages and fits 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(36));
  await login(page);
  const summary = page.getByTestId('header-summary');
  await expect(summary).toContainText('Containers: 2 running · 3 flagged');
  await expect(page.getByTestId('summary-mem')).toHaveText('Mem 36.0%');
  await expect(page.getByTestId('summary-flagged')).toHaveClass(/summary__item--flagged/);
  // Both Hosted Sites answer; the https one's certificate is at red, but it is up.
  await expect(page.getByTestId('summary-sites')).toHaveText('Sites: 2 up · 0 down');
  await expect(page.getByTestId('summary-sites-down')).not.toHaveClass(/flagged/);

  await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(85));
  await expect(page.getByTestId('summary-mem')).toHaveText(/^Mem 85\.0%/);
  await expect(page.getByTestId('summary-mem')).toHaveAttribute('data-level', 'warn');

  await page.getByRole('link', { name: 'Containers' }).click();
  await expect(page.getByTestId('summary-mem')).toHaveAttribute('data-level', 'warn');
  await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(92));
  await expect(page.getByTestId('summary-mem')).toHaveAttribute('data-level', 'critical');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
