import type { DiskIo } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';
import { RateTracker, parseCounter } from './counters.ts';

/** Bytes per sector in /proc/diskstats, whatever the device's real sector size. */
const SECTOR_BYTES = 512;

export interface DiskCounters {
  device: string;
  /** Raw sector counters: wraparound is detected on these, before scaling to bytes. */
  sectorsRead: bigint;
  sectorsWritten: bigint;
}

/** Parses /proc/diskstats: major minor name reads merged sectors-read ms writes merged sectors-written … */
export function parseDiskstats(text: string): DiskCounters[] {
  const out: DiskCounters[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const device = fields[2];
    const sectorsRead = parseCounter(fields[5]);
    const sectorsWritten = parseCounter(fields[9]);
    if (!device || sectorsRead === null || sectorsWritten === null) continue;
    out.push({ device, sectorsRead, sectorsWritten });
  }
  return out;
}

/** Virtual block devices, and device-mapper and RAID devices that repeat their disks' I/O. */
const NOT_PHYSICAL = /^(loop|ram|zram|dm-|md|nbd|fd)\d/;

/** Partition names, for when the Host's /sys/block cannot be read. */
const PARTITION = /^((sd|vd|xvd|hd)[a-z]+\d+|(nvme\d+n\d+|mmcblk\d+)p\d+)$/;

/**
 * Whether a diskstats device is a whole physical disk. /sys/block lists whole disks only
 * (partitions live under their disk), so it is used when available; otherwise partitions
 * are recognised by name.
 */
export function isPhysicalDisk(device: string, wholeDisks: ReadonlySet<string> | null): boolean {
  if (NOT_PHYSICAL.test(device)) return false;
  return wholeDisks ? wholeDisks.has(device) : !PARTITION.test(device);
}

/** Read and write throughput per physical disk, from successive diskstats reads (FR-10). */
export class DiskIoReader {
  readonly #hostRoot: HostRoot;
  readonly #now: () => number;
  readonly #rates = new RateTracker<'read' | 'write'>();

  constructor(hostRoot: HostRoot, now: () => number = () => performance.now()) {
    this.#hostRoot = hostRoot;
    this.#now = now;
  }

  async read(): Promise<DiskIo[]> {
    const [text, sysBlock] = await Promise.all([
      this.#hostRoot.readText('proc/diskstats'),
      this.#hostRoot.readDirOrNull('sys/block'),
    ]);
    const wholeDisks = sysBlock ? new Set(sysBlock) : null;
    const disks = parseDiskstats(text).filter((disk) => isPhysicalDisk(disk.device, wholeDisks));
    const rates = this.#rates.rates(
      this.#now(),
      new Map(disks.map((d) => [d.device, { read: d.sectorsRead, write: d.sectorsWritten }])),
    );
    const bytes = (sectorsPerSecond: number | null) =>
      sectorsPerSecond === null ? null : sectorsPerSecond * SECTOR_BYTES;
    return disks
      .map((disk) => {
        const rate = rates.get(disk.device)!;
        return {
          device: disk.device,
          readBytesPerSecond: bytes(rate.read),
          writeBytesPerSecond: bytes(rate.write),
        };
      })
      .sort((a, b) => a.device.localeCompare(b.device));
  }
}
