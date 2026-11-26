import type { LiveWindowSnapshot, WindowPoint } from '@lookout/shared';

const FIELDS = [
  'timestamp',
  'cpuPercent',
  'memoryPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'networkRxBytesPerSecond',
  'networkTxBytesPerSecond',
] as const satisfies readonly (keyof WindowPoint)[];

type Columns = Record<(typeof FIELDS)[number], Float64Array>;

/** How many samples a Live Window of `minutes` holds at `sampleIntervalMs`. */
export function windowCapacity(minutes: number, sampleIntervalMs: number): number {
  return Math.max(1, Math.ceil((minutes * 60_000) / sampleIntervalMs));
}

/**
 * The Live Window (FR-13, ADR-0004): a fixed-size ring buffer per metric, held in memory
 * only. Its memory is allocated once, up front, and never grows: each new point overwrites
 * the oldest. It is never persisted, so a restart starts with an empty window.
 */
export class LiveWindow {
  readonly capacity: number;
  readonly sampleIntervalMs: number;
  readonly #columns: Columns;
  #start = 0;
  #size = 0;

  constructor(minutes: number, sampleIntervalMs: number) {
    this.capacity = windowCapacity(minutes, sampleIntervalMs);
    this.sampleIntervalMs = sampleIntervalMs;
    this.#columns = Object.fromEntries(
      FIELDS.map((field) => [field, new Float64Array(this.capacity)]),
    ) as Columns;
  }

  get size(): number {
    return this.#size;
  }

  /** Bytes held by the buffer: fixed by its capacity, whatever has been pushed. */
  get byteLength(): number {
    return FIELDS.reduce((total, field) => total + this.#columns[field].byteLength, 0);
  }

  push(point: WindowPoint): void {
    const index = (this.#start + this.#size) % this.capacity;
    for (const field of FIELDS) this.#columns[field][index] = point[field] ?? Number.NaN;
    if (this.#size < this.capacity) this.#size += 1;
    else this.#start = (this.#start + 1) % this.capacity;
  }

  /** The window's points, oldest first. */
  points(): WindowPoint[] {
    const out: WindowPoint[] = [];
    for (let i = 0; i < this.#size; i += 1) {
      const index = (this.#start + i) % this.capacity;
      const cpu = this.#columns.cpuPercent[index]!;
      out.push({
        timestamp: this.#columns.timestamp[index]!,
        cpuPercent: Number.isNaN(cpu) ? null : cpu,
        memoryPercent: this.#columns.memoryPercent[index]!,
        diskReadBytesPerSecond: this.#columns.diskReadBytesPerSecond[index]!,
        diskWriteBytesPerSecond: this.#columns.diskWriteBytesPerSecond[index]!,
        networkRxBytesPerSecond: this.#columns.networkRxBytesPerSecond[index]!,
        networkTxBytesPerSecond: this.#columns.networkTxBytesPerSecond[index]!,
      });
    }
    return out;
  }

  snapshot(): LiveWindowSnapshot {
    return {
      capacity: this.capacity,
      sampleIntervalMs: this.sampleIntervalMs,
      points: this.points(),
    };
  }
}
