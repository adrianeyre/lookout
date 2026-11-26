import type { CpuMetrics, LoadAverage } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';
import { percent } from './percent.ts';

export interface CpuTimes {
  total: number;
  idle: number;
}

export interface ProcStat {
  overall: CpuTimes;
  cores: CpuTimes[];
}

function parseCpuLine(fields: string[]): CpuTimes {
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  // guest and guest_nice are already counted in user and nice, so they are left out.
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    fields.map(Number);
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
  };
}

export function parseProcStat(text: string): ProcStat {
  let overall: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!match) continue;
    const times = parseCpuLine(match[2]!.trim().split(/\s+/));
    if (match[1] === '') overall = times;
    else cores[Number(match[1])] = times;
  }
  if (!overall) throw new Error('proc/stat has no cpu line');
  // A missing core number (offline CPU) leaves a hole; fill it rather than skip it.
  return {
    overall,
    cores: Array.from({ length: cores.length }, (_, i) => cores[i] ?? { total: 0, idle: 0 }),
  };
}

/** Usage % between two samples, or null without a previous sample or elapsed time. */
export function usageBetween(previous: CpuTimes | undefined, current: CpuTimes): number | null {
  if (!previous) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return null;
  return percent(total - idle, total);
}

export function parseLoadavg(text: string): LoadAverage {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  if (![one, five, fifteen].every((n) => Number.isFinite(n))) {
    throw new Error('proc/loadavg is malformed');
  }
  return { one: one!, five: five!, fifteen: fifteen! };
}

/** Keeps the previous proc/stat sample so each read can report usage since the last one. */
export class CpuReader {
  readonly #hostRoot: HostRoot;
  #previous: ProcStat | undefined;

  constructor(hostRoot: HostRoot) {
    this.#hostRoot = hostRoot;
  }

  async read(): Promise<CpuMetrics> {
    const [statText, loadText] = await Promise.all([
      this.#hostRoot.readText('proc/stat'),
      this.#hostRoot.readText('proc/loadavg'),
    ]);
    const current = parseProcStat(statText);
    const previous = this.#previous;
    this.#previous = current;
    return {
      usagePercent: usageBetween(previous?.overall, current.overall),
      perCore: current.cores.map((core, i) => usageBetween(previous?.cores[i], core)),
      load: parseLoadavg(loadText),
    };
  }
}
