import { useState } from 'react';
import { FOLDER_SCAN_PATH, PRIVATE_FOLDERS, type FolderScan } from '@lookout/shared';
import { postJson } from '../api.ts';
import { scanStatusText } from '../folders.ts';
import { useNow } from '../hooks.ts';
import {
  thresholdLevel,
  type CpuMetrics,
  type DiskFilesystem,
  type DiskIo,
  type HostOverview,
  type LiveWindowSnapshot,
  type MemoryMetrics,
  type NetworkInterface,
} from '@lookout/shared';
import { Card, LevelBadge, Meter, Stat } from '../components/Card.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { formatBytes, formatDuration, formatLoad, formatPercent, formatRate } from '../format.ts';
import { useLiveEvent, useThresholds } from '../live.ts';
import { PageGrid } from '../grid/PageGrid.tsx';

function windowLabel(window: LiveWindowSnapshot | undefined): string {
  const minutes = window ? Math.round((window.capacity * window.sampleIntervalMs) / 60_000) : 0;
  return minutes > 0 ? `last ${minutes} minutes` : 'recent samples';
}

export function OverviewCard({ overview }: { overview: HostOverview }) {
  return (
    <Card title="Overview" testId="overview-card">
      <dl className="stats">
        <Stat label="Hostname" value={overview.hostname} testId="hostname" />
        <Stat label="OS" value={overview.os} />
        <Stat label="Kernel" value={overview.kernel} />
        <Stat label="Uptime" value={formatDuration(overview.uptimeSeconds)} testId="uptime" />
      </dl>
    </Card>
  );
}

export function CpuCard({ cpu, window }: { cpu: CpuMetrics; window?: LiveWindowSnapshot }) {
  const level = thresholdLevel(cpu.usagePercent, useThresholds());
  return (
    <Card title="CPU" testId="cpu-card">
      <p className="headline">
        <span className="headline__value" data-testid="cpu-percent">
          {formatPercent(cpu.usagePercent)}
        </span>
        <span className="headline__label">in use</span>
        <LevelBadge level={level} testId="cpu-level" />
      </p>
      <Meter percent={cpu.usagePercent} label="CPU usage" level={level} />
      {window && (
        <Sparkline
          series={[{ values: window.points.map((p) => p.cpuPercent), tone: 'primary' }]}
          capacity={window.capacity}
          max={100}
          label={`CPU usage, ${windowLabel(window)}`}
          testId="cpu-sparkline"
        />
      )}
      <dl className="stats stats--inline" aria-label="Load average">
        <Stat label="Load 1m" value={formatLoad(cpu.load.one)} testId="load-1" />
        <Stat label="5m" value={formatLoad(cpu.load.five)} />
        <Stat label="15m" value={formatLoad(cpu.load.fifteen)} />
      </dl>
      <ul className="cores" aria-label="Per-core usage">
        {cpu.perCore.map((usage, index) => (
          <li key={index} className="cores__item">
            <span className="cores__name">Core {index}</span>
            <Meter percent={usage} label={`Core ${index} usage`} />
            <span className="cores__value">{formatPercent(usage)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MemoryCard({
  memory,
  window,
}: {
  memory: MemoryMetrics;
  window?: LiveWindowSnapshot;
}) {
  const thresholds = useThresholds();
  const level = thresholdLevel(memory.usagePercent, thresholds);
  const swapLevel = thresholdLevel(memory.swap?.usagePercent ?? null, thresholds);
  return (
    <Card title="Memory" testId="memory-card">
      <p className="headline">
        <span className="headline__value" data-testid="memory-percent">
          {formatPercent(memory.usagePercent)}
        </span>
        <span className="headline__label">in use</span>
        <LevelBadge level={level} testId="memory-level" />
      </p>
      <Meter percent={memory.usagePercent} label="Memory usage" level={level} />
      {window && (
        <Sparkline
          series={[{ values: window.points.map((p) => p.memoryPercent), tone: 'primary' }]}
          capacity={window.capacity}
          max={100}
          label={`Memory usage, ${windowLabel(window)}`}
          testId="memory-sparkline"
        />
      )}
      <dl className="stats stats--inline">
        <Stat label="Used" value={formatBytes(memory.usedBytes)} />
        <Stat label="Available" value={formatBytes(memory.availableBytes)} />
        <Stat label="Total" value={formatBytes(memory.totalBytes)} />
      </dl>
      <h3 className="card__subtitle">
        Swap <LevelBadge level={swapLevel} testId="swap-level" />
      </h3>
      {memory.swap ? (
        <>
          <Meter percent={memory.swap.usagePercent} label="Swap usage" level={swapLevel} />
          <dl className="stats stats--inline">
            <Stat
              label="Used"
              value={`${formatBytes(memory.swap.usedBytes)} (${formatPercent(memory.swap.usagePercent)})`}
              testId="swap-used"
            />
            <Stat label="Total" value={formatBytes(memory.swap.totalBytes)} />
          </dl>
        </>
      ) : (
        <p className="muted" data-testid="no-swap">
          No swap
        </p>
      )}
    </Card>
  );
}

export function DiskCard({ disks }: { disks: DiskFilesystem[] }) {
  const thresholds = useThresholds();
  return (
    <Card title="Disk space" testId="disk-card">
      {disks.length === 0 ? (
        <p className="muted">No filesystems found.</p>
      ) : (
        <ul className="disks">
          {disks.map((disk) => {
            const level = thresholdLevel(disk.usagePercent, thresholds);
            return (
              <li key={disk.mountPoint} className="disks__item" data-testid="disk">
                <div className="disks__head">
                  <span className="disks__mount" data-testid="disk-mount">
                    {disk.mountPoint}
                  </span>
                  <span className="disks__percent">
                    <LevelBadge level={level} testId="disk-level" />
                    <span data-testid="disk-percent">{formatPercent(disk.usagePercent)}</span>
                  </span>
                </div>
                <Meter
                  percent={disk.usagePercent}
                  label={`${disk.mountPoint} usage`}
                  level={level}
                />
                <div className="disks__detail muted">
                  <span>
                    {disk.device} · {disk.fsType}
                  </span>
                  <span>
                    {formatBytes(disk.usedBytes)} used · {formatBytes(disk.freeBytes)} free ·{' '}
                    {formatBytes(disk.totalBytes)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const total = (values: (number | null)[]) =>
  values.every((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);

/** A two-series throughput chart with its legend. */
function ThroughputLegend({ first, second }: { first: string; second: string }) {
  return (
    <p className="legend muted">
      <span className="legend__item legend__item--primary">{first}</span>
      <span className="legend__item legend__item--secondary">{second}</span>
    </p>
  );
}

export function DiskIoCard({ diskIo, window }: { diskIo: DiskIo[]; window?: LiveWindowSnapshot }) {
  return (
    <Card title="Disk I/O" testId="disk-io-card">
      <dl className="stats stats--inline stats--headline">
        <Stat
          label="Read"
          value={formatRate(total(diskIo.map((d) => d.readBytesPerSecond)))}
          testId="disk-read"
        />
        <Stat
          label="Write"
          value={formatRate(total(diskIo.map((d) => d.writeBytesPerSecond)))}
          testId="disk-write"
        />
      </dl>
      {window && (
        <>
          <Sparkline
            series={[
              { values: window.points.map((p) => p.diskReadBytesPerSecond), tone: 'primary' },
              { values: window.points.map((p) => p.diskWriteBytesPerSecond), tone: 'secondary' },
            ]}
            capacity={window.capacity}
            label={`Disk read and write throughput, ${windowLabel(window)}`}
            testId="disk-io-sparkline"
          />
          <ThroughputLegend first="Read" second="Write" />
        </>
      )}
      {diskIo.length === 0 ? (
        <p className="muted">No physical disks found.</p>
      ) : (
        <table className="rates">
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Read</th>
              <th scope="col">Write</th>
            </tr>
          </thead>
          <tbody>
            {diskIo.map((disk) => (
              <tr key={disk.device} data-testid="disk-io-row">
                <th scope="row">{disk.device}</th>
                <td>{formatRate(disk.readBytesPerSecond)}</td>
                <td>{formatRate(disk.writeBytesPerSecond)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function NetworkCard({
  network,
  window,
}: {
  network: NetworkInterface[];
  window?: LiveWindowSnapshot;
}) {
  const [showVirtual, setShowVirtual] = useState(false);
  const shown = showVirtual ? network : network.filter((nic) => !nic.virtual);
  const real = network.filter((nic) => !nic.virtual);
  const hidden = network.length - real.length;
  return (
    <Card
      title="Network"
      testId="network-card"
      actions={
        <label className="toggle">
          <input
            type="checkbox"
            checked={showVirtual}
            onChange={(event) => setShowVirtual(event.target.checked)}
          />
          Show loopback and veth{hidden > 0 ? ` (${hidden})` : ''}
        </label>
      }
      lead={
        <dl className="stats stats--inline stats--headline">
          <Stat
            label="Receive"
            value={formatRate(total(real.map((n) => n.rxBytesPerSecond)))}
            testId="net-rx"
          />
          <Stat
            label="Transmit"
            value={formatRate(total(real.map((n) => n.txBytesPerSecond)))}
            testId="net-tx"
          />
        </dl>
      }
    >
      {window && (
        <>
          <Sparkline
            series={[
              { values: window.points.map((p) => p.networkRxBytesPerSecond), tone: 'primary' },
              { values: window.points.map((p) => p.networkTxBytesPerSecond), tone: 'secondary' },
            ]}
            capacity={window.capacity}
            label={`Network receive and transmit throughput, ${windowLabel(window)}`}
            testId="network-sparkline"
          />
          <ThroughputLegend first="Receive" second="Transmit" />
        </>
      )}
      {shown.length === 0 ? (
        <p className="muted">No network interfaces found.</p>
      ) : (
        <table className="rates">
          <thead>
            <tr>
              <th scope="col">Interface</th>
              <th scope="col">Receive</th>
              <th scope="col">Transmit</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((nic) => (
              <tr key={nic.name} data-testid="network-row">
                <th scope="row" data-testid="network-name">
                  {nic.name}
                </th>
                <td>{formatRate(nic.rxBytesPerSecond)}</td>
                <td>{formatRate(nic.txBytesPerSecond)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** The Host's largest folders, by the disk space each uses, with when they were scanned. */
export function FoldersCard({ scan, now }: { scan: FolderScan | undefined; now: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanning = scan?.state === 'scanning';
  const scanNow = async () => {
    setBusy(true);
    setError(null);
    // The Widget updates from the live stream as the scan runs and ends.
    const result = await postJson<FolderScan>(FOLDER_SCAN_PATH);
    setBusy(false);
    if (!result.ok && result.status !== 409) setError(result.message);
  };
  const action = (
    <button
      type="button"
      className="button button--quiet button--small"
      onClick={() => void scanNow()}
      disabled={busy || scanning || !scan}
      data-testid="folders-scan-now"
    >
      {scanning ? 'Scanning…' : 'Scan now'}
    </button>
  );
  return (
    <Card
      title="Largest folders"
      testId="folders-card"
      actions={action}
      lead={
        !scan ? (
          <p className="muted folders__status" role="status">
            Loading…
          </p>
        ) : (
          <p className="muted folders__status" role="status" data-testid="folders-status">
            {scanStatusText(scan, now)}
          </p>
        )
      }
    >
      {scan && (
        <>
          {error && (
            <p className="error" role="alert" data-testid="folders-error">
              {error}
            </p>
          )}
          {scan.folders.length === 0 ? (
            scan.state === 'done' && <p className="muted">No folders found.</p>
          ) : (
            <ol className="disks folders">
              {scan.folders.map((folder) => (
                <li key={folder.path} className="disks__item" data-testid="folder">
                  <div className="disks__head">
                    <span className="disks__mount" data-testid="folder-path">
                      <bdi>{folder.path}</bdi>
                    </span>
                    <span className="disks__percent">
                      <span data-testid="folder-size">{formatBytes(folder.bytes)}</span>
                    </span>
                  </div>
                  <Meter
                    percent={folder.percentOfDisk}
                    label={`${folder.path} uses ${formatPercent(folder.percentOfDisk)} of ${folder.mountPoint}`}
                  />
                  <div className="disks__detail muted">
                    <span>
                      {formatPercent(folder.percentOfDisk)} of <bdi>{folder.mountPoint}</bdi>
                    </span>
                    <span>{formatBytes(folder.diskBytes)} disk</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {scan.partial && (
            <p className="notice folders__note" data-testid="folders-partial">
              The scan stopped early at its limits, so these sizes may be short.
            </p>
          )}
          {scan.unreadable > 0 && (
            <p className="notice folders__note" data-testid="folders-unreadable">
              {scan.unreadable.toLocaleString('en-GB')}{' '}
              {scan.unreadable === 1 ? 'folder' : 'folders'} could not be read, so these sizes leave
              them out.
            </p>
          )}
          <p className="muted folders__note" data-testid="folders-private">
            Home folders ({PRIVATE_FOLDERS.join(' and ')}) are never scanned.
          </p>
        </>
      )}
    </Card>
  );
}

export function HostPage() {
  const sample = useLiveEvent('host');
  const window = useLiveEvent('window');
  const folders = useLiveEvent('folders');
  const now = useNow(30_000);
  if (!sample) {
    return (
      <p className="muted" role="status">
        Waiting for the first sample…
      </p>
    );
  }
  const live = window ? { window } : {};
  return (
    <PageGrid
      page="host"
      title="Host"
      titleHidden
      widgets={{
        'host.overview': <OverviewCard overview={sample.overview} />,
        'host.cpu': <CpuCard cpu={sample.cpu} {...live} />,
        'host.memory': <MemoryCard memory={sample.memory} {...live} />,
        'host.disks': <DiskCard disks={sample.disks} />,
        'host.diskIo': <DiskIoCard diskIo={sample.diskIo} {...live} />,
        'host.network': <NetworkCard network={sample.network} {...live} />,
        'host.folders': <FoldersCard scan={folders} now={now} />,
      }}
    />
  );
}
