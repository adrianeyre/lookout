import { useState } from 'react';
import {
  SITE_STATUSES,
  isSiteFlagged,
  siteCheckPath,
  siteFlagReason,
  type ContainersSnapshot,
  type HostedSite,
  type SiteSummary,
  type SitesSnapshot,
  type StatsOverview,
  type SiteStatus,
  type TlsThresholds,
} from '@lookout/shared';
import { postJson } from '../api.ts';
import { FlagBadge, HealthBadge, StateBadge } from '../components/ContainerBits.tsx';
import { Link } from '../components/Link.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { useNow } from '../hooks.ts';
import { useLiveEvent } from '../live.ts';
import { containerPath, sitePath } from '../router.ts';
import { useStatsOverview } from '../stats.ts';
import {
  NO_SITE_FILTERS,
  filterSites,
  siteResultText,
  siteSinceText,
  sortSites,
  tlsSummary,
  type SiteFilters,
} from '../sites.ts';
import { PageGrid } from '../grid/PageGrid.tsx';

const STATUS_WORD: Record<SiteStatus, string> = {
  pending: 'checking',
  up: 'up',
  slow: 'slow',
  down: 'down',
};

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return (
    <span className={`site-status site-status--${status}`} data-testid="site-status">
      {STATUS_WORD[status]}
    </span>
  );
}

/** The Flagged marker for a Hosted Site: an icon and words, not colour alone. */
export function SiteFlagBadge({
  site,
  now,
  tls,
}: {
  site: HostedSite;
  now: number;
  tls: TlsThresholds;
}) {
  const reason = siteFlagReason(site, now, tls);
  if (reason === null) return null;
  return (
    <span className="flag" data-testid="site-flag">
      <span className="flag__icon" aria-hidden="true">
        ⚑
      </span>
      Flagged: {reason}
    </span>
  );
}

export function TlsBadge({
  site,
  now,
  tls,
}: {
  site: HostedSite;
  now: number;
  tls: TlsThresholds;
}) {
  const summary = tlsSummary(site, now, tls);
  if (summary === null) return null;
  const certificate = site.last?.tls;
  return (
    <span
      className={`tls tls--${summary.level}`}
      data-testid="site-tls"
      data-level={summary.level}
      title={certificate ? `Issued by ${certificate.issuer}` : undefined}
    >
      {summary.level !== 'ok' && (
        <span className="tls__icon" aria-hidden="true">
          {summary.level === 'critical' ? '■' : '▲'}
        </span>
      )}
      {summary.text}
    </span>
  );
}

function CheckNow({ site }: { site: HostedSite }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    // The row updates from the live stream as soon as the check finishes.
    const result = await postJson<HostedSite>(siteCheckPath(site.id));
    setBusy(false);
    if (!result.ok) setError(result.message);
  };
  return (
    <span className="site__check">
      <button
        type="button"
        className="button button--quiet button--small"
        onClick={() => void run()}
        disabled={busy}
        data-testid="site-check-now"
      >
        {busy ? 'Checking…' : 'Check now'}
        {/* Starts with the visible words, so voice control can say "Check now" (WCAG 2.5.3). */}
        <span className="visually-hidden">: {site.url}</span>
      </button>
      {error && (
        <span className="error error--inline" role="alert" data-testid="site-check-error">
          {error}
        </span>
      )}
    </span>
  );
}

/** The Container behind a Hosted Site: its state and health, linking to its detail view. */
function SiteContainer({
  site,
  containers,
}: {
  site: HostedSite;
  containers: ContainersSnapshot | undefined;
}) {
  if (site.containerId === null) return <span className="muted">From LOOKOUT_SITES</span>;
  const container = containers?.containers.find((c) => c.id === site.containerId);
  return (
    <span className="site__container" data-testid="site-container">
      <Link href={containerPath(site.containerId)}>{site.containerName ?? site.containerId}</Link>
      {container ? (
        <>
          <StateBadge container={container} />
          <HealthBadge container={container} />
          <FlagBadge container={container} />
        </>
      ) : (
        containers?.available && <span className="muted">Container gone</span>
      )}
    </span>
  );
}

/** Today's visitors and the last 7 days', from the access logs (#11). */
function SiteVisitors({ site, summary }: { site: HostedSite; summary: SiteSummary }) {
  return (
    <span className="site__visitors" data-testid="site-visitors">
      <span>
        <strong data-testid="site-visitors-today">
          {summary.todayVisitors.toLocaleString('en-GB')}
        </strong>{' '}
        <span className="muted">{summary.todayVisitors === 1 ? 'visitor' : 'visitors'} today</span>
      </span>
      <Sparkline
        series={[{ values: summary.last7Days, tone: 'secondary' }]}
        capacity={7}
        label={`Visitors per day over the last 7 days for ${site.url}: ${summary.last7Days.join(', ')}`}
        testId="site-visitors-sparkline"
      />
    </span>
  );
}

export function SiteRow({
  site,
  sites,
  containers,
  now,
  summary,
}: {
  site: HostedSite;
  sites: SitesSnapshot;
  containers: ContainersSnapshot | undefined;
  now: number;
  /** Visitor figures, only when the access logs are read. */
  summary?: SiteSummary | undefined;
}) {
  const { tls, historyCapacity, checkIntervalMs } = sites.settings;
  const flagged = isSiteFlagged(site, now, tls);
  const last = site.last;
  const minutes = Math.round((historyCapacity * checkIntervalMs) / 60_000);
  return (
    <li
      className={`row site${flagged ? ' row--flagged' : ''}`}
      data-testid="site-row"
      data-url={site.url}
      data-status={site.status}
      data-flagged={flagged}
    >
      <div className="row__main">
        <a
          className="row__name site__url"
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="site-url"
        >
          {site.url}
        </a>
        <SiteContainer site={site} containers={containers} />
      </div>
      <div className="row__status">
        <SiteStatusBadge status={site.status} />
        <span className="muted site__result" data-testid="site-result">
          {siteResultText(site)}
        </span>
        {last?.responseMs != null && (
          <span className="muted" data-testid="site-time">
            {last.responseMs} ms
          </span>
        )}
        <span className="muted" data-testid="site-since">
          {siteSinceText(site, now)}
        </span>
        <SiteFlagBadge site={site} now={now} tls={tls} />
      </div>
      <div className="row__stats">
        <TlsBadge site={site} now={now} tls={tls} />
        {summary && <SiteVisitors site={site} summary={summary} />}
      </div>
      <div className="site__trend">
        <Sparkline
          series={[{ values: site.history.map((p) => p.responseMs), tone: 'primary' }]}
          capacity={historyCapacity}
          label={`Response time over the last ${minutes} minutes`}
          testId="site-sparkline"
        />
        <span className="site__actions">
          <CheckNow site={site} />
          <Link
            href={sitePath(site.id)}
            className="button button--quiet button--small"
            testId="site-stats-link"
          >
            Stats
            <span className="visually-hidden">: {site.url}</span>
          </Link>
        </span>
      </div>
    </li>
  );
}

function Filters({
  filters,
  onChange,
}: {
  filters: SiteFilters;
  onChange: (filters: SiteFilters) => void;
}) {
  return (
    <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
      <label className="field filters__text">
        <span className="field__label">Filter</span>
        <input
          className="field__input"
          type="search"
          placeholder="URL or Container"
          value={filters.text}
          onChange={(event) => onChange({ ...filters, text: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">Status</span>
        <select
          className="field__input"
          value={filters.status}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as SiteFilters['status'] })
          }
        >
          <option value="all">All statuses</option>
          {SITE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle filters__flagged">
        <input
          type="checkbox"
          checked={filters.flaggedOnly}
          onChange={(event) => onChange({ ...filters, flaggedOnly: event.target.checked })}
        />
        Flagged only
      </label>
    </form>
  );
}

/** Hosted Sites with their latest checks, Flagged ones first (PRD §14). */
export function SiteList({
  sites,
  containers,
  now,
  stats,
}: {
  sites: SitesSnapshot;
  containers: ContainersSnapshot | undefined;
  now: number;
  /** Visitor figures for each row; none shown without them or without access logs. */
  stats?: StatsOverview | undefined;
}) {
  const [filters, setFilters] = useState<SiteFilters>(NO_SITE_FILTERS);
  const { tls } = sites.settings;
  if (sites.sites.length === 0) {
    return (
      <div className="notice" data-testid="sites-empty">
        <p>
          <strong>No Hosted Sites.</strong> Lookout lists websites from Traefik router labels, a{' '}
          <code>lookout.url</code> label on a Container, or the <code>LOOKOUT_SITES</code> setting.
        </p>
      </div>
    );
  }
  const shown = sortSites(filterSites(sites.sites, filters, now, tls), now, tls);
  return (
    <>
      <Filters filters={filters} onChange={setFilters} />
      <p className="muted" role="status" data-testid="site-count">
        Showing {shown.length} of {sites.sites.length} Hosted Sites · checked every{' '}
        {Math.round(sites.settings.checkIntervalMs / 1000)} s
        {sites.notChecked ? (
          <>
            {' '}
            · {sites.notChecked} more found in Container labels and not checked (LOOKOUT_SITES come
            first)
          </>
        ) : null}
      </p>
      {shown.length === 0 ? (
        <p className="muted">No Hosted Sites match.</p>
      ) : (
        <ul className="rows">
          {shown.map((site) => (
            <SiteRow
              key={site.id}
              site={site}
              sites={sites}
              containers={containers}
              now={now}
              summary={stats?.available && stats.accessLogs ? stats.sites[site.id] : undefined}
            />
          ))}
        </ul>
      )}
    </>
  );
}

export function WebsitesPage() {
  const sites = useLiveEvent('sites');
  const containers = useLiveEvent('containers');
  const stats = useStatsOverview();
  const now = useNow(5000);
  return (
    <PageGrid
      page="websites"
      title="Websites"
      widgets={{
        'websites.list': sites ? (
          <SiteList sites={sites} containers={containers} now={now} stats={stats.value} />
        ) : (
          <p className="muted" role="status">
            Loading Hosted Sites…
          </p>
        ),
      }}
    />
  );
}
