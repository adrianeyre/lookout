import {
  thresholdLevel,
  type ContainersSnapshot,
  type HostSample,
  type SitesSnapshot,
  type ThresholdLevel,
  type Thresholds,
} from '@lookout/shared';
import { countContainers } from '../containers.ts';
import { formatPercent } from '../format.ts';
import { useLiveEvent, useThresholds } from '../live.ts';

const LEVEL_WORD: Record<ThresholdLevel, string> = {
  ok: '',
  warn: 'warning',
  critical: 'critical',
};

function Figure({
  label,
  percent,
  thresholds,
  testId,
}: {
  label: string;
  percent: number | null;
  thresholds: Thresholds;
  testId: string;
}) {
  const level = thresholdLevel(percent, thresholds);
  return (
    <span
      className={`summary__item summary__item--${level}`}
      data-testid={testId}
      data-level={level}
    >
      {label} {formatPercent(percent)}
      {level !== 'ok' && (
        <>
          <span className="summary__icon" aria-hidden="true">
            {level === 'critical' ? '■' : '▲'}
          </span>
          <span className="visually-hidden"> ({LEVEL_WORD[level]})</span>
        </>
      )}
    </span>
  );
}

/**
 * One line answering "is anything wrong?" on every page (FR-2), e.g.
 * "Containers: 4 running · 1 flagged | CPU 12% | Mem 61% | Disk 72%".
 */
export function HeaderSummaryView({
  containers,
  host,
  sites,
  thresholds,
}: {
  containers: ContainersSnapshot | undefined;
  host: HostSample | undefined;
  /** Hosted Sites; the figure is left out when there are none. */
  sites?: SitesSnapshot | undefined;
  thresholds: Thresholds;
}) {
  const checked = sites?.sites.filter((site) => site.status !== 'pending') ?? [];
  const sitesUp = checked.filter((site) => site.status !== 'down').length;
  const sitesDown = checked.length - sitesUp;
  const counts = containers?.available ? countContainers(containers.containers) : null;
  // Disk shows the fullest filesystem.
  const fullest = host?.disks.reduce<number | null>(
    (max, disk) => (max === null || disk.usagePercent > max ? disk.usagePercent : max),
    null,
  );
  return (
    <p className="summary" aria-label="Summary">
      <span className="summary__group" data-testid="summary-containers">
        {containers === undefined ? (
          'Containers: …'
        ) : counts === null ? (
          <span className="summary__item summary__item--warn">Containers: Docker unavailable</span>
        ) : (
          <>
            Containers: {counts.running} running ·{' '}
            <span
              className={`summary__item${counts.flagged > 0 ? ' summary__item--flagged' : ''}`}
              data-testid="summary-flagged"
            >
              {counts.flagged} flagged
            </span>
          </>
        )}
      </span>
      {sites && sites.sites.length > 0 && (
        <span className="summary__group" data-testid="summary-sites">
          <span>
            Sites: {sitesUp} up ·{' '}
            <span
              className={`summary__item${sitesDown > 0 ? ' summary__item--flagged' : ''}`}
              data-testid="summary-sites-down"
            >
              {sitesDown} down
            </span>
          </span>
        </span>
      )}
      {host && (
        <span className="summary__group">
          <Figure
            label="CPU"
            percent={host.cpu.usagePercent}
            thresholds={thresholds}
            testId="summary-cpu"
          />
          <Figure
            label="Mem"
            percent={host.memory.usagePercent}
            thresholds={thresholds}
            testId="summary-mem"
          />
          {fullest !== undefined && fullest !== null && (
            <Figure label="Disk" percent={fullest} thresholds={thresholds} testId="summary-disk" />
          )}
        </span>
      )}
    </p>
  );
}

export function HeaderSummary() {
  const containers = useLiveEvent('containers');
  const host = useLiveEvent('host');
  const sites = useLiveEvent('sites');
  const thresholds = useThresholds();
  return (
    <HeaderSummaryView containers={containers} host={host} sites={sites} thresholds={thresholds} />
  );
}
