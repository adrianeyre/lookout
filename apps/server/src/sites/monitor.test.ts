import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainersSnapshot, HostedSite, SiteCheck, SitesSnapshot } from '@lookout/shared';
import { makeContainer } from '../../test-support/fake-docker.ts';
import { summaryOf } from '../docker/parse.ts';
import type { CheckOptions } from './check.ts';
import { siteId } from './discovery.ts';
import { MAX_SITES, SiteMonitor, type SiteMonitorOptions } from './monitor.ts';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

function check(overrides: Partial<SiteCheck> = {}): SiteCheck {
  return {
    timestamp: 0,
    status: 'up',
    statusCode: 200,
    error: null,
    responseMs: 40,
    redirect: null,
    tls: null,
    ...overrides,
  };
}

let clock = Date.parse('2026-11-25T12:00:00Z');
const monitors: SiteMonitor[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
});

function makeMonitor(options: Partial<SiteMonitorOptions> = {}) {
  const results = new Map<string, SiteCheck>();
  const calls: { url: string; options: CheckOptions }[] = [];
  const monitor = new SiteMonitor({
    urls: ['https://shop.example/'],
    intervalMs: 60_000,
    timeoutMs: 10_000,
    slowMs: 2000,
    tls: { warnDays: 14, criticalDays: 7 },
    liveWindowMs: 5 * 60_000,
    log,
    now: () => clock,
    debounceMs: 0,
    checker: async (url, checkOptions) => {
      calls.push({ url, options: checkOptions });
      return { ...(results.get(url) ?? check()), timestamp: clock };
    },
    ...options,
  });
  monitors.push(monitor);
  return { monitor, results, calls };
}

const snapshot = (labels: Record<string, string>, available = true): ContainersSnapshot => ({
  available,
  containers: [summaryOf(makeContainer({ id: 'c1', name: 'blog', labels }))],
});

describe('SiteMonitor', () => {
  it('lists LOOKOUT_SITES as pending until the first check', () => {
    const { monitor } = makeMonitor();
    expect(monitor.snapshot.sites).toEqual([
      expect.objectContaining({ url: 'https://shop.example/', status: 'pending', last: null }),
    ]);
    // Five minutes of one-minute checks.
    expect(monitor.snapshot.settings.historyCapacity).toBe(5);
  });

  it('checks every Hosted Site at start and then every interval', async () => {
    vi.useFakeTimers();
    const { monitor, calls } = makeMonitor();
    monitor.start();
    await monitor.settled();
    expect(calls.map((c) => c.url)).toEqual(['https://shop.example/']);
    expect(calls[0]!.options).toMatchObject({
      timeoutMs: 10_000,
      slowMs: 2000,
      checkPublic: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
  });

  it('keeps "up since", "down since" and a response-time history in memory', async () => {
    const { monitor, results } = makeMonitor();
    const url = 'https://shop.example/';
    const id = siteId(url);
    const run = async () => {
      clock += 60_000;
      await monitor.checkNow(id);
    };
    const start = clock;
    await run();
    expect(monitor.snapshot.sites[0]).toMatchObject({ status: 'up', upSince: start + 60_000 });

    results.set(url, check({ status: 'slow', responseMs: 2500 }));
    await run();
    expect(monitor.snapshot.sites[0]).toMatchObject({ status: 'slow', upSince: start + 60_000 });

    results.set(url, check({ status: 'down', statusCode: 503, responseMs: 12 }));
    await run();
    await run();
    expect(monitor.snapshot.sites[0]).toMatchObject({
      status: 'down',
      upSince: null,
      downSince: start + 180_000,
    });

    results.set(url, check());
    await run();
    await run();
    await run();
    const site = monitor.snapshot.sites[0]!;
    expect(site).toMatchObject({ status: 'up', downSince: null, upSince: start + 300_000 });
    // Capped to the Live Window: five points, oldest dropped.
    expect(site.history.map((point) => point.responseMs)).toEqual([12, 12, 40, 40, 40]);
  });

  it('discovers Container Hosted Sites from the Container list, and drops them when they go', async () => {
    const { monitor, calls } = makeMonitor();
    monitor.start();
    monitor.updateContainers(
      snapshot({ 'traefik.http.routers.blog.rule': 'Host(`blog.example`)' }),
    );
    await monitor.settled();
    expect(monitor.snapshot.sites.map((site) => [site.url, site.containerName])).toEqual([
      ['http://blog.example/', 'blog'],
      ['https://shop.example/', null],
    ]);
    // A new Hosted Site is checked straight away.
    expect(calls.map((c) => c.url)).toContain('http://blog.example/');

    // Docker going away keeps the last known Hosted Sites.
    monitor.updateContainers({ available: false, containers: [] });
    expect(monitor.snapshot.sites).toHaveLength(2);

    monitor.updateContainers({ available: true, containers: [] });
    expect(monitor.snapshot.sites.map((site) => site.url)).toEqual(['https://shop.example/']);
  });

  it('logs skipped Traefik routers at debug level, once each', () => {
    const { monitor } = makeMonitor();
    const labels = { 'traefik.http.routers.api.rule': 'PathPrefix(`/api`)' };
    monitor.updateContainers(snapshot(labels));
    monitor.updateContainers(snapshot(labels));
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      { container: 'blog', reason: 'router api has no Host() rule' },
      'Hosted Site skipped',
    );
  });

  it('Check now with an unknown ID makes no request', async () => {
    const { monitor, calls } = makeMonitor();
    expect(await monitor.checkNow('0123456789abcdef')).toEqual({ result: 'unknown' });
    expect(calls).toHaveLength(0);
  });

  it('allows Check now once every 5 s per Hosted Site', async () => {
    const { monitor, calls } = makeMonitor();
    const id = siteId('https://shop.example/');
    expect((await monitor.checkNow(id)).result).toBe('checked');
    clock += 1000;
    expect(await monitor.checkNow(id)).toEqual({ result: 'limited', retryAfterMs: 4000 });
    clock += 4000;
    expect((await monitor.checkNow(id)).result).toBe('checked');
    expect(calls).toHaveLength(2);
  });

  it('runs at most `concurrency` checks at once', async () => {
    let active = 0;
    let peak = 0;
    const urls = Array.from({ length: 10 }, (_, i) => `https://site${i}.example/`);
    const { monitor } = makeMonitor({
      urls,
      concurrency: 3,
      checker: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return check();
      },
    });
    monitor.start();
    await monitor.settled();
    expect(peak).toBe(3);
    expect(monitor.snapshot.sites.every((site) => site.status === 'up')).toBe(true);
  });

  it(`checks at most ${MAX_SITES} Hosted Sites, warning once`, () => {
    const urls = Array.from({ length: MAX_SITES + 20 }, (_, i) => `https://s${i}.example/`);
    const { monitor } = makeMonitor({ urls });
    expect(monitor.snapshot.sites).toHaveLength(MAX_SITES);
    monitor.updateContainers({ available: true, containers: [] });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { found: MAX_SITES + 20, checked: MAX_SITES },
      'Too many Hosted Sites; checking LOOKOUT_SITES, then the first ones by URL',
    );
  });

  it('records a check that throws as down', async () => {
    const { monitor } = makeMonitor({
      checker: async () => {
        throw new Error('boom');
      },
    });
    await monitor.checkNow(siteId('https://shop.example/'));
    expect(monitor.snapshot.sites[0]).toMatchObject({
      status: 'down',
      last: { error: 'Check failed' },
    });
  });

  it('tells subscribers about changes', async () => {
    const { monitor } = makeMonitor();
    const listener = vi.fn<(snapshot: SitesSnapshot) => void>();
    monitor.subscribe(listener);
    await monitor.checkNow(siteId('https://shop.example/'));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener.mock.lastCall![0].sites[0]!.status).toBe('up');
  });
});

describe('SiteMonitor: the operator first, and refusals (#103, #104)', () => {
  const many = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      summaryOf(
        makeContainer({
          id: `${prefix}${i}`,
          name: `${prefix}${i}`,
          labels: {
            'lookout.url': Array.from(
              { length: 20 },
              (_, j) => `http://a${String(i).padStart(3, '0')}-${j}.example/`,
            ).join(','),
          },
        }),
      ),
    );

  it('keeps LOOKOUT_SITES within the 500, and counts what it does not check', () => {
    const { monitor } = makeMonitor({ urls: ['https://zzz.example/'] });
    // 26 Containers × 20 Hosted Sites, all sorting before the operator's own.
    monitor.updateContainers({ available: true, containers: many('c', 26) });
    const urls = monitor.snapshot.sites.map((site) => site.url);
    expect(urls).toHaveLength(MAX_SITES);
    expect(urls).toContain('https://zzz.example/');
    expect(monitor.snapshot.notChecked).toBe(26 * 20 + 1 - MAX_SITES);
  });

  it('shows why a refused Hosted Site is not checked, and makes no request for it', async () => {
    const { monitor, calls } = makeMonitor({ urls: [] });
    monitor.updateContainers(snapshot({ 'lookout.url': 'http://admin.internal:2375/' }));
    const id = siteId('http://admin.internal:2375/');
    const result = await monitor.checkNow(id);
    expect(result.result).toBe('checked');
    const site = (result as { site: HostedSite }).site;
    expect(site.status).toBe('down');
    expect(site.last?.statusCode).toBeNull();
    expect(site.last?.error).toMatch(/^Not checked: port 2375/);
    monitor.start();
    await monitor.settled();
    expect(calls).toEqual([]);
  });
});
