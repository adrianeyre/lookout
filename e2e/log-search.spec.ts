import { expect, test } from '@playwright/test';
import { E2E_PORT, dockerControl, login } from './server.ts';

test.afterEach(async () => {
  await dockerControl(E2E_PORT, 'reset');
});

test('log search highlights matches, and next/previous moves between them', async ({ page }) => {
  await login(page);
  await page.goto('/containers/c0ffee000001');
  const lines = page.getByTestId('log-line');
  await expect(lines).toHaveCount(3);

  const line = (text: string) => ({ stream: 'stdout', timestamp: Date.now(), text });
  await dockerControl(E2E_PORT, 'logs', {
    id: 'c0ffee000001',
    lines: [
      line('upstream timed out (110: Connection timed out)'),
      ...Array.from({ length: 120 }, (_, i) => line(`GET /item/${i} 200`)),
      line('upstream TIMED OUT again'),
    ],
  });
  await expect(lines).toHaveCount(125);

  await page.getByLabel('Search log').fill('timed out');
  const matches = page.getByTestId('log-match');
  await expect(matches).toHaveText(['timed out', 'timed out', 'TIMED OUT']);
  const count = page.getByTestId('log-match-count');
  await expect(count).toHaveText('3 of 3');
  const current = page.locator('[data-testid="log-match"][data-current]');
  await expect(current).toHaveText('TIMED OUT');

  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(count).toHaveText('2 of 3');
  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(count).toHaveText('1 of 3');
  await expect(current).toBeInViewport();
  await expect(page.getByTestId('logs-state')).toHaveText('Paused');

  // Enter moves to the next match, wrapping around.
  await page.getByLabel('Search log').press('Enter');
  await expect(count).toHaveText('2 of 3');
  await page.getByRole('button', { name: 'Next match' }).click();
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(count).toHaveText('1 of 3');

  // New lines are searched as they arrive, and the current match stays put.
  await dockerControl(E2E_PORT, 'logs', { id: 'c0ffee000001', lines: [line('timed out x3')] });
  await expect(count).toHaveText('1 of 4');
  await expect(matches).toHaveCount(4);

  await page.getByLabel('Search log').fill('no such text');
  await expect(count).toHaveText('No matches');
  await expect(matches).toHaveCount(0);
});
