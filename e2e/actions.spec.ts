import { expect, test, type Page } from '@playwright/test';
import { E2E_PORT, dockerControl, login } from './server.ts';

async function openDetail(page: Page, id: string) {
  await login(page);
  await page.goto(`/containers/${id}`);
  await expect(page.getByTestId('detail-name')).toBeVisible();
}

test.describe('Container Actions', () => {
  test.afterEach(async () => {
    await dockerControl(E2E_PORT, 'reset');
  });

  test('restarting a Flagged Container shows progress, then the new state', async ({ page }) => {
    await dockerControl(E2E_PORT, 'action-delay', { ms: 800 });
    // shop-worker-1 is restarting, so Flagged.
    await openDetail(page, 'c0ffee000003');
    await expect(page.getByTestId('container-flag')).toHaveText(/Restarting/);
    await expect(page.getByTestId('action-start')).toHaveCount(0);

    await page.getByTestId('action-restart').click();
    const dialog = page.getByRole('dialog', { name: 'Restart shop-worker-1?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Restart' }).click();

    await expect(page.getByTestId('action-status')).toHaveText(/Restarting shop-worker-1/);
    await expect(page.getByTestId('action-stop')).toBeDisabled();
    await expect(page.getByTestId('action-status')).toHaveText('Restarted shop-worker-1.', {
      timeout: 5000,
    });
    await expect(page.getByTestId('container-state')).toHaveText('running');
    await expect(page.getByTestId('container-flag')).toHaveCount(0);
    await expect(page.getByTestId('restart-count')).toContainText('8');
  });

  test('stop asks first, and cancelling does nothing', async ({ page }) => {
    await openDetail(page, 'c0ffee000001');
    await page.getByTestId('action-stop').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('container-state')).toHaveText('running');

    await page.getByTestId('action-stop').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('container-state')).toHaveText('exited');
    // A stopped Container offers Start and Remove instead.
    await expect(page.getByTestId('container-actions').getByRole('button')).toHaveText([
      'Start',
      'Remove',
    ]);
    await page.getByTestId('action-start').click();
    await expect(page.getByTestId('container-state')).toHaveText('running');
  });

  test("shows Docker's error message when an action fails", async ({ page }) => {
    await openDetail(page, 'c0ffee000005');
    await dockerControl(E2E_PORT, 'fail-next', {
      message: 'driver failed programming external connectivity: port is already allocated',
    });
    await page.getByTestId('action-start').click();
    await expect(page.getByTestId('action-error')).toHaveText(
      'Start failed: driver failed programming external connectivity: port is already allocated',
    );
    await expect(page.getByTestId('container-state')).toHaveText('exited');
  });

  test('remove keeps the confirm button disabled until the exact name is typed', async ({
    page,
  }) => {
    await openDetail(page, 'c0ffee000005');
    await page.getByTestId('action-remove').click();
    const dialog = page.getByRole('dialog', { name: 'Remove migrate?' });
    const confirm = dialog.getByTestId('confirm-action');
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId('confirm-name').fill('Migrate');
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId('confirm-name').fill('migrat');
    await expect(confirm).toBeDisabled();
    await dialog.getByTestId('confirm-name').fill('migrate');
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page).toHaveURL(/\/containers$/);
    await expect(page.locator('[data-testid="container-row"][data-name="migrate"]')).toHaveCount(0);
  });

  test("Lookout's own Container has its actions disabled, and the API refuses them", async ({
    page,
  }) => {
    await dockerControl(E2E_PORT, 'upsert', {
      container: {
        id: 'c0ffee0000ff',
        name: 'lookout',
        image: 'ghcr.io/adrianeyre/lookout:edge',
        labels: { 'lookout.self': 'true' },
        state: 'running',
      },
      action: 'start',
    });
    await openDetail(page, 'c0ffee0000ff');
    await expect(page.getByTestId('action-stop')).toBeDisabled();
    await expect(page.getByTestId('action-restart')).toBeDisabled();
    await expect(page.getByTestId('self-note')).toBeVisible();

    // Calling the API directly, from the signed-in page, is refused.
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/containers/c0ffee0000ff/actions/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return response.status;
    });
    expect(status).toBe(403);
    await expect(page.getByTestId('container-state')).toHaveText('running');
  });
});
