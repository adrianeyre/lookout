import { useId, useState } from 'react';
import {
  CONTAINER_STATES,
  isFlagged,
  type ContainersSnapshot,
  type ContainerState,
  type ContainerSummary,
} from '@lookout/shared';
import { FlagBadge, HealthBadge, StateBadge, StatsText } from '../components/ContainerBits.tsx';
import { Link } from '../components/Link.tsx';
import {
  NO_FILTERS,
  filterContainers,
  groupByProject,
  publishedPorts,
  statusText,
  type ContainerFilters,
  type StatsById,
} from '../containers.ts';
import { useContainerStats, useNow } from '../hooks.ts';
import { useLiveEvent } from '../live.ts';
import { containerPath } from '../router.ts';
import { PageGrid } from '../grid/PageGrid.tsx';
import { ContainerVolumes, UnusedVolumesCard } from '../components/Volumes.tsx';
import { useVolumes, type VolumesState } from '../volumes.ts';

export function DockerUnavailable() {
  return (
    <div className="notice notice--warn" role="status" data-testid="docker-unavailable">
      <p className="notice__title">Docker unavailable</p>
      <p>
        Lookout cannot reach the Docker daemon. It keeps retrying in the background, and the Host
        page still works.
      </p>
    </div>
  );
}

function ContainerRow({
  container,
  stats,
  now,
  volumes,
}: {
  container: ContainerSummary;
  stats: StatsById;
  now: number;
  volumes: VolumesState;
}) {
  const flagged = isFlagged(container);
  const ports = publishedPorts(container.ports);
  return (
    <li
      className={`row${flagged ? ' row--flagged' : ''}`}
      data-testid="container-row"
      data-name={container.name}
      data-flagged={flagged}
    >
      <div className="row__main">
        <Link className="row__name" href={containerPath(container.id)}>
          <bdi data-testid="container-name">{container.name}</bdi>
        </Link>
        <bdi className="row__image muted" data-testid="container-image">
          {container.image}
        </bdi>
      </div>
      <div className="row__status">
        <StateBadge container={container} />
        <HealthBadge container={container} />
        <span className="muted" data-testid="container-status">
          {statusText(container, now)}
        </span>
        <FlagBadge container={container} />
      </div>
      <div className="row__stats muted">
        {container.state === 'running' ? <StatsText stats={stats.get(container.id)} /> : null}
      </div>
      <div className="row__ports" data-testid="container-ports">
        {ports.map((port) => (
          <span key={port} className="port">
            {port}
          </span>
        ))}
      </div>
      <ContainerVolumes state={volumes} containerId={container.id} />
    </li>
  );
}

function Filters({
  filters,
  onChange,
}: {
  filters: ContainerFilters;
  onChange: (filters: ContainerFilters) => void;
}) {
  return (
    <form className="filters" role="search" onSubmit={(event) => event.preventDefault()}>
      <label className="field filters__text">
        <span className="field__label">Filter</span>
        <input
          className="field__input"
          type="search"
          placeholder="Name or Image"
          value={filters.text}
          onChange={(event) => onChange({ ...filters, text: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">State</span>
        <select
          className="field__input"
          value={filters.state}
          onChange={(event) =>
            onChange({ ...filters, state: event.target.value as ContainerState | 'all' })
          }
        >
          <option value="all">All states</option>
          {CONTAINER_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
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

/** Where this browser remembers which Compose Projects are closed. Every one starts open. */
const COLLAPSED_KEY = 'lookout.containers.collapsed';

function readCollapsed(): ReadonlySet<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(
      Array.isArray(saved) ? saved.filter((name): name is string => typeof name === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function saveCollapsed(names: ReadonlySet<string>) {
  try {
    if (names.size === 0) localStorage.removeItem(COLLAPSED_KEY);
    else localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...names]));
  } catch {
    // Not remembered, but still closed for now.
  }
}

/**
 * The Container list, grouped by Compose Project and filterable (FR-14 to FR-18). Each
 * Project opens and closes from its heading, and starts open.
 */
export function ContainerList({
  snapshot,
  stats,
  now,
  volumes = { status: 'loading' },
}: {
  snapshot: ContainersSnapshot;
  stats: StatsById;
  now: number;
  /** Docker's volumes, shown under the Containers that mount them (ADR-0015). */
  volumes?: VolumesState;
}) {
  const [filters, setFilters] = useState<ContainerFilters>(NO_FILTERS);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(readCollapsed);
  const baseId = useId();
  const toggle = (name: string) =>
    setCollapsed((before) => {
      const next = new Set(before);
      if (!next.delete(name)) next.add(name);
      saveCollapsed(next);
      return next;
    });
  if (!snapshot.available) return <DockerUnavailable />;
  const shown = filterContainers(snapshot.containers, filters);
  const groups = groupByProject(shown);
  return (
    <>
      <Filters filters={filters} onChange={setFilters} />
      <p className="muted" role="status" data-testid="container-count">
        Showing {shown.length} of {snapshot.containers.length} Containers
      </p>
      {groups.length === 0 ? (
        <p className="muted">No Containers match.</p>
      ) : (
        groups.map((group) => {
          const open = !collapsed.has(group.name);
          const listId = `${baseId}-${groups.indexOf(group)}`;
          return (
            <section
              key={group.name}
              className="group"
              aria-label={group.name}
              data-testid="container-group"
            >
              <h2 className="group__title">
                <button
                  type="button"
                  className="group__toggle"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => toggle(group.name)}
                >
                  <span className="group__chevron" aria-hidden="true" />
                  <bdi data-testid="group-name">{group.name}</bdi>
                  <span className="group__count">{group.containers.length}</span>
                </button>
              </h2>
              <ul className="rows" id={listId} hidden={!open}>
                {group.containers.map((container) => (
                  <ContainerRow
                    key={container.id}
                    container={container}
                    stats={stats}
                    now={now}
                    volumes={volumes}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}

export function ContainersPage() {
  const snapshot = useLiveEvent('containers');
  const stats = useContainerStats();
  const now = useNow();
  const volumes = useVolumes();
  return (
    <PageGrid
      page="containers"
      title="Containers"
      widgets={{
        'containers.list': snapshot ? (
          <ContainerList snapshot={snapshot} stats={stats} now={now} volumes={volumes.state} />
        ) : (
          <p className="muted" role="status">
            Loading Containers…
          </p>
        ),
        // Volumes need Docker; while it is unavailable the list above says so.
        ...(snapshot?.available === false
          ? {}
          : {
              'containers.volumes': (
                <UnusedVolumesCard state={volumes.state} refresh={volumes.refresh} />
              ),
            }),
      }}
    />
  );
}
