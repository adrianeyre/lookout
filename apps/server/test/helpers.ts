import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.ts';

export const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const TEST_PASSWORD = 'correct horse battery staple';
/** Argon2id hash of TEST_PASSWORD with cheap parameters. */
export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=8192,t=1,p=1$hen/04DMZIK3YwGth/Bg+Q$Xcu+GNzxzHBv9NX7jqRX6T9Wt8Uuy4r64C6bRSSz0vQ';

/**
 * A well-formed Argon2id hash at the minimum cost loadConfig accepts (#124). It matches no
 * password: config tests only need it to parse.
 */
export const CONFIG_TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$Y29uZmlnLXRlc3Qtc2FsdA$Y29uZmlnLXRlc3QtaGFzaC1tYXRjaGVzLW5vdGhpbmc';

/** A temporary Host root populated with the given files. */
export async function makeHostRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lookout-host-'));
  for (const [hostPath, text] of Object.entries(files)) {
    const target = path.join(root, hostPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    bindAddress: '127.0.0.1',
    port: 0,
    hostRoot: '/nonexistent',
    sampleIntervalMs: 2000,
    liveWindowMinutes: 15,
    warnPercent: 80,
    criticalPercent: 90,
    passwordHash: TEST_PASSWORD_HASH,
    sessionSecret: 'a-test-session-secret-that-is-long-enough',
    sessionIdleMs: 7 * 24 * 60 * 60 * 1000,
    sessionMaxMs: 30 * 24 * 60 * 60 * 1000,
    // The pen-test probes' Host (probes/harness.ts); IP addresses and localhost always pass.
    hostnames: ['lookout.test'],
    secureCookie: false,
    sites: [],
    siteCheckIntervalMs: 60_000,
    siteTimeoutMs: 10_000,
    siteSlowMs: 2000,
    tlsWarnDays: 14,
    tlsCriticalDays: 7,
    folderScanHours: 0,
    dataDir: null,
    ...overrides,
  };
}
