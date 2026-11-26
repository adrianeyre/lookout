/**
 * Docker's disk usage (GET /system/df), reduced to what Site Stats needs: each Image's,
 * Container's and volume's size and its Compose Project, and the build cache. Read-only:
 * Lookout measures, never prunes (ADR-0013).
 */

export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface DiskUsageReport {
  images: { id: string; bytes: number; containers: number }[];
  containers: {
    id: string;
    name: string;
    imageId: string;
    writableBytes: number;
    running: boolean;
    project: string | null;
    /** Named volumes it mounts. */
    volumes: string[];
  }[];
  volumes: { name: string; bytes: number; refCount: number; project: string | null }[];
  buildCache: { bytes: number; inUse: boolean; shared: boolean }[];
}

/** The parts of the Engine's /system/df answer Lookout reads. */
export interface EngineDiskUsage {
  Images?: { Id?: string; Size?: number; Containers?: number }[] | null;
  Containers?:
    | {
        Id?: string;
        Names?: string[] | null;
        ImageID?: string;
        SizeRw?: number;
        State?: string;
        Labels?: Record<string, string> | null;
        Mounts?: { Type?: string; Name?: string }[] | null;
      }[]
    | null;
  Volumes?:
    | {
        Name?: string;
        Labels?: Record<string, string> | null;
        UsageData?: { Size?: number; RefCount?: number } | null;
      }[]
    | null;
  BuildCache?: { Size?: number; InUse?: boolean; Shared?: boolean }[] | null;
}

/** A size Docker reports, or 0: it answers -1 for a size it has not worked out. */
const size = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function diskUsageFromEngine(raw: EngineDiskUsage | null): DiskUsageReport {
  return {
    images: (raw?.Images ?? []).map((image) => ({
      id: text(image.Id),
      bytes: size(image.Size),
      containers: count(image.Containers),
    })),
    containers: (raw?.Containers ?? []).map((container) => ({
      id: text(container.Id),
      name: text(container.Names?.[0]).replace(/^\//, ''),
      imageId: text(container.ImageID),
      writableBytes: size(container.SizeRw),
      running: container.State === 'running',
      project: container.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
      volumes: (container.Mounts ?? [])
        .filter((mount) => mount.Type === 'volume' && typeof mount.Name === 'string')
        .map((mount) => mount.Name!),
    })),
    volumes: (raw?.Volumes ?? []).map((volume) => ({
      name: text(volume.Name),
      bytes: size(volume.UsageData?.Size),
      refCount: count(volume.UsageData?.RefCount),
      project: volume.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
    })),
    buildCache: (raw?.BuildCache ?? []).map((record) => ({
      bytes: size(record.Size),
      inUse: record.InUse === true,
      shared: record.Shared === true,
    })),
  };
}

export interface DiskTotals {
  images: { count: number; bytes: number; reclaimableBytes: number };
  containers: { count: number; bytes: number; reclaimableBytes: number };
  volumes: { count: number; bytes: number; reclaimableBytes: number };
  buildCache: { count: number; bytes: number; reclaimableBytes: number };
}

/**
 * Server-wide totals, reclaimable as `docker system df` counts it: Images no Container uses,
 * stopped Containers' writable layers, volumes no Container mounts, and build cache that is
 * neither in use nor shared.
 */
export function diskTotals(report: DiskUsageReport): DiskTotals {
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    images: {
      count: report.images.length,
      bytes: sum(report.images.map((i) => i.bytes)),
      reclaimableBytes: sum(report.images.filter((i) => i.containers === 0).map((i) => i.bytes)),
    },
    containers: {
      count: report.containers.length,
      bytes: sum(report.containers.map((c) => c.writableBytes)),
      reclaimableBytes: sum(
        report.containers.filter((c) => !c.running).map((c) => c.writableBytes),
      ),
    },
    volumes: {
      count: report.volumes.length,
      bytes: sum(report.volumes.map((v) => v.bytes)),
      reclaimableBytes: sum(report.volumes.filter((v) => v.refCount === 0).map((v) => v.bytes)),
    },
    buildCache: {
      count: report.buildCache.length,
      bytes: sum(report.buildCache.map((b) => b.bytes)),
      reclaimableBytes: sum(
        report.buildCache.filter((b) => !b.inUse && !b.shared).map((b) => b.bytes),
      ),
    },
  };
}

export interface GroupSize {
  volumesBytes: number;
  imagesBytes: number;
  writableBytes: number;
}

/**
 * What a group of Containers uses: their writable layers, the Images they run (each once),
 * and their named volumes: those they mount, and, for a Compose Project, those labelled with
 * it (a volume no Container mounts right now is still the project's).
 */
export function groupSize(
  report: DiskUsageReport,
  containerIds: ReadonlySet<string>,
  project: string | null,
): GroupSize {
  const containers = report.containers.filter(
    (c) => containerIds.has(c.id) || (project !== null && c.project === project),
  );
  const imageIds = new Set(containers.map((c) => c.imageId));
  const volumeNames = new Set(containers.flatMap((c) => c.volumes));
  if (project !== null) {
    for (const volume of report.volumes)
      if (volume.project === project) volumeNames.add(volume.name);
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    writableBytes: sum(containers.map((c) => c.writableBytes)),
    imagesBytes: sum(report.images.filter((i) => imageIds.has(i.id)).map((i) => i.bytes)),
    volumesBytes: sum(report.volumes.filter((v) => volumeNames.has(v.name)).map((v) => v.bytes)),
  };
}
