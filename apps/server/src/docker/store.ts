import type { ContainerEvent, ContainersSnapshot, ContainerSummary } from '@lookout/shared';
import type { DockerClient } from './client.ts';
import { summaryOf } from './parse.ts';

type Listener = (snapshot: ContainersSnapshot) => void;

export interface StoreLogger {
  warn(obj: unknown, msg: string): void;
  info(obj: unknown, msg: string): void;
}

export interface ContainerStoreOptions {
  log: StoreLogger;
  /** How long to wait before trying Docker again after losing it. */
  retryMs?: number;
  /** Changes arriving within this time are sent to the browser as one update. */
  debounceMs?: number;
}

/** Event actions that cannot change anything the list shows. Health checks run as execs. */
const IGNORED_ACTION =
  /^(exec_|attach|detach|resize|top|export|commit|copy|archive-path|extract-to-dir)/;

/**
 * The Container list, kept current from Docker events (FR-19) rather than by polling.
 *
 * It lists every Container once, then re-inspects only the Container each event names. If
 * Docker is unreachable, or its event stream ends because the daemon restarted, the list
 * is reported unavailable (NFR-5) and the store retries in the background.
 */
export class ContainerStore {
  readonly #docker: DockerClient;
  readonly #log: StoreLogger;
  readonly #retryMs: number;
  readonly #debounceMs: number;
  readonly #containers = new Map<string, ContainerSummary>();
  readonly #listeners = new Set<Listener>();
  #available = false;
  #running = false;
  #session: AbortController | null = null;
  #retry: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  #broadcast: NodeJS.Timeout | undefined;
  #loop: Promise<void> | null = null;

  constructor(docker: DockerClient, options: ContainerStoreOptions) {
    this.#docker = docker;
    this.#log = options.log;
    this.#retryMs = options.retryMs ?? 2000;
    this.#debounceMs = options.debounceMs ?? 50;
  }

  get snapshot(): ContainersSnapshot {
    return {
      available: this.#available,
      containers: [...this.#containers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#session?.abort();
    if (this.#retry) {
      clearTimeout(this.#retry.timer);
      this.#retry.resolve();
    }
    clearTimeout(this.#broadcast);
    await this.#loop;
  }

  async #run(): Promise<void> {
    let firstAttempt = true;
    while (this.#running) {
      const session = new AbortController();
      this.#session = session;
      try {
        await this.#follow(session.signal);
        if (!this.#stopped()) this.#log.warn({}, 'Docker event stream ended; reconnecting');
      } catch (error) {
        // Log losing Docker once, not on every retry.
        if (!this.#stopped() && (this.#available || firstAttempt)) {
          this.#log.warn({ err: error }, 'Docker is unavailable; retrying in the background');
        }
      }
      session.abort();
      firstAttempt = false;
      if (this.#stopped()) break;
      if (this.#available) {
        this.#available = false;
        this.#containers.clear();
        this.#schedule();
      }
      await new Promise<void>((resolve) => {
        this.#retry = { timer: setTimeout(resolve, this.#retryMs), resolve };
      });
      this.#retry = null;
    }
  }

  /** A method, not a field read, because stop() can change it during any await. */
  #stopped(): boolean {
    return !this.#running;
  }

  /** One connection to Docker: subscribe to events, list everything, then apply events. */
  async #follow(signal: AbortSignal): Promise<void> {
    const events = this.#docker.events(signal)[Symbol.asyncIterator]();
    // Ask for the first event before listing, so nothing that happens during the list is
    // missed. Its rejection is handled when it is awaited below.
    const first = events.next();
    first.catch(() => undefined);

    const containers = await this.#docker.listContainers();
    this.#containers.clear();
    for (const container of containers) this.#containers.set(container.id, summaryOf(container));
    if (!this.#available) this.#log.info({ count: containers.length }, 'Connected to Docker');
    this.#available = true;
    this.#schedule();

    for (let next = await first; !next.done; next = await events.next()) {
      await this.#apply(next.value);
    }
  }

  async #apply(event: ContainerEvent): Promise<void> {
    if (IGNORED_ACTION.test(event.action)) return;
    if (event.action === 'destroy') {
      if (this.#containers.delete(event.containerId)) this.#schedule();
      return;
    }
    const container = await this.#docker.inspectContainer(event.containerId);
    if (container) this.#containers.set(container.id, summaryOf(container));
    else this.#containers.delete(event.containerId);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#broadcast !== undefined) return;
    this.#broadcast = setTimeout(() => {
      this.#broadcast = undefined;
      const snapshot = this.snapshot;
      for (const listener of this.#listeners) listener(snapshot);
    }, this.#debounceMs);
  }
}
