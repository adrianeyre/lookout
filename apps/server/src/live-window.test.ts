import { describe, expect, it } from 'vitest';
import type { WindowPoint } from '@lookout/shared';
import { LiveWindow, windowCapacity } from './live-window.ts';

const point = (timestamp: number): WindowPoint => ({
  timestamp,
  cpuPercent: timestamp === 0 ? null : 10,
  memoryPercent: 50,
  diskReadBytesPerSecond: 1,
  diskWriteBytesPerSecond: 2,
  networkRxBytesPerSecond: 3,
  networkTxBytesPerSecond: 4,
});

describe('LiveWindow', () => {
  it('holds the window length divided by the sample interval', () => {
    expect(windowCapacity(15, 2000)).toBe(450);
    expect(windowCapacity(1, 7000)).toBe(9);
    expect(new LiveWindow(15, 2000).capacity).toBe(450);
  });

  it('starts empty, as after a restart', () => {
    const window = new LiveWindow(15, 2000);
    expect(window.size).toBe(0);
    expect(window.snapshot()).toEqual({ capacity: 450, sampleIntervalMs: 2000, points: [] });
  });

  it('keeps the newest points, oldest first, and a missing CPU value stays missing', () => {
    const window = new LiveWindow(1, 20_000);
    for (let t = 0; t < 5; t += 1) window.push(point(t));
    expect(window.points().map((p) => p.timestamp)).toEqual([2, 3, 4]);
    const fresh = new LiveWindow(1, 20_000);
    fresh.push(point(0));
    expect(fresh.points()[0]!.cpuPercent).toBeNull();
  });

  it('never uses more memory than its capacity allows, however many points are pushed', () => {
    const window = new LiveWindow(15, 2000);
    const bytes = window.byteLength;
    // Seven 8-byte columns of 450 points.
    expect(bytes).toBe(7 * 8 * 450);
    for (let t = 0; t < 450 * 10; t += 1) window.push(point(t));
    expect(window.size).toBe(450);
    expect(window.byteLength).toBe(bytes);
    expect(window.points()).toHaveLength(450);
    expect(window.points().at(-1)!.timestamp).toBe(450 * 10 - 1);
  });
});
