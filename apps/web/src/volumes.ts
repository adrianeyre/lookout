import { VOLUMES_PATH, type DockerVolume, type VolumesSnapshot } from '@lookout/shared';
import { usePolledJson } from './stats.ts';

export type VolumesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; snapshot: VolumesSnapshot };

/**
 * Docker's volumes (ADR-0015), fetched now and every `intervalMs`, and every 5 s while their
 * sizes are still being measured. `refresh` fetches at once, as after a delete.
 */
export function useVolumes(intervalMs = 30_000): { state: VolumesState; refresh: () => void } {
  const loaded = usePolledJson<VolumesSnapshot>(VOLUMES_PATH, (value) =>
    value && value.sizesMeasuredAt !== null ? intervalMs : 5000,
  );
  const state: VolumesState = loaded.value
    ? { status: 'ok', snapshot: loaded.value }
    : loaded.error !== null
      ? { status: 'error', message: loaded.error }
      : { status: 'loading' };
  return { state, refresh: loaded.refresh };
}

/** The volumes one Container mounts, with where each is mounted. */
export function volumesOf(
  volumes: readonly DockerVolume[],
  containerId: string,
): { volume: DockerVolume; destination: string; readOnly: boolean }[] {
  return volumes.flatMap((volume) =>
    volume.usedBy
      .filter((use) => use.containerId === containerId)
      .map((use) => ({ volume, destination: use.destination, readOnly: use.readOnly })),
  );
}

/** Volumes no Container, running or stopped, mounts: the ones that can be deleted. */
export function unusedVolumes(volumes: readonly DockerVolume[]): DockerVolume[] {
  return volumes.filter((volume) => volume.usedBy.length === 0);
}
