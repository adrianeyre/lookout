import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { STATS_FILE, StatsStore, type TrafficRow } from './store.ts';
import { bucketStarts, dayStart, hourStart } from './time.ts';

const NOW = Date.parse('2026-11-26T12:30:00Z');

function traffic(
  overrides: Partial<TrafficRow> & Pick<TrafficRow, 'bucket' | 'start'>,
): TrafficRow {
  return {
    host: 'a1b2c3d4e5f60718',
    requests: 10,
    bots: 2,
    visitors: 3,
    pageViews: 4,
    s2xx: 8,
    s3xx: 1,
    s4xx: 1,
    s5xx: 0,
    latency: '{}',
    pages: '[]',
    referrers: '[]',
    ...overrides,
  };
}

describe('StatsStore', () => {
  it('creates its schema in an empty data directory and opens it again', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-stats-'));
    const store = StatsStore.open(dir);
    expect(store.persistent).toBe(true);
    expect(store.schemaVersion).toBe(1);
    store.putTraffic(traffic({ bucket: 'day', start: dayStart(NOW) }));
    store.close();
    expect(await readdir(dir)).toContain(STATS_FILE);
    const again = StatsStore.open(dir);
    expect(again.getTraffic('a1b2c3d4e5f60718', 'day', dayStart(NOW))?.visitors).toBe(3);
    again.close();
  });

  it('keeps stats in memory without a data directory', () => {
    const store = StatsStore.open(null);
    expect(store.persistent).toBe(false);
    store.close();
  });

  it('refuses a store written by a newer Lookout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-stats-'));
    const db = new DatabaseSync(path.join(dir, STATS_FILE));
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => StatsStore.open(dir)).toThrow('newer Lookout');
  });

  it('writes and reads rollups by range, oldest first', () => {
    const store = StatsStore.open(null);
    const days = bucketStarts('day', 3, NOW);
    for (const [i, start] of days.entries()) {
      store.putTraffic(traffic({ bucket: 'day', start, visitors: i + 1 }));
    }
    store.putTraffic(traffic({ bucket: 'hour', start: hourStart(NOW) }));
    // Rewriting a row replaces it.
    store.putTraffic(traffic({ bucket: 'day', start: days[2]!, visitors: 30 }));
    expect(store.trafficSince('a1b2c3d4e5f60718', 'day', days[1]!).map((r) => r.visitors)).toEqual([
      2, 30,
    ]);
    expect(store.dailyVisitorsSince(days[0]!)).toHaveLength(3);
    expect(store.hasTraffic('a1b2c3d4e5f60718')).toBe(true);
    expect(store.hasTraffic('0000000000000000')).toBe(false);
    store.close();
  });

  it('prunes hourly rows past 48 hours and daily rows past retention', () => {
    const store = StatsStore.open(null);
    const id = 'a1b2c3d4e5f60718';
    const oldHour = hourStart(NOW - 49 * 3_600_000);
    const recentHour = hourStart(NOW - 47 * 3_600_000);
    store.putTraffic(traffic({ bucket: 'hour', start: oldHour }));
    store.putTraffic(traffic({ bucket: 'hour', start: recentHour }));
    const days = bucketStarts('day', 10, NOW);
    for (const start of days) {
      store.putTraffic(traffic({ bucket: 'day', start }));
      store.putUptime({ siteId: id, bucket: 'day', start, checks: 1, up: 1, latency: '{}' });
      store.putSiteSize({
        siteId: id,
        start,
        measuredAt: start,
        source: 'project',
        subject: 'shop',
        volumes: 1,
        images: 1,
        writable: 1,
        folder: null,
      });
    }
    const removed = store.prune(NOW, 7);
    // One hour, and three days each of traffic, uptime and sizes.
    expect(removed).toBe(1 + 3 * 3);
    expect(store.trafficSince(id, 'hour', 0).map((r) => r.start)).toEqual([recentHour]);
    expect(store.trafficSince(id, 'day', 0).map((r) => r.start)).toEqual(days.slice(3));
    expect(store.siteSizesSince(id, 0)).toHaveLength(7);
    store.close();
  });

  it('keeps log offsets, certificate expiry and Docker disk usage', () => {
    const store = StatsStore.open(null);
    store.putOffset({ fileKey: '1:2', path: '/var/log/caddy/access.log', offset: 42 }, NOW);
    expect(store.offsets().get('1:2')?.offset).toBe(42);
    store.deleteOffset('1:2');
    expect(store.offsets().size).toBe(0);
    store.putTls('a1b2c3d4e5f60718', NOW + 5 * 86_400_000, NOW);
    expect(store.getTls('a1b2c3d4e5f60718')).toBe(NOW + 5 * 86_400_000);
    const part = { count: 1, bytes: 10, reclaimableBytes: 0 };
    const usage = {
      measuredAt: NOW,
      images: part,
      containers: part,
      volumes: part,
      buildCache: part,
    };
    store.putDockerDf(dayStart(NOW), usage);
    expect(store.latestDockerDf()).toEqual(usage);
    expect(store.dockerDfSince(0)).toHaveLength(1);
    store.close();
  });

  it('writes all of a transaction or none of it', () => {
    const store = StatsStore.open(null);
    expect(() =>
      store.transaction(() => {
        store.putTls('a1b2c3d4e5f60718', 1, 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.getTls('a1b2c3d4e5f60718')).toBeNull();
    store.close();
  });
});
