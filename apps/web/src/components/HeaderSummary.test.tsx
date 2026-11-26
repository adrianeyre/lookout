import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_TLS_THRESHOLDS,
  type ContainerSummary,
  type HostSample,
} from '@lookout/shared';
import { hostedSite } from '../test-support.ts';
import { HeaderSummaryView } from './HeaderSummary.tsx';

const container = (overrides: Partial<ContainerSummary>): ContainerSummary => ({
  id: 'x',
  name: 'x',
  image: 'i',
  state: 'running',
  health: null,
  composeProject: null,
  createdAt: 0,
  startedAt: 0,
  finishedAt: null,
  exitCode: 0,
  ports: [],
  labels: {},
  maskedLabels: [],
  ...overrides,
});

const host = {
  timestamp: 0,
  overview: { hostname: 'h', os: 'o', kernel: 'k', uptimeSeconds: 0 },
  cpu: { usagePercent: 12, perCore: [], load: { one: 0, five: 0, fifteen: 0 } },
  memory: { totalBytes: 1, availableBytes: 0, usedBytes: 1, usagePercent: 85, swap: null },
  disks: [
    {
      mountPoint: '/',
      device: 'a',
      fsType: 'ext4',
      totalBytes: 1,
      usedBytes: 1,
      freeBytes: 0,
      usagePercent: 72,
    },
    {
      mountPoint: '/b',
      device: 'b',
      fsType: 'ext4',
      totalBytes: 1,
      usedBytes: 1,
      freeBytes: 0,
      usagePercent: 93,
    },
  ],
  diskIo: [],
  network: [],
} satisfies HostSample;

describe('HeaderSummaryView', () => {
  it('summarises Containers and the Host, colouring each figure by threshold', () => {
    render(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={host}
        containers={{
          available: true,
          containers: [
            container({ id: 'a' }),
            container({ id: 'b' }),
            container({ id: 'c', state: 'exited', exitCode: 1 }),
            container({ id: 'd', state: 'exited', exitCode: 0 }),
          ],
        }}
      />,
    );
    expect(screen.getByTestId('summary-containers').textContent).toBe(
      'Containers: 2 running · 1 flagged',
    );
    expect(screen.getByTestId('summary-flagged').className).toContain('summary__item--flagged');
    expect(screen.getByTestId('summary-cpu').dataset.level).toBe('ok');
    expect(screen.getByTestId('summary-mem').dataset.level).toBe('warn');
    expect(screen.getByTestId('summary-mem').textContent).toContain('(warning)');
    // Disk is the fullest filesystem.
    expect(screen.getByTestId('summary-disk').textContent).toMatch(/^Disk 93\.0%/);
    expect(screen.getByTestId('summary-disk').dataset.level).toBe('critical');
  });

  it('does not highlight zero Flagged Containers', () => {
    render(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={undefined}
        containers={{ available: true, containers: [container({})] }}
      />,
    );
    expect(screen.getByTestId('summary-flagged').className).not.toContain('flagged');
  });

  it('says when Docker is unavailable', () => {
    render(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={host}
        containers={{ available: false, containers: [] }}
      />,
    );
    expect(screen.getByTestId('summary-containers').textContent).toBe(
      'Containers: Docker unavailable',
    );
  });

  it('counts Hosted Sites up and down, highlighting any down', () => {
    const settings = {
      checkIntervalMs: 60_000,
      timeoutMs: 10_000,
      slowMs: 2000,
      tls: DEFAULT_TLS_THRESHOLDS,
      historyCapacity: 15,
    };
    const { rerender } = render(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={undefined}
        containers={undefined}
        sites={{
          settings,
          sites: [
            hostedSite({ url: 'https://a.example/' }),
            hostedSite({ url: 'https://b.example/', status: 'slow' }),
            hostedSite({ url: 'https://c.example/', status: 'down' }),
            hostedSite({ url: 'https://d.example/', status: 'pending' }),
          ],
        }}
      />,
    );
    expect(screen.getByTestId('summary-sites').textContent).toBe('Sites: 2 up · 1 down');
    expect(screen.getByTestId('summary-sites-down').className).toContain('summary__item--flagged');

    rerender(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={undefined}
        containers={undefined}
        sites={{ settings, sites: [hostedSite({ url: 'https://a.example/' })] }}
      />,
    );
    expect(screen.getByTestId('summary-sites-down').className).not.toContain('flagged');

    // No Hosted Sites: the figure is left out.
    rerender(
      <HeaderSummaryView
        thresholds={DEFAULT_THRESHOLDS}
        host={undefined}
        containers={undefined}
        sites={{ settings, sites: [] }}
      />,
    );
    expect(screen.queryByTestId('summary-sites')).toBeNull();
  });
});
