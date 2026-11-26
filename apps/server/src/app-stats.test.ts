import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SiteStats, StatsOverview } from '@lookout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { caddyLog } from '../test-support/caddy-log.ts';
import { FakeDocker, makeContainer } from '../test-support/fake-docker.ts';
import { TEST_PASSWORD, makeHostRoot, testConfig } from '../test/helpers.ts';
import { buildApp, type AppOptions } from './app.ts';
import { siteId } from './sites/discovery.ts';
import { STATS_FILE } from './stats/store.ts';

const ORIGIN = 'http://lookout.test';
const HOST = 'lookout.test';
const SHOP = 'http://shop.example/';
const SHOP_ID = siteId(SHOP);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  options: Partial<AppOptions> = {},
): Promise<{ instance: FastifyInstance; cookie: string }> {
  const dist = await mkdtemp(path.join(tmpdir(), 'lookout-web-'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Lookout</title>');
  app = await buildApp({
    config: testConfig({ sites: [SHOP] }),
    docker: new FakeDocker(),
    webDistDir: dist,
    startSampler: false,
    startSiteMonitor: false,
    startFolderScanner: false,
    siteStatsPollMs: 20,
    siteStatsWriteMs: 20,
    ...options,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { password: TEST_PASSWORD },
  });
  return { instance: app, cookie: String(login.headers['set-cookie']).split(';')[0]! };
}

const get = (instance: FastifyInstance, cookie: string, url: string) =>
  instance.inject({ method: 'GET', url, headers: { cookie, host: HOST } });

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withLogs(lines: string) {
  const hostRoot = await makeHostRoot({ 'var/log/caddy/access.log': lines });
  return {
    hostRoot,
    config: testConfig({
      sites: [SHOP],
      hostRoot,
      accessLogs: path.join(hostRoot, 'var/log/caddy/*.log'),
    }),
  };
}

describe('Site Stats API', () => {
  it('describes the stats without access logs: visitor figures are not configured', async () => {
    const { instance, cookie } = await start();
    const overview = (await get(instance, cookie, '/api/stats')).json<StatsOverview>();
    expect(overview).toMatchObject({
      available: true,
      persistent: false,
      accessLogs: false,
      retentionDays: 90,
      measure: { state: 'idle', lastMeasuredAt: null, error: null },
      docker: { latest: null, points: [] },
    });
    expect(overview.sites[SHOP_ID]).toEqual({ todayVisitors: 0, last7Days: [0, 0, 0, 0, 0, 0, 0] });
    const stats = (
      await get(instance, cookie, `/api/stats/sites/${SHOP_ID}?range=7d`)
    ).json<SiteStats>();
    expect(stats.traffic.source).toBe('not-configured');
    expect(stats.sizes.source).toBe('none');
  });

  it('counts visitors from the access logs', async () => {
    const now = Date.now();
    const { config } = await withLogs(
      caddyLog([
        { ts: now, host: 'shop.example', remoteIp: '192.0.2.1', uri: '/?token=x' },
        { ts: now, host: 'shop.example', remoteIp: '192.0.2.1', uri: '/about' },
        { ts: now, host: 'shop.example', remoteIp: '192.0.2.2', referer: 'https://news.example/' },
        { ts: now, host: 'shop.example', userAgent: 'Googlebot/2.1' },
        { ts: now, host: 'shop.example', userAgent: 'Lookout (Hosted Site check)' },
        { ts: now, host: 'elsewhere.example' },
      ]),
    );
    const { instance, cookie } = await start({ config });
    const overview = await eventually(
      async () => (await get(instance, cookie, '/api/stats')).json<StatsOverview>(),
      (o) => o.sites[SHOP_ID]?.todayVisitors === 2,
    );
    expect(overview.accessLogs).toBe(true);
    expect(overview.sites[SHOP_ID]?.todayVisitors).toBe(2);

    const day = (
      await get(instance, cookie, `/api/stats/sites/${SHOP_ID}?range=24h`)
    ).json<SiteStats>();
    expect(day.bucket).toBe('hour');
    expect(day.traffic.points).toHaveLength(24);
    expect(day.traffic.source).toBe('ok');
    expect(day.traffic.points.at(-1)).toMatchObject({
      requests: 4,
      bots: 1,
      visitors: 2,
      pageViews: 3,
    });
    expect(day.topPages).toEqual([
      { key: '/', count: 2 },
      { key: '/about', count: 1 },
    ]);
    expect(day.topReferrers).toEqual([{ key: 'news.example', count: 1 }]);
    for (const [range, points] of [
      ['7d', 7],
      ['30d', 30],
      ['90d', 90],
    ] as const) {
      const stats = (
        await get(instance, cookie, `/api/stats/sites/${SHOP_ID}?range=${range}`)
      ).json<SiteStats>();
      expect(stats.traffic.points).toHaveLength(points);
      expect(stats.uptime).toHaveLength(points);
    }
  });

  it('counts requests for a Hosted Site found after they were read', async () => {
    const now = Date.now();
    const blog = 'https://blog.example/';
    const { config } = await withLogs(
      caddyLog([{ ts: now, host: 'blog.example', remoteIp: '192.0.2.7' }]),
    );
    const docker = new FakeDocker();
    const { instance, cookie } = await start({ config, docker });
    // Let the log be read before any Container names the site.
    await new Promise((resolve) => setTimeout(resolve, 150));
    docker.upsert(makeContainer({ id: 'blog1', name: 'blog', labels: { 'lookout.url': blog } }));
    const overview = await eventually(
      async () => (await get(instance, cookie, '/api/stats')).json<StatsOverview>(),
      (o) => o.sites[siteId(blog)]?.todayVisitors === 1,
    );
    expect(overview.sites[siteId(blog)]?.todayVisitors).toBe(1);
  });

  it('says when no access log matches', async () => {
    const hostRoot = await makeHostRoot({ 'etc/hostname': 'h' });
    const config = testConfig({
      sites: [SHOP],
      hostRoot,
      accessLogs: path.join(hostRoot, 'var/log/caddy/*.log'),
    });
    const { instance, cookie } = await start({ config });
    const stats = await eventually(
      async () =>
        (await get(instance, cookie, `/api/stats/sites/${SHOP_ID}?range=7d`)).json<SiteStats>(),
      (s) => s.traffic.source === 'no-logs',
    );
    expect(stats.traffic.source).toBe('no-logs');
  });

  it('answers 400 for an unknown range and 404 for an unknown site', async () => {
    const { instance, cookie } = await start();
    expect((await get(instance, cookie, `/api/stats/sites/${SHOP_ID}?range=week`)).statusCode).toBe(
      400,
    );
    expect(
      (await get(instance, cookie, '/api/stats/sites/0123456789abcdef?range=7d')).statusCode,
    ).toBe(404);
    expect(
      (await get(instance, cookie, `/api/stats/sites/${encodeURIComponent(SHOP)}`)).statusCode,
    ).toBe(404);
  });

  it('needs a session', async () => {
    const { instance } = await start();
    expect(
      (await instance.inject({ method: 'GET', url: '/api/stats', headers: { host: HOST } }))
        .statusCode,
    ).toBe(401);
    const page = await instance.inject({
      method: 'GET',
      url: `/websites/${SHOP_ID}`,
      headers: { host: HOST },
    });
    expect(page.statusCode).toBe(302);
  });

  it('serves the Site Stats page', async () => {
    const { instance, cookie } = await start();
    const page = await get(instance, cookie, `/websites/${SHOP_ID}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Lookout</title>');
  });

  it('Measure now measures once at a time, and only from this origin', async () => {
    const docker = new FakeDocker([
      makeContainer({
        id: 'web1',
        name: 'shop-web-1',
        composeProject: 'shop',
        labels: { 'lookout.url': SHOP },
      }),
    ]);
    docker.diskUsageDelayMs = 100;
    const { instance, cookie } = await start({ docker });
    const post = (origin?: string) =>
      instance.inject({
        method: 'POST',
        url: '/api/stats/measure',
        headers: { cookie, host: HOST, ...(origin ? { origin } : {}) },
      });
    expect((await post('http://evil.example')).statusCode).toBe(403);
    const first = await post(ORIGIN);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'measuring' });
    expect((await post(ORIGIN)).statusCode).toBe(409);
    const overview = await eventually(
      async () => (await get(instance, cookie, '/api/stats')).json<StatsOverview>(),
      (o) => o.measure.state === 'idle' && o.docker.latest !== null,
    );
    expect(overview.docker.latest?.images.count).toBe(1);
    expect(overview.docker.points).toHaveLength(1);
    expect(docker.diskUsageCalls).toBe(1);
    expect(docker.actions).toEqual([]);
  });

  it('keeps running, and says why, when the stats store cannot be opened', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'lookout-data-'));
    // A folder where the database file should be.
    await mkdir(path.join(dataDir, STATS_FILE));
    const { instance, cookie } = await start({ config: testConfig({ sites: [SHOP], dataDir }) });
    const overview = (await get(instance, cookie, '/api/stats')).json<StatsOverview>();
    expect(overview.available).toBe(false);
    expect(overview.error).toMatch(/could not be opened/);
    expect((await get(instance, cookie, `/api/stats/sites/${SHOP_ID}`)).statusCode).toBe(503);
    const measure = await instance.inject({
      method: 'POST',
      url: '/api/stats/measure',
      headers: { cookie, host: HOST, origin: ORIGIN },
    });
    expect(measure.statusCode).toBe(503);
    expect((await get(instance, cookie, '/api/sites')).statusCode).toBe(200);
  });

  it('keeps stats in LOOKOUT_DATA_DIR across a restart', async () => {
    const now = Date.now();
    const { config } = await withLogs(
      caddyLog([{ ts: now, host: 'shop.example', remoteIp: '192.0.2.9' }]),
    );
    const dataDir = await mkdtemp(path.join(tmpdir(), 'lookout-data-'));
    const first = await start({ config: { ...config, dataDir } });
    await eventually(
      async () => (await get(first.instance, first.cookie, '/api/stats')).json<StatsOverview>(),
      (o) => o.sites[SHOP_ID]?.todayVisitors === 1,
    );
    await first.instance.close();
    // Started again on the same logs, nothing is counted twice.
    const second = await start({ config: { ...config, dataDir } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const overview = (
      await get(second.instance, second.cookie, '/api/stats')
    ).json<StatsOverview>();
    expect(overview.persistent).toBe(true);
    expect(overview.sites[SHOP_ID]?.todayVisitors).toBe(1);
    const stats = (
      await get(second.instance, second.cookie, `/api/stats/sites/${SHOP_ID}?range=24h`)
    ).json<SiteStats>();
    expect(stats.traffic.points.at(-1)?.requests).toBe(1);
    await second.instance.close();
    // Only counts are stored: the visitor's address is in no file Lookout wrote (ADR-0014).
    for (const name of await readdir(dataDir)) {
      const bytes = await readFile(path.join(dataDir, name));
      expect(bytes.includes('192.0.2.9'), name).toBe(false);
    }
  });
});
