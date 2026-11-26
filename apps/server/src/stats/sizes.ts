import type { ContainerSummary, DockerDiskUsage, MeasureState, SizeSource } from '@lookout/shared';
import type { DockerClient } from '../docker/client.ts';
import { diskTotals, groupSize, type DiskUsageReport } from '../docker/disk-usage.ts';
import { ScanBudget, walkFilesystem } from '../folders/scan.ts';
import type { HostRoot } from '../host-root.ts';
import type { SiteSizeRow, StatsStore } from './store.ts';
import { dayStart, nextAt } from './time.ts';

/** The hour of the day (server time) sizes are measured. */
export const MEASURE_HOUR = 3;

/** A Hosted Site as the measurer sees it. */
export interface SizeSite {
  id: string;
  url: string;
  containerId: string | null;
}

export interface SizeSubject {
  source: SizeSource;
  subject: string | null;
  containerIds: Set<string>;
  project: string | null;
  folder: string | null;
}

/**
 * What a site's size is measured from: its Container's Compose Project (or the Container alone
 * when it has none), and the folder LOOKOUT_SITES names for it, if any.
 */
export function sizeSubject(
  site: SizeSite,
  containers: readonly ContainerSummary[],
  folders: Readonly<Record<string, string>>,
): SizeSubject {
  const folder = folders[site.url] ?? null;
  const container =
    site.containerId === null ? undefined : containers.find((c) => c.id === site.containerId);
  if (container) {
    const project = container.composeProject;
    return {
      source: project ? 'project' : 'container',
      subject: project ?? container.name,
      containerIds: new Set([container.id]),
      project,
      folder,
    };
  }
  if (folder !== null) {
    return { source: 'folder', subject: folder, containerIds: new Set(), project: null, folder };
  }
  return { source: 'none', subject: null, containerIds: new Set(), project: null, folder: null };
}

export interface SizeMeasurerLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export interface SizeMeasurerOptions {
  docker: DockerClient;
  hostRoot: HostRoot;
  store: StatsStore;
  sites: () => readonly SizeSite[];
  containers: () => readonly ContainerSummary[];
  folders: Readonly<Record<string, string>>;
  log: SizeMeasurerLogger;
  now?: () => number;
  /** How long after start the first measurement runs, when today has none yet. */
  firstDelayMs?: number;
}

/**
 * Measures each Hosted Site's disk and Docker space, and Docker's own disk usage, once a day at
 * 03:00 and on "Measure now" (ADR-0013). Asking Docker for sizes is slow on a busy Host, so it
 * is never done per page view. Only ever reads: nothing is pruned or deleted.
 */
export class SizeMeasurer {
  readonly #options: SizeMeasurerOptions & { now: () => number; firstDelayMs: number };
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | null = null;
  #started = false;
  state: MeasureState = 'idle';
  lastMeasuredAt: number | null = null;
  error: string | null = null;

  constructor(options: SizeMeasurerOptions) {
    this.#options = { now: Date.now, firstDelayMs: 60_000, ...options };
    this.lastMeasuredAt = options.store.latestDockerDf()?.measuredAt ?? null;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#options.now();
    const measuredToday = this.lastMeasuredAt !== null && this.lastMeasuredAt >= dayStart(now);
    this.#schedule(measuredToday ? nextAt(MEASURE_HOUR, now) - now : this.#options.firstDelayMs);
  }

  async stop(): Promise<void> {
    this.#started = false;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /** "Measure now": one measurement at a time. */
  measureNow(): { result: 'started' } | { result: 'busy' } {
    if (this.#running) return { result: 'busy' };
    void this.#run();
    return { result: 'started' };
  }

  /** Waits for a measurement running now; for tests. */
  async settled(): Promise<void> {
    await this.#running;
  }

  #schedule(delayMs: number) {
    clearTimeout(this.#timer);
    if (!this.#started) return;
    this.#timer = setTimeout(() => {
      void this.#run().finally(() => {
        const now = this.#options.now();
        this.#schedule(nextAt(MEASURE_HOUR, now) - now);
      });
    }, delayMs);
    this.#timer.unref();
  }

  #run(): Promise<void> {
    if (this.#running) return this.#running;
    this.state = 'measuring';
    this.#running = this.#measure()
      .then(() => {
        this.error = null;
      })
      .catch((error: unknown) => {
        this.error = 'Docker could not be asked for its disk usage; see the server log';
        this.#options.log.warn({ err: error }, 'Measuring sizes failed');
      })
      .finally(() => {
        this.state = 'idle';
        this.#running = null;
      });
    return this.#running;
  }

  async #measure(): Promise<void> {
    const { docker, store, log } = this.#options;
    const started = this.#options.now();
    const report = await docker.diskUsage();
    const measuredAt = this.#options.now();
    const day = dayStart(measuredAt);
    const totals = diskTotals(report);
    const usage: DockerDiskUsage = { measuredAt, ...totals };
    const containers = this.#options.containers();
    const rows: SiteSizeRow[] = [];
    for (const site of this.#options.sites()) {
      const subject = sizeSubject(site, containers, this.#options.folders);
      if (subject.source === 'none') continue;
      const group =
        subject.source === 'folder'
          ? null
          : groupSize(report, subject.containerIds, subject.project);
      const folderBytes = subject.folder === null ? null : await this.#folderBytes(subject.folder);
      rows.push({
        siteId: site.id,
        start: day,
        measuredAt,
        source: subject.source,
        subject: subject.subject,
        volumes: group?.volumesBytes ?? null,
        images: group?.imagesBytes ?? null,
        writable: group?.writableBytes ?? null,
        folder: folderBytes,
      });
    }
    store.transaction(() => {
      store.putDockerDf(day, usage);
      for (const row of rows) store.putSiteSize(row);
    });
    this.lastMeasuredAt = measuredAt;
    log.info({ sites: rows.length, ms: this.#options.now() - started }, 'Measured site sizes');
  }

  /**
   * A site folder's size, walked through the Host root like Largest folders: lstat only, never
   * a file's contents, never a link, never a home folder, within the same limits. Null when it
   * cannot be read.
   */
  async #folderBytes(folder: string): Promise<number | null> {
    try {
      const real = await this.#options.hostRoot.resolve(folder);
      const result = await walkFilesystem(real, folder, {
        budget: new ScanBudget(),
        skipKernelFolders: false,
      });
      return result.bytes;
    } catch (error) {
      this.#options.log.warn({ folder, err: error }, 'A site folder could not be measured');
      return null;
    }
  }
}

export type { DiskUsageReport };
