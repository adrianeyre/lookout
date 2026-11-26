import {
  isFlagged,
  type ContainerState,
  type ContainerStats,
  type ContainerSummary,
  type PublishedPort,
} from '@lookout/shared';
import { formatAgo } from './format.ts';

export const STANDALONE = 'Standalone';

export interface ContainerFilters {
  /** Matches the name or Image, case-insensitively. */
  text: string;
  state: ContainerState | 'all';
  flaggedOnly: boolean;
}

export const NO_FILTERS: ContainerFilters = { text: '', state: 'all', flaggedOnly: false };

export function filterContainers(
  containers: ContainerSummary[],
  filters: ContainerFilters,
): ContainerSummary[] {
  const text = filters.text.trim().toLowerCase();
  return containers.filter(
    (c) =>
      (text === '' ||
        c.name.toLowerCase().includes(text) ||
        c.image.toLowerCase().includes(text)) &&
      (filters.state === 'all' || c.state === filters.state) &&
      (!filters.flaggedOnly || isFlagged(c)),
  );
}

export interface ContainerGroup {
  name: string;
  containers: ContainerSummary[];
}

/** Groups by Compose Project (FR-15), alphabetically, with "Standalone" last. */
export function groupByProject(containers: ContainerSummary[]): ContainerGroup[] {
  const groups = new Map<string | null, ContainerSummary[]>();
  for (const container of containers) {
    const list = groups.get(container.composeProject) ?? [];
    list.push(container);
    groups.set(container.composeProject, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([name, list]) => ({
      name: name ?? STANDALONE,
      containers: list.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** "Up 3h 5m", "Exited (1) 12m ago", "Restarting", "Created", per FR-16. */
export function statusText(container: ContainerSummary, now: number): string {
  switch (container.state) {
    case 'running':
      return container.startedAt ? `Up ${formatAgo(container.startedAt, now)}` : 'Up';
    case 'paused':
      return 'Paused';
    case 'restarting':
      return 'Restarting';
    case 'created':
      return 'Created';
    case 'exited':
    case 'dead': {
      const label = container.state === 'dead' ? 'Dead' : 'Exited';
      const code = container.exitCode === null ? '' : ` (${container.exitCode})`;
      const ago = container.finishedAt ? ` ${formatAgo(container.finishedAt, now)} ago` : '';
      return `${label}${code}${ago}`;
    }
  }
}

/** Published ports as "8080→80/tcp", once each even when bound on IPv4 and IPv6. */
export function publishedPorts(ports: PublishedPort[]): string[] {
  const out = new Set<string>();
  for (const port of ports) {
    if (port.publicPort !== null)
      out.add(`${port.publicPort}→${port.privatePort}/${port.protocol}`);
  }
  return [...out];
}

export interface ContainerCounts {
  total: number;
  running: number;
  flagged: number;
}

export function countContainers(containers: ContainerSummary[]): ContainerCounts {
  return {
    total: containers.length,
    running: containers.filter((c) => c.state === 'running').length,
    flagged: containers.filter(isFlagged).length,
  };
}

export type StatsById = ReadonlyMap<string, ContainerStats>;
