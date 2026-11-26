const TWO_32 = 2n ** 32n;
const TWO_64 = 2n ** 64n;

/**
 * The increase in a kernel counter between two reads. Counters are unsigned and wrap: at
 * 2^32 on 32-bit kernels (and for some 32-bit fields everywhere), at 2^64 otherwise. A
 * counter that goes backwards from above 2^32 cannot have wrapped at 2^32, so a smaller
 * value there is taken as a 64-bit wrap.
 */
export function counterDelta(previous: bigint, current: bigint): bigint {
  if (current >= previous) return current - previous;
  return previous < TWO_32 ? current + TWO_32 - previous : current + TWO_64 - previous;
}

/** Units per second from a counter delta over an elapsed time, or null with no time. */
export function ratePerSecond(delta: bigint, elapsedMs: number): number | null {
  if (!(elapsedMs > 0)) return null;
  return Math.round((Number(delta) * 1000) / elapsedMs);
}

/** Parses a decimal counter field, or null if it is not one. */
export function parseCounter(field: string | undefined): bigint | null {
  return field !== undefined && /^\d+$/.test(field) ? BigInt(field) : null;
}

/**
 * Turns successive absolute counters (keyed by device or interface) into per-second rates.
 * Keys that disappear are forgotten; new keys report null until their second read.
 */
export class RateTracker<K extends string> {
  #previous = new Map<string, { at: number; values: Record<K, bigint> }>();

  rates(
    at: number,
    current: Map<string, Record<K, bigint>>,
  ): Map<string, Record<K, number | null>> {
    const out = new Map<string, Record<K, number | null>>();
    const next = new Map<string, { at: number; values: Record<K, bigint> }>();
    for (const [key, values] of current) {
      const previous = this.#previous.get(key);
      const rates = {} as Record<K, number | null>;
      for (const field of Object.keys(values) as K[]) {
        rates[field] = previous
          ? ratePerSecond(counterDelta(previous.values[field], values[field]), at - previous.at)
          : null;
      }
      out.set(key, rates);
      next.set(key, { at, values });
    }
    this.#previous = next;
    return out;
  }
}
