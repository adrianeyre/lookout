import { flagReason, type ContainerStats, type ContainerSummary } from '@lookout/shared';
import { formatBytes, formatPercent } from '../format.ts';

export function StateBadge({ container }: { container: ContainerSummary }) {
  return (
    <span className={`state state--${container.state}`} data-testid="container-state">
      {container.state}
    </span>
  );
}

export function HealthBadge({ container }: { container: ContainerSummary }) {
  if (container.health === null) return null;
  return (
    <span className={`health health--${container.health}`} data-testid="container-health">
      {container.health}
    </span>
  );
}

/** The Flagged marker: an icon and words, not colour alone (FR-17). */
export function FlagBadge({ container }: { container: ContainerSummary }) {
  const reason = flagReason(container);
  if (reason === null) return null;
  return (
    <span className="flag" data-testid="container-flag">
      <span className="flag__icon" aria-hidden="true">
        ⚑
      </span>
      Flagged: {reason}
    </span>
  );
}

export function StatsText({ stats }: { stats: ContainerStats | undefined }) {
  if (!stats) return <span className="muted">—</span>;
  return (
    <>
      <span data-testid="container-cpu">CPU {formatPercent(stats.cpuPercent)}</span>
      <span data-testid="container-memory">
        Mem {formatBytes(stats.memoryUsedBytes)}
        {stats.memoryLimitBytes > 0 ? ` / ${formatBytes(stats.memoryLimitBytes)}` : ''}
      </span>
    </>
  );
}
