import { chmod, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiskFilesystem } from '@lookout/shared';
import { HostRoot } from '../host-root.ts';
import { FolderScanner, SCAN_FAILED, ScanBudget, pickHeaviest, walkFilesystem } from './scan.ts';

const MiB = 1024 * 1024;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(path.join(root, 'locked'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

/** A made-up Host: files of real sizes, so their disk blocks are counted. */
async function host(files: Record<string, number>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lookout-folders-'));
  roots.push(root);
  for (const [file, bytes] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.alloc(bytes, 1));
  }
  return root;
}

describe('pickHeaviest', () => {
  it('takes the heaviest, never one inside another', () => {
    const picked = pickHeaviest(
      [
        { path: '/var/lib/docker', bytes: 90 },
        { path: '/var/lib/docker/volumes', bytes: 60 },
        { path: '/home/alice', bytes: 50 },
        { path: '/srv', bytes: 40 },
        { path: '/srv/media', bytes: 39 },
      ],
      3,
    );
    expect(picked.map((c) => c.path)).toEqual(['/var/lib/docker', '/home/alice', '/srv']);
  });

  it('does not treat a sibling with a longer name as inside', () => {
    const picked = pickHeaviest([
      { path: '/srv', bytes: 10 },
      { path: '/srv2', bytes: 9 },
    ]);
    expect(picked.map((c) => c.path)).toEqual(['/srv', '/srv2']);
  });
});

describe('walkFilesystem', () => {
  it('finds the folders where the space is, not the paths to them', async () => {
    const root = await host({
      'var/lib/docker/volumes/db/data': 6 * MiB,
      'var/lib/docker/volumes/media/data': 5 * MiB,
      'var/log/syslog': 64 * 1024,
      'srv/photos/a.bin': 2 * MiB,
      'srv/photos/b.bin': 2 * MiB,
    });
    const result = await walkFilesystem(root, '/');
    const picked = pickHeaviest(result.candidates).map((c) => c.path);
    // /var is nearly all /var/lib, which is all /var/lib/docker, and so on down to volumes,
    // whose space is spread over two folders.
    expect(picked[0]).toBe('/var/lib/docker/volumes');
    expect(picked).toContain('/srv/photos');
    expect(picked).not.toContain('/var');
    expect(picked).not.toContain('/var/lib');
    expect(result.unreadable).toBe(0);
  });

  it('counts a hard-linked file once', async () => {
    const root = await host({ 'a/one': 4 * MiB, 'a/three': 3 * MiB, 'b/small': 64 * 1024 });
    await link(path.join(root, 'a/one'), path.join(root, 'a/two'));
    const result = await walkFilesystem(root, '/');
    const a = result.candidates.find((c) => c.path === '/a');
    // 7 MiB of files, not 11: the second name for "one" adds nothing.
    expect(a?.bytes).toBeGreaterThanOrEqual(7 * MiB);
    expect(a?.bytes).toBeLessThan(8 * MiB);
  });

  it('never walks into proc, sys, dev or run at a filesystem’s root', async () => {
    const root = await host({ 'proc/kcore': 3 * MiB, 'srv/x': MiB, 'srv/y': MiB });
    const result = await walkFilesystem(root, '/');
    expect(result.candidates.map((c) => c.path)).not.toContain('/proc');
  });

  it.skipIf(process.getuid?.() === 0)('counts folders it cannot read', async () => {
    const root = await host({ 'locked/secret': MiB, 'open/a': MiB });
    await chmod(path.join(root, 'locked'), 0o000);
    const result = await walkFilesystem(root, '/');
    expect(result.unreadable).toBe(1);
  });

  it('names folders under another mount point by their Host path', async () => {
    const root = await host({ 'media/films/a': MiB, 'media/films/b': MiB });
    const result = await walkFilesystem(path.join(root, 'media'), '/srv/media');
    expect(result.candidates.map((c) => c.path)).toContain('/srv/media/films');
  });
});

describe('FolderScanner', () => {
  const disk = (mountPoint: string): DiskFilesystem => ({
    mountPoint,
    device: '/dev/test',
    fsType: 'ext4',
    totalBytes: 100 * MiB,
    usedBytes: 20 * MiB,
    freeBytes: 80 * MiB,
    usagePercent: 20,
  });

  async function scanner(intervalHours = 0) {
    const root = await host({ 'srv/media/a': 3 * MiB, 'srv/media/b': 3 * MiB, 'opt/x': MiB });
    return new FolderScanner({
      hostRoot: new HostRoot(root),
      disks: async () => [disk('/')],
      intervalHours,
      firstDelayMs: 60_000,
      now: () => 1_000_000,
    });
  }

  it('scans when asked, reports each change, and gives each folder its share of its disk', async () => {
    const folders = await scanner();
    const states: string[] = [];
    folders.subscribe((scan) => states.push(scan.state));
    expect(folders.scanNow().result).toBe('started');
    expect(folders.scanNow().result).toBe('busy');
    await folders.settled();
    const scan = folders.snapshot;
    expect(states[0]).toBe('scanning');
    expect(states.at(-1)).toBe('done');
    expect(scan.folders[0]).toMatchObject({ path: '/srv/media', mountPoint: '/' });
    expect(scan.folders[0]!.percentOfDisk).toBeCloseTo(
      (scan.folders[0]!.bytes / (100 * MiB)) * 100,
    );
    expect(scan.walked).toBeGreaterThan(0);
    expect(scan.finishedAt).toBe(1_000_000);
  });

  it('with an interval of 0, never scans by itself', async () => {
    const folders = await scanner(0);
    folders.start();
    expect(folders.snapshot).toMatchObject({ state: 'waiting', nextAt: null });
    await folders.stop();
  });

  it('with an interval, says when it will scan next', async () => {
    const folders = await scanner(6);
    folders.start();
    expect(folders.snapshot.nextAt).toBe(1_000_000 + 60_000);
    await folders.stop();
  });

  it('skips a filesystem it cannot reach, logging why, and scans the rest (#111)', async () => {
    const warnings: string[] = [];
    const folders = new FolderScanner({
      hostRoot: new HostRoot('/nonexistent-lookout-root'),
      disks: async () => [disk('/')],
      intervalHours: 0,
      log: { warn: (_object, message) => warnings.push(message) },
    });
    folders.scanNow();
    await folders.settled();
    expect(folders.snapshot.state).toBe('done');
    expect(warnings).toEqual(['Folder scan skipped a filesystem']);
  });

  it('reports a failed scan without throwing, in fixed text (#111)', async () => {
    const folders = new FolderScanner({
      hostRoot: new HostRoot('/nonexistent-lookout-root'),
      disks: () => Promise.reject(new Error("ENOENT: no such file, open '/host/proc/1/mounts'")),
      intervalHours: 0,
      log: { warn: () => undefined },
    });
    folders.scanNow();
    await folders.settled();
    expect(folders.snapshot.state).toBe('failed');
    expect(folders.snapshot.error).toBe(SCAN_FAILED);
  });

  it('never walks /home or /root, nor a filesystem mounted there (#107)', async () => {
    const root = await host({
      'home/alice/secret-project/a.bin': 2 * MiB,
      'home/alice/secret-project/b.bin': 2 * MiB,
      'root/private/c.bin': 2 * MiB,
      'srv/photos/a.bin': MiB,
      'srv/photos/b.bin': MiB,
    });
    const result = await walkFilesystem(root, '/');
    const paths = result.candidates.map((c) => c.path).join(' ');
    expect(paths).toContain('/srv/photos');
    expect(paths).not.toMatch(/home|root|alice|secret/);
    const mounted = await walkFilesystem(path.join(root, 'home'), '/home');
    expect(mounted.candidates).toEqual([]);
    expect(mounted.walked).toBe(0);
  });

  it('stops at its entry limit and says the result is partial (#109)', async () => {
    const files: Record<string, number> = {};
    for (let i = 0; i < 50; i++) files[`many/f${i}`] = 1024;
    const root = await host(files);
    expect((await walkFilesystem(root, '/')).partial).toBe(false);
    const limited = await walkFilesystem(root, '/', { budget: new ScanBudget({ entries: 10 }) });
    expect(limited.partial).toBe(true);
  });

  it('stops at its time limit and says the result is partial (#109)', async () => {
    const root = await host({ 'a/one': 1024, 'a/two': 1024 });
    let now = 0;
    const budget = new ScanBudget({ durationMs: 1000 }, () => (now += 600));
    expect((await walkFilesystem(root, '/', { budget })).partial).toBe(true);
  });

  it('does not walk below its depth limit, and says so (#109)', async () => {
    const root = await host({ 'a/b/c/d/e/deep.bin': MiB });
    const limited = await walkFilesystem(root, '/', { budget: new ScanBudget({ depth: 3 }) });
    expect(limited.partial).toBe(true);
    expect(limited.candidates.map((c) => c.path).join(' ')).not.toContain('/a/b/c/d');
  });
});
