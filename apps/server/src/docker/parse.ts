import { StringDecoder } from 'node:string_decoder';
import { publicDetail } from './secrets.ts';
import type {
  ContainerDetail,
  ContainerEvent,
  ContainerHealth,
  ContainerState,
  ContainerStats,
  ContainerSummary,
  EnvValue,
  LogLine,
  PublishedPort,
} from '@lookout/shared';

/** The fields Lookout reads from Docker's GET /containers/{id}/json. */
export interface EngineInspect {
  Id: string;
  Name?: string;
  Created?: string;
  /** The Image ID. */
  Image?: string;
  RestartCount?: number;
  Config?: {
    /** The Image as the Container was created from it, usually repository:tag. */
    Image?: string;
    /** A TTY Container's logs are one raw stream, without stdout/stderr frames. */
    Tty?: boolean;
    Env?: string[] | null;
    Cmd?: string[] | string | null;
    Entrypoint?: string[] | string | null;
    Labels?: Record<string, string> | null;
  };
  State?: {
    Status?: string;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Health?: { Status?: string } | null;
  };
  HostConfig?: { RestartPolicy?: { Name?: string; MaximumRetryCount?: number } | null };
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string; RW?: boolean }[];
  NetworkSettings?: {
    Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
    Networks?: Record<
      string,
      { IPAddress?: string; GlobalIPv6Address?: string; Gateway?: string } | null
    > | null;
  };
}

/**
 * A Container as the server sees it: the detail view's fields plus environment values.
 * Values stay on the server; API responses carry only the names (FR-20).
 */
/** Everything Lookout reads about a Container, unmasked: never sent to the browser as is. */
export type InspectedContainer = Omit<ContainerDetail, 'envNames' | 'maskedLabels' | 'masked'> & {
  env: EnvValue[];
};

const STATES: ReadonlySet<string> = new Set<ContainerState>([
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
]);

const HEALTHS: ReadonlySet<string> = new Set<ContainerHealth>(['starting', 'healthy', 'unhealthy']);

/** Docker's timestamps, with its zero time ("0001-01-01T00:00:00Z") meaning "never". */
function timestampOrNull(value: string | undefined): number | null {
  if (!value || value.startsWith('0001-01-01')) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function stringList(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function portsFrom(ports: NonNullable<EngineInspect['NetworkSettings']>['Ports']): PublishedPort[] {
  const out: PublishedPort[] = [];
  for (const [key, bindings] of Object.entries(ports ?? {})) {
    const [port, proto] = key.split('/');
    const privatePort = Number(port);
    if (!Number.isInteger(privatePort)) continue;
    const protocol = proto === 'udp' || proto === 'sctp' ? proto : 'tcp';
    if (!bindings || bindings.length === 0) {
      out.push({ privatePort, publicPort: null, protocol, ip: null });
      continue;
    }
    for (const binding of bindings) {
      const publicPort = Number(binding.HostPort);
      out.push({
        privatePort,
        publicPort: Number.isInteger(publicPort) && publicPort > 0 ? publicPort : null,
        protocol,
        ip: binding.HostIp || null,
      });
    }
  }
  return out.sort((a, b) => a.privatePort - b.privatePort);
}

/** Splits "NAME=value" (a variable without "=" has an empty value, as Docker treats it). */
export function envFrom(entries: string[] | null | undefined): EnvValue[] {
  return (entries ?? []).map((entry) => {
    const equals = entry.indexOf('=');
    return equals < 0
      ? { name: entry, value: '' }
      : { name: entry.slice(0, equals), value: entry.slice(equals + 1) };
  });
}

export function inspectedFromEngine(
  container: EngineInspect,
  imageDigest: string | null = null,
  imageClaimsSelf = false,
): InspectedContainer {
  const labels = container.Config?.Labels ?? {};
  const rawState = container.State?.Status ?? '';
  const state = STATES.has(rawState) ? (rawState as ContainerState) : 'dead';
  const rawHealth = container.State?.Health?.Status ?? '';
  const startedAt = timestampOrNull(container.State?.StartedAt);
  const finishedAt = timestampOrNull(container.State?.FinishedAt);
  const policy = container.HostConfig?.RestartPolicy;
  const policyName = policy?.Name || 'no';
  return {
    id: container.Id,
    name: (container.Name ?? container.Id.slice(0, 12)).replace(/^\//, ''),
    image: container.Config?.Image ?? container.Image ?? '',
    state,
    health: HEALTHS.has(rawHealth) ? (rawHealth as ContainerHealth) : null,
    composeProject: labels['com.docker.compose.project'] ?? null,
    createdAt: timestampOrNull(container.Created) ?? 0,
    startedAt,
    finishedAt,
    // A Container that has never run has no exit code, whatever Docker's default says.
    exitCode: startedAt === null ? null : (container.State?.ExitCode ?? null),
    ports: portsFrom(container.NetworkSettings?.Ports),
    labels,
    ...(imageClaimsSelf ? { selfClaimedByImage: true } : {}),
    imageId: container.Image ?? '',
    imageDigest,
    command: stringList(container.Config?.Cmd),
    entrypoint: stringList(container.Config?.Entrypoint),
    env: envFrom(container.Config?.Env),
    mounts: (container.Mounts ?? []).map((mount) => ({
      type: mount.Type ?? 'bind',
      source: mount.Type === 'volume' && mount.Name ? mount.Name : (mount.Source ?? ''),
      destination: mount.Destination ?? '',
      readOnly: mount.RW === false,
    })),
    networks: Object.entries(container.NetworkSettings?.Networks ?? {})
      .map(([name, network]) => ({
        name,
        ipAddress: network?.IPAddress || null,
        ipv6Address: network?.GlobalIPv6Address || null,
        gateway: network?.Gateway || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    restartPolicy:
      policyName === 'on-failure' && policy?.MaximumRetryCount
        ? `on-failure:${policy.MaximumRetryCount}`
        : policyName,
    restartCount: container.RestartCount ?? 0,
  };
}

/**
 * The list row for a Container: everything except detail-only fields. Labels are raw here,
 * for Hosted Site discovery; what leaves for the browser goes through publicSummary.
 */
export function summaryOf(container: InspectedContainer): ContainerSummary {
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    state: container.state,
    health: container.health,
    composeProject: container.composeProject,
    createdAt: container.createdAt,
    startedAt: container.startedAt,
    finishedAt: container.finishedAt,
    exitCode: container.exitCode,
    ports: container.ports,
    labels: container.labels,
    maskedLabels: [],
    ...(container.selfClaimedByImage ? { selfClaimedByImage: true } : {}),
  };
}

/**
 * The detail view's fields: environment variable names only, never their values, and other
 * secrets masked (secrets.ts).
 */
export function detailOf(container: InspectedContainer): ContainerDetail {
  return publicDetail(container);
}

/** The fields Lookout reads from a Docker event. */
export interface EngineEvent {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string };
  id?: string;
  time?: number;
  timeNano?: number;
}

export function eventFromEngine(event: EngineEvent): ContainerEvent | null {
  if (event.Type !== undefined && event.Type !== 'container') return null;
  const containerId = event.Actor?.ID ?? event.id;
  if (!containerId || !event.Action) return null;
  const timestamp =
    event.timeNano !== undefined ? Math.floor(event.timeNano / 1e6) : (event.time ?? 0) * 1000;
  return { containerId, action: event.Action, timestamp };
}

/** The fields Lookout reads from one Docker stats sample. */
export interface EngineStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
}

/** CPU % and memory the same way `docker stats` calculates them. */
export function statsFromEngine(containerId: string, stats: EngineStats): ContainerStats {
  const cpu = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const cpus = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length || 1;
  const cpuPercent =
    cpuDelta > 0 && systemDelta > 0 ? Math.round((cpuDelta / systemDelta) * cpus * 1000) / 10 : 0;

  const memory = stats.memory_stats;
  // cgroup v2 reports inactive_file; cgroup v1 reports total_inactive_file.
  const inactive = memory?.stats?.inactive_file ?? memory?.stats?.total_inactive_file ?? 0;
  const usage = memory?.usage ?? 0;
  return {
    containerId,
    cpuPercent,
    memoryUsedBytes: Math.max(0, usage - (inactive < usage ? inactive : 0)),
    memoryLimitBytes: memory?.limit ?? 0,
  };
}

/**
 * The longest log line Lookout holds while it waits for a newline (#115, X1b): a longer one
 * is sent in pieces of this size, so a Container that never writes a newline cannot grow
 * Lookout's memory.
 */
export const MAX_LOG_LINE_CHARS = 64 * 1024;

/**
 * The longest line of Docker's JSON streams (events, stats) Lookout reads (#116, X1b, the
 * Engine body limit). A longer one cannot be parsed in pieces, so it is dropped whole.
 */
export const MAX_JSON_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Splits a chunked text stream into lines, holding at most `maxLength` characters of an
 * unfinished line (#115). Past that, `split` sends what it holds as a line of its own and
 * carries on; `drop` discards the line up to its newline. Each chunk is scanned once, so a
 * long line costs linear time, not a re-split of everything held on every chunk.
 */
export class LineSplitter {
  readonly #maxLength: number;
  readonly #overflow: 'split' | 'drop';
  #parts: string[] = [];
  #length = 0;
  #dropping = false;

  constructor(maxLength = MAX_LOG_LINE_CHARS, overflow: 'split' | 'drop' = 'split') {
    this.#maxLength = maxLength;
    this.#overflow = overflow;
  }

  push(chunk: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      this.#hold(newline < 0 ? chunk.slice(start) : chunk.slice(start, newline), out);
      if (newline < 0) return out;
      const line = this.#take();
      if (line) out.push(line);
      start = newline + 1;
    }
  }

  flush(): string[] {
    const rest = this.#take();
    return rest ? [rest] : [];
  }

  #hold(text: string, out: string[]): void {
    while (text.length > 0) {
      if (this.#dropping) return;
      const room = this.#maxLength - this.#length;
      if (text.length <= room) {
        this.#parts.push(text);
        this.#length += text.length;
        return;
      }
      this.#parts.push(text.slice(0, room));
      text = text.slice(room);
      const full = this.#parts.join('');
      this.#parts = [];
      this.#length = 0;
      if (this.#overflow === 'split') out.push(full);
      else this.#dropping = true;
    }
  }

  /** The line held so far, or '' if there is none (or it was dropped), and a fresh start. */
  #take(): string {
    const line = this.#dropping ? '' : this.#parts.join('');
    this.#parts = [];
    this.#length = 0;
    this.#dropping = false;
    return line;
  }
}

/**
 * Decodes Docker's multiplexed log stream (non-TTY Containers): each frame is an 8-byte
 * header [stream, 0, 0, 0, size (big-endian uint32)] followed by `size` bytes.
 *
 * A frame's payload is passed on as it arrives rather than buffered until the size its
 * header claims has come (#115): a header claiming 4 GiB holds nothing more than any other
 * frame, and lines are bounded by LineSplitter. Bytes are decoded as UTF-8 per stream, so a
 * character split across frames or chunks survives.
 */
export class LogFrameDecoder {
  #header = Buffer.alloc(0);
  #remaining = 0;
  #stream: LogLine['stream'] = 'stdout';
  readonly #lines = { stdout: new LineSplitter(), stderr: new LineSplitter() };
  readonly #text = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

  push(chunk: Buffer): LogLine[] {
    const out: LogLine[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#remaining === 0) {
        const needed = 8 - this.#header.length;
        this.#header = Buffer.concat([this.#header, chunk.subarray(offset, offset + needed)]);
        offset += needed;
        if (this.#header.length < 8) break;
        this.#stream = this.#header[0] === 2 ? 'stderr' : 'stdout';
        this.#remaining = this.#header.readUInt32BE(4);
        this.#header = Buffer.alloc(0);
        continue;
      }
      const take = Math.min(this.#remaining, chunk.length - offset);
      const payload = this.#text[this.#stream].write(chunk.subarray(offset, offset + take));
      offset += take;
      this.#remaining -= take;
      for (const raw of this.#lines[this.#stream].push(payload)) {
        out.push(logLineFrom(this.#stream, raw));
      }
    }
    return out;
  }
}

/** Splits Docker's "<RFC 3339 timestamp> <text>" log line. */
export function logLineFrom(stream: LogLine['stream'], raw: string): LogLine {
  const line = raw.replace(/\r$/, '');
  const space = line.indexOf(' ');
  const timestamp = space > 0 ? Date.parse(line.slice(0, space)) : Number.NaN;
  return Number.isNaN(timestamp)
    ? { stream, timestamp: 0, text: line }
    : { stream, timestamp, text: line.slice(space + 1) };
}
