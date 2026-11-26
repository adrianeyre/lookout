import type { SiteCheck, StatsBucket } from '@lookout/shared';
import { Histogram } from './histogram.ts';
import type { StatsStore } from './store.ts';
import { bucketEnd, bucketStart } from './time.ts';

interface UptimePeriod {
  siteId: string;
  bucket: StatsBucket;
  start: number;
  checks: number;
  up: number;
  latency: Histogram;
  dirty: boolean;
}

/**
 * Hourly and daily uptime from the Hosted Site checks Lookout already runs (no extra checks):
 * how many ran, how many were up or slow, and their response times. A Hosted Site Lookout
 * refuses to check is never recorded. The latest certificate expiry is kept too.
 */
export class UptimeRecorder {
  readonly #store: StatsStore;
  readonly #now: () => number;
  readonly #open = new Map<string, UptimePeriod>();
  /** The certificate expiry last written per site, so an unchanged one is not written again. */
  readonly #tls = new Map<string, number>();

  constructor(store: StatsStore, now: () => number) {
    this.#store = store;
    this.#now = now;
  }

  record(siteId: string, check: SiteCheck): void {
    for (const bucket of ['hour', 'day'] as const) {
      const period = this.#period(siteId, bucket, bucketStart(bucket, check.timestamp));
      period.checks += 1;
      if (check.status !== 'down') period.up += 1;
      if (check.responseMs !== null) period.latency.add(check.responseMs);
      period.dirty = true;
    }
    const validTo = check.tls?.validTo;
    if (validTo !== undefined && this.#tls.get(siteId) !== validTo) {
      this.#tls.set(siteId, validTo);
      this.#store.putTls(siteId, validTo, check.timestamp);
    }
  }

  /** Writes the changed periods (in the caller's transaction) and lets ended ones go. */
  flush(): void {
    const now = this.#now();
    for (const [key, period] of this.#open) {
      if (period.dirty) {
        this.#store.putUptime({
          siteId: period.siteId,
          bucket: period.bucket,
          start: period.start,
          checks: period.checks,
          up: period.up,
          latency: JSON.stringify(period.latency),
        });
        period.dirty = false;
      }
      if (bucketEnd(period.bucket, period.start) <= now) this.#open.delete(key);
    }
  }

  #period(siteId: string, bucket: StatsBucket, start: number): UptimePeriod {
    const key = `${siteId}|${bucket}|${start}`;
    let period = this.#open.get(key);
    if (!period) {
      const row = this.#store.getUptime(siteId, bucket, start);
      period = {
        siteId,
        bucket,
        start,
        checks: row?.checks ?? 0,
        up: row?.up ?? 0,
        latency: Histogram.parse(row?.latency),
        dirty: false,
      };
      this.#open.set(key, period);
    }
    return period;
  }
}
