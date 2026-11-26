/**
 * Pen-test scope issue R1 (#68): the Host root and Host Metrics, probed in-process (H14).
 * Findings are in docs/pen-test/findings/R1.md. While a gap is open, an `it.fails` states
 * the property that should hold beside a `today_…` test pinning what happens now (PRD,
 * "Checks every scope issue carries").
 *
 * Every Host root here is a temporary directory. Where a probe needs somewhere "outside the
 * Host root", that is another temporary directory, never a real system file.
 */
import { readFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDER_SCAN_PATH, type DiskFilesystem } from '@lookout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderScanner, ScanBudget, walkFilesystem } from '../../folders/scan.ts';
import { HostRoot } from '../../host-root.ts';
import { DiskReader } from '../../metrics/disks.ts';
import { readOverview } from '../../metrics/overview.ts';
import { ORIGIN, HOST, startProbeApp, type ProbeApp } from './harness.ts';

const MiB = 1024 * 1024;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));

const temps: string[] = [];
let probe: ProbeApp | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  // realpath: on macOS tmpdir() is itself reached through a link (/var → /private/var).
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

async function write(root: string, file: string, content: string | Buffer) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** A Host root, and a directory beside it that stands for "outside the Host root". */
async function hostAndOutside() {
  const root = await tempDir('lookout-r1-host-');
  const outside = await tempDir('lookout-r1-outside-');
  await write(root, 'proc/1/mounts', '');
  await write(outside, 'os-release', 'PRETTY_NAME="Outside the Host root"\n');
  await mkdir(path.join(outside, 'data'), { recursive: true });
  return { root, outside };
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + path.sep);

describe('R1 H14: HostRoot containment by path text', () => {
  it('refuses textual escapes: .., encoded and absolute forms stay under the root (sound)', async () => {
    const { root } = await hostAndOutside();
    const hostRoot = new HostRoot(root);
    for (const escape of ['../etc/passwd', '/../../etc', 'proc/../../..', '..']) {
      expect(() => hostRoot.path(escape), escape).toThrow(/escapes the Host root/);
    }
    // Percent-encoding is not decoded, and a leading / is the Host's /, not the Container's.
    expect(hostRoot.path('%2e%2e/etc')).toBe(path.join(root, '%2e%2e/etc'));
    expect(hostRoot.path('/etc/hostname')).toBe(path.join(root, 'etc/hostname'));
  });

  it('skips a mount table entry that escapes by path text (sound)', async () => {
    const { root } = await hostAndOutside();
    await write(root, 'proc/1/mounts', '/dev/evil /..\\057..\\057.. ext4 rw 0 0\n');
    const seen: string[] = [];
    const disks = await new DiskReader(new HostRoot(root), async (p, _b, bsize) => {
      seen.push(p);
      return bsize;
    }).read();
    expect(disks).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('never reads a Host file through a link that leaves the Host root', async () => {
    const { root, outside } = await hostAndOutside();
    await write(root, 'proc/uptime', '1.00 1.00\n');
    await mkdir(path.join(root, 'etc'), { recursive: true });
    await symlink(path.join(outside, 'os-release'), path.join(root, 'etc/os-release'));
    const overview = await readOverview(new HostRoot(root));
    expect(overview.os).not.toContain('Outside the Host root');
  });

  it('etc/os-release through an absolute link out of the root is not read: the OS falls back, a relative link inside it is read (#113) (regression)', async () => {
    const { root, outside } = await hostAndOutside();
    await write(root, 'proc/uptime', '1.00 1.00\n');
    await mkdir(path.join(root, 'etc'), { recursive: true });
    // On a real Host an absolute link resolves inside Lookout's Container, not the Host
    // (NixOS's /etc/os-release → /etc/static/os-release is one).
    await symlink(path.join(outside, 'os-release'), path.join(root, 'etc/os-release'));
    expect((await readOverview(new HostRoot(root))).os).toBe('Linux');
    // Debian's own relative link, which stays inside the root, still works.
    await write(root, 'usr/lib/os-release', 'PRETTY_NAME="Inside the Host root"\n');
    await rm(path.join(root, 'etc/os-release'));
    await symlink('../usr/lib/os-release', path.join(root, 'etc/os-release'));
    expect((await readOverview(new HostRoot(root))).os).toBe('Inside the Host root');
  });

  it('measures no mount point that is reached through a link out of the Host root', async () => {
    const { root, outside } = await hostAndOutside();
    await mkdir(path.join(root, 'mnt'), { recursive: true });
    await symlink(path.join(outside, 'data'), path.join(root, 'mnt/linked'));
    await write(root, 'proc/1/mounts', '/dev/sdz1 /mnt/linked ext4 rw 0 0\n');
    const disks = await new DiskReader(new HostRoot(root), async (_p, _b, bsize) => bsize).read();
    expect(disks.map((d) => d.mountPoint)).not.toContain('/mnt/linked');
  });

  it('stat, statfs and df never land on a link target outside the Host root; a mount point inside it is still measured (#113) (regression)', async () => {
    const { root, outside } = await hostAndOutside();
    await mkdir(path.join(root, 'mnt'), { recursive: true });
    await symlink(path.join(outside, 'data'), path.join(root, 'mnt/linked'));
    // A relative link climbs out of the root too: from <root>/mnt, ../../ is the root's parent.
    await symlink(
      path.relative(path.join(root, 'mnt'), path.join(outside, 'data')),
      path.join(root, 'mnt/relative'),
    );
    await mkdir(path.join(root, 'mnt/real'), { recursive: true });
    await write(
      root,
      'proc/1/mounts',
      '/dev/sdz1 /mnt/linked ext4 rw 0 0\n/dev/sdz2 /mnt/relative ext4 rw 0 0\n/dev/sdz3 /mnt/real ext4 rw 0 0\n',
    );
    const dfPaths: string[] = [];
    const disks = await new DiskReader(new HostRoot(root), async (p, _b, bsize) => {
      dfPaths.push(p);
      return bsize;
    }).read();
    // Neither linked mount point is measured; the real one is, and df gets its real path.
    expect(disks.map((d) => d.mountPoint)).toEqual(['/mnt/real']);
    expect(dfPaths).toEqual([path.join(root, 'mnt/real')]);
    for (const p of dfPaths) expect(inside(await realpath(p), root)).toBe(true);
  });
});

/** A HostRoot that records every Host path it is asked for. */
class RecordingHostRoot extends HostRoot {
  readonly asked = new Set<string>();
  override path(hostPath: string): string {
    this.asked.add(hostPath);
    return super.path(hostPath);
  }
}

describe('R1: no route, label or setting feeds a path into HostRoot', () => {
  const FIXED = new Set([
    'proc/stat',
    'proc/loadavg',
    'proc/meminfo',
    'proc/uptime',
    'proc/diskstats',
    'proc/1/mounts',
    'proc/1/net/dev',
    'proc/sys/kernel/hostname',
    'proc/sys/kernel/osrelease',
    'etc/hostname',
    'etc/os-release',
    'usr/lib/os-release',
    'sys/block',
  ]);

  it('asks HostRoot only for fixed paths and the mount table, whatever a request carries (sound)', async () => {
    const root = await tempDir('lookout-r1-routes-');
    const fixtureHost = path.join(REPO, 'e2e/fixtures/host');
    await mkdir(path.join(root, 'mnt'), { recursive: true });
    for (const file of ['proc/1/mounts', 'proc/stat', 'proc/meminfo', 'proc/loadavg']) {
      await write(root, file, readFileSync(path.join(fixtureHost, file)));
    }
    await write(root, 'proc/uptime', '100.00 50.00\n');
    await write(root, 'proc/1/mounts', '/dev/sda1 / ext4 rw 0 0\n');
    const hostRoot = new RecordingHostRoot(root);
    probe = await startProbeApp({
      hostRoot,
      startSampler: true,
      startFolderScanner: false,
      blockUnitProbe: async (_p, _b, bsize) => bsize,
    });
    const cookie = await probe.signIn();
    const hostile = '/../../etc/shadow';
    const enc = encodeURIComponent(hostile);
    const headers = { cookie, origin: ORIGIN, host: HOST, 'x-host-path': hostile };
    const requests: { method: 'GET' | 'POST'; url: string; payload?: Record<string, string> }[] = [
      { method: 'GET', url: `/api/session?path=${enc}` },
      { method: 'GET', url: `/api/docker/status?path=${enc}` },
      { method: 'GET', url: `/api/containers?path=${enc}` },
      { method: 'GET', url: `/api/containers/${enc}` },
      { method: 'GET', url: `/api/containers/x/env/${enc}` },
      { method: 'GET', url: `/api/sites?path=${enc}` },
      { method: 'POST', url: `/api/sites/${enc}/check`, payload: { path: hostile } },
      { method: 'GET', url: `/api/folders?path=${enc}&root=${enc}` },
      {
        method: 'POST',
        url: `${FOLDER_SCAN_PATH}?path=${enc}`,
        payload: { path: hostile, root: hostile },
      },
      { method: 'GET', url: `/api/host/${enc}` },
      { method: 'GET', url: `/${enc}` },
    ];
    for (const request of requests) {
      const response = await probe.app.inject({ ...request, headers });
      expect(response.statusCode, request.url).toBeLessThan(500);
    }
    // Let the sampler and the scan that POST started read what they read.
    await vi.waitFor(() => expect(hostRoot.asked.has('proc/stat')).toBe(true), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mountPoints = new Set(['/']);
    for (const asked of hostRoot.asked) {
      expect(FIXED.has(asked) || mountPoints.has(asked), asked).toBe(true);
      expect(asked).not.toContain('shadow');
    }
  });

  it('LOOKOUT_HOST_ROOT is the only setting that names a Host path, and it must be absolute (sound)', () => {
    const source = readFileSync(path.join(REPO, 'apps/server/src/config.ts'), 'utf8');
    const pathSettings = [...source.matchAll(/read\('(LOOKOUT_[A-Z_]+)'/g)]
      .map((m) => m[1])
      .filter((name) => /ROOT|PATH|DIR|FILE|MOUNT/.test(name!));
    expect(pathSettings).toEqual(['LOOKOUT_HOST_ROOT']);
    expect(source).toMatch(/LOOKOUT_HOST_ROOT must be an absolute path/);
  });

  it('no label is read as a Host path: discovery and actions never reach HostRoot (sound)', () => {
    for (const file of [
      'apps/server/src/sites/discovery.ts',
      'apps/server/src/sites/monitor.ts',
      'apps/server/src/sites/check.ts',
      'apps/server/src/docker/parse.ts',
      'apps/server/src/docker/store.ts',
      'packages/shared/src/actions.ts',
    ]) {
      const source = readFileSync(path.join(REPO, file), 'utf8');
      expect(source, file).not.toMatch(/HostRoot|hostRoot|node:fs/);
    }
  });
});

const disk = (mountPoint: string, totalBytes = 100 * MiB): DiskFilesystem => ({
  mountPoint,
  device: '/dev/sdz1',
  fsType: 'ext4',
  totalBytes,
  usedBytes: 0,
  freeBytes: totalBytes,
  usagePercent: 0,
});

describe('R1: the Largest folders scan reads beyond statfs (FR-14a)', () => {
  it('the scan never lists a folder under /home or /root, however big (#107) (regression)', async () => {
    const root = await tempDir('lookout-r1-folders-');
    for (let i = 0; i < 4; i++) {
      await write(root, `home/owner/client-acme-merger/part${i}.bin`, Buffer.alloc(MiB, 1));
      await write(root, `root/private/part${i}.bin`, Buffer.alloc(MiB, 1));
      await write(root, `srv/media/part${i}.bin`, Buffer.alloc(MiB / 4, 1));
    }
    await write(root, 'home/owner/notes.txt', 'x');
    await write(root, 'srv/media/other/x.bin', Buffer.alloc(MiB / 4, 1));
    const { candidates } = await walkFilesystem(root, '/');
    const paths = candidates.map((c) => c.path);
    // The scan still lists folder names elsewhere (the v1 review item 4 half, above).
    expect(paths).toContain('/srv/media');
    expect(paths.join(' ')).not.toMatch(/home|root|acme|private/);
  });

  it("the v1 review's item 4 describes what Lookout reads under a mount point", () => {
    // Item 4 says mount points "are only statfs'ed, never read"; the scan opens every folder.
    const review = readFileSync(path.join(REPO, 'docs/security-review-v1.md'), 'utf8');
    const item4 = review.split('\n').find((line) => line.startsWith('| 4 |'))!;
    expect(item4).not.toMatch(/only `?statfs`?ed, never read/);
  });

  it('never advises running Lookout as root', () => {
    const page = readFileSync(path.join(REPO, 'apps/web/src/pages/HostPage.tsx'), 'utf8');
    expect(page).not.toMatch(/user: &quot;0:0&quot;|Run Lookout as root/);
  });

  it('the Widget says folders could not be read, and nothing about root (#108) (regression)', () => {
    const page = readFileSync(path.join(REPO, 'apps/web/src/pages/HostPage.tsx'), 'utf8');
    expect(page).toContain('could not be read, so these sizes leave');
    expect(page).not.toMatch(/as root|0:0/);
  });
});

describe('R1: the folder scan is bounded by Lookout, not by the Host (a Container is an input)', () => {
  /** Counts the "dev:ino" keys the walk adds to its hard-link set. */
  async function hardLinkKeys(count: number, limit?: number): Promise<number> {
    const root = await tempDir('lookout-r1-links-');
    // What any Container can do in its own volume or writable layer, both on the Host's disk.
    const dir = path.join(root, 'var/lib/docker/volumes/hostile/_data');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      await writeFile(path.join(dir, `f${i}`), '');
      await link(path.join(dir, `f${i}`), path.join(dir, `g${i}`));
    }
    let keys = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own `this` below
    const add = Set.prototype.add;
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown,
    ) {
      if (typeof value === 'string' && /^\d+:\d+$/.test(value)) keys += 1;
      return add.call(this, value);
    });
    try {
      await walkFilesystem(root, '/', {
        budget: new ScanBudget(limit === undefined ? {} : { hardLinks: limit }),
      });
    } finally {
      spy.mockRestore();
    }
    return keys;
  }

  const BOUND = 1024;

  it('holds a bounded number of hard-link keys, however many a Container makes', async () => {
    // FOLDER_SCAN_LIMITS.hardLinks is 1,000,000; the same cap, made small.
    expect(await hardLinkKeys(BOUND + 500, BOUND)).toBeLessThanOrEqual(BOUND);
  }, 60_000);

  it('below its cap, holds one key per hard-linked file, so each is counted once (#109) (regression)', async () => {
    expect(await hardLinkKeys(BOUND + 500)).toBe(BOUND + 500);
  }, 60_000);
});

describe('R1: a failed scan', () => {
  async function failedScan() {
    const root = await tempDir('lookout-r1-failed-');
    const scanner = new FolderScanner({
      hostRoot: new HostRoot(root),
      // A mount point Disk space listed that is gone (unmounted, or not searchable) by the walk.
      disks: async () => [disk('/mnt/gone')],
      intervalHours: 0,
      log: { warn: () => undefined },
    });
    scanner.scanNow();
    await scanner.settled();
    return { root, snapshot: scanner.snapshot };
  }

  it("sends a fixed text, not Node's error with the path under the Host root", async () => {
    const root = await tempDir('lookout-r1-failed-');
    const scanner = new FolderScanner({
      hostRoot: new HostRoot(root),
      disks: () => Promise.reject(new Error(`ENOENT: no such file, open '${root}/proc/1/mounts'`)),
      intervalHours: 0,
      log: { warn: () => undefined },
    });
    scanner.scanNow();
    await scanner.settled();
    expect(scanner.snapshot.state).toBe('failed');
    expect(scanner.snapshot.error).not.toMatch(/ENOENT|EACCES|lstat|\//);
  });

  it('a mount point that has gone skips only itself: the scan finishes, with no path in it (#111) (regression)', async () => {
    const { snapshot } = await failedScan();
    expect(snapshot.state).toBe('done');
    expect(snapshot.error).toBeNull();
  });
});

describe('R1: folder names are Container text', () => {
  const page = () => readFileSync(path.join(REPO, 'apps/web/src/pages/HostPage.tsx'), 'utf8');
  const folderPathCell = () => {
    const at = page().indexOf('data-testid="folder-path"');
    return page().slice(at - 80, at + 120);
  };

  it('isolates a folder path in <bdi>, like every other piece of Container text (#89)', () => {
    expect(folderPathCell()).toMatch(/<bdi>\s*\{folder\.path\}\s*<\/bdi>/);
  });

  it('never renders {folder.path} bare (#112) (regression)', () => {
    expect(folderPathCell()).not.toMatch(/>\s*\{folder\.path\}\s*<\/span>/);
  });
});
