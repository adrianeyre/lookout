import type { MemoryMetrics } from '@lookout/shared';
import type { HostRoot } from '../host-root.ts';
import { percent } from './percent.ts';

/** Parses /proc/meminfo into a map of field name to bytes. */
export function parseMeminfo(text: string): Map<string, number> {
  const fields = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([\w()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line);
    if (match) {
      const multiplier = line.trimEnd().endsWith('kB') ? 1024 : 1;
      fields.set(match[1]!, Number(match[2]) * multiplier);
    }
  }
  return fields;
}

export function memoryFromMeminfo(text: string): MemoryMetrics {
  const fields = parseMeminfo(text);
  const need = (name: string): number => {
    const value = fields.get(name);
    if (value === undefined) throw new Error(`meminfo has no ${name}`);
    return value;
  };

  const totalBytes = need('MemTotal');
  const availableBytes = need('MemAvailable');
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  const swapTotal = fields.get('SwapTotal') ?? 0;
  const swapFree = fields.get('SwapFree') ?? 0;
  const swapUsed = Math.max(0, swapTotal - swapFree);

  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usagePercent: percent(usedBytes, totalBytes),
    swap:
      swapTotal > 0
        ? { totalBytes: swapTotal, usedBytes: swapUsed, usagePercent: percent(swapUsed, swapTotal) }
        : null,
  };
}

export async function readMemory(hostRoot: HostRoot): Promise<MemoryMetrics> {
  return memoryFromMeminfo(await hostRoot.readText('proc/meminfo'));
}
