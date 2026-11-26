import type { DiskFilesystem } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';
import { dfBlockUnitProbe, type BlockUnitProbe } from './block-size.ts';
import { percent } from './percent.ts';

export interface MountEntry {
  device: string;
  mountPoint: string;
  fsType: string;
}

/** Filesystem types that are not real storage, and are hidden like `df` hides them. */
const PSEUDO_FS_TYPES = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
  'nfsd',
  'fuse.lxcfs',
  'fuse.gvfsd-fuse',
  'fuse.portal',
  'fuse.snapfuse',
]);

/** Decodes the octal escapes the kernel uses in /proc/<pid>/mounts (\040 is a space). */
export function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

export function parseMounts(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const [device, mountPoint, fsType] = line.trim().split(/\s+/);
    if (!device || !mountPoint || !fsType) continue;
    entries.push({
      device: decodeMountField(device),
      mountPoint: decodeMountField(mountPoint),
      fsType,
    });
  }
  return entries;
}

/**
 * Keeps one entry per real filesystem: pseudo filesystems are dropped, and when a device is
 * mounted more than once (bind mounts), only its shortest mount point is kept, as `df` does.
 */
export function realFilesystems(entries: MountEntry[]): MountEntry[] {
  const byDevice = new Map<string, MountEntry>();
  for (const entry of entries) {
    if (PSEUDO_FS_TYPES.has(entry.fsType) || entry.fsType.startsWith('cgroup')) continue;
    if (entry.device === 'none' || entry.device === '') continue;
    const existing = byDevice.get(entry.device);
    if (!existing || entry.mountPoint.length < existing.mountPoint.length) {
      byDevice.set(entry.device, entry);
    }
  }
  return [...byDevice.values()].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
}

/** Reads disk space per real filesystem, caching each filesystem's block unit. */
export class DiskReader {
  readonly #hostRoot: HostRoot;
  readonly #probe: BlockUnitProbe;
  readonly #units = new Map<string, bigint>();

  constructor(hostRoot: HostRoot, probe: BlockUnitProbe = dfBlockUnitProbe) {
    this.#hostRoot = hostRoot;
    this.#probe = probe;
  }

  async read(): Promise<DiskFilesystem[]> {
    const mounts = realFilesystems(parseMounts(await this.#hostRoot.readText('proc/1/mounts')));
    const measured = await Promise.all(mounts.map((mount) => this.#measure(mount)));

    // Different device names can still be one filesystem (for example a bind mount of a
    // subdirectory, or a FUSE layer over another mount). Like df, keep one entry per st_dev,
    // with the shortest mount point.
    const byDev = new Map<bigint, { dev: bigint; disk: DiskFilesystem }>();
    for (const entry of measured) {
      if (!entry) continue;
      const existing = byDev.get(entry.dev);
      if (!existing || entry.disk.mountPoint.length < existing.disk.mountPoint.length) {
        byDev.set(entry.dev, entry);
      }
    }
    return [...byDev.values()]
      .map((entry) => entry.disk)
      .sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
  }

  async #measure(mount: MountEntry): Promise<{ dev: bigint; disk: DiskFilesystem } | null> {
    try {
      const [stats, info] = await Promise.all([
        this.#hostRoot.statfs(mount.mountPoint),
        this.#hostRoot.stat(mount.mountPoint),
      ]);
      if (stats.blocks === 0n) return null;
      const key = `${mount.device}\0${mount.mountPoint}`;
      let unit = this.#units.get(key);
      if (unit === undefined) {
        // df is handed the real path, already checked to be inside the Host root (#113).
        const real = await this.#hostRoot.resolve(mount.mountPoint);
        unit = await this.#probe(real, stats.blocks, stats.bsize);
        this.#units.set(key, unit);
      }
      const totalBytes = Number(stats.blocks * unit);
      const freeBytes = Number(stats.bavail * unit);
      const usedBytes = Number((stats.blocks - stats.bfree) * unit);
      return {
        dev: info.dev,
        disk: {
          mountPoint: mount.mountPoint,
          device: mount.device,
          fsType: mount.fsType,
          totalBytes,
          usedBytes,
          freeBytes,
          usagePercent: percent(usedBytes, usedBytes + freeBytes),
        },
      };
    } catch {
      // Unreadable mounts (permissions, stale network shares) are skipped, as df does, and so
      // is a mount point reached through a link out of the Host root (#113).
      return null;
    }
  }
}
