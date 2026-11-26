import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, serverEnv } from './e2e/server.ts';

export default defineConfig({
  testDir: 'e2e',
  // Tests share one server and change its fixture Host root, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/server/test-support/e2e-main.ts',
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    env: serverEnv(E2E_PORT),
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
