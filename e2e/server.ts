import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

export const E2E_PORT = 7788;
export const PASSWORD = 'e2e-password';
/** Argon2id hash of PASSWORD, with cheap parameters to keep the tests quick. */
const PASSWORD_HASH =
  '$argon2id$v=19$m=8192,t=1,p=1$aRYUwdtA8ovKf4xfCypxMA$MpIYGkcrMqdLlIOQ6uBOg6OnKIVXUNQSCJYUzy/pqDg';
export const SAMPLE_INTERVAL_MS = 500;
/** Hosted Sites are checked every second in Playwright. */
export const SITE_CHECK_INTERVAL_MS = 1000;

/** The fake http Hosted Site a test server checks (named by shop-web-1's lookout.url). */
export const sitePort = (port: number) => port + 1000;
/** The fake https Hosted Site, from LOOKOUT_SITES, whose certificate expires in 5 days. */
export const secureSitePort = (port: number) => port + 2000;
export const siteUrl = (port: number) => `http://store.example:${sitePort(port)}/`;
export const secureSiteUrl = (port: number) => `https://secure.example:${secureSitePort(port)}/`;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The fixture Host root a test server on this port reads from. */
export function hostRootFor(port: number): string {
  return path.join(repoRoot, 'e2e', '.tmp', `host-${port}`);
}

/** Where a test server on this port keeps its Site Stats (LOOKOUT_DATA_DIR). */
export function dataDirFor(port: number): string {
  return path.join(repoRoot, 'e2e', '.tmp', `data-${port}`);
}

export function serverEnv(port: number): Record<string, string> {
  return {
    LOOKOUT_BIND_ADDRESS: '127.0.0.1',
    LOOKOUT_PORT: String(port),
    LOOKOUT_HOST_ROOT: hostRootFor(port),
    LOOKOUT_SAMPLE_INTERVAL_MS: String(SAMPLE_INTERVAL_MS),
    LOOKOUT_PASSWORD_HASH: PASSWORD_HASH,
    LOOKOUT_SESSION_SECRET: 'e2e-session-secret-that-is-at-least-32-bytes',
    LOOKOUT_E2E_SEED: '1',
    LOOKOUT_E2E_HEARTBEAT_MS: '500',
    LOOKOUT_SITES: secureSiteUrl(port),
    LOOKOUT_SITE_CHECK_INTERVAL_SECONDS: String(SITE_CHECK_INTERVAL_MS / 1000),
    LOOKOUT_SITE_TIMEOUT_MS: '900',
    LOOKOUT_SITE_SLOW_MS: '300',
    // Site Stats: the seeded Caddy access log (e2e-main.ts) and a data directory.
    LOOKOUT_ACCESS_LOGS: path.join(hostRootFor(port), 'var/log/caddy/*.log'),
    LOOKOUT_DATA_DIR: dataDirFor(port),
  };
}

/** Starts an extra server (for tests that stop and restart it) and waits until it is live. */
export async function startServer(
  port: number,
  seed = true,
  env: Record<string, string> = {},
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['apps/server/test-support/e2e-main.ts'], {
    cwd: repoRoot,
    env: { ...process.env, ...serverEnv(port), LOOKOUT_E2E_SEED: seed ? '1' : '0', ...env },
    stdio: 'inherit',
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return child;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Server did not start in time');
}

export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

/** Overwrites a file in a server's fixture Host root, for example "proc/meminfo". */
export async function writeHostFile(port: number, hostPath: string, text: string): Promise<void> {
  await writeFile(path.join(hostRootFor(port), hostPath), text);
}

export async function readHostFile(port: number, hostPath: string): Promise<string> {
  return readFile(path.join(hostRootFor(port), hostPath), 'utf8');
}

export async function login(page: Page, baseURL?: string): Promise<void> {
  await page.goto(`${baseURL ?? ''}/login`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/');
}

/** A meminfo file with the given usage %, everything else held constant. */
export function meminfoWithUsage(percent: number): string {
  const totalKb = 8_000_000;
  const availableKb = Math.round(totalKb * (1 - percent / 100));
  return [
    `MemTotal:        ${totalKb} kB`,
    `MemFree:         ${Math.round(availableKb / 2)} kB`,
    `MemAvailable:    ${availableKb} kB`,
    'SwapTotal:       2097152 kB',
    'SwapFree:        1048576 kB',
    '',
  ].join('\n');
}

/** Drives the fake Docker in a test server (apps/server/test-support/e2e-main.ts). */
export async function dockerControl(port: number, path: string, body: unknown = {}): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/__e2e/docker/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
}

/** Makes a fake Hosted Site answer 200, 503, slowly, or refuse connections. */
export async function setSiteMode(
  port: number,
  site: 'http' | 'https',
  mode: 'ok' | 'error' | 'slow' | 'refuse',
): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/__e2e/sites/${site}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error(`site mode failed: ${response.status}`);
}

/** How many fake Docker streams of a kind are open on the server. */
export async function openDockerStreams(port: number, kind: 'events' | 'logs' | 'stats') {
  const response = await fetch(`http://127.0.0.1:${port}/__e2e/docker/open/${kind}`);
  return ((await response.json()) as { open: number }).open;
}

/** Sets filesystem usage % by mount point, e.g. {"/": 91}; {} restores the real values. */
export async function setDiskUsage(port: number, usage: Record<string, number>): Promise<void> {
  await writeHostFile(port, '.e2e-statfs.json', JSON.stringify(usage));
}
