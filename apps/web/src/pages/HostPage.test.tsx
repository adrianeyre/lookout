import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MemoryMetrics, StatsOverview } from '@lookout/shared';
import {
  byTraffic,
  CpuCard,
  DiskCard,
  DiskIoCard,
  DockerDiskCard,
  MemoryCard,
  NetworkCard,
  OverviewCard,
} from './HostPage.tsx';

const GiB = 1024 ** 3;

const memory: MemoryMetrics = {
  totalBytes: 8 * GiB,
  availableBytes: 5 * GiB,
  usedBytes: 3 * GiB,
  usagePercent: 37.5,
  swap: { totalBytes: 2 * GiB, usedBytes: 0.5 * GiB, usagePercent: 25 },
};

describe('OverviewCard', () => {
  it('shows the Host identity and uptime', () => {
    render(
      <OverviewCard
        overview={{ hostname: 'harbour', os: 'Debian 13', kernel: '6.12.0', uptimeSeconds: 90_061 }}
      />,
    );
    expect(screen.getByTestId('hostname').textContent).toBe('harbour');
    expect(screen.getByTestId('uptime').textContent).toBe('1d 1h 1m');
  });
});

describe('CpuCard', () => {
  it('shows a dash on the first sample, before there is a previous value', () => {
    render(
      <CpuCard
        cpu={{
          usagePercent: null,
          perCore: [null, null],
          load: { one: 0.5, five: 0.25, fifteen: 0.1 },
        }}
      />,
    );
    expect(screen.getByTestId('cpu-percent').textContent).toBe('—');
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  it('shows overall and per-core usage and load averages', () => {
    render(
      <CpuCard
        cpu={{ usagePercent: 42, perCore: [60, 24], load: { one: 1.5, five: 1, fifteen: 0.75 } }}
      />,
    );
    expect(screen.getByTestId('cpu-percent').textContent).toBe('42.0%');
    expect(screen.getByText('Core 1')).toBeTruthy();
    expect(screen.getByText('24.0%')).toBeTruthy();
    expect(screen.getByTestId('load-1').textContent).toBe('1.50');
    expect(screen.getByText('0.75')).toBeTruthy();
  });
});

describe('MemoryCard', () => {
  it('shows memory and swap', () => {
    render(<MemoryCard memory={memory} />);
    expect(screen.getByTestId('memory-percent').textContent).toBe('37.5%');
    expect(screen.getByText('3.00 GiB')).toBeTruthy();
    expect(screen.getByTestId('swap-used').textContent).toBe('512 MiB (25.0%)');
  });

  it('says "No swap" on a Host without swap, not 0%', () => {
    render(<MemoryCard memory={{ ...memory, swap: null }} />);
    expect(screen.getByTestId('no-swap').textContent).toBe('No swap');
    expect(screen.queryByTestId('swap-used')).toBeNull();
  });
});

describe('DiskCard', () => {
  it('shows one row per filesystem', () => {
    render(
      <DiskCard
        disks={[
          {
            mountPoint: '/',
            device: '/dev/sda1',
            fsType: 'ext4',
            totalBytes: 100 * GiB,
            usedBytes: 40 * GiB,
            freeBytes: 55 * GiB,
            usagePercent: 42.1,
          },
          {
            mountPoint: '/mnt/media library',
            device: '/dev/sdb1',
            fsType: 'xfs',
            totalBytes: 2048 * GiB,
            usedBytes: 1024 * GiB,
            freeBytes: 1024 * GiB,
            usagePercent: 50,
          },
        ]}
      />,
    );
    expect(screen.getAllByTestId('disk-mount').map((el) => el.textContent)).toEqual([
      '/',
      '/mnt/media library',
    ]);
    expect(screen.getByText('/dev/sdb1 · xfs')).toBeTruthy();
    expect(screen.getByText(/1.00 TiB used · 1.00 TiB free · 2.00 TiB/)).toBeTruthy();
  });
});

describe('thresholds', () => {
  const disk = (usagePercent: number) => ({
    mountPoint: `/d${usagePercent}`,
    device: '/dev/sda1',
    fsType: 'ext4',
    totalBytes: 100 * GiB,
    usedBytes: usagePercent * GiB,
    freeBytes: (100 - usagePercent) * GiB,
    usagePercent,
  });

  it('labels each disk amber or red, in words as well as colour', () => {
    render(<DiskCard disks={[disk(79), disk(80), disk(89), disk(90)]} />);
    expect(screen.getAllByRole('meter').map((m) => m.dataset.level)).toEqual([
      'ok',
      'warn',
      'warn',
      'critical',
    ]);
    expect(screen.getAllByTestId('disk-level').map((el) => el.textContent)).toEqual([
      '▲Warning',
      '▲Warning',
      '■Critical',
    ]);
  });

  it('applies to CPU, memory and swap', () => {
    render(
      <CpuCard cpu={{ usagePercent: 91, perCore: [], load: { one: 0, five: 0, fifteen: 0 } }} />,
    );
    render(
      <MemoryCard
        memory={{ ...memory, usagePercent: 85, swap: { ...memory.swap!, usagePercent: 95 } }}
      />,
    );
    expect(screen.getByTestId('cpu-level').dataset.level).toBe('critical');
    expect(screen.getByTestId('memory-level').dataset.level).toBe('warn');
    expect(screen.getByTestId('swap-level').dataset.level).toBe('critical');
  });
});

describe('DiskIoCard', () => {
  it('shows totals and each disk, with a dash before the first rate', () => {
    render(
      <DiskIoCard
        diskIo={[
          { device: 'nvme0n1', readBytesPerSecond: 1024, writeBytesPerSecond: 2048 },
          { device: 'sda', readBytesPerSecond: 1024, writeBytesPerSecond: null },
        ]}
      />,
    );
    expect(screen.getByTestId('disk-read').textContent).toBe('2.00 KiB/s');
    expect(screen.getByTestId('disk-write').textContent).toBe('2.00 KiB/s');
    expect(screen.getAllByTestId('disk-io-row')).toHaveLength(2);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('NetworkCard', () => {
  const network = [
    { name: 'eth0', virtual: false, rxBytesPerSecond: 1024, txBytesPerSecond: 512 },
    { name: 'lo', virtual: true, rxBytesPerSecond: 99_999, txBytesPerSecond: 99_999 },
    { name: 'veth1a2b', virtual: true, rxBytesPerSecond: 1, txBytesPerSecond: 1 },
  ];

  it('hides loopback and veth until the toggle shows them', async () => {
    render(<NetworkCard network={network} />);
    const names = () => screen.getAllByTestId('network-name').map((el) => el.textContent);
    expect(names()).toEqual(['eth0']);
    // Totals never include virtual interfaces.
    expect(screen.getByTestId('net-rx').textContent).toBe('1.00 KiB/s');
    await userEvent.click(screen.getByLabelText(/Show loopback and veth/));
    // Busiest first: lo receives the most.
    expect(names()).toEqual(['lo', 'eth0', 'veth1a2b']);
    await userEvent.click(screen.getByLabelText(/Show loopback and veth/));
    expect(names()).toEqual(['eth0']);
  });
});

describe('byTraffic', () => {
  const nic = (name: string, rx: number | null, tx: number | null) => ({
    name,
    virtual: false,
    rxBytesPerSecond: rx,
    txBytesPerSecond: tx,
  });

  it('puts the highest receive rate first, then the highest transmit rate, then by name', () => {
    const sorted = byTraffic([
      nic('eth0', 100, 5),
      nic('wlan0', 900, 1),
      nic('eth1', 100, 50),
      nic('tailscale0', null, null),
      nic('bond0', 100, 50),
    ]);
    expect(sorted.map((n) => n.name)).toEqual(['wlan0', 'bond0', 'eth1', 'eth0', 'tailscale0']);
  });

  it('leaves the list it was given alone', () => {
    const given = [nic('a', 1, 1), nic('b', 2, 2)];
    byTraffic(given);
    expect(given.map((n) => n.name)).toEqual(['a', 'b']);
  });
});

describe('sparklines', () => {
  it('draw the Live Window', () => {
    const point = (cpuPercent: number | null) => ({
      timestamp: 0,
      cpuPercent,
      memoryPercent: 40,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      networkRxBytesPerSecond: 0,
      networkTxBytesPerSecond: 0,
    });
    render(
      <CpuCard
        cpu={{ usagePercent: 10, perCore: [], load: { one: 0, five: 0, fifteen: 0 } }}
        window={{
          capacity: 450,
          sampleIntervalMs: 2000,
          points: [point(null), point(10), point(20)],
        }}
      />,
    );
    const sparkline = screen.getByTestId('cpu-sparkline');
    expect(sparkline.dataset.points).toBe('3');
    expect(sparkline.getAttribute('aria-label')).toBe('CPU usage, last 15 minutes');
  });
});

describe('DockerDiskCard', () => {
  const NOW = Date.parse('2026-11-26T12:00:00Z');
  const part = (count: number, bytes: number, reclaimableBytes: number) => ({
    count,
    bytes,
    reclaimableBytes,
  });
  const overview = (overrides: Partial<StatsOverview> = {}): StatsOverview => ({
    available: true,
    error: null,
    persistent: true,
    retentionDays: 90,
    accessLogs: false,
    sites: {},
    measure: { state: 'idle', lastMeasuredAt: NOW, error: null },
    docker: {
      latest: {
        measuredAt: NOW,
        images: part(18, 6 * GiB, 0.5 * GiB),
        containers: part(16, 0, 0),
        volumes: part(50, 10 * GiB, 3 * GiB),
        buildCache: part(31, GiB, GiB),
      },
      points: [
        {
          start: NOW - 86_400_000,
          imagesBytes: 6 * GiB,
          containersBytes: 0,
          volumesBytes: 9 * GiB,
          buildCacheBytes: GiB,
        },
        {
          start: NOW,
          imagesBytes: 6 * GiB,
          containersBytes: 0,
          volumesBytes: 10 * GiB,
          buildCacheBytes: GiB,
        },
      ],
    },
    ...overrides,
  });

  it('shows each part with what pruning could free, and the trend, with no prune button', () => {
    render(<DockerDiskCard overview={overview()} error={null} now={NOW} onMeasured={() => {}} />);
    expect(screen.getByTestId('docker-disk-total').textContent).toBe('17.0 GiB');
    const rows = screen.getAllByTestId('docker-disk-row');
    expect(rows.map((row) => row.getAttribute('data-part'))).toEqual([
      'images',
      'containers',
      'volumes',
      'buildCache',
    ]);
    expect(rows[2]!.textContent).toBe('Volumes5010.0 GiB3.00 GiB');
    expect(screen.getByTestId('docker-disk-chart').getAttribute('data-points')).toBe('2');
    expect(screen.queryByRole('button', { name: /prune/i })).toBeNull();
    expect(screen.getByTestId('measure-now')).toBeTruthy();
  });

  it('says when it has never been measured, and why it is unavailable', () => {
    const { rerender } = render(
      <DockerDiskCard
        overview={overview({ docker: { latest: null, points: [] } })}
        error={null}
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    expect(screen.getByTestId('docker-disk-empty').textContent).toContain('Not measured yet');
    rerender(
      <DockerDiskCard
        overview={overview({ available: false, error: 'Could not open the stats store' })}
        error={null}
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    expect(screen.getByTestId('docker-disk-error').textContent).toBe(
      'Could not open the stats store',
    );
    rerender(
      <DockerDiskCard
        overview={undefined}
        error="Lookout cannot be reached."
        now={NOW}
        onMeasured={() => {}}
      />,
    );
    expect(screen.getByTestId('docker-disk-error').textContent).toBe('Lookout cannot be reached.');
  });
});
