/**
 * Docker volumes (ADR-0015): which Containers use each one, and the unused ones, which can be
 * deleted. Shared by the server and the Containers page.
 */

/** A Container that mounts a volume. */
export interface VolumeUse {
  containerId: string;
  containerName: string;
  destination: string;
  readOnly: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  /** When Docker created it, ms since the epoch, or null if Docker didn't say. */
  createdAt: number | null;
  /** Its Compose Project label, if any. */
  project: string | null;
  /** Disk space it uses, or null when Docker hasn't been asked yet (or can't tell). */
  sizeBytes: number | null;
  /** Every Container, running or stopped, that mounts it. Empty means unused. */
  usedBy: VolumeUse[];
}

export interface VolumesSnapshot {
  volumes: DockerVolume[];
  /** When the sizes were measured, or null if they haven't been yet. */
  sizesMeasuredAt: number | null;
}

export const VOLUMES_PATH = '/api/volumes';

/** Docker's volume names: [a-zA-Z0-9][a-zA-Z0-9_.-]+. Anything else is unknown. */
export const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

/** "Delete": takes the volume's name, and the same name typed again to confirm. */
export function volumeDeletePath(name: string): string {
  return `/api/volumes/${encodeURIComponent(name)}/delete`;
}

export interface VolumeDeleteRequest {
  confirmName: string;
}
