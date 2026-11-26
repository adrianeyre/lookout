/**
 * Pen-test scope issue R1 (#68): how `df` is run (PRD, "Good and to confirm": "`df` runs
 * through `execFile` with an absolute path and no shell"). Findings: docs/pen-test/findings/R1.md.
 */
import { describe, expect, it, vi } from 'vitest';

const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string) => void,
  ) => {
    calls.push({ file, args, options });
    callback(
      null,
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 1000 1 999 1% /\n',
    );
  },
  exec: () => {
    throw new Error('exec (a shell) must never be used');
  },
}));

const { dfBlockUnitProbe } = await import('../../metrics/block-size.ts');

describe('R1: df', () => {
  it('runs through execFile with fixed arguments, no shell, and a timeout (sound)', async () => {
    calls.length = 0;
    const path = '/host/mnt/data; rm -rf / #';
    await dfBlockUnitProbe(path, 250n, 4096n);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.args).toEqual(['-P', '-k', '--', path]);
    expect(call!.options.shell).toBeUndefined();
    expect(call!.options.timeout).toBe(5000);
  });

  it('runs df by an absolute path, not whatever PATH finds first', async () => {
    calls.length = 0;
    await dfBlockUnitProbe('/host', 250n, 4096n);
    expect(calls[0]!.file).toMatch(/^\//);
  });

  it('runs /bin/df, never one found through PATH (regression)', async () => {
    calls.length = 0;
    await dfBlockUnitProbe('/host', 250n, 4096n);
    expect(calls[0]!.file).toBe('/bin/df');
  });

  it('is only ever handed a path under the Host root, which starts with / (never an option) (sound)', async () => {
    const { HostRoot } = await import('../../host-root.ts');
    const root = new HostRoot('/host');
    for (const mountPoint of ['-h', '--help', '/-x', '']) {
      expect(root.path(mountPoint)).toMatch(/^\/host/);
    }
  });
});
