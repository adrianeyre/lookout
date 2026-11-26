import type { HostSample } from './host.ts';

/** The metrics the Live Window keeps for sparklines (FR-13), in one sample. */
export interface WindowPoint {
  timestamp: number;
  /** Null when CPU usage is not known yet (the first sample). */
  cpuPercent: number | null;
  memoryPercent: number;
  /** Totals across physical block devices. */
  diskReadBytesPerSecond: number;
  diskWriteBytesPerSecond: number;
  /** Totals across non-virtual network interfaces (loopback and veth* are left out). */
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
}

/** The Live Window as sent to a newly connected browser, oldest point first. */
export interface LiveWindowSnapshot {
  /** The most points the window holds: its length divided by the sample interval. */
  capacity: number;
  sampleIntervalMs: number;
  points: WindowPoint[];
}

const sum = (values: (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** The Live Window point for a Host sample. Server and browser both use this. */
export function windowPointFrom(sample: HostSample): WindowPoint {
  const physical = sample.network.filter((nic) => !nic.virtual);
  return {
    timestamp: sample.timestamp,
    cpuPercent: sample.cpu.usagePercent,
    memoryPercent: sample.memory.usagePercent,
    diskReadBytesPerSecond: sum(sample.diskIo.map((d) => d.readBytesPerSecond)),
    diskWriteBytesPerSecond: sum(sample.diskIo.map((d) => d.writeBytesPerSecond)),
    networkRxBytesPerSecond: sum(physical.map((n) => n.rxBytesPerSecond)),
    networkTxBytesPerSecond: sum(physical.map((n) => n.txBytesPerSecond)),
  };
}

/** A new snapshot with `point` appended, dropping the oldest points beyond capacity. */
export function appendToWindow(window: LiveWindowSnapshot, point: WindowPoint): LiveWindowSnapshot {
  const points = [...window.points, point];
  const excess = points.length - window.capacity;
  return { ...window, points: excess > 0 ? points.slice(excess) : points };
}
