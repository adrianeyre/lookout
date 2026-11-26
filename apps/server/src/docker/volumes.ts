import type { DockerVolume, VolumesSnapshot } from '@lookout/shared';
import type { DockerClient } from './client.ts';
import type { InspectedContainer } from './parse.ts';

/** How long volume sizes are reused before Docker is asked again (it walks every volume). */
export const VOLUME_SIZES_TTL_MS = 10 * 60_000;

export interface VolumeLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export type DeleteOutcome =
  | { result: 'deleted' }
  | { result: 'unknown' }
  | { result: 'mismatch' }
  | { result: 'busy' }
  | { result: 'in-use'; containers: string[] }
  | { result: 'failed'; error: unknown };

/** Which Containers mount each volume, from every Container, running or stopped. */
export function volumeUsers(containers: readonly InspectedContainer[]) {
  const users = new Map<string, DockerVolume['usedBy']>();
  for (const container of [...containers].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const mount of container.mounts) {
      if (mount.type !== 'volume' || mount.source === '') continue;
      const list = users.get(mount.source) ?? [];
      list.push({
        containerId: container.id,
        containerName: container.name,
        destination: mount.destination,
        readOnly: mount.readOnly,
      });
      users.set(mount.source, list);
    }
  }
  return users;
}

/**
 * Docker's volumes for the Containers page (ADR-0015): each one, the Containers that mount it,
 * and its size. Sizes come from /system/df, which walks every volume, so they are reused for
 * VOLUME_SIZES_TTL_MS and refreshed in the background, never awaited by a page.
 *
 * Deleting is for unused volumes only. The server checks that no Container, running or
 * stopped, mounts it, that the typed name matches, and never forces: Docker refuses one in use.
 */
export class VolumeService {
  readonly #docker: DockerClient;
  readonly #log: VolumeLogger;
  readonly #now: () => number;
  #sizes = new Map<string, number>();
  #sizesAt: number | null = null;
  #refreshing: Promise<void> | null = null;
  #deleting = false;

  constructor(docker: DockerClient, log: VolumeLogger, now: () => number = Date.now) {
    this.#docker = docker;
    this.#log = log;
    this.#now = now;
  }

  async snapshot(): Promise<VolumesSnapshot> {
    const [volumes, containers] = await Promise.all([
      this.#docker.listVolumes(),
      this.#docker.listContainers(),
    ]);
    if (this.#sizesAt === null || this.#now() - this.#sizesAt > VOLUME_SIZES_TTL_MS) {
      void this.refreshSizes();
    }
    const users = volumeUsers(containers);
    return {
      volumes: volumes
        .map((volume) => ({
          ...volume,
          sizeBytes: this.#sizes.get(volume.name) ?? null,
          usedBy: users.get(volume.name) ?? [],
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sizesMeasuredAt: this.#sizesAt,
    };
  }

  /** Asks Docker for every volume's size; one at a time. */
  refreshSizes(): Promise<void> {
    this.#refreshing ??= this.#docker
      .diskUsage(['volume'])
      .then((report) => {
        this.#sizes = new Map(report.volumes.map((v) => [v.name, v.bytes]));
        this.#sizesAt = this.#now();
      })
      .catch((error: unknown) => {
        this.#log.warn({ err: error }, 'Volume sizes could not be read');
      })
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  async delete(name: string, confirmName: unknown): Promise<DeleteOutcome> {
    if (this.#deleting) return { result: 'busy' };
    this.#deleting = true;
    try {
      const [volumes, containers] = await Promise.all([
        this.#docker.listVolumes(),
        this.#docker.listContainers(),
      ]);
      if (!volumes.some((v) => v.name === name)) return { result: 'unknown' };
      if (confirmName !== name) return { result: 'mismatch' };
      const users = volumeUsers(containers).get(name) ?? [];
      if (users.length > 0) {
        return { result: 'in-use', containers: users.map((u) => u.containerName) };
      }
      try {
        await this.#docker.removeVolume(name);
      } catch (error) {
        return { result: 'failed', error };
      }
      this.#sizes.delete(name);
      this.#log.info({ volume: name }, 'Volume deleted');
      return { result: 'deleted' };
    } finally {
      this.#deleting = false;
    }
  }
}
