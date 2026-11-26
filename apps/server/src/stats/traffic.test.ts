import { describe, expect, it } from 'vitest';
import { caddyLine } from '../../test-support/caddy-log.ts';
import {
  caddyJson,
  hostKey,
  LOOKOUT_USER_AGENT,
  siteHostKey,
  type AccessEntry,
} from './access-log.ts';
import { Histogram } from './histogram.ts';
import { StatsStore } from './store.ts';
import { dayStart, hourStart } from './time.ts';
import { MAX_HOSTS_PER_DAY, MAX_TOP_KEYS, TrafficRecorder } from './traffic.ts';
import type { CaddyRequest } from '../../test-support/caddy-log.ts';

const NOW = Date.parse('2026-11-26T12:30:00Z');
const SITE = 'a1b2c3d4e5f60718';

function entry(request: Partial<CaddyRequest> = {}): AccessEntry {
  const parsed = caddyJson.parse(caddyLine({ ts: NOW - 60_000, host: 'shop.example', ...request }));
  if (!('entry' in parsed)) throw new Error('not an entry');
  return parsed.entry;
}

function setup(now = NOW) {
  const store = StatsStore.open(null);
  const clock = { now };
  const recorder = new TrafficRecorder(store, {
    now: () => clock.now,
    oldestDay: () => dayStart(clock.now) - 89 * 86_400_000,
    oldestHour: () => clock.now - 48 * 3_600_000,
  });
  const flush = () => store.transaction(() => recorder.flush());
  return { store, recorder, clock, flush };
}

describe('TrafficRecorder', () => {
  it('adds requests up per hour and per day', () => {
    const { store, recorder, flush } = setup();
    recorder.record(SITE, entry({ remoteIp: '192.0.2.1', uri: '/?a=1' }));
    recorder.record(SITE, entry({ remoteIp: '192.0.2.1', uri: '/about' }));
    recorder.record(
      SITE,
      entry({ remoteIp: '192.0.2.2', uri: '/style.css', contentType: 'text/css' }),
    );
    recorder.record(SITE, entry({ remoteIp: '192.0.2.3', status: 404 }));
    recorder.record(SITE, entry({ remoteIp: '192.0.2.4', status: 502, duration: 2 }));
    recorder.record(SITE, entry({ remoteIp: '192.0.2.5', status: 301 }));
    flush();
    for (const [bucket, start] of [
      ['hour', hourStart(NOW - 60_000)],
      ['day', dayStart(NOW)],
    ] as const) {
      const row = store.getTraffic(SITE, bucket, start)!;
      expect(row).toMatchObject({
        requests: 6,
        bots: 0,
        visitors: 5,
        pageViews: 2,
        s2xx: 3,
        s3xx: 1,
        s4xx: 1,
        s5xx: 1,
      });
      expect(Histogram.parse(row.latency).percentile(100)).toBeGreaterThan(1500);
    }
  });

  it('counts an IPv6 /64 as one visitor', () => {
    const { store, recorder, flush } = setup();
    recorder.record(SITE, entry({ remoteIp: '2001:db8:1:2::1' }));
    recorder.record(SITE, entry({ remoteIp: '2001:db8:1:2::abcd' }));
    recorder.record(SITE, entry({ remoteIp: '2001:db8:1:3::1' }));
    flush();
    expect(store.getTraffic(SITE, 'day', dayStart(NOW))?.visitors).toBe(2);
  });

  it('counts bots apart: never as visitors or page views', () => {
    const { store, recorder, flush } = setup();
    recorder.record(SITE, entry({ userAgent: 'Googlebot/2.1', remoteIp: '66.249.66.1' }));
    recorder.record(SITE, entry({ userAgent: null, remoteIp: '198.51.100.1' }));
    recorder.record(SITE, entry({ remoteIp: '192.0.2.1' }));
    flush();
    expect(store.getTraffic(SITE, 'day', dayStart(NOW))).toMatchObject({
      requests: 3,
      bots: 2,
      visitors: 1,
      pageViews: 1,
    });
  });

  it('never counts Lookout’s own Hosted Site checks', () => {
    const { store, recorder, flush } = setup();
    expect(recorder.record(SITE, entry({ userAgent: LOOKOUT_USER_AGENT }))).toBe('own-check');
    flush();
    expect(store.hasTraffic(SITE)).toBe(false);
  });

  it('keeps top pages without their query strings, and other sites as referrers', () => {
    const { store, recorder, flush } = setup();
    recorder.record(
      SITE,
      entry({ uri: '/reset?token=s3cret', referer: 'https://www.google.com/' }),
    );
    recorder.record(SITE, entry({ uri: '/reset?token=other', referer: 'https://shop.example/' }));
    recorder.record(SITE, entry({ uri: '/', referer: 'https://news.example/a?b=c' }));
    flush();
    const row = store.getTraffic(SITE, 'day', dayStart(NOW))!;
    expect(row.pages).toBe('[["/reset",2],["/",1]]');
    expect(row.pages).not.toContain('s3cret');
    expect(row.referrers).toBe('[["google.com",1],["news.example",1]]');
    // Hourly rows keep no top lists.
    expect(store.getTraffic(SITE, 'hour', hourStart(NOW - 60_000))!.pages).toBe('[]');
  });

  it('stops adding new pages past MAX_TOP_KEYS', () => {
    const { store, recorder, flush } = setup();
    for (let i = 0; i < MAX_TOP_KEYS + 5; i++) recorder.record(SITE, entry({ uri: `/p${i}` }));
    recorder.record(SITE, entry({ uri: '/p0' }));
    flush();
    const pages = JSON.parse(store.getTraffic(SITE, 'day', dayStart(NOW))!.pages) as [
      string,
      number,
    ][];
    expect(pages[0]).toEqual(['/p0', 2]);
    expect(pages).toHaveLength(50);
  });

  it('leaves out requests older than retention, and hourly ones older than 48 hours', () => {
    const { store, recorder, flush } = setup();
    expect(recorder.record(SITE, entry({ ts: NOW - 200 * 86_400_000 }))).toBe('too-old');
    recorder.record(SITE, entry({ ts: NOW - 72 * 3_600_000 }));
    flush();
    expect(store.trafficSince(SITE, 'hour', 0)).toEqual([]);
    expect(store.trafficSince(SITE, 'day', 0)).toHaveLength(1);
  });

  it('carries on from the stored totals of an open day after a restart', () => {
    const first = setup();
    first.recorder.record(SITE, entry({ remoteIp: '192.0.2.1' }));
    first.flush();
    const recorder = new TrafficRecorder(first.store, {
      now: () => NOW,
      oldestDay: () => 0,
      oldestHour: () => 0,
    });
    recorder.record(SITE, entry({ remoteIp: '192.0.2.2' }));
    first.store.transaction(() => recorder.flush());
    expect(first.store.getTraffic(SITE, 'day', dayStart(NOW))).toMatchObject({
      requests: 2,
      visitors: 2,
    });
  });

  it('lets a period go once it has ended and is idle', () => {
    const { recorder, clock, flush } = setup();
    recorder.record(SITE, entry());
    expect(recorder.openPeriods).toBe(2);
    clock.now = NOW + 2 * 86_400_000;
    flush();
    expect(recorder.openPeriods).toBe(0);
  });
});

describe('host keys', () => {
  it('keys requests by Host name, with a port only when it is not 80 or 443', () => {
    expect(hostKey('Shop.Example')).toBe('shop.example');
    expect(hostKey('shop.example:443')).toBe('shop.example');
    expect(hostKey('shop.example.:80')).toBe('shop.example');
    expect(hostKey('store.example:8788')).toBe('store.example:8788');
    expect(hostKey('[2001:db8::1]:8080')).toBe('[2001:db8::1]:8080');
    expect(hostKey('')).toBeNull();
    expect(hostKey('evil.example@shop.example')).toBeNull();
    expect(hostKey('a b')).toBeNull();
  });

  it('finds a Hosted Site’s requests by its URL, whatever port the proxy got them on', () => {
    expect(siteHostKey('https://cdn.example.com/')).toBe(hostKey('cdn.example.com'));
    expect(siteHostKey('http://store.example:8788/')).toBe(hostKey('store.example:8788'));
    expect(siteHostKey('https://shop.example:443/a')).toBe('shop.example');
    expect(siteHostKey('not a url')).toBeNull();
  });
});

describe('TrafficRecorder: memory', () => {
  it('holds at most maxVisitorsHeld addresses across every period, then counts each as new', () => {
    const store = StatsStore.open(null);
    const recorder = new TrafficRecorder(store, {
      now: () => NOW,
      oldestDay: () => 0,
      oldestHour: () => 0,
      maxVisitorsHeld: 4,
    });
    // Each address is held twice (its hour and its day): two fit, the rest are counted as new.
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.3']) {
      recorder.record('shop.example', entry({ remoteIp: ip }));
    }
    store.transaction(() => recorder.flush());
    expect(store.getTraffic('shop.example', 'day', dayStart(NOW))?.visitors).toBe(4);
  });
});

describe('TrafficRecorder: made-up hosts', () => {
  it('counts at most MAX_HOSTS_PER_DAY hosts a day', () => {
    const { store, recorder, flush } = setup();
    for (let i = 0; i < MAX_HOSTS_PER_DAY; i++) {
      expect(recorder.record(`h${i}.example`, entry())).toBe('counted');
    }
    expect(recorder.record('one-more.example', entry())).toBe('too-many-hosts');
    // A host already counted today still is.
    expect(recorder.record('h0.example', entry())).toBe('counted');
    flush();
    expect(store.hasTraffic('one-more.example')).toBe(false);
    expect(store.getTraffic('h0.example', 'day', dayStart(NOW))?.requests).toBe(2);
  });
});
