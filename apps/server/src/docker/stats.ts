import type { ContainerStats, ContainersSnapshot } from '@lookout/shared';
import type { DockerClient } from './client.ts';
import type { ContainerStore } from './store.ts';

type Listener = (stats: ContainerStats[]) => void;

/**
 * Per-Container CPU and memory (FR-16, FR-19). Docker's stats streams are only open while
 * at least one browser has a Containers view open: with no subscriber, none are (NFR-1).
 */
export class StatsHub {
  readonly #docker: DockerClient;
  readonly #store: ContainerStore;
  readonly #flushMs: number;
  readonly #listeners = new Set<Listener>();
  readonly #streams = new Map<string, AbortController>();
  readonly #latest = new Map<string, ContainerStats>();
  #unsubscribeStore: (() => void) | null = null;
  #timer: NodeJS.Timeout | undefined;

  constructor(docker: DockerClient, store: ContainerStore, flushMs = 1000) {
    this.#docker = docker;
    this.#store = store;
    this.#flushMs = flushMs;
  }

  /** How many Docker stats streams are open. */
  get openStreams(): number {
    return this.#streams.size;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    else if (this.#latest.size > 0) listener([...this.#latest.values()]);
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0) this.#stop();
    };
  }

  #start(): void {
    this.#unsubscribeStore = this.#store.subscribe((snapshot) => this.#sync(snapshot));
    this.#sync(this.#store.snapshot);
    this.#timer = setInterval(() => this.#flush(), this.#flushMs);
  }

  #stop(): void {
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
    clearInterval(this.#timer);
    for (const controller of this.#streams.values()) controller.abort();
    this.#streams.clear();
    this.#latest.clear();
  }

  /** Opens a stream for each running Container and closes the rest. */
  #sync(snapshot: ContainersSnapshot): void {
    const running = new Set(
      snapshot.containers.filter((c) => c.state === 'running').map((c) => c.id),
    );
    for (const [id, controller] of this.#streams) {
      if (!running.has(id)) {
        controller.abort();
        this.#streams.delete(id);
        this.#latest.delete(id);
      }
    }
    for (const id of running) if (!this.#streams.has(id)) this.#open(id);
  }

  #open(id: string): void {
    const controller = new AbortController();
    this.#streams.set(id, controller);
    void (async () => {
      try {
        for await (const stats of this.#docker.stats(id, controller.signal)) {
          if (controller.signal.aborted) break;
          this.#latest.set(id, stats);
        }
      } catch {
        // The Container stopped or Docker went away; the next list change reopens it.
      } finally {
        if (this.#streams.get(id) === controller) this.#streams.delete(id);
      }
    })();
  }

  #flush(): void {
    if (this.#latest.size === 0) return;
    const stats = [...this.#latest.values()];
    for (const listener of this.#listeners) listener(stats);
  }
}
