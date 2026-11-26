import { useEffect, useState, type ReactNode } from 'react';
import {
  DAY_MS,
  STATS_RANGES,
  STATS_TOP_COUNT,
  type ContainersSnapshot,
  type HostedSite,
  type MeasureState,
  type SiteStats,
  type StatsOverview,
  type StatsRange,
  type TopEntry,
  type TrafficSource,
} from '@lookout/shared';
import { Card, Stat } from '../components/Card.tsx';
import { BarChart, LineChart, type ChartSeries } from '../components/Chart.tsx';
import { HealthBadge, StateBadge } from '../components/ContainerBits.tsx';
import { Link } from '../components/Link.tsx';
import { formatAgo, formatBytes, formatPercent } from '../format.ts';
import { PageGrid } from '../grid/PageGrid.tsx';
import { useNow } from '../hooks.ts';
import { useLiveEvent } from '../live.ts';
import { PATHS, containerPath } from '../router.ts';
import { measureNow, useSiteStats, useStatsOverview } from '../stats.ts';

const RANGE_LABEL: Record<StatsRange, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

const count = (value: number) => value.toLocaleString('en-GB', { maximumFractionDigits: 1 });
const ms = (value: number) => `${Math.round(value).toLocaleString('en-GB')} ms`;
const percent = (value: number) => formatPercent(value);

/** The 24h / 7d / 30d / 90d switch: radio buttons drawn as one segmented control. */
export function RangeSwitch({
  range,
  onChange,
}: {
  range: StatsRange;
  onChange: (range: StatsRange) => void;
}) {
  return (
    <fieldset className="segmented" data-testid="stats-range">
      <legend className="visually-hidden">Range</legend>
      {STATS_RANGES.map((value) => (
        <label key={value} className="segmented__option">
          <input
            type="radio"
            name="stats-range"
            value={value}
            checked={value === range}
            onChange={() => onChange(value)}
            aria-label={RANGE_LABEL[value]}
          />
          <span aria-hidden="true">{value}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Why a site has no visitor figures, in words, or null when it has them. */
export function trafficEmptyText(source: TrafficSource): string | null {
  switch (source) {
    case 'not-configured':
      return 'Visitor figures need the access logs: LOOKOUT_ACCESS_LOGS is not set.';
    case 'no-logs':
      return "No access log file matches LOOKOUT_ACCESS_LOGS, or it can't be read.";
    case 'no-entries':
      return "No requests for this site's host in the access logs yet.";
    case 'ok':
      return null;
  }
}

function Empty({ text, testId = 'widget-empty' }: { text: string; testId?: string }) {
  return (
    <p className="muted stats-empty" data-testid={testId}>
      {text}
    </p>
  );
}

const unit = (stats: SiteStats) => (stats.bucket === 'hour' ? 'hour' : 'day');

/** A traffic Widget: its chart, or why there is none. */
function TrafficCard({
  title,
  testId,
  stats,
  chart,
}: {
  title: string;
  testId: string;
  stats: SiteStats;
  chart: (starts: number[]) => ReactNode;
}) {
  const empty = trafficEmptyText(stats.traffic.source);
  return (
    <Card title={title} testId={testId}>
      {empty ? <Empty text={empty} /> : chart(stats.traffic.points.map((p) => p.start))}
    </Card>
  );
}

export function VisitorsCard({ stats }: { stats: SiteStats }) {
  const points = stats.traffic.points;
  const total = points.reduce((sum, p) => sum + p.visitors, 0);
  return (
    <TrafficCard
      title="Visitors"
      testId="site-visitors"
      stats={stats}
      chart={(starts) => (
        <>
          <p className="headline">
            <span className="headline__value" data-testid="site-visitors-latest">
              {count(points.at(-1)?.visitors ?? 0)}
            </span>
            <span className="headline__label">
              this {unit(stats)} · {count(total)} in {RANGE_LABEL[stats.range].toLowerCase()}
            </span>
          </p>
          <LineChart
            series={[{ name: 'Visitors', values: points.map((p) => p.visitors), tone: 'primary' }]}
            starts={starts}
            bucket={stats.bucket}
            label={`Unique visitors per ${unit(stats)}`}
            format={count}
            testId="site-visitors-chart"
          />
        </>
      )}
    />
  );
}

export function PageViewsCard({ stats }: { stats: SiteStats }) {
  const points = stats.traffic.points;
  return (
    <TrafficCard
      title="Page views and requests"
      testId="site-page-views"
      stats={stats}
      chart={(starts) => (
        <BarChart
          series={[
            { name: 'Page views', values: points.map((p) => p.pageViews), tone: 'primary' },
            { name: 'Requests', values: points.map((p) => p.requests), tone: 'secondary' },
          ]}
          starts={starts}
          bucket={stats.bucket}
          label={`Page views and requests per ${unit(stats)}`}
          format={count}
          testId="site-page-views-chart"
        />
      )}
    />
  );
}

export function BotsCard({ stats }: { stats: SiteStats }) {
  const points = stats.traffic.points;
  return (
    <TrafficCard
      title="Humans and bots"
      testId="site-bots"
      stats={stats}
      chart={(starts) => (
        <BarChart
          stacked
          series={[
            {
              name: 'Humans',
              values: points.map((p) => Math.max(0, p.requests - p.bots)),
              tone: 'primary',
            },
            { name: 'Bots', values: points.map((p) => p.bots), tone: 'muted' },
          ]}
          starts={starts}
          bucket={stats.bucket}
          label={`Requests from humans and bots per ${unit(stats)}`}
          format={count}
          testId="site-bots-chart"
        />
      )}
    />
  );
}

export function StatusCard({ stats }: { stats: SiteStats }) {
  const points = stats.traffic.points;
  const series: ChartSeries[] = [
    { name: '2xx', values: points.map((p) => p.status['2xx']), tone: 'ok' },
    { name: '3xx', values: points.map((p) => p.status['3xx']), tone: 'primary' },
    { name: '4xx', values: points.map((p) => p.status['4xx']), tone: 'warn' },
    { name: '5xx', values: points.map((p) => p.status['5xx']), tone: 'critical' },
  ];
  return (
    <TrafficCard
      title="Status codes"
      testId="site-status-codes"
      stats={stats}
      chart={(starts) => (
        <BarChart
          stacked
          series={series}
          starts={starts}
          bucket={stats.bucket}
          label={`Responses by status class per ${unit(stats)}`}
          format={count}
          testId="site-status-chart"
        />
      )}
    />
  );
}

export function ResponseTimeCard({ stats }: { stats: SiteStats }) {
  const points = stats.traffic.points;
  return (
    <TrafficCard
      title="Response time"
      testId="site-response-time"
      stats={stats}
      chart={(starts) => (
        <LineChart
          series={[
            { name: 'p50', values: points.map((p) => p.p50Ms), tone: 'primary' },
            { name: 'p95', values: points.map((p) => p.p95Ms), tone: 'secondary' },
          ]}
          starts={starts}
          bucket={stats.bucket}
          label={`Response time per ${unit(stats)}, median and 95th percentile`}
          format={ms}
          summary="average"
          testId="site-response-chart"
        />
      )}
    />
  );
}

export function TopCard({
  title,
  testId,
  heading,
  entries,
  stats,
}: {
  title: string;
  testId: string;
  heading: string;
  entries: TopEntry[];
  stats: SiteStats;
}) {
  const empty = trafficEmptyText(stats.traffic.source);
  return (
    <Card title={title} testId={testId}>
      {empty ? (
        <Empty text={empty} />
      ) : entries.length === 0 ? (
        <Empty text={`None in ${RANGE_LABEL[stats.range].toLowerCase()}.`} />
      ) : (
        <table className="rates top-table">
          <thead>
            <tr>
              <th scope="col">{heading}</th>
              <th scope="col">Requests</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, STATS_TOP_COUNT).map((entry) => (
              <tr key={entry.key} data-testid={`${testId}-row`}>
                <th scope="row">
                  <bdi>{entry.key}</bdi>
                </th>
                <td>{count(entry.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function UptimeCard({ stats }: { stats: SiteStats }) {
  const points = stats.uptime;
  const checks = points.reduce((sum, p) => sum + p.checks, 0);
  const up = points.reduce((sum, p) => sum + p.up, 0);
  const starts = points.map((p) => p.start);
  return (
    <Card title="Uptime" testId="site-uptime">
      {checks === 0 ? (
        <Empty text={`No checks in ${RANGE_LABEL[stats.range].toLowerCase()} yet.`} />
      ) : (
        <>
          <p className="headline">
            <span className="headline__value" data-testid="site-uptime-percent">
              {formatPercent((up / checks) * 100)}
            </span>
            <span className="headline__label">up, {count(checks)} checks</span>
          </p>
          <LineChart
            series={[{ name: 'Uptime', values: points.map((p) => p.uptimePercent), tone: 'ok' }]}
            starts={starts}
            bucket={stats.bucket}
            max={100}
            label={`Uptime per ${unit(stats)}`}
            format={percent}
            summary="average"
            testId="site-uptime-chart"
          />
          <h3 className="card__subtitle">Latency</h3>
          <LineChart
            series={[
              { name: 'p50', values: points.map((p) => p.p50Ms), tone: 'primary' },
              { name: 'p95', values: points.map((p) => p.p95Ms), tone: 'secondary' },
            ]}
            starts={starts}
            bucket={stats.bucket}
            label={`Check latency per ${unit(stats)}, median and 95th percentile`}
            format={ms}
            summary="average"
            testId="site-latency-chart"
          />
        </>
      )}
    </Card>
  );
}

export function TlsCard({ stats, now }: { stats: SiteStats; now: number }) {
  const https = stats.url.startsWith('https:');
  let body;
  if (!https) {
    body = <Empty text="Not https, so there is no certificate." />;
  } else if (stats.tlsValidTo === null) {
    body = <Empty text="No certificate seen yet." />;
  } else {
    const days = Math.ceil((stats.tlsValidTo - now) / DAY_MS);
    const expiry = new Date(stats.tlsValidTo).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    body = (
      <p className="headline">
        <span className="headline__value" data-testid="site-tls-days">
          {days <= 0 ? 'Expired' : `${days} ${days === 1 ? 'day' : 'days'}`}
        </span>
        <span className="headline__label">
          {days <= 0 ? `on ${expiry}` : `left, expires ${expiry}`}
        </span>
      </p>
    );
  }
  return (
    <Card title="TLS certificate" testId="site-tls-card">
      {body}
    </Card>
  );
}

const SIZE_PARTS = [
  { key: 'volumesBytes', name: 'Volumes', tone: 'primary' },
  { key: 'imagesBytes', name: 'Images', tone: 'secondary' },
  { key: 'writableBytes', name: 'Writable layers', tone: 'warn' },
  { key: 'folderBytes', name: 'Folder', tone: 'ok' },
] as const;

function sizeSubject(stats: SiteStats): string | null {
  const { source, subject } = stats.sizes;
  if (subject === null) return null;
  if (source === 'project') return `Compose Project ${subject}`;
  if (source === 'container') return `Container ${subject}`;
  if (source === 'folder') return `Folder ${subject}`;
  return null;
}

/** "Measure now", with what it is doing and why it failed. It only measures; nothing is deleted. */
export function MeasureNow({
  state,
  lastMeasuredAt,
  error,
  now,
  onMeasured,
}: {
  state: MeasureState | undefined;
  lastMeasuredAt: number | null;
  error: string | null;
  now: number;
  onMeasured: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const measuring = busy || state === 'measuring';
  const run = async () => {
    setBusy(true);
    setFailure(null);
    const message = await measureNow();
    setBusy(false);
    if (message) setFailure(message);
    onMeasured();
  };
  const shown = failure ?? error;
  return (
    <div className="measure">
      <button
        type="button"
        className="button button--quiet button--small"
        onClick={() => void run()}
        disabled={measuring}
        data-testid="measure-now"
      >
        {measuring ? 'Measuring…' : 'Measure now'}
      </button>
      <span className="muted" role="status" data-testid="measure-status">
        {measuring
          ? 'Measuring disk and Docker space…'
          : lastMeasuredAt
            ? `Measured ${formatAgo(lastMeasuredAt, now)} ago · daily at 03:00`
            : 'Measured daily at 03:00'}
      </span>
      {shown && (
        <span className="error error--inline" role="alert" data-testid="measure-error">
          {shown}
        </span>
      )}
    </div>
  );
}

export function SizeCard({
  stats,
  overview,
  now,
  onMeasured,
}: {
  stats: SiteStats;
  overview: StatsOverview | undefined;
  now: number;
  onMeasured: () => void;
}) {
  const { source, points } = stats.sizes;
  const latest = points.at(-1);
  const parts = SIZE_PARTS.filter((part) => points.some((p) => p[part.key] !== null));
  const subject = sizeSubject(stats);
  let body;
  if (source === 'none') {
    body = (
      <Empty text="This site has no Container or folder to measure: add a lookout.url label to its Container, or URL=/folder in LOOKOUT_SITES." />
    );
  } else if (!latest) {
    body = <Empty text="Not measured yet." />;
  } else {
    const total = parts.reduce((sum, part) => sum + (latest[part.key] ?? 0), 0);
    body = (
      <>
        <p className="headline">
          <span className="headline__value" data-testid="site-size-total">
            {formatBytes(total)}
          </span>
          <span className="headline__label">in all</span>
        </p>
        <dl className="stats stats--inline">
          {parts.map((part) => (
            <Stat
              key={part.key}
              label={part.name}
              value={formatBytes(latest[part.key] ?? 0)}
              testId={`site-size-${part.key}`}
            />
          ))}
        </dl>
        <BarChart
          stacked
          series={parts.map((part) => ({
            name: part.name,
            values: points.map((p) => p[part.key]),
            tone: part.tone,
          }))}
          starts={points.map((p) => p.start)}
          bucket="day"
          label="Disk and Docker space per day, last 90 days"
          format={formatBytes}
          summary="average"
          testId="site-size-chart"
        />
      </>
    );
  }
  return (
    <Card title="Disk and Docker space" testId="site-size">
      {subject && (
        <p className="muted" data-testid="site-size-subject">
          <bdi>{subject}</bdi>
        </p>
      )}
      {body}
      {source !== 'none' && (
        <MeasureNow
          state={overview?.measure.state}
          lastMeasuredAt={overview?.measure.lastMeasuredAt ?? null}
          error={overview?.measure.error ?? null}
          now={now}
          onMeasured={onMeasured}
        />
      )}
    </Card>
  );
}

/** The site's Containers: every one in its Compose Project, or just its own. */
export function siteContainers(
  site: HostedSite | undefined,
  snapshot: ContainersSnapshot | undefined,
) {
  if (!site?.containerId || !snapshot) return [];
  const own = snapshot.containers.find((c) => c.id === site.containerId);
  if (!own) return [];
  if (own.composeProject === null) return [own];
  return snapshot.containers
    .filter((c) => c.composeProject === own.composeProject)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ContainersCard({
  site,
  containers,
}: {
  site: HostedSite | undefined;
  containers: ContainersSnapshot | undefined;
}) {
  const list = siteContainers(site, containers);
  let body;
  if (!site?.containerId) {
    body = <Empty text="From LOOKOUT_SITES: no Container serves it that Lookout knows of." />;
  } else if (containers && !containers.available) {
    body = <Empty text="Docker is unavailable." />;
  } else if (list.length === 0) {
    body = <Empty text={containers ? 'Its Container is gone.' : 'Loading Containers…'} />;
  } else {
    const project = list[0]!.composeProject;
    body = (
      <>
        {project && (
          <p className="muted">
            Compose Project <bdi>{project}</bdi>
          </p>
        )}
        <ul className="site-containers">
          {list.map((container) => (
            <li key={container.id} data-testid="site-container-row">
              <Link href={containerPath(container.id)}>{container.name}</Link>
              <StateBadge container={container} />
              <HealthBadge container={container} />
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <Card title="Containers" testId="site-containers">
      {body}
    </Card>
  );
}

function Back() {
  return (
    <p className="back">
      <Link href={PATHS.websites} className="button button--quiet button--back">
        <span aria-hidden="true">←</span> All Websites
      </Link>
    </p>
  );
}

/** One Hosted Site's stats: visitors, uptime and size, as Widgets (#10). */
export function SiteStatsPage({ id }: { id: string }) {
  const [range, setRange] = useState<StatsRange>('7d');
  const stats = useSiteStats(id, range);
  const overview = useStatsOverview();
  const sites = useLiveEvent('sites');
  const containers = useLiveEvent('containers');
  const now = useNow(30_000);
  const site = sites?.sites.find((s) => s.id === id);

  // A measurement that finishes brings new sizes: ask for this site's stats again.
  const lastMeasuredAt = overview.value?.measure.lastMeasuredAt ?? null;
  const refreshStats = stats.refresh;
  useEffect(() => {
    if (lastMeasuredAt !== null) refreshStats();
  }, [lastMeasuredAt, refreshStats]);

  if (stats.status === 404) {
    return (
      <>
        <Back />
        <p className="error" role="alert" data-testid="site-stats-error">
          There is no Hosted Site with this ID. It may have gone since the link was made.
        </p>
      </>
    );
  }
  if (stats.error && !stats.value) {
    return (
      <>
        <Back />
        <p className="error" role="alert" data-testid="site-stats-error">
          {stats.error}
        </p>
      </>
    );
  }
  const url = stats.value?.url ?? site?.url ?? '';
  const head = (
    <div className="site-stats__head">
      <Back />
      <h1 className="page-title site-stats__title" data-testid="site-stats-title">
        <bdi>{url || 'Site Stats'}</bdi>
      </h1>
      <RangeSwitch range={range} onChange={setRange} />
    </div>
  );
  const value = stats.value;
  if (!value) {
    return (
      <PageGrid
        page="site"
        title="Site Stats"
        head={head}
        widgets={{
          'site.visitors': (
            <p className="muted" role="status">
              Loading…
            </p>
          ),
        }}
      />
    );
  }
  return (
    <PageGrid
      page="site"
      title="Site Stats"
      head={head}
      widgets={{
        'site.visitors': <VisitorsCard stats={value} />,
        'site.pageViews': <PageViewsCard stats={value} />,
        'site.bots': <BotsCard stats={value} />,
        'site.status': <StatusCard stats={value} />,
        'site.responseTime': <ResponseTimeCard stats={value} />,
        'site.uptime': <UptimeCard stats={value} />,
        'site.topPages': (
          <TopCard
            title="Top pages"
            testId="site-top-pages"
            heading="Path"
            entries={value.topPages}
            stats={value}
          />
        ),
        'site.topReferrers': (
          <TopCard
            title="Top referrers"
            testId="site-top-referrers"
            heading="Domain"
            entries={value.topReferrers}
            stats={value}
          />
        ),
        'site.size': (
          <SizeCard
            stats={value}
            overview={overview.value}
            now={now}
            onMeasured={overview.refresh}
          />
        ),
        'site.tls': <TlsCard stats={value} now={now} />,
        'site.containers': <ContainersCard site={site} containers={containers} />,
      }}
    />
  );
}
