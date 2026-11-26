import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { caddyLine, caddyLog } from '../../test-support/caddy-log.ts';
import { HostRoot } from '../host-root.ts';
import { caddyJson, MAX_LINE_BYTES, type AccessEntry } from './access-log.ts';
import { AccessLogFollower, globToRegExp } from './follower.ts';
import { StatsStore } from './store.ts';

const NOW = Date.parse('2026-11-26T12:30:00Z');
const quiet = { info: () => undefined, warn: () => undefined };

async function setup(store = StatsStore.open(null)) {
  const root = await mkdtemp(path.join(tmpdir(), 'lookout-host-'));
  await mkdir(path.join(root, 'var/log/caddy'), { recursive: true });
  return { root, store, logDir: path.join(root, 'var/log/caddy') };
}

function follower(root: string, store: StatsStore, seen: AccessEntry[], flushes = { count: 0 }) {
  return new AccessLogFollower({
    pattern: path.join(root, 'var/log/caddy/*.log'),
    hostRoot: new HostRoot(root),
    store,
    format: caddyJson,
    onEntry: (entry) => seen.push(entry),
    onFlush: () => {
      flushes.count += 1;
    },
    log: quiet,
    now: () => NOW,
  });
}

const requests = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ ts: NOW, host: 'shop.example', uri: `/${from + i}` }));

describe('globToRegExp', () => {
  it('matches * and ? in a file name only', () => {
    expect(globToRegExp('*.log').test('access.log')).toBe(true);
    expect(globToRegExp('*.log').test('access.log.gz')).toBe(false);
    expect(globToRegExp('site-?.log').test('site-a.log')).toBe(true);
    expect(globToRegExp('a.log').test('aXlog')).toBe(false);
  });
});

describe('AccessLogFollower', () => {
  it('reads new lines, and only whole ones', async () => {
    const { root, store, logDir } = await setup();
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    const file = path.join(logDir, 'access.log');
    await writeFile(
      file,
      caddyLog(requests(2)) + caddyLine({ ts: NOW, host: 'shop.example' }).slice(0, 40),
    );
    await reader.poll();
    expect(seen.map((e) => e.uri)).toEqual(['/0', '/1']);
    expect(reader.status).toBe('ok');
    await appendFile(
      file,
      `${caddyLine({ ts: NOW, host: 'shop.example', uri: '/x' }).slice(40)}\n`,
    );
    await reader.poll();
    expect(seen.map((e) => e.uri)).toEqual(['/0', '/1', '/x']);
  });

  it('carries on after a restart without counting anything twice', async () => {
    const { root, store, logDir } = await setup();
    const file = path.join(logDir, 'access.log');
    await writeFile(file, caddyLog(requests(3)));
    const first: AccessEntry[] = [];
    await follower(root, store, first).poll();
    await appendFile(file, caddyLog(requests(2, 3)));
    const second: AccessEntry[] = [];
    await follower(root, store, second).poll();
    expect(first.map((e) => e.uri)).toEqual(['/0', '/1', '/2']);
    expect(second.map((e) => e.uri)).toEqual(['/3', '/4']);
  });

  it('finishes a rotated file and starts the new one from its beginning', async () => {
    const { root, store, logDir } = await setup();
    const file = path.join(logDir, 'access.log');
    await writeFile(file, caddyLog(requests(2)));
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    // Caddy writes a little more, then rotates: rename, and a new file.
    await appendFile(file, caddyLog(requests(1, 2)));
    await rename(file, path.join(logDir, 'access-2026-11-26T12-00-00.000.log'));
    await writeFile(file, caddyLog(requests(1, 3)));
    await reader.poll();
    expect(seen.map((e) => e.uri).sort()).toEqual(['/0', '/1', '/2', '/3']);
    // The rotated file is deleted (or compressed away): its place is forgotten.
    await rm(path.join(logDir, 'access-2026-11-26T12-00-00.000.log'));
    await reader.poll();
    expect(store.offsets().size).toBe(1);
  });

  it('starts a truncated file again', async () => {
    const { root, store, logDir } = await setup();
    const file = path.join(logDir, 'access.log');
    await writeFile(file, caddyLog(requests(3)));
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    await truncate(file, 0);
    await appendFile(file, caddyLog(requests(1, 9)));
    await reader.poll();
    expect(seen.map((e) => e.uri)).toEqual(['/0', '/1', '/2', '/9']);
  });

  it('skips malformed and over-long lines, and Caddy’s own messages', async () => {
    const { root, store, logDir } = await setup();
    const long = `{"pad":"${'x'.repeat(MAX_LINE_BYTES + 10)}"}`;
    await writeFile(
      path.join(logDir, 'access.log'),
      `not json\n${long}\n{"level":"info","msg":"server running"}\n${caddyLog(requests(1))}`,
    );
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    expect(seen).toHaveLength(1);
    expect(reader.malformed).toBe(2);
  });

  it('skips a line far longer than one read', async () => {
    const { root, store, logDir } = await setup();
    await writeFile(
      path.join(logDir, 'access.log'),
      `${'y'.repeat(3 * 1024 * 1024)}\n${caddyLog(requests(1))}`,
    );
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    expect(seen).toHaveLength(1);
    expect(reader.malformed).toBe(1);
  });

  it('writes its place in the same transaction as the totals', async () => {
    const { root, store, logDir } = await setup();
    await writeFile(path.join(logDir, 'access.log'), caddyLog(requests(1)));
    const flushes = { count: 0 };
    await follower(root, store, [], flushes).poll();
    expect(flushes.count).toBe(1);
    expect([...store.offsets().values()][0]).toMatchObject({ path: '/var/log/caddy/access.log' });
  });

  it('says there are no logs when nothing matches or the folder is missing', async () => {
    const { root, store } = await setup();
    const reader = follower(root, store, []);
    await reader.poll();
    expect(reader.status).toBe('no-logs');
    const missing = new AccessLogFollower({
      pattern: path.join(root, 'var/log/nothing/*.log'),
      hostRoot: new HostRoot(root),
      store,
      format: caddyJson,
      onEntry: () => undefined,
      onFlush: () => undefined,
      log: quiet,
    });
    await missing.poll();
    expect(missing.status).toBe('no-logs');
  });

  it('never follows a link, so a log cannot be pointed at another file', async () => {
    const { root, store, logDir } = await setup();
    const secret = path.join(root, 'secret.txt');
    await writeFile(secret, caddyLog(requests(1)));
    await symlink(secret, path.join(logDir, 'access.log'));
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    expect(seen).toEqual([]);
    expect(reader.status).toBe('no-logs');
  });

  it('never leaves the Host root through a linked folder', async () => {
    const { root, store } = await setup();
    const outside = await mkdtemp(path.join(tmpdir(), 'lookout-outside-'));
    await writeFile(path.join(outside, 'access.log'), caddyLog(requests(1)));
    await rm(path.join(root, 'var/log/caddy'), { recursive: true });
    await symlink(outside, path.join(root, 'var/log/caddy'));
    const seen: AccessEntry[] = [];
    const reader = follower(root, store, seen);
    await reader.poll();
    expect(seen).toEqual([]);
    expect(reader.status).toBe('no-logs');
  });
});
