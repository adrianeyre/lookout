import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  E2E_PORT,
  login,
  meminfoWithUsage,
  startServer,
  stopServer,
  writeHostFile,
} from './server.ts';

// Its own server, so stopping it does not disturb the other tests.
const PORT = E2E_PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | undefined;

test.afterAll(async () => {
  if (server) await stopServer(server);
});

test('the reconnecting state shows while the server is down; a restart then signs the user out (#83)', async ({
  page,
}) => {
  server = await startServer(PORT);
  await login(page, BASE);
  await expect(page.getByTestId('memory-card')).toBeVisible();

  await stopServer(server);
  await expect(page.getByTestId('connection-lost')).toBeVisible({ timeout: 10_000 });

  // Restarting Lookout ends every session, so a logged-out cookie can never come back: the
  // page reconnects, finds its session gone and returns to the login page.
  server = await startServer(PORT, false);
  await writeHostFile(PORT, 'proc/meminfo', meminfoWithUsage(55));
  await page.waitForURL(`${BASE}/login`, { timeout: 15_000 });

  await login(page, BASE);
  await expect(page.getByTestId('memory-percent')).toHaveText('55.0%');
});
