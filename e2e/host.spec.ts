import { expect, test } from '@playwright/test';
import {
  E2E_PORT,
  SAMPLE_INTERVAL_MS,
  login,
  meminfoWithUsage,
  readHostFile,
  writeHostFile,
} from './server.ts';

/** Within one sample interval, plus time for the browser to receive and render it. */
const ONE_SAMPLE = SAMPLE_INTERVAL_MS + 1500;

test.describe('Host page', () => {
  let originalStat: string;

  test.beforeAll(async () => {
    originalStat = await readHostFile(E2E_PORT, 'proc/stat');
  });

  test.afterEach(async () => {
    await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(36));
    await writeHostFile(E2E_PORT, 'proc/stat', originalStat);
  });

  test('without a session, the dashboard sends you to login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('a wrong password is refused', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect password');
  });

  test('shows the overview, CPU, memory and disks of the fixture Host', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('hostname')).toHaveText('harbour');
    await expect(page.getByTestId('overview-card')).toContainText('Debian GNU/Linux 13 (trixie)');
    await expect(page.getByTestId('overview-card')).toContainText('6.12.48-1-amd64');
    await expect(page.getByTestId('load-1')).toHaveText('0.52');

    // The fixture's mounts also list tmpfs and overlay, which are hidden. Its two ext4
    // "devices" are really one temporary filesystem (one st_dev), so df would list one.
    await expect(page.getByTestId('disk-mount')).toHaveText(['/']);
    await expect(page.getByTestId('disk-card')).toContainText('/dev/sda1 · ext4');
  });

  test('the live memory % follows the fixture meminfo', async ({ page }) => {
    await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(36));
    await login(page);
    await expect(page.getByTestId('memory-percent')).toHaveText('36.0%');

    await writeHostFile(E2E_PORT, 'proc/meminfo', meminfoWithUsage(72.5));
    await expect(page.getByTestId('memory-percent')).toHaveText('72.5%', { timeout: ONE_SAMPLE });
  });

  test('changing CPU time in the fixture updates the CPU card', async ({ page }) => {
    await login(page);
    // A static proc/stat means no CPU time has passed, so there is no usage figure.
    await expect(page.getByTestId('cpu-percent')).toHaveText('—');

    // Advance every counter: 300 busy and 100 idle jiffies out of 400 is 75% busy. Keep
    // advancing so each new sample sees the same rate.
    let step = 0;
    const tick = setInterval(() => {
      step += 1;
      const busy = 10_000 + 300 * step;
      const idle = 80_000 + 100 * step;
      void writeHostFile(
        E2E_PORT,
        'proc/stat',
        `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 ${busy} 0 0 ${idle} 0 0 0 0 0 0\n`,
      );
    }, SAMPLE_INTERVAL_MS / 2);
    try {
      await expect(page.getByTestId('cpu-percent')).toHaveText('75.0%', {
        timeout: ONE_SAMPLE * 2,
      });
    } finally {
      clearInterval(tick);
    }
  });
});
