import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  STATS_HOURLY_KEEP_HOURS,
  type DockerDiskUsage,
  type SizeSource,
  type StatsBucket,
} from '@lookout/shared';

/**
 * Site Stats' store (ADR-0013): hourly and daily totals in SQLite, through Node's built-in
 * `node:sqlite`, so there is no native dependency. It lives in LOOKOUT_DATA_DIR, the only place
 * Lookout writes. Only counts and sizes are stored: never a client IP address (ADR-0014).
 */

export const STATS_FILE = 'stats.db';

/** The schema's version (SQLite's user_version). Each step in MIGRATIONS moves it on by one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE traffic (
    host TEXT NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('hour', 'day')),
    start INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    bots INTEGER NOT NULL,
    visitors INTEGER NOT NULL,
    page_views INTEGER NOT NULL,
    s2xx INTEGER NOT NULL,
    s3xx INTEGER NOT NULL,
    s4xx INTEGER NOT NULL,
    s5xx INTEGER NOT NULL,
    latency TEXT NOT NULL,
    pages TEXT NOT NULL,
    referrers TEXT NOT NULL,
    PRIMARY KEY (host, bucket, start)
  ) WITHOUT ROWID;
  CREATE TABLE uptime (
    site_id TEXT NOT NULL,
    bucket TEXT NOT NULL CHECK (bucket IN ('hour', 'day')),
    start INTEGER NOT NULL,
    checks INTEGER NOT NULL,
    up INTEGER NOT NULL,
    latency TEXT NOT NULL,
    PRIMARY KEY (site_id, bucket, start)
  ) WITHOUT ROWID;
  CREATE TABLE site_tls (
    site_id TEXT PRIMARY KEY,
    valid_to INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE site_size (
    site_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    measured_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    subject TEXT,
    volumes INTEGER,
    images INTEGER,
    writable INTEGER,
    folder INTEGER,
    PRIMARY KEY (site_id, start)
  ) WITHOUT ROWID;
  CREATE TABLE docker_df (
    start INTEGER PRIMARY KEY,
    measured_at INTEGER NOT NULL,
    usage TEXT NOT NULL
  );
  CREATE TABLE log_offset (
    file_key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    offset INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,
];

export interface TrafficRow {
  /**
   * The Host the requests named (hostKey), not a Hosted Site's ID: a request is counted even
   * before the Hosted Site it belongs to is found, and a site reads its host's rows.
   */
  host: string;
  bucket: StatsBucket;
  start: number;
  requests: number;
  bots: number;
  visitors: number;
  pageViews: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  /** Histogram JSON. */
  latency: string;
  /** Top entries JSON: [[key, count], …]. Only daily rows have them. */
  pages: string;
  referrers: string;
}

export interface UptimeRow {
  siteId: string;
  bucket: StatsBucket;
  start: number;
  checks: number;
  up: number;
  latency: string;
}

export interface SiteSizeRow {
  siteId: string;
  start: number;
  measuredAt: number;
  source: SizeSource;
  subject: string | null;
  volumes: number | null;
  images: number | null;
  writable: number | null;
  folder: number | null;
}

export interface LogOffset {
  fileKey: string;
  path: string;
  offset: number;
}

type Row = Record<string, SQLInputValue>;

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function trafficFrom(row: Row): TrafficRow {
  return {
    host: text(row.host),
    bucket: row.bucket as StatsBucket,
    start: num(row.start),
    requests: num(row.requests),
    bots: num(row.bots),
    visitors: num(row.visitors),
    pageViews: num(row.page_views),
    s2xx: num(row.s2xx),
    s3xx: num(row.s3xx),
    s4xx: num(row.s4xx),
    s5xx: num(row.s5xx),
    latency: text(row.latency),
    pages: text(row.pages),
    referrers: text(row.referrers),
  };
}

function uptimeFrom(row: Row): UptimeRow {
  return {
    siteId: text(row.site_id),
    bucket: row.bucket as StatsBucket,
    start: num(row.start),
    checks: num(row.checks),
    up: num(row.up),
    latency: text(row.latency),
  };
}

export class StatsStore {
  readonly #db: DatabaseSync;
  /** Whether it is a file in LOOKOUT_DATA_DIR (false: in memory, lost on restart). */
  readonly persistent: boolean;

  private constructor(db: DatabaseSync, persistent: boolean) {
    this.#db = db;
    this.persistent = persistent;
  }

  /**
   * Opens (creating if need be) the store in `dataDir`, or one in memory when there is no data
   * directory. Throws if the file cannot be opened or migrated.
   */
  static open(dataDir: string | null): StatsStore {
    let db: DatabaseSync;
    if (dataDir === null) {
      db = new DatabaseSync(':memory:');
    } else {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path.join(dataDir, STATS_FILE));
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA busy_timeout = 2000');
    try {
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new StatsStore(db, dataDir !== null);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  /** Runs `fn` in one transaction: all of it is written, or none. */
  transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  get schemaVersion(): number {
    return num((this.#db.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  putTraffic(row: TrafficRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO traffic
         (host, bucket, start, requests, bots, visitors, page_views, s2xx, s3xx, s4xx, s5xx,
          latency, pages, referrers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.host,
        row.bucket,
        row.start,
        row.requests,
        row.bots,
        row.visitors,
        row.pageViews,
        row.s2xx,
        row.s3xx,
        row.s4xx,
        row.s5xx,
        row.latency,
        row.pages,
        row.referrers,
      );
  }

  getTraffic(host: string, bucket: StatsBucket, start: number): TrafficRow | null {
    const row = this.#db
      .prepare('SELECT * FROM traffic WHERE host = ? AND bucket = ? AND start = ?')
      .get(host, bucket, start) as Row | undefined;
    return row ? trafficFrom(row) : null;
  }

  /** Rows with `from <= start`, oldest first. */
  trafficSince(host: string, bucket: StatsBucket, from: number): TrafficRow[] {
    return (
      this.#db
        .prepare(
          'SELECT * FROM traffic WHERE host = ? AND bucket = ? AND start >= ? ORDER BY start',
        )
        .all(host, bucket, from) as Row[]
    ).map(trafficFrom);
  }

  /** Whether any request for this host has ever been counted. */
  hasTraffic(host: string): boolean {
    return this.#db.prepare('SELECT 1 FROM traffic WHERE host = ? LIMIT 1').get(host) !== undefined;
  }

  /** Daily visitors of every host since `from`. */
  dailyVisitorsSince(from: number): { host: string; start: number; visitors: number }[] {
    return (
      this.#db
        .prepare(
          "SELECT host, start, visitors FROM traffic WHERE bucket = 'day' AND start >= ? ORDER BY start",
        )
        .all(from) as Row[]
    ).map((row) => ({
      host: text(row.host),
      start: num(row.start),
      visitors: num(row.visitors),
    }));
  }

  putUptime(row: UptimeRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO uptime (site_id, bucket, start, checks, up, latency)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.siteId, row.bucket, row.start, row.checks, row.up, row.latency);
  }

  getUptime(siteId: string, bucket: StatsBucket, start: number): UptimeRow | null {
    const row = this.#db
      .prepare('SELECT * FROM uptime WHERE site_id = ? AND bucket = ? AND start = ?')
      .get(siteId, bucket, start) as Row | undefined;
    return row ? uptimeFrom(row) : null;
  }

  uptimeSince(siteId: string, bucket: StatsBucket, from: number): UptimeRow[] {
    return (
      this.#db
        .prepare(
          'SELECT * FROM uptime WHERE site_id = ? AND bucket = ? AND start >= ? ORDER BY start',
        )
        .all(siteId, bucket, from) as Row[]
    ).map(uptimeFrom);
  }

  putTls(siteId: string, validTo: number, seenAt: number): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO site_tls (site_id, valid_to, seen_at) VALUES (?, ?, ?)')
      .run(siteId, validTo, seenAt);
  }

  getTls(siteId: string): number | null {
    const row = this.#db.prepare('SELECT valid_to FROM site_tls WHERE site_id = ?').get(siteId) as
      Row | undefined;
    return row ? num(row.valid_to) : null;
  }

  putSiteSize(row: SiteSizeRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO site_size
         (site_id, start, measured_at, source, subject, volumes, images, writable, folder)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.siteId,
        row.start,
        row.measuredAt,
        row.source,
        row.subject,
        row.volumes,
        row.images,
        row.writable,
        row.folder,
      );
  }

  siteSizesSince(siteId: string, from: number): SiteSizeRow[] {
    return (
      this.#db
        .prepare('SELECT * FROM site_size WHERE site_id = ? AND start >= ? ORDER BY start')
        .all(siteId, from) as Row[]
    ).map((row) => ({
      siteId: text(row.site_id),
      start: num(row.start),
      measuredAt: num(row.measured_at),
      source: row.source as SizeSource,
      subject: row.subject === null ? null : text(row.subject),
      volumes: numOrNull(row.volumes),
      images: numOrNull(row.images),
      writable: numOrNull(row.writable),
      folder: numOrNull(row.folder),
    }));
  }

  putDockerDf(start: number, usage: DockerDiskUsage): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO docker_df (start, measured_at, usage) VALUES (?, ?, ?)')
      .run(start, usage.measuredAt, JSON.stringify(usage));
  }

  dockerDfSince(from: number): { start: number; usage: DockerDiskUsage }[] {
    return (
      this.#db
        .prepare('SELECT start, usage FROM docker_df WHERE start >= ? ORDER BY start')
        .all(from) as Row[]
    ).map((row) => ({
      start: num(row.start),
      usage: JSON.parse(text(row.usage)) as DockerDiskUsage,
    }));
  }

  latestDockerDf(): DockerDiskUsage | null {
    const row = this.#db
      .prepare('SELECT usage FROM docker_df ORDER BY start DESC LIMIT 1')
      .get() as Row | undefined;
    return row ? (JSON.parse(text(row.usage)) as DockerDiskUsage) : null;
  }

  offsets(): Map<string, LogOffset> {
    const rows = this.#db.prepare('SELECT file_key, path, offset FROM log_offset').all() as Row[];
    return new Map(
      rows.map((row) => [
        text(row.file_key),
        { fileKey: text(row.file_key), path: text(row.path), offset: num(row.offset) },
      ]),
    );
  }

  putOffset(offset: LogOffset, now: number): void {
    this.#db
      .prepare(
        'INSERT OR REPLACE INTO log_offset (file_key, path, offset, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(offset.fileKey, offset.path, offset.offset, now);
  }

  deleteOffset(fileKey: string): void {
    this.#db.prepare('DELETE FROM log_offset WHERE file_key = ?').run(fileKey);
  }

  /**
   * Deletes hourly rows older than STATS_HOURLY_KEEP_HOURS, and daily rows and sizes older than
   * `retentionDays`. Returns how many rows went.
   */
  prune(now: number, retentionDays: number): number {
    const hourlyFrom = now - STATS_HOURLY_KEEP_HOURS * 3_600_000;
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
    const dailyFrom = cutoff.getTime();
    let removed = 0;
    this.transaction(() => {
      for (const table of ['traffic', 'uptime']) {
        removed += Number(
          this.#db
            .prepare(`DELETE FROM ${table} WHERE bucket = 'hour' AND start < ?`)
            .run(hourlyFrom).changes,
        );
        removed += Number(
          this.#db.prepare(`DELETE FROM ${table} WHERE bucket = 'day' AND start < ?`).run(dailyFrom)
            .changes,
        );
      }
      removed += Number(
        this.#db.prepare('DELETE FROM site_size WHERE start < ?').run(dailyFrom).changes,
      );
      removed += Number(
        this.#db.prepare('DELETE FROM docker_df WHERE start < ?').run(dailyFrom).changes,
      );
    });
    return removed;
  }

  /** The start of the oldest daily row kept with `retentionDays`. */
  static retentionStart(now: number, retentionDays: number): number {
    const cutoff = new Date(now);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (retentionDays - 1));
    return cutoff.getTime();
  }
}

function migrate(db: DatabaseSync): void {
  const version = num((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (version > MIGRATIONS.length) {
    throw new Error(
      `${STATS_FILE} was written by a newer Lookout (schema ${version}); this one knows ${MIGRATIONS.length}`,
    );
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
