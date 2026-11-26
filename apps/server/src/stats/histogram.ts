/**
 * Response times as a small histogram, so percentiles can be kept per hour and per day without
 * keeping every request: buckets grow by 2^(1/4) (about 19%), from 1 ms to about 18 minutes.
 * Histograms add up, and are stored as JSON with only their non-empty buckets.
 */
const STEPS_PER_DOUBLING = 4;
export const HISTOGRAM_BUCKETS = 81;

export class Histogram {
  readonly counts = new Map<number, number>();

  static parse(json: string | null | undefined): Histogram {
    const histogram = new Histogram();
    if (!json) return histogram;
    try {
      const raw = JSON.parse(json) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
          const index = Number(key);
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index < HISTOGRAM_BUCKETS &&
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value > 0
          ) {
            histogram.counts.set(index, Math.floor(value));
          }
        }
      }
    } catch {
      // An unreadable histogram counts as empty.
    }
    return histogram;
  }

  static indexOf(ms: number): number {
    if (!(ms > 1)) return 0;
    return Math.min(HISTOGRAM_BUCKETS - 1, Math.ceil(Math.log2(ms) * STEPS_PER_DOUBLING));
  }

  /** A bucket's typical value: the geometric middle of its range. */
  static valueOf(index: number): number {
    if (index === 0) return 1;
    return 2 ** ((index - 0.5) / STEPS_PER_DOUBLING);
  }

  get total(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  add(ms: number): void {
    const index = Histogram.indexOf(ms);
    this.counts.set(index, (this.counts.get(index) ?? 0) + 1);
  }

  merge(other: Histogram): void {
    for (const [index, count] of other.counts) {
      this.counts.set(index, (this.counts.get(index) ?? 0) + count);
    }
  }

  /** The `p`th percentile (0 to 100) in ms, rounded, or null when empty. */
  percentile(p: number): number | null {
    const total = this.total;
    if (total === 0) return null;
    const rank = Math.max(1, Math.ceil((p / 100) * total));
    let seen = 0;
    for (const index of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(index)!;
      if (seen >= rank) return Math.round(Histogram.valueOf(index));
    }
    return null;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
