import type { SiteCheck } from '@lookout/shared';
import { describe, expect, it } from 'vitest';
import { Histogram } from './histogram.ts';
import { StatsStore } from './store.ts';
import { dayStart, hourStart } from './time.ts';
import { UptimeRecorder } from './uptime.ts';

const NOW = Date.parse('2026-11-26T12:30:00Z');

function check(overrides: Partial<SiteCheck>): SiteCheck {
  return {
    timestamp: NOW,
    status: 'up',
    statusCode: 200,
    error: null,
    responseMs: 40,
    redirect: null,
    tls: null,
    ...overrides,
  };
}

describe('UptimeRecorder', () => {
  it('rolls checks up into uptime % and latency per hour and day', () => {
    const store = StatsStore.open(null);
    const recorder = new UptimeRecorder(store, () => NOW);
    recorder.record('up', check({ responseMs: 40 }));
    recorder.record('up', check({ status: 'slow', responseMs: 3000 }));
    recorder.record('up', check({ status: 'down', statusCode: null, responseMs: null }));
    store.transaction(() => recorder.flush());
    for (const [bucket, start] of [
      ['hour', hourStart(NOW)],
      ['day', dayStart(NOW)],
    ] as const) {
      const row = store.getUptime('up', bucket, start)!;
      expect(row).toMatchObject({ checks: 3, up: 2 });
      expect(Histogram.parse(row.latency).total).toBe(2);
    }
  });

  it('records a site that is down all day as 0 up', () => {
    const store = StatsStore.open(null);
    const recorder = new UptimeRecorder(store, () => NOW);
    for (let i = 0; i < 5; i++) {
      recorder.record('down', check({ status: 'down', statusCode: 503, responseMs: 12 }));
    }
    store.transaction(() => recorder.flush());
    expect(store.getUptime('down', 'day', dayStart(NOW))).toMatchObject({ checks: 5, up: 0 });
  });

  it('keeps the latest certificate expiry, written only when it changes', () => {
    const store = StatsStore.open(null);
    const recorder = new UptimeRecorder(store, () => NOW);
    const tls = {
      subject: 'shop.example',
      issuer: 'Test CA',
      validTo: NOW + 30 * 86_400_000,
      hostnameMatches: true,
      trusted: true,
      error: null,
    };
    recorder.record('s', check({ tls }));
    recorder.record('s', check({ tls: { ...tls, validTo: NOW + 90 * 86_400_000 } }));
    expect(store.getTls('s')).toBe(NOW + 90 * 86_400_000);
  });
});
