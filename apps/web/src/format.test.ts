import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatDuration,
  formatLoad,
  formatPercent,
  formatRate,
} from './format.ts';

describe('formatBytes', () => {
  it('uses binary units like free -h and df -h', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.50 KiB');
    expect(formatBytes(8013876 * 1024)).toBe('7.64 GiB');
    expect(formatBytes(512 * 1024 ** 3)).toBe('512 GiB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('shows one decimal place, and a dash for no value', () => {
    expect(formatPercent(36.07)).toBe('36.1%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('shows days, hours and minutes', () => {
    expect(formatDuration(354823)).toBe('4d 2h 33m');
    expect(formatDuration(3600)).toBe('1h 0m');
    expect(formatDuration(59)).toBe('59s');
  });
});

describe('formatLoad', () => {
  it('shows two decimal places', () => {
    expect(formatLoad(0.5)).toBe('0.50');
  });
});

describe('formatRate', () => {
  it('formats bytes per second', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(1.5 * 1024 * 1024)).toBe('1.50 MiB/s');
  });
});

describe('formatAgo', () => {
  it('keeps the two largest units', () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 45_000, now)).toBe('45s');
    expect(formatAgo(now - (3 * 3600 + 5 * 60 + 9) * 1000, now)).toBe('3h 5m');
    expect(formatAgo(now - (2 * 86_400 + 4 * 3600 + 60) * 1000, now)).toBe('2d 4h');
  });
});
