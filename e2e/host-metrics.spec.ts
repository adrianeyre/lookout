import { expect, test } from '@playwright/test';
import {
  E2E_PORT,
  SAMPLE_INTERVAL_MS,
  login,
  readHostFile,
  setDiskUsage,
  writeHostFile,
} from './server.ts';

const ONE_SAMPLE = SAMPLE_INTERVAL_MS + 1500;

test.describe('Host metrics: disk I/O, network, thresholds and sparklines', () => {
  let diskstats: string;
  let netDev: string;

  test.beforeAll(async () => {
    diskstats = await readHostFile(E2E_PORT, 'proc/diskstats');
    netDev = await readHostFile(E2E_PORT, 'proc/1/net/dev');
  });

  test.afterEach(async () => {
    await writeHostFile(E2E_PORT, 'proc/diskstats', diskstats);
    await writeHostFile(E2E_PORT, 'proc/1/net/dev', netDev);
    await setDiskUsage(E2E_PORT, {});
  });

  test('disk I/O shows whole disks only, with live throughput', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('disk-io-row')).toHaveCount(1);
    await expect(page.getByTestId('disk-io-card')).toContainText('sda');
    await expect(page.getByTestId('disk-io-card')).not.toContainText('sda1');
    await expect(page.getByTestId('disk-io-card')).not.toContainText('loop0');

    // Read 1024 sectors (512 KiB) every 250 ms: 2 MiB/s. Writing nothing.
    let sectors = 9_000_000;
    const tick = setInterval(() => {
      sectors += 1024;
      void writeHostFile(
        E2E_PORT,
        'proc/diskstats',
        `   8       0 sda 1 0 ${sectors} 0 1 0 4000000 0 0 0 0 0 0 0 0 0 0\n`,
      );
    }, SAMPLE_INTERVAL_MS / 2);
    try {
      await expect(page.getByTestId('disk-read')).toHaveText(/^(1\.9\d|2\.0\d) MiB\/s$/, {
        timeout: ONE_SAMPLE * 3,
      });
      await expect(page.getByTestId('disk-write')).toHaveText('0 B/s');
    } finally {
      clearInterval(tick);
    }
  });

  test('network hides loopback and veth until the toggle shows them', async ({ page }) => {
    await login(page);
    const names = page.getByTestId('network-name');
    await expect(names).toHaveText(['eth0']);
    await page.getByLabel(/Show loopback and veth/).check();
    await expect(names).toHaveText(['eth0', 'lo', 'vethab12cd']);
    await page.getByLabel(/Show loopback and veth/).uncheck();
    await expect(names).toHaveText(['eth0']);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`a disk at 91% shows red in the ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await setDiskUsage(E2E_PORT, { '/': 91 });
      await login(page);
      const disk = page.getByTestId('disk').filter({ hasText: '/' });
      await expect(disk.getByTestId('disk-percent')).toHaveText('91.0%', { timeout: ONE_SAMPLE });
      await expect(disk.getByTestId('disk-level')).toHaveText('■Critical');
      const meter = disk.getByRole('meter');
      await expect(meter).toHaveAttribute('data-level', 'critical');
      const [fill, critical] = await meter.evaluate((el) => [
        getComputedStyle(el.querySelector('.meter__fill')!).backgroundColor,
        getComputedStyle(el).getPropertyValue('--color-critical').trim(),
      ]);
      expect(critical).toBe(colorScheme === 'dark' ? '#ff7b72' : '#b42318');
      expect(fill).toBe(colorScheme === 'dark' ? 'rgb(255, 123, 114)' : 'rgb(180, 35, 24)');
      // The header summary shows the fullest disk in red too.
      await expect(page.getByTestId('summary-disk')).toHaveAttribute('data-level', 'critical');
    });
  }

  test('sparklines keep the Live Window across a reload', async ({ page }) => {
    await login(page);
    const sparkline = page.getByTestId('memory-sparkline');
    await expect
      .poll(async () => Number(await sparkline.getAttribute('data-points')), {
        timeout: ONE_SAMPLE * 4,
      })
      .toBeGreaterThanOrEqual(4);
    await page.reload();
    // The server sends the existing window first, so the chart is not empty after a reload.
    const afterReload = Number(
      await page.getByTestId('memory-sparkline').getAttribute('data-points'),
    );
    expect(afterReload).toBeGreaterThanOrEqual(4);
    for (const id of ['cpu-sparkline', 'disk-io-sparkline', 'network-sparkline']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });
});
