import { request as httpRequest, type IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import {
  SELF_LABEL,
  type ContainerEvent,
  type ContainerStats,
  type LogLine,
} from '@lookout/shared';
import type { DockerClient, EngineVolume, LogOptions } from './client.ts';
import { diskUsageFromEngine, type DiskUsageReport, type EngineDiskUsage } from './disk-usage.ts';
import {
  LineSplitter,
  LogFrameDecoder,
  MAX_JSON_LINE_CHARS,
  eventFromEngine,
  inspectedFromEngine,
  logLineFrom,
  statsFromEngine,
  type EngineEvent,
  type EngineInspect,
  type EngineStats,
  type InspectedContainer,
} from './parse.ts';

/** Where the Docker Engine API is: a Unix socket, or a plain-HTTP TCP address. */
export type EngineAddress = { socketPath: string } | { host: string; port: number };

/**
 * The Engine API address from DOCKER_HOST (unix:// or tcp://), or Docker's default socket.
 * TLS (DOCKER_TLS_VERIFY) is not supported: Lookout expects the local socket (ADR-0003).
 */
export function engineAddress(env: Record<string, string | undefined> = process.env) {
  const dockerHost = env.DOCKER_HOST?.trim();
  if (!dockerHost) return { socketPath: '/var/run/docker.sock' } satisfies EngineAddress;
  if (dockerHost.startsWith('unix://')) {
    return { socketPath: dockerHost.slice('unix://'.length) } satisfies EngineAddress;
  }
  const url = new URL(dockerHost.replace(/^tcp:\/\//, 'http://'));
  return { host: url.hostname, port: Number(url.port || 2375) } satisfies EngineAddress;
}

/**
 * A failed Engine API call. `json` is set only when the answer was Docker's own JSON error
 * body: a plain-text answer (a socket proxy's refusal) is never passed on as Docker's
 * message (#92), though its first line is kept in `message` for the server log.
 */
export class EngineError extends Error {
  override name = 'EngineError';
  readonly statusCode: number;
  readonly json: { message?: string } | null;

  constructor(statusCode: number, json: { message?: string } | null, text = '') {
    super(
      json?.message ?? `Docker answered ${statusCode} ${text.split('\n')[0]!.slice(0, 200)}`.trim(),
    );
    this.statusCode = statusCode;
    this.json = json;
  }
}

type Query = Record<string, string | number | boolean>;

/**
 * The most of one Engine answer Lookout reads (#116, X1b). Inspect bodies carry a
 * Container's labels and environment, which whoever built its Image chose, so their size is
 * an input: past this the answer is abandoned, never held.
 */
export const MAX_ENGINE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The most of the Container list Lookout reads. Only the IDs are kept from it (each
 * Container is then inspected on its own, within MAX_ENGINE_BODY_BYTES), so this bounds time,
 * not memory.
 */
export const MAX_ENGINE_LIST_BYTES = 64 * 1024 * 1024;

/**
 * The most of a /system/df answer Lookout reads. It lists every Image, Container, volume and
 * build-cache record, so it can be large; it is read once a day and on "Measure now", and only
 * sizes and Compose Project labels are kept from it.
 */
export const MAX_ENGINE_DF_BYTES = 64 * 1024 * 1024;

/** An Engine answer longer than Lookout reads. Its text never reaches the browser. */
export class EngineBodyTooLarge extends Error {
  override name = 'EngineBodyTooLarge';
  constructor(limit: number) {
    super(`Docker's answer was over ${limit} bytes`);
  }
}

async function readBody(response: IncomingMessage, limit = MAX_ENGINE_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    length += (chunk as Buffer).length;
    if (length > limit) {
      response.destroy();
      throw new EngineBodyTooLarge(limit);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The Container IDs in a GET /containers/json answer, read as it streams so no more than a
 * few bytes of it are ever held (#116). Inside a JSON string a quote is always escaped, so
 * `"Id":"` is only ever a key; a label whose own key is "Id" can at most add one more
 * reference to inspect, which names a Container that exists (de-duplicated by its ID once
 * inspected) or none (left out).
 */
async function listedIds(response: IncomingMessage): Promise<string[]> {
  const ids = new Set<string>();
  const pattern = /"Id":"([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})"/g;
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let length = 0;
  for await (const chunk of response) {
    length += (chunk as Buffer).length;
    if (length > MAX_ENGINE_LIST_BYTES) {
      response.destroy();
      throw new EngineBodyTooLarge(MAX_ENGINE_LIST_BYTES);
    }
    const text = carry + decoder.write(chunk as Buffer);
    for (const match of text.matchAll(pattern)) ids.add(match[1]!);
    // Keep enough to finish a match that straddles two chunks.
    carry = text.slice(-80);
  }
  return [...ids];
}

/**
 * A Container whose inspect answer was over MAX_ENGINE_BODY_BYTES: listed so the operator
 * sees it, with nothing read from it, and refused by every route that needs its detail.
 */
const oversized = new WeakSet<InspectedContainer>();

export function isOversized(container: InspectedContainer): boolean {
  return oversized.has(container);
}

function oversizedContainer(id: string): InspectedContainer {
  const container: InspectedContainer = {
    id,
    name: id.slice(0, 12),
    image: `Docker's answer for this Container is over ${MAX_ENGINE_BODY_BYTES / 1024 / 1024} MiB`,
    state: 'dead',
    health: null,
    composeProject: null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    ports: [],
    labels: {},
    imageId: '',
    imageDigest: null,
    command: [],
    entrypoint: [],
    env: [],
    mounts: [],
    networks: [],
    restartPolicy: 'no',
    restartCount: 0,
  };
  oversized.add(container);
  return container;
}

/** Docker's JSON error body {"message": …}, or null for anything else (plain text, HTML). */
function errorBody(text: string): { message?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function* jsonLines<T>(stream: IncomingMessage, signal: AbortSignal): AsyncIterable<T> {
  // A line too long to read is dropped whole: half a JSON value cannot be parsed (#116).
  const lines = new LineSplitter(MAX_JSON_LINE_CHARS, 'drop');
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of stream) {
      for (const line of lines.push(decoder.write(chunk as Buffer))) yield JSON.parse(line) as T;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    stream.destroy();
  }
}

/** What Lookout reads from a Container's Image. */
interface ImageFacts {
  digest: string | null;
  /** The Image itself carries the `lookout.self` label (#105). */
  claimsSelf: boolean;
}

const UNKNOWN_IMAGE: ImageFacts = { digest: null, claimsSelf: false };

/**
 * The real Docker Engine API client: plain HTTP over DOCKER_HOST or /var/run/docker.sock.
 *
 * Lookout uses a dozen endpoints, so this talks to them directly rather than through an SDK:
 * dockerode alone added about 35 MB of memory (SSH, gRPC and protobuf support Lookout never
 * uses), which NFR-1's 100 MB budget cannot afford.
 */
export class EngineDockerClient implements DockerClient {
  readonly #address: EngineAddress;
  /** Image ID → repository digest. An Image ID names fixed content, so this never goes stale. */
  readonly #images = new Map<string, ImageFacts>();

  constructor(address: EngineAddress = engineAddress()) {
    this.#address = address;
  }

  /** Sends one request; resolves with the response once its headers arrive. */
  #request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Query = {},
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          ...this.#address,
          method,
          path: search ? `${path}?${search}` : path,
          headers: { host: 'docker' },
          ...(signal ? { signal } : {}),
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
  }

  /** Sends a request and reads its JSON body, throwing EngineError for an error status. */
  async #call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Query = {},
    limit = MAX_ENGINE_BODY_BYTES,
  ): Promise<T | null> {
    const response = await this.#request(method, path, query);
    const text = await readBody(response, limit);
    const status = response.statusCode ?? 0;
    if (status >= 400) {
      throw new EngineError(status, errorBody(text), text);
    }
    return text ? (JSON.parse(text) as T) : null;
  }

  /** Opens a streaming endpoint, throwing EngineError if Docker refuses it. */
  async #stream(path: string, query: Query, signal: AbortSignal): Promise<IncomingMessage> {
    const response = await this.#request('GET', path, query, signal);
    const status = response.statusCode ?? 0;
    if (status >= 400) {
      const text = await readBody(response);
      throw new EngineError(status, errorBody(text), text);
    }
    return response;
  }

  #containerPath(id: string, action = ''): string {
    return `/containers/${encodeURIComponent(id)}${action}`;
  }

  /** Docker answers /_ping with a plain-text "OK", not JSON, so only the status counts. */
  async ping(): Promise<boolean> {
    try {
      const response = await this.#request('GET', '/_ping');
      await readBody(response);
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }

  async listContainers(): Promise<InspectedContainer[]> {
    const response = await this.#request('GET', '/containers/json', { all: true });
    const status = response.statusCode ?? 0;
    if (status >= 400) {
      const text = await readBody(response);
      throw new EngineError(status, errorBody(text), text);
    }
    // Only the IDs are read from the list (#116): it carries every Container's labels. The
    // list also lacks start times and exit codes, so inspect each Container. One removed in
    // between is simply left out.
    const ids = await listedIds(response);
    const inspected = await Promise.all(ids.map((id) => this.inspectContainer(id)));
    const byId = new Map<string, InspectedContainer>();
    for (const container of inspected) if (container) byId.set(container.id, container);
    return [...byId.values()];
  }

  async #inspectRaw(id: string): Promise<EngineInspect | null> {
    try {
      return await this.#call<EngineInspect>('GET', this.#containerPath(id, '/json'));
    } catch (error) {
      if (error instanceof EngineError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async inspectContainer(id: string): Promise<InspectedContainer | null> {
    let raw: EngineInspect | null;
    try {
      raw = await this.#inspectRaw(id);
    } catch (error) {
      if (error instanceof EngineBodyTooLarge) return oversizedContainer(id);
      throw error;
    }
    if (!raw) return null;
    const image = raw.Image ? await this.#image(raw.Image) : UNKNOWN_IMAGE;
    return inspectedFromEngine(raw, image.digest, image.claimsSelf);
  }

  /** The Image's digest, and whether it carries `lookout.self` itself (#105). */
  async #image(imageId: string): Promise<ImageFacts> {
    const cached = this.#images.get(imageId);
    if (cached !== undefined) return cached;
    try {
      const image = await this.#call<{
        RepoDigests?: string[] | null;
        Config?: { Labels?: Record<string, string> | null } | null;
      }>('GET', `/images/${encodeURIComponent(imageId)}/json`);
      const facts: ImageFacts = {
        digest: image?.RepoDigests?.[0] ?? null,
        claimsSelf: image?.Config?.Labels?.[SELF_LABEL] !== undefined,
      };
      if (this.#images.size > 1000) this.#images.clear();
      this.#images.set(imageId, facts);
      return facts;
    } catch {
      // The Image can be gone while the Container remains; the digest is then unknown, and
      // its labels too. Not cached, so the next inspect asks again.
      return UNKNOWN_IMAGE;
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<ContainerEvent> {
    const stream = await this.#stream(
      '/events',
      { filters: JSON.stringify({ type: ['container'] }) },
      signal,
    );
    for await (const raw of jsonLines<EngineEvent>(stream, signal)) {
      const event = eventFromEngine(raw);
      if (event) yield event;
    }
  }

  async *logs(id: string, options: LogOptions, signal: AbortSignal): AsyncIterable<LogLine> {
    const info = await this.#inspectRaw(id);
    if (!info) throw new EngineError(404, { message: `No such container: ${id}` });
    const stream = await this.#stream(
      this.#containerPath(id, '/logs'),
      {
        follow: options.follow,
        stdout: true,
        stderr: true,
        timestamps: true,
        tail: options.tail,
      },
      signal,
    );
    try {
      if (info.Config?.Tty) {
        // TTY Containers send one raw stream with no frame headers.
        const lines = new LineSplitter();
        const decoder = new StringDecoder('utf8');
        for await (const chunk of stream) {
          for (const line of lines.push(decoder.write(chunk as Buffer))) {
            yield logLineFrom('stdout', line);
          }
        }
      } else {
        const decoder = new LogFrameDecoder();
        for await (const chunk of stream) yield* decoder.push(chunk as Buffer);
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      stream.destroy();
    }
  }

  async *stats(id: string, signal: AbortSignal): AsyncIterable<ContainerStats> {
    const stream = await this.#stream(this.#containerPath(id, '/stats'), { stream: true }, signal);
    for await (const raw of jsonLines<EngineStats>(stream, signal)) {
      yield statsFromEngine(id, raw);
    }
  }

  // Docker answers 304 when the Container is already in the asked-for state; that is fine.
  async startContainer(id: string): Promise<void> {
    await this.#call('POST', this.#containerPath(id, '/start'));
  }

  async stopContainer(id: string): Promise<void> {
    await this.#call('POST', this.#containerPath(id, '/stop'));
  }

  async restartContainer(id: string): Promise<void> {
    await this.#call('POST', this.#containerPath(id, '/restart'));
  }

  async removeContainer(id: string): Promise<void> {
    // Never force-remove a running Container, and never delete its volumes (FR-25).
    await this.#call('DELETE', this.#containerPath(id), { force: false, v: false });
  }

  async diskUsage(types?: readonly 'volume'[]): Promise<DiskUsageReport> {
    // `type` (Engine API 1.42+) asks only for those parts, which is much quicker; an older
    // Engine ignores it and answers everything.
    const query: Query = types && types.length > 0 ? { type: types.join(',') } : {};
    const raw = await this.#call<EngineDiskUsage>('GET', '/system/df', query, MAX_ENGINE_DF_BYTES);
    return diskUsageFromEngine(raw);
  }

  async listVolumes(): Promise<EngineVolume[]> {
    const raw = await this.#call<{
      Volumes?:
        | {
            Name?: string;
            Driver?: string;
            CreatedAt?: string;
            Labels?: Record<string, string> | null;
          }[]
        | null;
    }>('GET', '/volumes', {}, MAX_ENGINE_DF_BYTES);
    return (raw?.Volumes ?? []).flatMap((volume) => {
      if (typeof volume.Name !== 'string') return [];
      const created = volume.CreatedAt ? Date.parse(volume.CreatedAt) : Number.NaN;
      return [
        {
          name: volume.Name,
          driver: typeof volume.Driver === 'string' ? volume.Driver : 'local',
          createdAt: Number.isFinite(created) ? created : null,
          project: volume.Labels?.['com.docker.compose.project'] ?? null,
        },
      ];
    });
  }

  async removeVolume(name: string): Promise<void> {
    // Never forced (ADR-0015): Docker refuses a volume any Container uses.
    await this.#call('DELETE', `/volumes/${encodeURIComponent(name)}`, { force: false });
  }
}
