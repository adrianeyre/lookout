import { describe, expect, it } from 'vitest';
import { RateTracker, counterDelta, ratePerSecond } from './counters.ts';

describe('counterDelta', () => {
  it('is the difference while the counter grows', () => {
    expect(counterDelta(100n, 250n)).toBe(150n);
    expect(counterDelta(5n, 5n)).toBe(0n);
  });

  it('handles a 32-bit counter wrapping', () => {
    expect(counterDelta(2n ** 32n - 100n, 50n)).toBe(150n);
  });

  it('handles a 64-bit counter wrapping', () => {
    expect(counterDelta(2n ** 64n - 10n, 20n)).toBe(30n);
  });
});

describe('ratePerSecond', () => {
  it('scales to one second, and has no rate without elapsed time', () => {
    expect(ratePerSecond(1000n, 2000)).toBe(500);
    expect(ratePerSecond(1000n, 0)).toBeNull();
  });
});

describe('RateTracker', () => {
  it('reports null until a key has two reads, and forgets keys that vanish', () => {
    const tracker = new RateTracker<'n'>();
    expect(tracker.rates(0, new Map([['a', { n: 0n }]]))).toEqual(new Map([['a', { n: null }]]));
    expect(tracker.rates(1000, new Map([['a', { n: 10n }]]))).toEqual(new Map([['a', { n: 10 }]]));
    tracker.rates(2000, new Map());
    expect(tracker.rates(3000, new Map([['a', { n: 99n }]]))).toEqual(
      new Map([['a', { n: null }]]),
    );
  });
});
