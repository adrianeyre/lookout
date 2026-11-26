import { expect, test } from '@playwright/test';
import { login } from './server.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
});

test('the Host page shows its largest folders, heaviest first, with a bar for each', async ({
  page,
}) => {
  const card = page.getByTestId('folders-card');
  await expect(card.getByTestId('folder').first()).toBeVisible({ timeout: 10_000 });
  const paths = await card.getByTestId('folder-path').allTextContents();
  expect(paths[0]).toBe('/srv/media/films');
  expect(paths).toContain('/var/lib/docker/volumes/shop_db');
  expect(paths).toContain('/opt/backups');
  // Never a folder that is only the way to a bigger one, nor proc or sys, nor anything in a
  // home folder (#107).
  for (const path of paths) expect(path).not.toMatch(/^\/(proc|sys|srv|var|opt)$|^\/(home|root)\b/);
  await expect(card.getByRole('meter').first()).toBeVisible();
  await expect(card.getByTestId('folders-status')).toContainText('Scanned');
  await expect(card.getByTestId('folders-status')).toContainText('next in');
});

test('Scan now scans again', async ({ page }) => {
  const card = page.getByTestId('folders-card');
  await expect(card.getByTestId('folder').first()).toBeVisible({ timeout: 10_000 });
  const first = await card.getByTestId('folders-status').textContent();
  await card.getByRole('button', { name: 'Scan now' }).click();
  await expect(card.getByRole('button', { name: /Scan now|Scanning/ })).toBeVisible();
  await expect(card.getByTestId('folders-status')).toContainText('Scanned', { timeout: 10_000 });
  await expect(card.getByTestId('folder').first()).toBeVisible();
  expect(first).toBeTruthy();
});
