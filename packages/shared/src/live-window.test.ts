import { describe, expect, it } from 'vitest';
import type { HostSample } from './host.ts';
import { appendToWindow, windowPointFrom, type WindowPoint } from './live-window.ts';

const sample: HostSample = {
  timestamp: 1000,
  overview: { hostname: 'h', os: 'os', kernel: 'k', uptimeSeconds: 1 },
  cpu: { usagePercent: 12.5, perCore: [], load: { one: 0, five: 0, fifteen: 0 } },
  memory: { totalBytes: 1, availableBytes: 0, usedBytes: 1, usagePercent: 61, swap: null },
  disks: [],
  diskIo: [
    { device: 'sda', readBytesPerSecond: 100, writeBytesPerSecond: 10 },
    { device: 'nvme0n1', readBytesPerSecond: 50, writeBytesPerSecond: null },
  ],
  network: [
    { name: 'eth0', virtual: false, rxBytesPerSecond: 1000, txBytesPerSecond: 200 },
    { name: 'lo', virtual: true, rxBytesPerSecond: 5000, txBytesPerSecond: 5000 },
    { name: 'veth1', virtual: true, rxBytesPerSecond: 5000, txBytesPerSecond: 5000 },
  ],
};

describe('windowPointFrom', () => {
  it('totals disk I/O and real network interfaces', () => {
    expect(windowPointFrom(sample)).toEqual({
      timestamp: 1000,
      cpuPercent: 12.5,
      memoryPercent: 61,
      diskReadBytesPerSecond: 150,
      diskWriteBytesPerSecond: 10,
      networkRxBytesPerSecond: 1000,
      networkTxBytesPerSecond: 200,
    });
  });
});

describe('appendToWindow', () => {
  it('drops the oldest points beyond capacity', () => {
    const point = (timestamp: number): WindowPoint => ({ ...windowPointFrom(sample), timestamp });
    let window = { capacity: 3, sampleIntervalMs: 2000, points: [] as WindowPoint[] };
    for (let t = 1; t <= 5; t += 1) window = appendToWindow(window, point(t));
    expect(window.points.map((p) => p.timestamp)).toEqual([3, 4, 5]);
  });
});
