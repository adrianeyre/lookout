import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HostRoot } from '../host-root.ts';
import { fixture, makeHostRoot } from '../../test/helpers.ts';
import { CpuReader, parseLoadavg, parseProcStat, usageBetween } from './cpu.ts';

const stat1 = readFileSync(fixture('stat-1'), 'utf8');
const stat2 = readFileSync(fixture('stat-2'), 'utf8');

describe('parseProcStat', () => {
  it('reads the overall and per-core counters, counting iowait as idle', () => {
    const stat = parseProcStat(stat1);
    expect(stat.overall).toEqual({ total: 94800, idle: 81000 });
    expect(stat.cores).toHaveLength(2);
    expect(stat.cores[0]).toEqual({ total: 47400, idle: 40500 });
  });
});

describe('usageBetween', () => {
  it('is null on the first sample, with no previous value', () => {
    expect(usageBetween(undefined, parseProcStat(stat1).overall)).toBeNull();
  });

  it('is busy time over total time between two samples', () => {
    // total +2000, idle +1000 → 50% busy.
    expect(usageBetween(parseProcStat(stat1).overall, parseProcStat(stat2).overall)).toBe(50);
  });

  it('is null when no time has passed', () => {
    const { overall } = parseProcStat(stat1);
    expect(usageBetween(overall, overall)).toBeNull();
  });
});

describe('parseLoadavg', () => {
  it('reads the 1, 5 and 15-minute load averages', () => {
    expect(parseLoadavg('0.52 0.58 0.59 2/412 123456\n')).toEqual({
      one: 0.52,
      five: 0.58,
      fifteen: 0.59,
    });
  });
});

describe('CpuReader', () => {
  it('reports null first, then usage per core from successive samples', async () => {
    const root = await makeHostRoot({ 'proc/stat': stat1, 'proc/loadavg': '1.00 0.50 0.25 1/1 1' });
    const { writeFile } = await import('node:fs/promises');
    const reader = new CpuReader(new HostRoot(root));

    const first = await reader.read();
    expect(first.usagePercent).toBeNull();
    expect(first.perCore).toEqual([null, null]);
    expect(first.load.one).toBe(1);

    await writeFile(`${root}/proc/stat`, stat2);
    const second = await reader.read();
    expect(second.usagePercent).toBe(50);
    // core 0: total +1000, idle +350 → 65%; core 1: total +1000, idle +650 → 35%.
    expect(second.perCore).toEqual([65, 35]);
  });
});
