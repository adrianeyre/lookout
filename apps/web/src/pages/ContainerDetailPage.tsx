import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { PageGrid } from '../grid/PageGrid.tsx';
import {
  SECRET_MASK,
  isSelf,
  secretPath,
  type ContainerDetail,
  type ContainerSummary,
  type EnvValue,
  type SecretField,
  type SecretValue,
  type SitesSnapshot,
} from '@lookout/shared';
import { getJson } from '../api.ts';
import { Card, Stat } from '../components/Card.tsx';
import { ContainerActions } from '../components/ContainerActions.tsx';
import { FlagBadge, HealthBadge, StateBadge, StatsText } from '../components/ContainerBits.tsx';
import { Link } from '../components/Link.tsx';
import { LogViewer } from '../components/LogViewer.tsx';
import { publishedPorts, statusText } from '../containers.ts';
import { formatTimestamp } from '../format.ts';
import { useContainerStats, useNow } from '../hooks.ts';
import { useLiveEvent } from '../live.ts';
import { PATHS, navigate } from '../router.ts';
import { sitesForContainer } from '../sites.ts';
import { DockerUnavailable } from './ContainersPage.tsx';
import { SiteFlagBadge, SiteStatusBadge } from './WebsitesPage.tsx';

/** The Hosted Sites a Container serves, linking each to the Websites page (PRD §14). */
export function ContainerSites({
  container,
  sites,
  now,
}: {
  container: ContainerSummary;
  sites: SitesSnapshot | undefined;
  now: number;
}) {
  const served = sites ? sitesForContainer(sites.sites, container) : [];
  if (!sites || served.length === 0) return null;
  return (
    <Card title="Hosted Sites" testId="detail-sites">
      <ul className="plain-list">
        {served.map((site) => (
          <li key={site.id} className="detail-site" data-testid="detail-site" data-url={site.url}>
            <Link href={PATHS.websites}>{site.url}</Link> <SiteStatusBadge status={site.status} />{' '}
            <SiteFlagBadge site={site} now={now} tls={sites.settings.tls} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

const envUrl = (id: string, name: string) =>
  `/api/containers/${encodeURIComponent(id)}/env/${encodeURIComponent(name)}`;

/**
 * One value the server masked because it looks like a secret (#91): a command argument, a
 * label or a mount source. Like an environment value, it is fetched only when its own reveal
 * control is used, and forgotten again when hidden.
 */
export function MaskedValue({
  containerId,
  field,
  secretKey,
  shown,
  label,
}: {
  containerId: string;
  field: SecretField;
  secretKey: string | number;
  /** What the server sent: the value with its secret part masked. */
  shown: string;
  /** Names the value for the button, e.g. "command argument 3". */
  label: string;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (value !== null) return setValue(null);
    setError(null);
    const result = await getJson<SecretValue>(secretPath(containerId, field, secretKey));
    if (result.ok) setValue(result.value.value);
    else setError(`Could not reveal ${label}: ${result.message}`);
  };
  return (
    <span className="secret" data-testid="masked-value">
      <bdi>{value ?? shown}</bdi>{' '}
      <button
        type="button"
        className="button button--quiet button--small"
        onClick={() => void toggle()}
        aria-label={`${value === null ? 'Reveal' : 'Hide'} ${label}`}
      >
        {value === null ? 'Reveal' : 'Hide'}
      </button>
      {error && (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      )}
    </span>
  );
}

/** A command or entrypoint, each argument isolated and masked arguments revealable. */
function Args({
  containerId,
  field,
  args,
  masked,
}: {
  containerId: string;
  field: 'command' | 'entrypoint';
  args: string[];
  masked: number[];
}) {
  if (args.length === 0) return <code>—</code>;
  return (
    <code>
      {args.map((arg, index) => (
        <Fragment key={index}>
          {index > 0 && ' '}
          {masked.includes(index) ? (
            <MaskedValue
              containerId={containerId}
              field={field}
              secretKey={index}
              shown={arg}
              label={`${field} argument ${index + 1}`}
            />
          ) : (
            <bdi>{arg}</bdi>
          )}
        </Fragment>
      ))}
    </code>
  );
}

/**
 * Environment variables with values masked (FR-20). A value is fetched from the server only
 * when its own reveal control is used, and is forgotten again when hidden. Lookout's own
 * Container holds its session secret and password hash, so its values are never revealable
 * (#79).
 */
export function EnvList({
  containerId,
  names,
  self = false,
}: {
  containerId: string;
  names: string[];
  self?: boolean;
}) {
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const reveal = async (name: string) => {
    setError(null);
    const result = await getJson<EnvValue>(envUrl(containerId, name));
    if (result.ok) setRevealed((current) => new Map(current).set(name, result.value.value));
    else setError(`Could not reveal ${name}: ${result.message}`);
  };
  const hide = (name: string) =>
    setRevealed((current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });

  if (names.length === 0) return <p className="muted">No environment variables.</p>;
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {self && (
        <p className="muted" data-testid="env-self">
          This is Lookout&apos;s own Container: its values are never revealed here.
        </p>
      )}
      <ul className="env">
        {names.map((name, index) => {
          const value = revealed.get(name);
          return (
            <li key={`${name}-${index}`} className="env__item" data-testid="env-var">
              <bdi className="env__name" data-testid="env-name">
                {name}
              </bdi>
              <span className="env__value" data-testid="env-value">
                {value === undefined ? (
                  <span className="env__mask" aria-label="Hidden value">
                    {SECRET_MASK}
                  </span>
                ) : (
                  <bdi>{value}</bdi>
                )}
              </span>
              {!self && (
                <button
                  type="button"
                  className="button button--quiet button--small"
                  onClick={() => (value === undefined ? void reveal(name) : hide(name))}
                  aria-label={`${value === undefined ? 'Reveal' : 'Hide'} ${name}`}
                >
                  {value === undefined ? 'Reveal' : 'Hide'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function List({ items, empty }: { items: ReactNode[]; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return <ul className="plain-list">{items}</ul>;
}

export function ContainerDetailView({
  detail,
  live,
}: {
  detail: ContainerDetail;
  /** The latest list row for this Container, which updates live. */
  live: ContainerSummary;
}) {
  const now = useNow();
  const stats = useContainerStats();
  const sites = useLiveEvent('sites');
  const ports = publishedPorts(live.ports);
  const served = sites ? sitesForContainer(sites.sites, live) : [];
  return (
    <PageGrid
      page="container"
      title={live.name}
      head={
        <div className="detail__head">
          <h1 className="page-title" data-testid="detail-name">
            <bdi>{live.name}</bdi>
          </h1>
          <div className="row__status">
            <StateBadge container={live} />
            <HealthBadge container={live} />
            <span className="muted" data-testid="container-status">
              {statusText(live, now)}
            </span>
            <FlagBadge container={live} />
          </div>
          <ContainerActions container={live} onRemoved={() => navigate(PATHS.containers)} />
        </div>
      }
      empty={served.length === 0 ? ['container.sites'] : []}
      widgets={{
        'container.details': (
          <Card title="Container" testId="detail-container">
            <dl className="stats">
              <Stat label="Image" value={<bdi>{live.image}</bdi>} />
              <Stat label="Container ID" value={<code>{detail.id}</code>} />
              <Stat label="Image ID" value={<code>{detail.imageId}</code>} />
              <Stat
                label="Digest"
                value={detail.imageDigest ? <code>{detail.imageDigest}</code> : '—'}
              />
              <Stat
                label="Compose Project"
                value={
                  live.composeProject === null ? 'Standalone' : <bdi>{live.composeProject}</bdi>
                }
              />
              <Stat
                label="Entrypoint"
                value={
                  <Args
                    containerId={detail.id}
                    field="entrypoint"
                    args={detail.entrypoint}
                    masked={detail.masked.entrypoint}
                  />
                }
              />
              <Stat
                label="Command"
                value={
                  <Args
                    containerId={detail.id}
                    field="command"
                    args={detail.command}
                    masked={detail.masked.command}
                  />
                }
              />
              <Stat label="Ports" value={ports.length > 0 ? ports.join(', ') : '—'} />
              {live.state === 'running' && (
                <Stat
                  label="Usage"
                  value={
                    <span className="usage">
                      <StatsText stats={stats.get(live.id)} />
                    </span>
                  }
                />
              )}
            </dl>
          </Card>
        ),
        'container.lifecycle': (
          <Card title="Lifecycle" testId="detail-lifecycle">
            <dl className="stats">
              <Stat label="Restart policy" value={detail.restartPolicy} />
              <Stat label="Restart count" value={detail.restartCount} testId="restart-count" />
              <Stat label="Last exit code" value={live.exitCode ?? '—'} testId="exit-code" />
              <Stat label="Created" value={formatTimestamp(live.createdAt)} />
              <Stat label="Started" value={formatTimestamp(live.startedAt)} />
              <Stat label="Finished" value={formatTimestamp(live.finishedAt)} />
            </dl>
          </Card>
        ),
        'container.sites': <ContainerSites container={live} sites={sites} now={now} />,
        'container.env': (
          <Card title="Environment" testId="detail-env">
            <EnvList containerId={detail.id} names={detail.envNames} self={isSelf(live)} />
          </Card>
        ),
        'container.mounts': (
          <Card title="Mounts" testId="detail-mounts">
            <List
              empty="No mounts."
              items={detail.mounts.map((mount, index) => (
                <li key={`${mount.destination}-${index}`}>
                  <code>
                    {detail.masked.mounts.includes(index) ? (
                      <MaskedValue
                        containerId={detail.id}
                        field="mount"
                        secretKey={index}
                        shown={mount.source}
                        label={`source of the mount at ${mount.destination}`}
                      />
                    ) : (
                      <bdi>{mount.source || mount.type}</bdi>
                    )}
                  </code>{' '}
                  →{' '}
                  <code>
                    <bdi>{mount.destination}</bdi>
                  </code>{' '}
                  <span className="muted">
                    {mount.type}
                    {mount.readOnly ? ' · read-only' : ' · read-write'}
                  </span>
                </li>
              ))}
            />
          </Card>
        ),
        'container.networks': (
          <Card title="Networks" testId="detail-networks">
            <List
              empty="No networks."
              items={detail.networks.map((network) => (
                <li key={network.name}>
                  <strong>
                    <bdi>{network.name}</bdi>
                  </strong>{' '}
                  <span className="muted">
                    <bdi>
                      {[network.ipAddress, network.ipv6Address].filter(Boolean).join(', ') ||
                        'no address'}
                    </bdi>
                    {network.gateway ? (
                      <>
                        {' · gateway '}
                        <bdi>{network.gateway}</bdi>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            />
          </Card>
        ),
        'container.labels': (
          <Card title="Labels" testId="detail-labels">
            <List
              empty="No labels."
              items={Object.entries(live.labels)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => (
                  <li key={key}>
                    <code>
                      <bdi>{key}</bdi>
                    </code>{' '}
                    ={' '}
                    <code>
                      {live.maskedLabels.includes(key) ? (
                        <MaskedValue
                          containerId={detail.id}
                          field="label"
                          secretKey={key}
                          shown={value}
                          label={`label ${key}`}
                        />
                      ) : (
                        <bdi>{value}</bdi>
                      )}
                    </code>
                  </li>
                ))}
            />
          </Card>
        ),
        'container.logs': <LogViewer containerId={detail.id} />,
      }}
    />
  );
}

/** The detail view for one Container, at /containers/:id. */
export function ContainerDetailPage({ id }: { id: string }) {
  const snapshot = useLiveEvent('containers');
  const live = snapshot?.containers.find((c) => c.id === id || c.name === id);
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Detail-only fields (restart count, networks…) can change when the Container's state
  // does, so fetch again then.
  const version = live ? `${live.state}|${live.health}|${live.startedAt}|${live.finishedAt}` : '';
  useEffect(() => {
    let cancelled = false;
    void getJson<ContainerDetail>(`/api/containers/${encodeURIComponent(id)}`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setDetail(result.value);
        setError(null);
      } else {
        setError(result.status === 404 ? 'This Container no longer exists.' : result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  const back = (
    <p className="back">
      <Link href={PATHS.containers} className="button button--quiet button--back">
        <span aria-hidden="true">←</span> All Containers
      </Link>
    </p>
  );
  if (snapshot && !snapshot.available) {
    return (
      <>
        {back}
        <DockerUnavailable />
      </>
    );
  }
  if (error && !detail) {
    return (
      <>
        {back}
        <p className="error" role="alert" data-testid="detail-error">
          {error}
        </p>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        {back}
        <p className="muted" role="status">
          Loading…
        </p>
      </>
    );
  }
  if (snapshot && !live) {
    return (
      <>
        {back}
        <p className="error" role="alert" data-testid="detail-error">
          This Container no longer exists.
        </p>
      </>
    );
  }
  return (
    <>
      {back}
      <ContainerDetailView detail={detail} live={live ?? detail} />
    </>
  );
}
