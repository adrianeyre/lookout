import { windowPointFrom, type HostSample } from '@lookout/shared';
import type { HostRoot } from './host-root.ts';
import { LiveWindow } from './live-window.ts';
import type { BlockUnitProbe } from './metrics/block-size.ts';
import { CpuReader } from './metrics/cpu.ts';
import { DiskIoReader } from './metrics/disk-io.ts';
import { DiskReader } from './metrics/disks.ts';
import { readMemory } from './metrics/memory.ts';
import { NetworkReader } from './metrics/network.ts';
import { readOverview } from './metrics/overview.ts';

type Listener = (sample: HostSample) => void;

export interface SamplerLogger {
  error(obj: unknown, msg: string): void;
}

export interface SamplerOptions {
  intervalMs: number;
  liveWindowMinutes: number;
  log: SamplerLogger;
  blockUnitProbe?: BlockUnitProbe;
}

/**
 * Samples every Host Metric on a fixed interval, keeps the Live Window, and hands each
 * sample to its listeners.
 */
export class HostSampler {
  readonly #hostRoot: HostRoot;
  readonly #intervalMs: number;
  readonly #log: SamplerLogger;
  readonly #cpu: CpuReader;
  readonly #disks: DiskReader;
  readonly #diskIo: DiskIoReader;
  readonly #network: NetworkReader;
  readonly window: LiveWindow;
  readonly #listeners = new Set<Listener>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #latest: HostSample | null = null;

  constructor(hostRoot: HostRoot, options: SamplerOptions) {
    this.#hostRoot = hostRoot;
    this.#intervalMs = options.intervalMs;
    this.#log = options.log;
    this.#cpu = new CpuReader(hostRoot);
    this.#disks = new DiskReader(hostRoot, options.blockUnitProbe);
    this.#diskIo = new DiskIoReader(hostRoot);
    this.#network = new NetworkReader(hostRoot);
    this.window = new LiveWindow(options.liveWindowMinutes, options.intervalMs);
  }

  get latest(): HostSample | null {
    return this.#latest;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sample(): Promise<HostSample> {
    const [overview, cpu, memory, disks, diskIo, network] = await Promise.all([
      readOverview(this.#hostRoot),
      this.#cpu.read(),
      readMemory(this.#hostRoot),
      this.#disks.read(),
      // Disk I/O and network are optional extras: a Host without them still has a dashboard.
      this.#diskIo.read().catch((error: unknown) => this.#optional('Disk I/O', error)),
      this.#network.read().catch((error: unknown) => this.#optional('Network', error)),
    ]);
    return { timestamp: Date.now(), overview, cpu, memory, disks, diskIo, network };
  }

  #warned = new Set<string>();

  #optional(name: string, error: unknown): [] {
    if (!this.#warned.has(name)) {
      this.#warned.add(name);
      this.#log.error({ err: error }, `${name} metrics are unavailable`);
    }
    return [];
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async () => {
      const started = Date.now();
      try {
        const sample = await this.sample();
        this.#latest = sample;
        this.window.push(windowPointFrom(sample));
        for (const listener of this.#listeners) listener(sample);
      } catch (error) {
        this.#log.error({ err: error }, 'Host Metric sample failed');
      }
      if (this.#running) {
        // Schedule from the start of this tick so the cadence does not drift by read time.
        const delay = Math.max(0, this.#intervalMs - (Date.now() - started));
        this.#timer = setTimeout(() => void tick(), delay);
      }
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
  }
}
