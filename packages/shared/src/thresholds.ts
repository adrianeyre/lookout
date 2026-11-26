export interface Thresholds {
  /** Amber at or above this percentage. */
  warnPercent: number;
  /** Red at or above this percentage. */
  criticalPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warnPercent: 80, criticalPercent: 90 };

export type ThresholdLevel = 'ok' | 'warn' | 'critical';

/**
 * The single threshold rule (FR-12), used for CPU, memory, swap, every filesystem and the
 * header summary: amber at ≥ warn, red at ≥ critical. A missing value is never a warning.
 */
export function thresholdLevel(percent: number | null, thresholds: Thresholds): ThresholdLevel {
  if (percent === null || !Number.isFinite(percent)) return 'ok';
  if (percent >= thresholds.criticalPercent) return 'critical';
  if (percent >= thresholds.warnPercent) return 'warn';
  return 'ok';
}
