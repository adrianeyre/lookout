export type ContainerState = 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead';

export const CONTAINER_STATES: readonly ContainerState[] = [
  'running',
  'restarting',
  'paused',
  'created',
  'exited',
  'dead',
];

export type ContainerHealth = 'starting' | 'healthy' | 'unhealthy';

export interface PublishedPort {
  privatePort: number;
  publicPort: number | null;
  protocol: 'tcp' | 'udp' | 'sctp';
  ip: string | null;
}

export interface ContainerSummary {
  id: string;
  name: string;
  /** repository:tag */
  image: string;
  state: ContainerState;
  /** Null when the Container has no health check. */
  health: ContainerHealth | null;
  /** Compose Project name, or null for a standalone Container. */
  composeProject: string | null;
  createdAt: number;
  /** When the Container last started (ms since the epoch), or null if it never has. */
  startedAt: number | null;
  /** When the Container last stopped (ms since the epoch), or null if it never has. */
  finishedAt: number | null;
  /** The last exit code, or null if the Container has never exited. */
  exitCode: number | null;
  ports: PublishedPort[];
  /** Label values; a value that looks like a secret is SECRET_MASK until revealed (H8). */
  labels: Record<string, string>;
  /** The keys of labels whose values were masked, each revealable on its own. */
  maskedLabels: string[];
  /**
   * True when the Container's Image carries `lookout.self` itself (a `LABEL` in its
   * Dockerfile), so the label is the Image publisher's, not the operator's (#105).
   */
  selfClaimedByImage?: boolean;
}

/** What a masked value is shown as until it is revealed. */
export const SECRET_MASK = '••••••••';

/**
 * Where a masked value sits (H8): an argument of the command or entrypoint (by index), a
 * label (by key) or a mount's source (by index). The environment has its own reveal.
 */
export type SecretField = 'command' | 'entrypoint' | 'label' | 'mount';

export const SECRET_FIELDS: readonly SecretField[] = ['command', 'entrypoint', 'label', 'mount'];

export function isSecretField(value: string): value is SecretField {
  return (SECRET_FIELDS as readonly string[]).includes(value);
}

/** One revealed value, fetched only when asked for (like EnvValue). */
export interface SecretValue {
  field: SecretField;
  key: string;
  value: string;
}

/** The URL that reveals one masked value. */
export function secretPath(containerId: string, field: SecretField, key: string | number): string {
  return `/api/containers/${encodeURIComponent(containerId)}/secrets/${field}/${encodeURIComponent(String(key))}`;
}

export interface ContainerMount {
  type: string;
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface ContainerNetwork {
  name: string;
  ipAddress: string | null;
  ipv6Address: string | null;
  gateway: string | null;
}

/**
 * Everything the detail view shows (FR-20). Environment variable values are never part of
 * it: the server sends one value at a time, only when the user reveals it.
 */
export interface ContainerDetail extends ContainerSummary {
  /** The Image ID (sha256:…). */
  imageId: string;
  /** The Image's repository digest, or null for a local build. */
  imageDigest: string | null;
  /** Arguments; the indexes in `masked.command` are masked (H8). */
  command: string[];
  entrypoint: string[];
  /** Environment variable names, in the Container's order. */
  envNames: string[];
  /** Mounts; a source at an index in `masked.mounts` is SECRET_MASK until revealed. */
  mounts: ContainerMount[];
  /** Which command and entrypoint arguments, and which mount sources, are masked. */
  masked: { command: number[]; entrypoint: number[]; mounts: number[] };
  networks: ContainerNetwork[];
  restartPolicy: string;
  restartCount: number;
}

export interface EnvValue {
  name: string;
  value: string;
}

/** The Container list as the server last saw it. */
export interface ContainersSnapshot {
  /** False while the Docker daemon is unreachable (NFR-5). */
  available: boolean;
  containers: ContainerSummary[];
}

/** A Docker event about a Container, trimmed to what Lookout needs. */
export interface ContainerEvent {
  containerId: string;
  /** Docker's action, for example "start", "die", "health_status: unhealthy". */
  action: string;
  timestamp: number;
}

export interface ContainerStats {
  containerId: string;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
}

export interface LogLine {
  stream: 'stdout' | 'stderr';
  /** Docker's timestamp for the line, ms since the epoch. */
  timestamp: number;
  text: string;
}

/** The "last N lines" choices for a log tail (FR-21). */
export const LOG_TAIL_OPTIONS = [100, 500, 1000] as const;
export type LogTail = (typeof LOG_TAIL_OPTIONS)[number];
export const DEFAULT_LOG_TAIL: LogTail = 500;

/**
 * The single rule for a Flagged Container (FR-17): restarting, unhealthy, or exited with a
 * non-zero exit code. Used by the Container list and the header summary.
 */
export function isFlagged(container: Pick<ContainerSummary, 'state' | 'health' | 'exitCode'>) {
  if (container.state === 'restarting') return true;
  if (container.health === 'unhealthy') return true;
  return container.state === 'exited' && container.exitCode !== null && container.exitCode !== 0;
}

/** Why a Container is Flagged, for its label, or null if it is not. */
export function flagReason(
  container: Pick<ContainerSummary, 'state' | 'health' | 'exitCode'>,
): string | null {
  if (container.state === 'restarting') return 'Restarting';
  if (container.health === 'unhealthy') return 'Unhealthy';
  if (isFlagged(container)) return `Exited with code ${container.exitCode}`;
  return null;
}
