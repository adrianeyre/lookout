import type { StatsBucket } from '@lookout/shared';
import { Histogram } from './histogram.ts';
import {
  LOOKOUT_USER_AGENT,
  clientIp,
  isBot,
  isPageView,
  pathOf,
  refererDomain,
  visitorKey,
  type AccessEntry,
} from './access-log.ts';
import type { StatsStore, TrafficRow } from './store.ts';
import { bucketEnd, bucketStart } from './time.ts';

/**
 * The most visitor addresses held in memory at once, across every open hour and day of every
 * host (about 20 MB at most); past it each new visitor is counted as new.
 */
export const MAX_VISITORS_HELD = 200_000;
/** The most distinct pages and referrer domains counted per day; past it new ones are left out. */
export const MAX_TOP_KEYS = 500;
/** How many of each a daily row keeps, so a range can still find its top 10. */
export const TOP_KEPT = 50;

/** The most distinct hosts counted per day; past it a new host's requests are left out. */
export const MAX_HOSTS_PER_DAY = 200;

class Counter {
  readonly counts = new Map<string, number>();

  static parse(json: string): Counter {
    const counter = new Counter();
    try {
      const raw = JSON.parse(json) as unknown;
      if (Array.isArray(raw)) {
        for (const pair of raw) {
          if (
            Array.isArray(pair) &&
            typeof pair[0] === 'string' &&
            typeof pair[1] === 'number' &&
            pair[1] > 0
          ) {
            counter.counts.set(pair[0], pair[1]);
          }
        }
      }
    } catch {
      // Unreadable: start again.
    }
    return counter;
  }

  add(key: string, by = 1): void {
    const current = this.counts.get(key);
    if (current === undefined && this.counts.size >= MAX_TOP_KEYS) return;
    this.counts.set(key, (current ?? 0) + by);
  }

  top(count: number): [string, number][] {
    return [...this.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count);
  }

  toJSON(): [string, number][] {
    return this.top(TOP_KEPT);
  }
}

/** One open hour or day of one site, held in memory and written out as a whole row. */
class Period {
  requests = 0;
  bots = 0;
  pageViews = 0;
  s2xx = 0;
  s3xx = 0;
  s4xx = 0;
  s5xx = 0;
  /** Visitors already counted before this process held the period (from the store). */
  visitorsBefore = 0;
  /** Visitors seen past MAX_VISITORS_HELD, each counted as new. */
  visitorsOver = 0;
  /** Distinct visitor keys, in memory only: never written anywhere (ADR-0014). */
  readonly visitors = new Set<string>();
  latency = new Histogram();
  pages = new Counter();
  referrers = new Counter();
  touchedAt = 0;
  dirty = false;

  readonly host: string;
  readonly bucket: StatsBucket;
  readonly start: number;

  constructor(host: string, bucket: StatsBucket, start: number) {
    this.host = host;
    this.bucket = bucket;
    this.start = start;
  }

  static from(row: TrafficRow): Period {
    const period = new Period(row.host, row.bucket, row.start);
    period.requests = row.requests;
    period.bots = row.bots;
    period.pageViews = row.pageViews;
    period.s2xx = row.s2xx;
    period.s3xx = row.s3xx;
    period.s4xx = row.s4xx;
    period.s5xx = row.s5xx;
    period.visitorsBefore = row.visitors;
    period.latency = Histogram.parse(row.latency);
    period.pages = Counter.parse(row.pages);
    period.referrers = Counter.parse(row.referrers);
    return period;
  }

  get visitorCount(): number {
    return this.visitorsBefore + this.visitors.size + this.visitorsOver;
  }

  toRow(): TrafficRow {
    return {
      host: this.host,
      bucket: this.bucket,
      start: this.start,
      requests: this.requests,
      bots: this.bots,
      visitors: this.visitorCount,
      pageViews: this.pageViews,
      s2xx: this.s2xx,
      s3xx: this.s3xx,
      s4xx: this.s4xx,
      s5xx: this.s5xx,
      latency: JSON.stringify(this.latency),
      pages: this.bucket === 'day' ? JSON.stringify(this.pages) : '[]',
      referrers: this.bucket === 'day' ? JSON.stringify(this.referrers) : '[]',
    };
  }
}

export interface TrafficRecorderOptions {
  now: () => number;
  /** Requests older than this are not counted: past the retention, or hourly past 48 hours. */
  oldestDay: () => number;
  oldestHour: () => number;
  /** MAX_VISITORS_HELD, smaller in tests. */
  maxVisitorsHeld?: number;
}

/** What one request did, for tests and the follower's counts. */
export type RecordResult = 'counted' | 'own-check' | 'too-old' | 'too-many-hosts';

/**
 * Turns requests into hourly and daily totals per host (ADR-0014): a Hosted Site reads the
 * totals of the host its URL names. Each open hour and day is
 * held in memory and written as a whole row by flush(); a period that has ended and not been
 * touched for a minute is then let go.
 *
 * A visitor is a distinct client address (an IPv6 /64 counting as one) per site per hour or
 * day, among human requests. The addresses are only ever held in memory for the open period:
 * after a restart a day's earlier visitors are a number, so someone seen before and after it
 * counts twice that day.
 */
export class TrafficRecorder {
  readonly #store: StatsStore;
  readonly #options: TrafficRecorderOptions;
  readonly #open = new Map<string, Period>();
  /** Visitor addresses held across every open period (MAX_VISITORS_HELD). */
  #held = 0;
  /** The hosts counted each day, to bound how many a stream of made-up Host headers adds. */
  readonly #hosts = new Map<number, Set<string>>();

  constructor(store: StatsStore, options: TrafficRecorderOptions) {
    this.#store = store;
    this.#options = options;
  }

  /** Counts one request for `host` (hostKey of its Host header). */
  record(host: string, entry: AccessEntry): RecordResult {
    if (entry.userAgent === LOOKOUT_USER_AGENT) return 'own-check';
    if (entry.ts < this.#options.oldestDay()) return 'too-old';
    const day = bucketStart('day', entry.ts);
    let hosts = this.#hosts.get(day);
    if (!hosts) {
      hosts = new Set();
      this.#hosts.set(day, hosts);
      // Only the days still being written need their hosts.
      for (const held of this.#hosts.keys())
        if (held < day - 2 * 86_400_000) this.#hosts.delete(held);
    }
    if (!hosts.has(host)) {
      if (hosts.size >= MAX_HOSTS_PER_DAY) return 'too-many-hosts';
      hosts.add(host);
    }
    const bot = isBot(entry.userAgent);
    const ip = bot ? null : clientIp(entry);
    const visitor = ip === null ? null : visitorKey(ip);
    const pageView = !bot && isPageView(entry);
    const buckets: StatsBucket[] =
      entry.ts >= this.#options.oldestHour() ? ['hour', 'day'] : ['day'];
    for (const bucket of buckets) {
      const period = this.#period(host, bucket, bucketStart(bucket, entry.ts));
      period.requests += 1;
      if (bot) period.bots += 1;
      if (visitor !== null && !period.visitors.has(visitor)) {
        if (this.#held < (this.#options.maxVisitorsHeld ?? MAX_VISITORS_HELD)) {
          period.visitors.add(visitor);
          this.#held += 1;
        } else {
          period.visitorsOver += 1;
        }
      }
      if (pageView) period.pageViews += 1;
      const statusClass = Math.floor(entry.status / 100);
      if (statusClass === 2) period.s2xx += 1;
      else if (statusClass === 3) period.s3xx += 1;
      else if (statusClass === 4) period.s4xx += 1;
      else if (statusClass === 5) period.s5xx += 1;
      if (entry.durationMs !== null) period.latency.add(entry.durationMs);
      if (bucket === 'day' && pageView) {
        period.pages.add(pathOf(entry.uri));
        const domain = refererDomain(entry.referer);
        const own = (() => {
          try {
            return new URL(`http://${entry.host}`).hostname.replace(/^www\./, '');
          } catch {
            return null;
          }
        })();
        if (domain !== null && domain !== own) period.referrers.add(domain);
      }
    }
    return 'counted';
  }

  /** Writes every changed open period (in the caller's transaction), then lets old ones go. */
  flush(): void {
    const now = this.#options.now();
    for (const [key, period] of this.#open) {
      if (period.dirty) {
        this.#store.putTraffic(period.toRow());
        period.dirty = false;
      }
      const ended = bucketEnd(period.bucket, period.start) <= now;
      if (ended && period.touchedAt < now - 60_000) {
        this.#held -= period.visitors.size;
        this.#open.delete(key);
      }
    }
  }

  /** The open period's row as it would be written, for reads between flushes. */
  get openPeriods(): number {
    return this.#open.size;
  }

  #period(host: string, bucket: StatsBucket, start: number): Period {
    const key = `${host}|${bucket}|${start}`;
    let period = this.#open.get(key);
    if (!period) {
      const row = this.#store.getTraffic(host, bucket, start);
      period = row ? Period.from(row) : new Period(host, bucket, start);
      this.#open.set(key, period);
    }
    period.touchedAt = this.#options.now();
    period.dirty = true;
    return period;
  }
}
