import { EventEmitter, on } from 'node:events';
import type { ContainerAction, ContainerEvent, ContainerStats, LogLine } from '@lookout/shared';
import type { DockerClient, LogOptions } from '../src/docker/client.ts';
import type { DiskUsageReport } from '../src/docker/disk-usage.ts';
import { EngineError } from '../src/docker/engine.ts';
import type { InspectedContainer } from '../src/docker/parse.ts';

type StreamKind = 'events' | 'logs' | 'stats';
type FailureKind = 'docker' | 'connection';

/** An error as the Engine client throws it for Docker's own JSON error answer. */
const dockerError = (status: number, message: string) => new EngineError(status, { message });

/** A Container for tests, with every field filled in and the given ones overridden. */
export function makeContainer(
  overrides: Partial<InspectedContainer> & { id: string },
): InspectedContainer {
  const running = (overrides.state ?? 'running') === 'running';
  return {
    name: overrides.id,
    image: 'example:1',
    state: 'running',
    health: null,
    composeProject: null,
    createdAt: Date.parse('2026-11-01T00:00:00Z'),
    startedAt: running ? Date.parse('2026-11-25T08:00:00Z') : null,
    finishedAt: null,
    exitCode: running ? 0 : null,
    ports: [],
    labels: {},
    imageId: `sha256:${'0'.repeat(64)}`,
    imageDigest: null,
    command: [],
    entrypoint: [],
    env: [],
    mounts: [],
    networks: [],
    restartPolicy: 'no',
    restartCount: 0,
    ...overrides,
  };
}

/**
 * An in-memory Docker for unit and Playwright tests. Tests change its state with the
 * methods below and it emits matching events. Lives outside src/ and is excluded from the
 * Image, so the production entry point cannot load it.
 */
export class FakeDocker implements DockerClient {
  readonly #containers = new Map<string, InspectedContainer>();
  readonly #logs = new Map<string, LogLine[]>();
  readonly #stats = new Map<string, ContainerStats>();
  readonly #emitter = new EventEmitter();
  readonly #open: Record<StreamKind, number> = { events: 0, logs: 0, stats: 0 };
  #available = true;
  #nextFailure: { message: string; kind: FailureKind } | null = null;
  /** How long each Container Action takes, so a test can see its progress. */
  actionDelayMs = 0;
  /** Every Container Action asked of this Docker, in order. */
  readonly actions: { action: ContainerAction; id: string }[] = [];
  /** Aborted when Docker "goes away", ending every open stream with an error. */
  #outage = new AbortController();

  constructor(containers: InspectedContainer[] = []) {
    this.#emitter.setMaxListeners(0);
    for (const container of containers) this.#containers.set(container.id, container);
  }

  get available(): boolean {
    return this.#available;
  }

  /** Setting false makes every call fail and ends open streams, like a stopped daemon. */
  set available(value: boolean) {
    if (value === this.#available) return;
    this.#available = value;
    if (value) this.#outage = new AbortController();
    else this.#outage.abort();
  }

  /** How many streams of a kind are open right now. */
  openStreams(kind: StreamKind): number {
    return this.#open[kind];
  }

  async ping(): Promise<boolean> {
    return this.#available;
  }

  async listContainers(): Promise<InspectedContainer[]> {
    this.#assertAvailable();
    return [...this.#containers.values()].map((c) => structuredClone(c));
  }

  async inspectContainer(id: string): Promise<InspectedContainer | null> {
    this.#assertAvailable();
    const container = this.#containers.get(id) ?? this.#byName(id);
    return container ? structuredClone(container) : null;
  }

  /** Adds or replaces a Container and emits an event for it. */
  upsert(container: InspectedContainer, action = 'update'): void {
    this.#containers.set(container.id, container);
    this.emitEvent({ containerId: container.id, action, timestamp: Date.now() });
  }

  remove(id: string): void {
    this.#containers.delete(id);
    this.emitEvent({ containerId: id, action: 'destroy', timestamp: Date.now() });
  }

  /** Replaces every Container without emitting events, as if Docker had restarted. */
  reset(containers: InspectedContainer[]): void {
    this.#containers.clear();
    this.#logs.clear();
    this.#stats.clear();
    this.#nextFailure = null;
    this.actionDelayMs = 0;
    this.actions.length = 0;
    for (const container of containers) this.#containers.set(container.id, container);
  }

  emitEvent(event: ContainerEvent): void {
    this.#emitter.emit('event', event);
  }

  appendLog(id: string, line: LogLine): void {
    const lines = this.#logs.get(id) ?? [];
    lines.push(line);
    this.#logs.set(id, lines);
    this.#emitter.emit(`log:${id}`, line);
  }

  setStats(stats: ContainerStats): void {
    this.#stats.set(stats.containerId, stats);
    this.#emitter.emit(`stats:${stats.containerId}`, stats);
  }

  /**
   * Makes the next Container Action fail: with Docker's own JSON error message (`docker`, the
   * default), or before Docker answers, as Node's connection error (`connection`).
   */
  failNextAction(message: string, kind: FailureKind = 'docker'): void {
    this.#nextFailure = { message, kind };
  }

  async startContainer(id: string): Promise<void> {
    const container = await this.#beginAction('start', id);
    if (container.state === 'running') throw dockerError(304, 'container already started');
    this.upsert({ ...container, state: 'running', startedAt: Date.now() }, 'start');
  }

  async stopContainer(id: string): Promise<void> {
    const container = await this.#beginAction('stop', id);
    this.upsert(
      { ...container, state: 'exited', exitCode: 0, health: null, finishedAt: Date.now() },
      'die',
    );
  }

  async restartContainer(id: string): Promise<void> {
    const container = await this.#beginAction('restart', id);
    this.upsert(
      {
        ...container,
        state: 'running',
        health: container.health === null ? null : 'healthy',
        exitCode: 0,
        startedAt: Date.now(),
        restartCount: container.restartCount + 1,
      },
      'restart',
    );
  }

  /** Set to answer diskUsage with this report; null makes one up from the Containers. */
  diskUsageReport: DiskUsageReport | null = null;
  /** How long diskUsage takes, so a test can see "Measure now" running. */
  diskUsageDelayMs = 0;
  diskUsageCalls = 0;

  /**
   * Docker's disk usage. Unless a report is set, each Image is 100 MB, each Container's
   * writable layer 1 MB, and each Compose Project has a 50 MB "<project>_data" volume.
   */
  async diskUsage(): Promise<DiskUsageReport> {
    this.#assertAvailable();
    this.diskUsageCalls += 1;
    if (this.diskUsageDelayMs > 0) await new Promise((r) => setTimeout(r, this.diskUsageDelayMs));
    if (this.diskUsageReport) return structuredClone(this.diskUsageReport);
    const containers = [...this.#containers.values()];
    const images = new Map<string, number>();
    for (const c of containers) images.set(c.imageId, (images.get(c.imageId) ?? 0) + 1);
    const projects = [
      ...new Set(containers.flatMap((c) => (c.composeProject ? [c.composeProject] : []))),
    ];
    return {
      images: [...images].map(([id, count]) => ({ id, bytes: 100_000_000, containers: count })),
      containers: containers.map((c) => ({
        id: c.id,
        name: c.name,
        imageId: c.imageId,
        writableBytes: 1_000_000,
        running: c.state === 'running',
        project: c.composeProject,
        volumes: c.composeProject ? [`${c.composeProject}_data`] : [],
      })),
      volumes: projects.map((project) => ({
        name: `${project}_data`,
        bytes: 50_000_000,
        refCount: 1,
        project,
      })),
      buildCache: [{ bytes: 20_000_000, inUse: false, shared: false }],
    };
  }

  async removeContainer(id: string): Promise<void> {
    const container = await this.#beginAction('remove', id);
    // Like Docker without force: a running Container cannot be removed.
    if (container.state === 'running' || container.state === 'restarting') {
      throw dockerError(
        409,
        `cannot remove container "${container.name}": container is running: stop the container before removing or force remove`,
      );
    }
    this.remove(container.id);
  }

  async #beginAction(action: ContainerAction, id: string): Promise<InspectedContainer> {
    this.#assertAvailable();
    this.actions.push({ action, id });
    if (this.actionDelayMs > 0) await new Promise((r) => setTimeout(r, this.actionDelayMs));
    const failure = this.#nextFailure;
    this.#nextFailure = null;
    if (failure !== null) {
      throw failure.kind === 'docker'
        ? dockerError(500, failure.message)
        : Object.assign(new Error(failure.message), { code: 'ECONNREFUSED' });
    }
    const container = this.#containers.get(id) ?? this.#byName(id);
    if (!container) throw dockerError(404, `No such container: ${id}`);
    return structuredClone(container);
  }

  async *events(signal: AbortSignal): AsyncIterable<ContainerEvent> {
    this.#assertAvailable();
    yield* this.#counted('events', this.#listen<ContainerEvent>('event', signal));
  }

  async *logs(id: string, options: LogOptions, signal: AbortSignal): AsyncIterable<LogLine> {
    this.#assertAvailable();
    const lines = this.#counted('logs', this.#tailThenFollow(id, options, signal));
    yield* lines;
  }

  async *stats(id: string, signal: AbortSignal): AsyncIterable<ContainerStats> {
    this.#assertAvailable();
    const current = this.#stats.get(id);
    yield* this.#counted(
      'stats',
      (async function* (listen: AsyncIterable<ContainerStats>) {
        if (current) yield current;
        yield* listen;
      })(this.#listen<ContainerStats>(`stats:${id}`, signal)),
    );
  }

  async *#tailThenFollow(
    id: string,
    options: LogOptions,
    signal: AbortSignal,
  ): AsyncIterable<LogLine> {
    const existing = this.#logs.get(id) ?? [];
    yield* existing.slice(Math.max(0, existing.length - options.tail));
    if (options.follow) yield* this.#listen<LogLine>(`log:${id}`, signal);
  }

  async *#counted<T>(kind: StreamKind, source: AsyncIterable<T>): AsyncIterable<T> {
    this.#open[kind] += 1;
    try {
      yield* source;
    } finally {
      this.#open[kind] -= 1;
    }
  }

  async *#listen<T>(name: string, signal: AbortSignal): AsyncIterable<T> {
    const outage = this.#outage.signal;
    try {
      for await (const [value] of on(this.#emitter, name, {
        signal: AbortSignal.any([signal, outage]),
      })) {
        yield value as T;
      }
    } catch (error) {
      if (signal.aborted) return;
      if (outage.aborted) throw new Error('Docker connection lost', { cause: error });
      throw error;
    }
  }

  #byName(name: string): InspectedContainer | undefined {
    return [...this.#containers.values()].find((c) => c.name === name);
  }

  #assertAvailable(): void {
    if (!this.#available) throw new Error('connect ENOENT /var/run/docker.sock');
  }
}
