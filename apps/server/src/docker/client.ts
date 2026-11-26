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
  diskUsage(types?: readonly 'volume'[]): Promise<DiskUsageReport>;
  /** Every volume (GET /volumes), for the Containers page's volumes (ADR-0015). */
  listVolumes(): Promise<EngineVolume[]>;
  /**
   * Deletes a volume no Container uses (ADR-0015). Never forced: Docker itself refuses one in
   * use. Rejects with Docker's error otherwise.
   */
  removeVolume(name: string): Promise<void>;
}

export interface EngineVolume {
  name: string;
  driver: string;
  createdAt: number | null;
  project: string | null;
}
