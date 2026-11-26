import { execFile } from 'node:child_process';

/**
 * Returns the size in bytes of the units statfs counts blocks in, for a path.
 *
 * Block counts are in units of f_frsize, but Node's statfs only reports f_bsize. They are the
 * same on most local filesystems, but not on NFS, CIFS, FUSE or virtiofs, where using f_bsize
 * overstates sizes many times over. The unit never changes for a mounted filesystem, so it is
 * worked out once per mount and cached.
 */
export type BlockUnitProbe = (path: string, blocks: bigint, bsize: bigint) => Promise<bigint>;

/** Parses `df -P -k` output into the filesystem's total size in KiB. */
export function parseDfTotalKiB(output: string): bigint | null {
  const line = output.trim().split('\n')[1];
  const total = line?.trim().split(/\s+/)[1];
  return total && /^\d+$/.test(total) ? BigInt(total) : null;
}

/** The power of two (at least 512) nearest to bytes / blocks. */
export function blockUnitFrom(totalBytes: bigint, blocks: bigint): bigint | null {
  if (blocks <= 0n || totalBytes <= 0n) return null;
  const ratio = Number(totalBytes) / Number(blocks);
  const exponent = Math.max(9, Math.round(Math.log2(ratio)));
  return 2n ** BigInt(exponent);
}

/**
 * Calibrates against `df -P -k`, which reads f_frsize. Run with execFile, by its absolute
 * path (never whatever PATH finds first, #114), with fixed arguments and `--` before the path,
 * never through a shell. Falls back to f_bsize if df is missing or its output is unexpected.
 */
const DF = '/bin/df';

export const dfBlockUnitProbe: BlockUnitProbe = (path, blocks, bsize) =>
  new Promise((resolve) => {
    execFile(DF, ['-P', '-k', '--', path], { timeout: 5000 }, (error, stdout) => {
      const totalKiB = error ? null : parseDfTotalKiB(stdout);
      resolve((totalKiB !== null && blockUnitFrom(totalKiB * 1024n, blocks)) || bsize);
    });
  });
