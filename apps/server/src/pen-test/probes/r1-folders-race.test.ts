/**
 * Pen-test scope issue R1 (#68): the Largest folders walk and links (H14). The walk lstats
 * each entry, then opens a directory by its path, so a Container that swaps one of its own
 * directories for a link between the two (its volume and writable layer are on the Host's
 * disk) sends the walk wherever the link points. The race is made deterministic here by
 * answering the lstat as the directory it was a moment before. Findings: docs/pen-test/findings/R1.md.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { walkFilesystem } from '../../folders/scan.ts';

/**
 * Names whose lstat answers as the directory they were before the swap. Keyed by the last
 * path component, because on Linux the walk reaches a child through its parent's handle
 * (/proc/self/fd/N/<name>), not by the path from the root.
 */
const swapped = new Map<string, string>();
const swappedFor = (target: string) => swapped.get(path.basename(target));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (async (target: string, ...rest: unknown[]) => {
      const before = swappedFor(target);
      return (real.lstat as (...args: unknown[]) => unknown)(before ?? target, ...rest);
    }) as typeof real.lstat,
  };
});

const MiB = 1024 * 1024;
const temps: string[] = [];
afterEach(async () => {
  swapped.clear();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A Host with a Hostile Container's volume, and a private folder elsewhere on the same disk. */
async function setUp() {
  const root = await tempDir('lookout-r1-race-');
  const volume = path.join(root, 'var/lib/docker/volumes/hostile/_data');
  const before = path.join(volume, 'was-a-folder');
  await mkdir(before, { recursive: true });
  // Elsewhere on the same filesystem: the Host's own folder the link points at.
  const elsewhere = await tempDir('lookout-r1-elsewhere-');
  const target = path.join(elsewhere, 'private-project');
  await mkdir(target);
  for (let i = 0; i < 4; i++) await writeFile(path.join(target, `p${i}`), Buffer.alloc(MiB, 1));
  const link = path.join(volume, 'swapped');
  await symlink(target, link);
  return { root, before, link };
}

describe('R1 H14: the folder walk and links', () => {
  it('never follows a link it sees as a link (sound)', async () => {
    const { root } = await setUp();
    const { candidates } = await walkFilesystem(root, '/');
    expect(candidates.map((c) => c.path).join('\n')).not.toContain('swapped');
  });

  it('never walks through a directory swapped for a link between lstat and opendir', async () => {
    const { root, before, link } = await setUp();
    swapped.set(path.basename(link), before);
    const { candidates } = await walkFilesystem(root, '/');
    expect(candidates.map((c) => c.path).join('\n')).not.toContain('swapped');
  });

  it("a swapped directory is not followed: the link's target is never counted (#110) (regression)", async () => {
    const { root, before, link } = await setUp();
    swapped.set(path.basename(link), before);
    // The mock is live: lstat now says the link is the directory it was.
    expect((await fs.lstat(link)).isDirectory()).toBe(true);
    const { candidates } = await walkFilesystem(root, '/');
    const total = candidates.reduce((sum, c) => sum + c.bytes, 0);
    expect(candidates.map((c) => c.path).join('\n')).not.toContain('swapped');
    // The 4 MiB of private-project, elsewhere on the disk, is nowhere in the sizes.
    expect(total).toBeLessThan(4 * MiB);
  });

  it('a mount point that is itself a link is not walked (#110) (regression)', async () => {
    const { root, link } = await setUp();
    const mountLink = path.join(root, 'mnt/linked');
    await mkdir(path.dirname(mountLink), { recursive: true });
    // Points at the folder holding private-project, elsewhere on the disk.
    await symlink(path.dirname(await realpath(link)), mountLink);
    expect((await fs.lstat(mountLink)).isSymbolicLink()).toBe(true);
    const { candidates, walked } = await walkFilesystem(mountLink, '/mnt/linked');
    expect(candidates).toEqual([]);
    expect(walked).toBe(0);
  });
});
