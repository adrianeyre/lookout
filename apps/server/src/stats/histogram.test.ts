import { describe, expect, it } from 'vitest';
import { Histogram } from './histogram.ts';

describe('Histogram', () => {
  it('gives percentiles within a bucket (about 19%) of the true value', () => {
    const histogram = new Histogram();
    for (let ms = 1; ms <= 100; ms++) histogram.add(ms);
    const p50 = histogram.percentile(50)!;
    const p95 = histogram.percentile(95)!;
    expect(p50).toBeGreaterThan(50 / 1.2);
    expect(p50).toBeLessThan(50 * 1.2);
    expect(p95).toBeGreaterThan(95 / 1.2);
    expect(p95).toBeLessThan(95 * 1.2);
  });

  it('is null when empty, and survives a JSON round trip and merging', () => {
    expect(new Histogram().percentile(50)).toBeNull();
    const a = new Histogram();
    a.add(10);
    a.add(10);
    const b = Histogram.parse(JSON.stringify(a));
    b.add(1000);
    a.merge(b);
    expect(a.total).toBe(5);
    expect(a.percentile(100)).toBeGreaterThan(800);
  });

  it('ignores anything in stored JSON that is not a bucket count', () => {
    const parsed = Histogram.parse('{"3":2,"-1":5,"999":1,"x":3,"4":"many","5":-2}');
    expect(parsed.total).toBe(2);
    expect(Histogram.parse('nonsense').total).toBe(0);
  });

  it('puts sub-millisecond and huge times in the end buckets', () => {
    const histogram = new Histogram();
    histogram.add(0.2);
    histogram.add(10 ** 12);
    expect(histogram.percentile(1)).toBe(1);
    expect(histogram.counts.size).toBe(2);
  });
});
