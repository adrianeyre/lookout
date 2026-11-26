import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostRoot } from '../host-root.ts';
import { fixture, makeHostRoot } from '../../test/helpers.ts';
import { DiskIoReader, isPhysicalDisk, parseDiskstats } from './disk-io.ts';

const diskstats = readFileSync(fixture('diskstats'), 'utf8');

/** A diskstats line for `device` with the given sector counters. */
const line = (device: string, sectorsRead: bigint, sectorsWritten: bigint) =>
  `   8       0 ${device} 1 0 ${sectorsRead} 0 1 0 ${sectorsWritten} 0 0 0 0 0 0 0 0 0 0\n`;

describe('parseDiskstats', () => {
  it('reads the sectors read and written', () => {
    const sda = parseDiskstats(diskstats).find((d) => d.device === 'sda');
    expect(sda).toEqual({ device: 'sda', sectorsRead: 9_000_000n, sectorsWritten: 4_000_000n });
  });
});

describe('isPhysicalDisk', () => {
  const names = parseDiskstats(diskstats).map((d) => d.device);

  it('keeps whole disks only, by name, without /sys/block', () => {
    expect(names.filter((name) => isPhysicalDisk(name, null))).toEqual([
      'sda',
      'nvme0n1',
      'mmcblk0',
    ]);
  });

  it('uses /sys/block when it can, which lists whole disks only', () => {
    const sysBlock = new Set([
      'loop0',
      'loop1',
      'sda',
      'nvme0n1',
      'mmcblk0',
      'dm-0',
      'md0',
      'ram0',
      'zram0',
    ]);
    expect(names.filter((name) => isPhysicalDisk(name, sysBlock))).toEqual([
      'sda',
      'nvme0n1',
      'mmcblk0',
    ]);
  });
});

describe('DiskIoReader', () => {
  async function reader(text: string, sysBlock?: string[]) {
    const files: Record<string, string> = { 'proc/diskstats': text };
    for (const name of sysBlock ?? []) files[`sys/block/${name}/dev`] = '8:0\n';
    const root = new HostRoot(await makeHostRoot(files));
    const clock = { now: 0 };
    return { root, clock, reader: new DiskIoReader(root, () => clock.now) };
  }

  it('reports null on the first read, then bytes/s', async () => {
    const { root, clock, reader: io } = await reader(line('sda', 0n, 0n), ['sda']);
    expect(await io.read()).toEqual([
      { device: 'sda', readBytesPerSecond: null, writeBytesPerSecond: null },
    ]);
    // 2048 sectors read (1 MiB) and 4096 written (2 MiB) over two seconds.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(root.path('proc/diskstats'), line('sda', 2048n, 4096n));
    clock.now = 2000;
    expect(await io.read()).toEqual([
      { device: 'sda', readBytesPerSecond: 512 * 1024, writeBytesPerSecond: 1024 * 1024 },
    ]);
  });

  it('survives a 32-bit counter wrapping', async () => {
    const { root, clock, reader: io } = await reader(line('sda', 2n ** 32n - 1024n, 0n));
    await io.read();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(root.path('proc/diskstats'), line('sda', 1024n, 0n));
    clock.now = 1000;
    const [sda] = await io.read();
    expect(sda!.readBytesPerSecond).toBe(2048 * 512);
  });

  it('drops partitions, loop, ram and device-mapper devices from the fixture', async () => {
    const { reader: io } = await reader(diskstats);
    expect((await io.read()).map((d) => d.device)).toEqual(['mmcblk0', 'nvme0n1', 'sda']);
  });
});
