/**
 * Site Stats (ADR-0013, ADR-0014): per-site visitors from the reverse proxy's access logs,
 * uptime from Hosted Site checks, and disk and Docker space, kept as hourly and daily totals.
 * Shared by the server's stats store and the Site Stats page.
 */

/** The ranges the Site Stats page offers. 24h has hourly points; the rest daily ones. */
export type StatsRange = '24h' | '7d' | '30d' | '90d';

export const STATS_RANGES: readonly StatsRange[] = ['24h', '7d', '30d', '90d'];

/** How many points each range has, and how long each point is. */
export const STATS_RANGE_POINTS: Readonly<
  Record<StatsRange, { points: number; bucket: StatsBucket }>
> = {
  '24h': { points: 24, bucket: 'hour' },
  '7d': { points: 7, bucket: 'day' },
  '30d': { points: 30, bucket: 'day' },
  '90d': { points: 90, bucket: 'day' },
};

export type StatsBucket = 'hour' | 'day';

export function isStatsRange(value: unknown): value is StatsRange {
  return typeof value === 'string' && (STATS_RANGES as readonly string[]).includes(value);
}

/** Retention of daily totals, in days (LOOKOUT_STATS_RETENTION_DAYS). */
export const STATS_RETENTION_DEFAULT_DAYS = 90;
export const STATS_RETENTION_MIN_DAYS = 7;
export const STATS_RETENTION_MAX_DAYS = 365;
/** Hourly totals are kept this long. */
export const STATS_HOURLY_KEEP_HOURS = 48;

/** How many top pages and referrer domains a site's stats list. */
export const STATS_TOP_COUNT = 10;

/** One hour or one day of a site's traffic, from the access logs. */
export interface TrafficPoint {
  /** The start of the hour or day, ms since the epoch (server local time). */
  start: number;
  /** Every request, bots included. */
  requests: number;
  /** Requests whose user agent looks like a bot. */
  bots: number;
  /** Distinct human visitors: client IPs, an IPv6 /64 counting as one. */
  visitors: number;
  /** Successful human GETs answered with text/html. */
  pageViews: number;
  /** Responses by status class. */
  status: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  /** Response time percentiles in ms, or null with no requests. */
  p50Ms: number | null;
  p95Ms: number | null;
}

/** One hour or one day of a site's checks (uptime history). */
export interface UptimePoint {
  start: number;
  checks: number;
  /** Checks that were up or slow. */
  up: number;
  /** up / checks × 100, or null with no checks. */
  uptimePercent: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** A site's size on one day. Absent parts are null (not measured, or not applicable). */
export interface SizePoint {
  /** The start of the day it was measured. */
  start: number;
  measuredAt: number;
  /** Named volumes of the site's Compose Project. */
  volumesBytes: number | null;
  /** Images its Containers run. */
  imagesBytes: number | null;
  /** Its Containers' writable layers. */
  writableBytes: number | null;
  /** The folder it serves (a site with no Container, `URL=/folder` in LOOKOUT_SITES). */
  folderBytes: number | null;
}

export interface TopEntry {
  key: string;
  count: number;
}

/** Why there are no visitor figures for a site, or 'ok'. */
export type TrafficSource =
  /** LOOKOUT_ACCESS_LOGS is not set: the visitor Widgets are hidden. */
  | 'not-configured'
  /** No file matches LOOKOUT_ACCESS_LOGS, or none can be read. */
  | 'no-logs'
  /** The logs are read, but no request for this site's host has been seen. */
  | 'no-entries'
  | 'ok';

/** What a site's sizes are measured from. */
export type SizeSource = 'project' | 'container' | 'folder' | 'none';

export interface SiteStats {
  siteId: string;
  url: string;
  range: StatsRange;
  bucket: StatsBucket;
  traffic: { source: TrafficSource; points: TrafficPoint[] };
  /** Top pages (paths only, no query string) and referrer domains over the range. */
  topPages: TopEntry[];
  topReferrers: TopEntry[];
  uptime: UptimePoint[];
  /** The latest certificate expiry seen, ms since the epoch, or null (http, or never seen). */
  tlsValidTo: number | null;
  sizes: {
    source: SizeSource;
    /** The Compose Project, or the Container's name, or the folder. */
    subject: string | null;
    /** Daily points over the last 90 days (whatever the range), oldest first. */
    points: SizePoint[];
  };
}

/** A Hosted Site's line on the Websites list. */
export interface SiteSummary {
  todayVisitors: number;
  /** Visitors per day for the last 7 days, oldest first, today last. */
  last7Days: number[];
}

/** Docker's disk usage, server-wide, like `docker system df`. */
export interface DockerDiskUsage {
  measuredAt: number;
  images: DockerDiskPart;
  containers: DockerDiskPart;
  volumes: DockerDiskPart;
  buildCache: DockerDiskPart;
}

export interface DockerDiskPart {
  count: number;
  bytes: number;
  /** What `docker system prune` (and `--volumes`) could free. */
  reclaimableBytes: number;
}

export interface DockerDiskPoint {
  start: number;
  imagesBytes: number;
  containersBytes: number;
  volumesBytes: number;
  buildCacheBytes: number;
}

export type MeasureState = 'idle' | 'measuring';

/** GET /api/stats: what the Websites list and the Host page need. */
export interface StatsOverview {
  /** False when the stats store could not be opened: `error` says why. */
  available: boolean;
  error: string | null;
  /** False without LOOKOUT_DATA_DIR: stats are kept in memory and lost on restart. */
  persistent: boolean;
  retentionDays: number;
  /** Whether LOOKOUT_ACCESS_LOGS is set. Without it, visitor figures are hidden. */
  accessLogs: boolean;
  /** Per Hosted Site ID. */
  sites: Record<string, SiteSummary>;
  measure: { state: MeasureState; lastMeasuredAt: number | null; error: string | null };
  /** The latest server-wide Docker disk usage, and its daily trend (90 days). */
  docker: { latest: DockerDiskUsage | null; points: DockerDiskPoint[] };
}

export const STATS_PATH = '/api/stats';
/** "Measure now": sizes every site and Docker's disk usage. Read-only; nothing is pruned. */
export const STATS_MEASURE_PATH = '/api/stats/measure';

export function siteStatsPath(id: string, range: StatsRange): string {
  return `/api/stats/sites/${encodeURIComponent(id)}?range=${range}`;
}
