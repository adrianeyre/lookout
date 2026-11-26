import type { ContainerEvent, ContainerStats, LogLine } from '@lookout/shared';
import type { DiskUsageReport } from './disk-usage.ts';
import type { InspectedContainer } from './parse.ts';

export interface LogOptions {
  /** How many existing lines to send first. */
  tail: number;
  follow: boolean;
}

/**
 * Everything Lookout needs from Docker. The real implementation talks to the Engine API
 * over the socket; tests and Playwright use a fake (apps/server/test-support), which the
 * production entry point never imports.
 */
export interface DockerClient {
  ping(): Promise<boolean>;
  /** Every Container, running and stopped (FR-14). */
  listContainers(): Promise<InspectedContainer[]>;
  /** One Container, or null if it does not exist. */
  inspectContainer(id: string): Promise<InspectedContainer | null>;
  events(signal: AbortSignal): AsyncIterable<ContainerEvent>;
  logs(containerId: string, options: LogOptions, signal: AbortSignal): AsyncIterable<LogLine>;
  stats(containerId: string, signal: AbortSignal): AsyncIterable<ContainerStats>;
  /**
   * The Container Actions (ADR-0005). Each resolves once Docker has done it and rejects
   * with Docker's error otherwise. There is no exec, pull, kill or pause.
   */
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  restartContainer(id: string): Promise<void>;
  /** Never forced and never removes volumes (FR-25). */
  removeContainer(id: string): Promise<void>;
  /**
   * Docker's disk usage (GET /system/df) for Site Stats. Slow on a busy Host, so it is asked
   * for once a day and on "Measure now", never per page view. Read-only (ADR-0013).
   */
  diskUsage(): Promise<DiskUsageReport>;
}
