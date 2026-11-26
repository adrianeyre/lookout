import type { ContainersSnapshot, ContainerStats, LogLine } from './containers.ts';
import type { FolderScan } from './folders.ts';
import type { HostSample } from './host.ts';
import type { LiveWindowSnapshot } from './live-window.ts';
import type { SitesSnapshot } from './sites.ts';
import type { Thresholds } from './thresholds.ts';

/** The single live stream the SPA opens on every page. */
export const LIVE_STREAM_PATH = '/api/stream';

/** Server settings the browser needs, sent first on every live stream. */
export interface LiveSettings {
  thresholds: Thresholds;
  sampleIntervalMs: number;
  liveWindowMinutes: number;
}

/** Named Server-Sent Events on the live stream, and their JSON payloads. */
export interface LiveEvents {
  settings: LiveSettings;
  /** The whole Live Window, sent once when the stream opens, before any `host` event. */
  window: LiveWindowSnapshot;
  host: HostSample;
  containers: ContainersSnapshot;
  /** Hosted Sites and their last checks (PRD §14), sent when the stream opens and on change. */
  sites: SitesSnapshot;
  /** The Host's largest folders, sent when the stream opens and as a scan runs and ends. */
  folders: FolderScan;
}

export type LiveEventName = keyof LiveEvents;

/** Stats for running Containers, streamed only while a Containers view is open (FR-19). */
export const CONTAINER_STATS_STREAM_PATH = '/api/containers/stats';

export interface ContainerStatsEvents {
  stats: ContainerStats[];
}

/** Named events on a Container's log stream (FR-21). */
export interface LogStreamEvents {
  /** Sent first: the browser drops any lines it has, as a reconnect replays the tail. */
  reset: { tail: number };
  lines: LogLine[];
  /** The log ended, for example because the Container stopped. */
  end: Record<string, never>;
}
