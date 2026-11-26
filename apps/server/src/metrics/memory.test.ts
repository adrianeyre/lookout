import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import { memoryFromMeminfo, parseMeminfo } from './memory.ts';

describe('memoryFromMeminfo', () => {
  it('calculates used as total − available, as `free` does', () => {
    const memory = memoryFromMeminfo(readFileSync(fixture('meminfo'), 'utf8'));
    expect(memory.totalBytes).toBe(8013876 * 1024);
    expect(memory.availableBytes).toBe(5123456 * 1024);
    expect(memory.usedBytes).toBe((8013876 - 5123456) * 1024);
    expect(memory.usagePercent).toBe(36.1);
    expect(memory.swap).toEqual({
      totalBytes: 2097148 * 1024,
      usedBytes: (2097148 - 1572860) * 1024,
      usagePercent: 25,
    });
  });

  it('reports no swap, not 0%, on a Host without swap', () => {
    const memory = memoryFromMeminfo(readFileSync(fixture('meminfo-no-swap'), 'utf8'));
    expect(memory.swap).toBeNull();
    expect(memory.usagePercent).toBe(24.3);
  });

  it('fails clearly without MemAvailable', () => {
    expect(() => memoryFromMeminfo('MemTotal: 100 kB\n')).toThrow(/MemAvailable/);
  });

  it('reads unitless fields as plain numbers', () => {
    expect(parseMeminfo('HugePages_Total:       4\n').get('HugePages_Total')).toBe(4);
  });
});
