import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostRoot } from '../host-root.ts';
import { fixture, makeHostRoot } from '../../test/helpers.ts';
import { blockUnitFrom, parseDfTotalKiB } from './block-size.ts';
import { DiskReader, decodeMountField, parseMounts, realFilesystems } from './disks.ts';

const dockerHostMounts = readFileSync(fixture('mounts-docker-host'), 'utf8');

describe('decodeMountField', () => {
  it('decodes the kernel octal escapes', () => {
    expect(decodeMountField('/mnt/media\\040library')).toBe('/mnt/media library');
    expect(decodeMountField('/a\\011b\\012c\\134d')).toBe('/a\tb\nc\\d');
  });
});

describe('realFilesystems', () => {
  it('keeps only real filesystems from a Docker Host, one per device', () => {
    const filesystems = realFilesystems(parseMounts(dockerHostMounts));
    expect(filesystems).toEqual([
      { device: '/dev/mapper/vg0-root', mountPoint: '/', fsType: 'ext4' },
      { device: '/dev/sda1', mountPoint: '/boot', fsType: 'ext4' },
      { device: '/dev/sda15', mountPoint: '/boot/efi', fsType: 'vfat' },
      { device: '/dev/sdb1', mountPoint: '/mnt/media library', fsType: 'ext4' },
    ]);
  });

  it('drops tmpfs, overlay, squashfs and other pseudo filesystems', () => {
    const types = new Set(realFilesystems(parseMounts(dockerHostMounts)).map((m) => m.fsType));
    for (const pseudo of ['tmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup2', 'nsfs']) {
      expect(types.has(pseudo)).toBe(false);
    }
  });

  it('keeps the shortest mount point of a bind-mounted device, as df does', () => {
    const mounts = parseMounts(
      '/dev/sdb1 /srv/backups ext4 rw 0 0\n/dev/sdb1 /mnt/media ext4 rw 0 0\n',
    );
    expect(realFilesystems(mounts).map((m) => m.mountPoint)).toEqual(['/mnt/media']);
  });

  it('keeps "/" for the root device even if a bind mount is listed first', () => {
    const mounts = parseMounts('/dev/sda2 /var/lib/x ext4 rw 0 0\n/dev/sda2 / ext4 rw 0 0\n');
    expect(realFilesystems(mounts).map((m) => m.mountPoint)).toEqual(['/']);
  });
});

describe('DiskReader', () => {
  const bsizeProbe = (_path: string, _blocks: bigint, bsize: bigint) => Promise.resolve(bsize);

  it('runs statfs under the Host root and reports sizes like df', async () => {
    const root = await makeHostRoot({
      'proc/1/mounts': '/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/data\\040disk ext4 rw 0 0\n',
      'mnt/data disk/.keep': '',
    });
    // Both fixture "devices" are really the same temporary filesystem, so a real Host
    // would list them once; check the sizes on the first.
    const disks = await new DiskReader(new HostRoot(root), bsizeProbe).read();
    expect(disks.map((d) => d.mountPoint)).toEqual(['/']);
    const [disk] = disks;
    expect(disk!.totalBytes).toBeGreaterThan(0);
    expect(disk!.usedBytes + disk!.freeBytes).toBeLessThanOrEqual(disk!.totalBytes);
    expect(disk!.usagePercent).toBeGreaterThanOrEqual(0);
    expect(disk!.usagePercent).toBeLessThanOrEqual(100);
  });

  it('uses the calibrated block unit, once per filesystem', async () => {
    const root = await makeHostRoot({ 'proc/1/mounts': '/dev/sda1 / ext4 rw 0 0\n' });
    let calls = 0;
    const reader = new DiskReader(new HostRoot(root), (_path, _blocks, bsize) => {
      calls += 1;
      return Promise.resolve(bsize * 2n);
    });
    const withBsize = await new DiskReader(new HostRoot(root), bsizeProbe).read();
    const [first] = await reader.read();
    await reader.read();
    expect(calls).toBe(1);
    expect(first!.totalBytes).toBe(withBsize[0]!.totalBytes * 2);
  });

  it('skips mount points it cannot stat', async () => {
    const root = await makeHostRoot({ 'proc/1/mounts': '/dev/sdz1 /missing ext4 rw 0 0\n' });
    expect(await new DiskReader(new HostRoot(root), bsizeProbe).read()).toEqual([]);
  });
});

describe('block unit calibration', () => {
  it('reads the total from df -P -k', () => {
    const output = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      'virtiofs0       1948403712 274430976 1673972736      15% /host/run/host_virtiofs/Users',
    ].join('\n');
    expect(parseDfTotalKiB(output)).toBe(1948403712n);
    expect(parseDfTotalKiB('garbage')).toBeNull();
  });

  it('recovers f_frsize where it differs from f_bsize', () => {
    // virtiofs on a real Host: f_bsize 1 MiB, f_frsize 4 KiB, 487101010 blocks.
    expect(blockUnitFrom(1948403712n * 1024n, 487101010n)).toBe(4096n);
    expect(blockUnitFrom(0n, 10n)).toBeNull();
  });
});
