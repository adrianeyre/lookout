import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TLS_THRESHOLDS,
  type HostedSite,
  type SitesSnapshot,
  type StatsOverview,
} from '@lookout/shared';
import { hostedSite, summary } from '../test-support.ts';
import { SiteList } from './WebsitesPage.tsx';

// One fixed clock for the fixtures and the page, so durations are exact.
const NOW = Date.parse('2026-11-25T12:00:00Z');

const snapshot = (sites: HostedSite[]): SitesSnapshot => ({
  settings: {
    checkIntervalMs: 60_000,
    timeoutMs: 10_000,
    slowMs: 2000,
    tls: DEFAULT_TLS_THRESHOLDS,
    historyCapacity: 15,
  },
  sites,
});

const containers = {
  available: true,
  containers: [summary({ id: 'c1', name: 'shop-web-1', state: 'exited', exitCode: 137 })],
};

const sites = [
  hostedSite(
    {
      url: 'https://shop.example/',
      status: 'down',
      containerId: 'c1',
      containerName: 'shop-web-1',
      sources: ['traefik', 'env'],
      history: [
        { timestamp: NOW - 120_000, responseMs: 80 },
        { timestamp: NOW - 60_000, responseMs: null },
      ],
    },
    NOW,
  ),
  hostedSite({ url: 'http://blog.example/' }, NOW),
  hostedSite({ url: 'http://wiki.example/', status: 'slow' }, NOW),
];

const rows = () => screen.getAllByTestId('site-row');
const urls = () => rows().map((row) => row.getAttribute('data-url'));

afterEach(() => vi.restoreAllMocks());

describe('SiteList', () => {
  it('shows Flagged Hosted Sites first, linked to their Container', () => {
    render(<SiteList sites={snapshot(sites)} containers={containers} now={NOW} />);
    expect(urls()).toEqual([
      'https://shop.example/',
      'http://blog.example/',
      'http://wiki.example/',
    ]);
    const shop = rows()[0]!;
    expect(shop.getAttribute('data-flagged')).toBe('true');
    expect(within(shop).getByTestId('site-flag').textContent).toContain('Flagged: Down');
    expect(within(shop).getByTestId('site-result').textContent).toContain('503');
    expect(within(shop).getByTestId('site-since').textContent).toContain('Down for 5m');
    const container = within(shop).getByTestId('site-container');
    expect(within(container).getByRole('link', { name: 'shop-web-1' }).getAttribute('href')).toBe(
      '/containers/c1',
    );
    // The Container is Flagged too: exited 137.
    expect(within(container).getByTestId('container-flag').textContent).toContain(
      'Exited with code 137',
    );
    expect(within(shop).getByTestId('site-sparkline').getAttribute('data-points')).toBe('2');
    expect(within(rows()[1]!).getByTestId('site-tls').textContent).toContain('No TLS');
    expect(within(rows()[1]!).queryByTestId('site-container')).toBeNull();
  });

  it('says how many Hosted Sites from labels are not checked (#104)', () => {
    const { rerender } = render(
      <SiteList sites={snapshot(sites)} containers={containers} now={NOW} />,
    );
    expect(screen.getByTestId('site-count').textContent).not.toContain('not checked');
    rerender(
      <SiteList sites={{ ...snapshot(sites), notChecked: 21 }} containers={containers} now={NOW} />,
    );
    expect(screen.getByTestId('site-count').textContent).toContain(
      '21 more found in Container labels and not checked',
    );
  });

  it('filters by text, status and Flagged only', async () => {
    const user = userEvent.setup();
    render(<SiteList sites={snapshot(sites)} containers={containers} now={NOW} />);
    await user.type(screen.getByRole('searchbox'), 'shop-web');
    expect(urls()).toEqual(['https://shop.example/']);
    await user.clear(screen.getByRole('searchbox'));
    await user.selectOptions(screen.getByLabelText('Status'), 'slow');
    expect(urls()).toEqual(['http://wiki.example/']);
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await user.click(screen.getByLabelText('Flagged only'));
    expect(urls()).toEqual(['https://shop.example/']);
    expect(screen.getByTestId('site-count').textContent).toContain('Showing 1 of 3 Hosted Sites');
  });

  it('Check now posts the Hosted Site ID, never its URL, and shows a refusal', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'This Hosted Site was checked moments ago' }), {
        status: 429,
      }),
    );
    const user = userEvent.setup();
    render(<SiteList sites={snapshot([sites[1]!])} containers={containers} now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Check now: http://blog.example/' }));
    expect(fetch).toHaveBeenCalledWith(
      `/api/sites/${sites[1]!.id}/check`,
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect((await screen.findByTestId('site-check-error')).textContent).toContain(
      'This Hosted Site was checked moments ago',
    );
  });

  it('explains where Hosted Sites come from when there are none', () => {
    render(<SiteList sites={snapshot([])} containers={containers} now={NOW} />);
    expect(screen.getByTestId('sites-empty').textContent).toContain('LOOKOUT_SITES');
  });

  describe('visitor figures (#11)', () => {
    const overview = (overrides: Partial<StatsOverview> = {}): StatsOverview => ({
      available: true,
      error: null,
      persistent: true,
      retentionDays: 90,
      accessLogs: true,
      sites: { [sites[1]!.id]: { todayVisitors: 3, last7Days: [0, 1, 4, 2, 0, 5, 3] } },
      measure: { state: 'idle', lastMeasuredAt: null, error: null },
      docker: { latest: null, points: [] },
      ...overrides,
    });

    it("shows today's visitors and a 7-day sparkline, and links to the Stats page", () => {
      render(
        <SiteList
          sites={snapshot([sites[1]!, sites[2]!])}
          containers={containers}
          now={NOW}
          stats={overview()}
        />,
      );
      const [blog, wiki] = rows();
      expect(within(blog!).getByTestId('site-visitors-today').textContent).toBe('3');
      expect(within(blog!).getByTestId('site-visitors-sparkline').getAttribute('data-points')).toBe(
        '7',
      );
      // No figures for a site the logs have nothing on.
      expect(within(wiki!).queryByTestId('site-visitors')).toBeNull();
      expect(
        within(blog!)
          .getByRole('link', { name: 'Stats: http://blog.example/' })
          .getAttribute('href'),
      ).toBe(`/websites/${sites[1]!.id}`);
    });

    it('hides them without access logs, or when the stats are unavailable', () => {
      const { rerender } = render(
        <SiteList
          sites={snapshot([sites[1]!])}
          containers={containers}
          now={NOW}
          stats={overview({ accessLogs: false })}
        />,
      );
      expect(screen.queryByTestId('site-visitors')).toBeNull();
      rerender(
        <SiteList
          sites={snapshot([sites[1]!])}
          containers={containers}
          now={NOW}
          stats={overview({ available: false, error: 'No store' })}
        />,
      );
      expect(screen.queryByTestId('site-visitors')).toBeNull();
      // The Stats page is still a click away.
      expect(screen.getByTestId('site-stats-link')).toBeTruthy();
    });
  });
});
