import {
  STATS_RANGE_POINTS,
  STATS_TOP_COUNT,
  type ContainerSummary,
  type DockerDiskPoint,
  type HostedSite,
  type SiteStats,
  type SiteSummary,
  type SizePoint,
  type StatsOverview,
  type StatsRange,
  type TopEntry,
  type TrafficPoint,
  type TrafficSource,
  type UptimePoint,
} from '@lookout/shared';
import type { Config } from '../config.ts';
import type { DockerClient } from '../docker/client.ts';
import type { HostRoot } from '../host-root.ts';
import type { SiteMonitor } from '../sites/monitor.ts';
import { caddyJson, hostKey, siteHostKey } from './access-log.ts';
import { AccessLogFollower } from './follower.ts';
import { Histogram } from './histogram.ts';
import { SizeMeasurer, sizeSubject } from './sizes.ts';
import { StatsStore, type TrafficRow, type UptimeRow } from './store.ts';
import { bucketStarts } from './time.ts';
import { TrafficRecorder } from './traffic.ts';
import { UptimeRecorder } from './uptime.ts';

const HOUR_MS = 3_600_000;
/** Size and Docker trends always cover this many days, whatever the range. */
const SIZE_TREND_DAYS = 90;

export interface StatsLogger {
  debug(obj: unknown, msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

export interface StatsServiceOptions {
  config: Pick<Config, 'dataDir' | 'accessLogs' | 'statsRetentionDays' | 'siteFolders'>;
  docker: DockerClient;
  hostRoot: HostRoot;
  sites: SiteMonitor;
  containers: () => readonly ContainerSummary[];
  log: StatsLogger;
  now?: () => number;
  /** How often open totals are written to the store. */
  writeMs?: number;
  /** How often the access logs are read. */
  pollMs?: number;
  /** How long after start the first size measurement runs, when today has none. */
  firstMeasureDelayMs?: number;
}

type Parts = {
  store: StatsStore;
  traffic: TrafficRecorder;
  uptime: UptimeRecorder;
  follower: AccessLogFollower | null;
  measurer: SizeMeasurer;
};

/**
 * Site Stats (ADR-0013, ADR-0014): visitors from the access logs, uptime from the Hosted Site
 * checks, and sizes measured daily, kept as hourly and daily totals. If the store cannot be
 * opened Lookout still runs, and the stats say why they are missing.
 */
export class StatsService {
  readonly #options: StatsServiceOptions & { now: () => number };
  readonly #parts: Parts | null;
  readonly error: string | null;
  #timer: NodeJS.Timeout | undefined;
  #lastPrune = 0;
  #unsubscribe: (() => void)[] = [];
  /** Requests with no usable Host header. */
  unmatched = 0;

  constructor(options: StatsServiceOptions) {
    this.#options = { now: Date.now, ...options };
    const { config, log } = options;
    const now = this.#options.now;
    let parts: Parts | null = null;
    let error: string | null = null;
    try {
      const store = StatsStore.open(config.dataDir);
      const traffic = new TrafficRecorder(store, {
        now,
        oldestDay: () => StatsStore.retentionStart(now(), config.statsRetentionDays),
        oldestHour: () => now() - 48 * HOUR_MS,
      });
      const uptime = new UptimeRecorder(store, now);
      const follower =
        config.accessLogs === null
          ? null
          : new AccessLogFollower({
              pattern: config.accessLogs,
              hostRoot: options.hostRoot,
              store,
              format: caddyJson,
              onEntry: (entry) => {
                // Kept by host, so a Hosted Site found later still has its requests.
                const host = hostKey(entry.host);
                if (host === null) this.unmatched += 1;
                else traffic.record(host, entry);
              },
              onFlush: () => traffic.flush(),
              log,
              now,
              ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
            });
      const measurer = new SizeMeasurer({
        docker: options.docker,
        hostRoot: options.hostRoot,
        store,
        sites: () => options.sites.snapshot.sites,
        containers: options.containers,
        folders: config.siteFolders,
        log,
        now,
        ...(options.firstMeasureDelayMs !== undefined
          ? { firstDelayMs: options.firstMeasureDelayMs }
          : {}),
      });
      parts = { store, traffic, uptime, follower, measurer };
      if (!store.persistent) {
        log.warn({}, 'LOOKOUT_DATA_DIR is not set, so Site Stats are kept in memory only');
      }
    } catch (cause) {
      error = 'The stats store could not be opened; see the server log';
      log.error({ err: cause }, 'Site Stats are unavailable: the stats store could not be opened');
    }
    this.#parts = parts;
    this.error = error;
  }

  get available(): boolean {
    return this.#parts !== null;
  }

  /** For tests. */
  get parts(): Parts | null {
    return this.#parts;
  }

  start(): void {
    const parts = this.#parts;
    if (!parts) return;
    const { sites } = this.#options;
    this.#unsubscribe.push(
      sites.subscribeChecks((siteId, check) => parts.uptime.record(siteId, check)),
    );
    parts.follower?.start();
    parts.measurer.start();
    this.#prune();
    const tick = () => {
      this.flush();
      this.#prune();
      this.#timer = setTimeout(tick, this.#options.writeMs ?? 10_000);
    };
    this.#timer = setTimeout(tick, this.#options.writeMs ?? 10_000);
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    const parts = this.#parts;
    if (!parts) return;
    await parts.follower?.stop();
    await parts.measurer.stop();
    this.flush();
    parts.store.close();
  }

  /** Writes every open total. */
  flush(): void {
    const parts = this.#parts;
    if (!parts) return;
    try {
      parts.store.transaction(() => {
        parts.traffic.flush();
        parts.uptime.flush();
      });
    } catch (error) {
      this.#options.log.warn({ err: error }, 'Writing Site Stats failed');
    }
  }

  /** Deletes what is past retention, at most once an hour. */
  #prune(): void {
    const parts = this.#parts;
    const now = this.#options.now();
    if (!parts || now - this.#lastPrune < HOUR_MS) return;
    this.#lastPrune = now;
    try {
      const removed = parts.store.prune(now, this.#options.config.statsRetentionDays);
      if (removed > 0) this.#options.log.info({ removed }, 'Pruned old Site Stats');
    } catch (error) {
      this.#options.log.warn({ err: error }, 'Pruning Site Stats failed');
    }
  }

  measureNow(): { result: 'started' | 'busy' | 'unavailable' } {
    if (!this.#parts) return { result: 'unavailable' };
    return this.#parts.measurer.measureNow();
  }

  measureState(): StatsOverview['measure'] {
    const measurer = this.#parts?.measurer;
    return {
      state: measurer?.state ?? 'idle',
      lastMeasuredAt: measurer?.lastMeasuredAt ?? null,
      error: measurer?.error ?? null,
    };
  }

  overview(): StatsOverview {
    const { config } = this.#options;
    const parts = this.#parts;
    const base = {
      retentionDays: config.statsRetentionDays,
      accessLogs: config.accessLogs !== null,
      measure: this.measureState(),
    };
    if (!parts) {
      return {
        ...base,
        available: false,
        error: this.error,
        persistent: false,
        sites: {},
        docker: { latest: null, points: [] },
      };
    }
    this.flush();
    const now = this.#options.now();
    const days = bucketStarts('day', 7, now);
    const byKey = new Map<string, number>();
    for (const row of parts.store.dailyVisitorsSince(days[0]!)) {
      byKey.set(`${row.host}|${row.start}`, row.visitors);
    }
    const sites: Record<string, SiteSummary> = {};
    for (const site of this.#options.sites.snapshot.sites) {
      const host = siteHostKey(site.url);
      const last7Days = days.map((start) => byKey.get(`${host}|${start}`) ?? 0);
      sites[site.id] = { todayVisitors: last7Days.at(-1) ?? 0, last7Days };
    }
    const trendFrom = StatsStore.retentionStart(now, SIZE_TREND_DAYS);
    const points: DockerDiskPoint[] = parts.store
      .dockerDfSince(trendFrom)
      .map(({ start, usage }) => ({
        start,
        imagesBytes: usage.images.bytes,
        containersBytes: usage.containers.bytes,
        volumesBytes: usage.volumes.bytes,
        buildCacheBytes: usage.buildCache.bytes,
      }));
    return {
      ...base,
      available: true,
      error: null,
      persistent: parts.store.persistent,
      sites,
      docker: { latest: parts.store.latestDockerDf(), points },
    };
  }

  /** A Hosted Site's stats over a range, or null when no Hosted Site has that ID. */
  siteStats(id: string, range: StatsRange): SiteStats | null {
    const parts = this.#parts;
    const site = this.#options.sites.snapshot.sites.find((s) => s.id === id);
    if (!parts || !site) return null;
    this.flush();
    const { store } = parts;
    const now = this.#options.now();
    const { points: count, bucket } = STATS_RANGE_POINTS[range];
    const starts = bucketStarts(bucket, count, now);

    const host = siteHostKey(site.url) ?? '';
    const trafficRows = new Map(
      store.trafficSince(host, bucket, starts[0]!).map((r) => [r.start, r]),
    );
    const traffic = starts.map((start) => trafficPoint(start, trafficRows.get(start)));

    // Top pages and referrers are kept per day: a 24-hour range uses today's and yesterday's.
    const topDays = bucket === 'hour' ? bucketStarts('day', 2, now) : starts;
    const dayRows =
      bucket === 'day' ? [...trafficRows.values()] : store.trafficSince(host, 'day', topDays[0]!);
    const pages = mergeTop(dayRows.map((r) => r.pages));
    const referrers = mergeTop(dayRows.map((r) => r.referrers));

    const uptimeRows = new Map(store.uptimeSince(id, bucket, starts[0]!).map((r) => [r.start, r]));
    const uptime = starts.map((start) => uptimePoint(start, uptimeRows.get(start)));

    const subject = sizeSubject(site, this.#options.containers(), this.#options.config.siteFolders);
    const sizePoints: SizePoint[] = store
      .siteSizesSince(id, StatsStore.retentionStart(now, SIZE_TREND_DAYS))
      .map((row) => ({
        start: row.start,
        measuredAt: row.measuredAt,
        volumesBytes: row.volumes,
        imagesBytes: row.images,
        writableBytes: row.writable,
        folderBytes: row.folder,
      }));

    return {
      siteId: id,
      url: site.url,
      range,
      bucket,
      traffic: { source: this.#trafficSource(host), points: traffic },
      topPages: pages,
      topReferrers: referrers,
      uptime,
      tlsValidTo: tlsValidTo(site, store),
      sizes: { source: subject.source, subject: subject.subject, points: sizePoints },
    };
  }

  #trafficSource(host: string): TrafficSource {
    const parts = this.#parts!;
    if (!parts.follower) return 'not-configured';
    if (parts.follower.status === 'no-logs') return 'no-logs';
    return parts.store.hasTraffic(host) ? 'ok' : 'no-entries';
  }
}

function tlsValidTo(site: HostedSite, store: StatsStore): number | null {
  if (!site.url.startsWith('https:')) return null;
  return site.last?.tls?.validTo ?? store.getTls(site.id);
}

function trafficPoint(start: number, row: TrafficRow | undefined): TrafficPoint {
  const latency = Histogram.parse(row?.latency);
  return {
    start,
    requests: row?.requests ?? 0,
    bots: row?.bots ?? 0,
    visitors: row?.visitors ?? 0,
    pageViews: row?.pageViews ?? 0,
    status: {
      '2xx': row?.s2xx ?? 0,
      '3xx': row?.s3xx ?? 0,
      '4xx': row?.s4xx ?? 0,
      '5xx': row?.s5xx ?? 0,
    },
    p50Ms: latency.percentile(50),
    p95Ms: latency.percentile(95),
  };
}

function uptimePoint(start: number, row: UptimeRow | undefined): UptimePoint {
  const latency = Histogram.parse(row?.latency);
  const checks = row?.checks ?? 0;
  return {
    start,
    checks,
    up: row?.up ?? 0,
    uptimePercent: checks === 0 ? null : Math.round(((row?.up ?? 0) / checks) * 10_000) / 100,
    p50Ms: latency.percentile(50),
    p95Ms: latency.percentile(95),
  };
}

/** Adds up each day's kept top entries and returns the top STATS_TOP_COUNT. */
export function mergeTop(lists: readonly string[]): TopEntry[] {
  const totals = new Map<string, number>();
  for (const json of lists) {
    let pairs: unknown;
    try {
      pairs = JSON.parse(json);
    } catch {
      continue;
    }
    if (!Array.isArray(pairs)) continue;
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number') {
        totals.set(pair[0], (totals.get(pair[0]) ?? 0) + pair[1]);
      }
    }
  }
  return [...totals]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, STATS_TOP_COUNT)
    .map(([key, count]) => ({ key, count }));
}
