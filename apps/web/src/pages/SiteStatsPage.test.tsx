import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TLS_THRESHOLDS,
  type SiteStats,
  type StatsOverview,
  type TrafficPoint,
} from '@lookout/shared';
import { LiveClient, LiveContext } from '../live.ts';
import { FakeEventSource, hostedSite, summary } from '../test-support.ts';
import {
  BotsCard,
  ContainersCard,
  PageViewsCard,
  ResponseTimeCard,
  SiteStatsPage,
  StatusCard,
  SizeCard,
  TlsCard,
  TopCard,
  UptimeCard,
  VisitorsCard,
  siteContainers,
  trafficEmptyText,
} from './SiteStatsPage.tsx';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const ID = '0123456789abcdef';

const traffic = (start: number, visitors: number): TrafficPoint => ({
  start,
  requests: visitors * 3,
  bots: 1,
  visitors,
  pageViews: visitors * 2,
  status: { '2xx': visitors * 2, '3xx': 0, '4xx': 1, '5xx': 0 },
  p50Ms: 12,
  p95Ms: 80,
});

function stats(overrides: Partial<SiteStats> = {}): SiteStats {
  return {
    siteId: ID,
    url: 'https://shop.example/',
    range: '7d',
    bucket: 'day',
    traffic: {
      source: 'ok',
      points: [0, 1, 2].map((i) => traffic(NOW - (2 - i) * DAY, i + 1)),
    },
    topPages: [
      { key: '/', count: 9 },
      { key: '/about', count: 3 },
    ],
    topReferrers: [{ key: 'search.example', count: 4 }],
    uptime: [
      { start: NOW - DAY, checks: 10, up: 9, uptimePercent: 90, p50Ms: 20, p95Ms: 40 },
      { start: NOW, checks: 10, up: 10, uptimePercent: 100, p50Ms: 25, p95Ms: 50 },
    ],
    tlsValidTo: NOW + 4.2 * DAY,
    sizes: {
      source: 'project',
      subject: 'shop',
      points: [
        {
          start: NOW - DAY,
          measuredAt: NOW - DAY,
          volumesBytes: 1024,
          imagesBytes: 2048,
          writableBytes: 0,
          folderBytes: null,
        },
        {
          start: NOW,
          measuredAt: NOW,
          volumesBytes: 2048,
          imagesBytes: 2048,
          writableBytes: 1024,
          folderBytes: null,
        },
      ],
    },
    ...overrides,
  };
}

const overview = (overrides: Partial<StatsOverview> = {}): StatsOverview => ({
  available: true,
  error: null,
  persistent: true,
  retentionDays: 90,
  accessLogs: true,
  sites: {},
  measure: { state: 'idle', lastMeasuredAt: NOW - 3_600_000, error: null },
  docker: { latest: null, points: [] },
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('trafficEmptyText', () => {
  it('says why there are no visitor figures', () => {
    expect(trafficEmptyText('not-configured')).toContain('LOOKOUT_ACCESS_LOGS is not set');
    expect(trafficEmptyText('no-logs')).toContain("can't be read");
    expect(trafficEmptyText('no-entries')).toContain('No requests');
    expect(trafficEmptyText('ok')).toBeNull();
  });
});

describe('the traffic Widgets', () => {
  it('chart visitors with this period and the range total', () => {
    render(<VisitorsCard stats={stats()} />);
    expect(screen.getByTestId('site-visitors-latest').textContent).toBe('3');
    expect(screen.getByTestId('site-visitors').textContent).toContain('6 in last 7 days');
    expect(screen.getByTestId('site-visitors-chart').getAttribute('data-points')).toBe('3');
  });

  it.each(['not-configured', 'no-logs', 'no-entries'] as const)(
    'explain an empty chart when the source is %s',
    (source) => {
      render(<VisitorsCard stats={stats({ traffic: { source, points: [] } })} />);
      expect(screen.getByTestId('widget-empty').textContent).toBe(trafficEmptyText(source));
      expect(screen.queryByTestId('site-visitors-chart')).toBeNull();
    },
  );

  it('chart page views beside requests', () => {
    render(<PageViewsCard stats={stats()} />);
    const chart = screen.getByTestId('site-page-views-chart');
    expect(chart.getAttribute('data-points')).toBe('3');
    // Page views 2 + 4 + 6, requests 3 + 6 + 9.
    const summary = screen.getByTestId('site-page-views-chart-summary').textContent;
    expect(summary).toContain('Page views');
    expect(summary).toContain('12');
    expect(summary).toContain('18');
  });

  it('stack humans and bots, humans being requests less bots', () => {
    render(<BotsCard stats={stats()} />);
    expect(screen.getByTestId('site-bots-chart').getAttribute('data-points')).toBe('3');
    // Humans 2 + 5 + 8, bots 1 + 1 + 1.
    const summary = screen.getByTestId('site-bots-chart-summary').textContent;
    expect(summary).toContain('Humans');
    expect(summary).toContain('15');
    expect(summary).toContain('Bots');
  });

  it('stack responses by status class', () => {
    render(<StatusCard stats={stats()} />);
    expect(screen.getByTestId('site-status-chart').getAttribute('data-points')).toBe('3');
    const summary = screen.getByTestId('site-status-chart-summary').textContent;
    for (const name of ['2xx', '3xx', '4xx', '5xx']) expect(summary).toContain(name);
  });

  it('chart the median and 95th percentile response times', () => {
    render(<ResponseTimeCard stats={stats()} />);
    expect(screen.getByTestId('site-response-chart').getAttribute('data-points')).toBe('3');
    const summary = screen.getByTestId('site-response-chart-summary').textContent;
    expect(summary).toContain('p50');
    expect(summary).toContain('p95');
  });

  it.each([
    ['page views', PageViewsCard, 'site-page-views-chart'],
    ['bots', BotsCard, 'site-bots-chart'],
    ['status codes', StatusCard, 'site-status-chart'],
    ['response time', ResponseTimeCard, 'site-response-chart'],
  ] as const)('explain why %s has no chart', (_name, Widget, chartId) => {
    render(<Widget stats={stats({ traffic: { source: 'no-logs', points: [] } })} />);
    expect(screen.getByTestId('widget-empty').textContent).toBe(trafficEmptyText('no-logs'));
    expect(screen.queryByTestId(chartId)).toBeNull();
  });

  it('list the top referrer domains', () => {
    render(
      <TopCard
        title="Top referrers"
        testId="site-top-referrers"
        heading="Domain"
        entries={stats().topReferrers}
        stats={stats()}
      />,
    );
    expect(screen.getByTestId('site-top-referrers').textContent).toContain('search.example');
  });

  it('list the top pages, or say there are none', () => {
    const { rerender } = render(
      <TopCard
        title="Top pages"
        testId="site-top-pages"
        heading="Path"
        entries={stats().topPages}
        stats={stats()}
      />,
    );
    expect(screen.getAllByTestId('site-top-pages-row').map((row) => row.textContent)).toEqual([
      '/9',
      '/about3',
    ]);
    rerender(
      <TopCard
        title="Top pages"
        testId="site-top-pages"
        heading="Path"
        entries={[]}
        stats={stats()}
      />,
    );
    expect(screen.getByTestId('widget-empty').textContent).toBe('None in last 7 days.');
  });
});

describe('UptimeCard', () => {
  it('gives the uptime over the range and charts it', () => {
    render(<UptimeCard stats={stats()} />);
    expect(screen.getByTestId('site-uptime-percent').textContent).toBe('95.0%');
    expect(screen.getByTestId('site-uptime-chart')).toBeTruthy();
    expect(screen.getByTestId('site-latency-chart')).toBeTruthy();
  });

  it('says when there have been no checks', () => {
    render(<UptimeCard stats={stats({ uptime: [] })} />);
    expect(screen.getByTestId('widget-empty').textContent).toContain('No checks');
  });
});

describe('TlsCard', () => {
  it('gives the days left, rounded up', () => {
    render(<TlsCard stats={stats()} now={NOW} />);
    expect(screen.getByTestId('site-tls-days').textContent).toBe('5 days');
  });

  it('says an http site has no certificate, and an https one not yet seen', () => {
    const { rerender } = render(
      <TlsCard stats={stats({ url: 'http://blog.example/', tlsValidTo: null })} now={NOW} />,
    );
    expect(screen.getByTestId('widget-empty').textContent).toContain('Not https');
    rerender(<TlsCard stats={stats({ tlsValidTo: null })} now={NOW} />);
    expect(screen.getByTestId('widget-empty').textContent).toContain('No certificate seen yet');
  });
});

describe('SizeCard', () => {
  it('shows the latest sizes, only the parts measured, and the trend', () => {
    render(<SizeCard stats={stats()} overview={overview()} now={NOW} onMeasured={() => {}} />);
    expect(screen.getByTestId('site-size-subject').textContent).toBe('Compose Project shop');
    expect(screen.getByTestId('site-size-total').textContent).toBe('5.00 KiB');
    expect(screen.getByTestId('site-size-volumesBytes').textContent).toBe('2.00 KiB');
    expect(screen.queryByTestId('site-size-folderBytes')).toBeNull();
    expect(screen.getByTestId('site-size-chart').getAttribute('data-points')).toBe('2');
    expect(screen.getByTestId('measure-status').textContent).toContain('Measured 1h');
  });

  it('says why there is nothing to measure, or that it is not measured yet', () => {
    const { rerender } = render(
      <SizeCard
        stats={stats({ sizes: { source: 'none', subject: null, points: [] } })}
        overview={overview()}
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    expect(screen.getByTestId('widget-empty').textContent).toContain('no Container or folder');
    expect(screen.queryByTestId('measure-now')).toBeNull();
    rerender(
      <SizeCard
        stats={stats({ sizes: { source: 'folder', subject: '/srv/cdn', points: [] } })}
        overview={overview()}
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    expect(screen.getByTestId('widget-empty').textContent).toBe('Not measured yet.');
    expect(screen.getByTestId('site-size-subject').textContent).toBe('Folder /srv/cdn');
  });

  it('Measure now posts, then says why it was refused', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Already measuring' }), { status: 409 }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const onMeasured = vi.fn();
    render(<SizeCard stats={stats()} overview={overview()} now={NOW} onMeasured={onMeasured} />);
    await userEvent.click(screen.getByTestId('measure-now'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/stats/measure',
      expect.objectContaining({ method: 'POST' }),
    );
    expect((await screen.findByTestId('measure-error')).textContent).toBe('Already measuring');
    expect(onMeasured).toHaveBeenCalled();
  });

  it('shows a running measurement', () => {
    render(
      <SizeCard
        stats={stats()}
        overview={overview({ measure: { state: 'measuring', lastMeasuredAt: null, error: null } })}
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    const button = screen.getByTestId<HTMLButtonElement>('measure-now');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Measuring…');
  });
});

describe('ContainersCard', () => {
  const containers = {
    available: true,
    containers: [
      summary({ id: 'db', name: 'shop-db-1', composeProject: 'shop' }),
      summary({ id: 'web', name: 'shop-web-1', composeProject: 'shop', health: 'healthy' }),
      summary({ id: 'other', name: 'blog-1', composeProject: 'blog' }),
      summary({ id: 'lone', name: 'lone', composeProject: null, state: 'exited' }),
    ],
  };

  it("lists every Container in the site's Compose Project", () => {
    const site = hostedSite({ url: 'https://shop.example/', containerId: 'web' });
    expect(siteContainers(site, containers).map((c) => c.name)).toEqual([
      'shop-db-1',
      'shop-web-1',
    ]);
    render(<ContainersCard site={site} containers={containers} />);
    const rows = screen.getAllByTestId('site-container-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByRole('link').getAttribute('href')).toBe('/containers/web');
    expect(within(rows[1]!).getByTestId('container-health').textContent).toBe('healthy');
  });

  it('lists just the Container without a Compose Project, and explains having none', () => {
    const lone = hostedSite({ url: 'http://lone.example/', containerId: 'lone' });
    expect(siteContainers(lone, containers).map((c) => c.id)).toEqual(['lone']);
    render(
      <ContainersCard site={hostedSite({ url: 'https://x.example/' })} containers={containers} />,
    );
    expect(screen.getByTestId('widget-empty').textContent).toContain('From LOOKOUT_SITES');
  });
});

describe('SiteStatsPage', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  function withLive(children: ReactNode) {
    const client = new LiveClient({
      onExpired: () => undefined,
      createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource,
      checkSession: () => Promise.resolve(true),
    });
    client.connect();
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.emit('sites', {
        settings: {
          checkIntervalMs: 60_000,
          timeoutMs: 10_000,
          slowMs: 2000,
          tls: DEFAULT_TLS_THRESHOLDS,
          historyCapacity: 15,
        },
        sites: [{ ...hostedSite({ url: 'https://shop.example/' }), id: ID }],
      });
      source.emit('containers', { available: true, containers: [] });
    });
    return <LiveContext.Provider value={client}>{children}</LiveContext.Provider>;
  }

  it('asks for the range chosen, and goes back to Websites', async () => {
    const fetch = vi.fn((url: string) => {
      if (url === '/api/stats') return Promise.resolve(new Response(JSON.stringify(overview())));
      const range = new URL(url, 'http://x').searchParams.get('range') as SiteStats['range'];
      return Promise.resolve(
        new Response(JSON.stringify(stats({ range, bucket: range === '24h' ? 'hour' : 'day' }))),
      );
    });
    vi.stubGlobal('fetch', fetch);
    render(withLive(<SiteStatsPage id={ID} />));
    expect((await screen.findByTestId('site-stats-title')).textContent).toBe(
      'https://shop.example/',
    );
    await screen.findByTestId('site-visitors-chart');
    expect(fetch).toHaveBeenCalledWith(`/api/stats/sites/${ID}?range=7d`, expect.anything());

    await userEvent.click(screen.getByRole('radio', { name: 'Last 24 hours' }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(`/api/stats/sites/${ID}?range=24h`, expect.anything()),
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Last 24 hours' }).checked).toBe(
      true,
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(`/api/stats/sites/${ID}?range=90d`, expect.anything()),
    );
    expect(screen.getByRole('link', { name: /All Websites/ }).getAttribute('href')).toBe(
      '/websites',
    );
  });

  it('says when there is no such Hosted Site', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/stats'
            ? new Response(JSON.stringify(overview()))
            : new Response(JSON.stringify({ error: 'No such Hosted Site' }), { status: 404 }),
        ),
      ),
    );
    render(withLive(<SiteStatsPage id="ffffffffffffffff" />));
    expect((await screen.findByTestId('site-stats-error')).textContent).toContain(
      'no Hosted Site with this ID',
    );
  });

  it('shows why the stats are unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'The stats store could not be opened' }), {
            status: 503,
          }),
        ),
      ),
    );
    render(withLive(<SiteStatsPage id={ID} />));
    expect((await screen.findByTestId('site-stats-error')).textContent).toBe(
      'The stats store could not be opened',
    );
  });
});
