import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, thresholdLevel } from './thresholds.ts';

describe('thresholdLevel', () => {
  it.each([
    [0, 'ok'],
    [79, 'ok'],
    [79.9, 'ok'],
    [80, 'warn'],
    [89, 'warn'],
    [89.9, 'warn'],
    [90, 'critical'],
    [100, 'critical'],
  ] as const)('%s%% is %s with the defaults', (percent, level) => {
    expect(thresholdLevel(percent, DEFAULT_THRESHOLDS)).toBe(level);
  });

  it('uses configured thresholds', () => {
    const thresholds = { warnPercent: 50, criticalPercent: 70 };
    expect(thresholdLevel(49, thresholds)).toBe('ok');
    expect(thresholdLevel(50, thresholds)).toBe('warn');
    expect(thresholdLevel(70, thresholds)).toBe('critical');
  });

  it('never warns about a missing value', () => {
    expect(thresholdLevel(null, DEFAULT_THRESHOLDS)).toBe('ok');
    expect(thresholdLevel(Number.NaN, DEFAULT_THRESHOLDS)).toBe('ok');
  });
});
