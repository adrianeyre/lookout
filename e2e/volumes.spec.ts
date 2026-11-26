import { expect, test } from '@playwright/test';
import { E2E_PORT, dockerControl, login } from './server.ts';

/**
 * Volumes on the Docker page (ADR-0015). The fake Docker's shop-web-1 mounts shop_cache, and
 * old_cache and stray_data are used by nothing.
 */
test.describe('Volumes', () => {
  test.afterEach(async () => {
    await dockerControl(E2E_PORT, 'reset');
  });

  test('the Docker link shows each Container’s volumes, and unused ones can be deleted', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('link', { name: 'Docker', exact: true }).click();
    await expect(page).toHaveURL(/\/containers$/);

    const shop = page.locator('[data-testid="container-row"][data-name="shop-web-1"]');
    await expect(shop.getByTestId('container-volume')).toContainText('shop_cache');
    await expect(shop.getByTestId('container-volume')).toContainText('/var/cache/nginx');

    const unused = page.getByTestId('unused-volume');
    await expect(unused).toHaveCount(2);
    await expect(unused.first()).toHaveAttribute('data-name', 'old_cache');
    // Sizes arrive once Docker has measured them.
    await expect(unused.first()).toContainText('MiB');

    const stray = page.locator('[data-testid="unused-volume"][data-name="stray_data"]');
    await stray.getByTestId('volume-delete').click();
    const dialog = page.getByTestId('volume-delete-dialog');
    await expect(dialog.getByTestId('volume-confirm-delete')).toBeDisabled();
    await dialog.getByTestId('volume-confirm-name').fill('stray_data');
    await dialog.getByTestId('volume-confirm-delete').click();
    await expect(page.getByTestId('volume-delete-result')).toHaveText('Deleted stray_data');
    await expect(unused).toHaveCount(1);
  });

  test('a volume in use cannot be deleted, even through the API', async ({ page }) => {
    await login(page);
    const response = await page.request.post('/api/volumes/shop_cache/delete', {
      data: { confirmName: 'shop_cache' },
      headers: { origin: `http://127.0.0.1:${E2E_PORT}` },
    });
    expect(response.status()).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/In use by shop-web-1/);
  });
});
