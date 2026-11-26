/**
 * The Host's largest folders. Each real filesystem that Disk space lists is walked from its
 * mount point, under the Host root, without crossing into another filesystem (so /proc, /sys
 * and Docker's overlay mounts are never entered), counting each file's disk blocks like `du`
 * and each hard-linked file once. Only folder totals are kept while walking, and only the
 * result afterwards, in memory.
 *
 * The walk is one directory entry at a time, yielding to the event loop often, so it never
 * competes with the dashboard; it is slow on purpose. Folders Lookout cannot read (it runs as
 * a non-root user) are counted, so the Widget can say its sizes leave them out.
 *
 * What it reads, and what bounds it (pen-test R1, #107-#111, #113):
 * - only directory listings and each entry's lstat: never a file's contents;
 * - never /home or /root (PRIVATE_FOLDERS), nor a filesystem mounted under them;
 * - never a link: a mount point that is a link is skipped, and each directory is opened
 *   without following a link and checked to be the one lstat saw, so a Container that swaps
 *   one of its folders for a link cannot send the walk elsewhere. On Linux each child is then
 *   reached through its parent's open handle, so no folder above it can be swapped either;
 * - FOLDER_SCAN_LIMITS: hard links remembered, entries, depth and time, after which the
 *   result is marked partial.
 */
import { constants, lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import {
  FOLDER_COUNT,
  FOLDER_SCAN_LIMITS,
  PRIVATE_FOLDERS,
  type DiskFilesystem,
  type FolderScan,
  type FolderUsage,
} from '@lookout/shared';
import { OWN_FD_DIR, type HostRoot } from '../host-root.ts';

/** A folder whose biggest child holds this much of it is only a way to that child. */
export const DOMINANT_CHILD = 0.8;
/** How many candidates the walk keeps, more than it shows, so overlaps can be skipped. */
const CANDIDATES = 200;
/** Entries walked between yields to the event loop. */
const YIELD_EVERY = 256;
/** Never walked into at a filesystem's root: kernel and runtime views, not storage. */
const SKIP_AT_ROOT = new Set(['proc', 'sys', 'dev', 'run']);

export interface Candidate {
  path: string;
  bytes: number;
}

/**
 * The heaviest `count` folders, none inside another. Candidates are the folders whose space
 * is spread over their contents (no single child holds most of it), so a folder that is
 * mostly one child gives way to that child: "/var/lib/docker/volumes", not "/var".
 */
export function pickHeaviest(candidates: readonly Candidate[], count = FOLDER_COUNT): Candidate[] {
  const chosen: Candidate[] = [];
  const inside = (child: string, parent: string) =>
    child === parent || child.startsWith(parent === '/' ? '/' : `${parent}/`);
  for (const candidate of [...candidates].sort((a, b) => b.bytes - a.bytes)) {
    if (chosen.length === count) break;
    if (candidate.bytes <= 0) continue;
    if (chosen.some((c) => inside(candidate.path, c.path) || inside(c.path, candidate.path))) {
      continue;
    }
    chosen.push(candidate);
  }
  return chosen;
}

export interface WalkResult {
  candidates: Candidate[];
  /** Disk space the whole walk counted, in bytes (the starting folder's own blocks excluded). */
  bytes: number;
  walked: number;
  unreadable: number;
  /** True if the walk stopped at, or went past, one of its limits. */
  partial: boolean;
}

export type ScanLimits = { [K in keyof typeof FOLDER_SCAN_LIMITS]: number };

/** What one scan has used of its limits, shared by every filesystem it walks. */
export class ScanBudget {
  readonly limits: ScanLimits;
  readonly #now: () => number;
  readonly #deadline: number;
  entries = 0;
  partial = false;
  /** True once the entries or the time are used up: nothing more is walked. */
  exhausted = false;
  /** "dev:ino" of every hard-linked file counted, so each is counted once. */
  readonly seenLinks = new Set<string>();

  constructor(limits: Partial<ScanLimits> = {}, now: () => number = Date.now) {
    this.limits = { ...FOLDER_SCAN_LIMITS, ...limits };
    this.#now = now;
    this.#deadline = now() + this.limits.durationMs;
  }

  /** Counts one entry; false once the scan must stop. */
  take(): boolean {
    this.entries += 1;
    if (this.exhausted || this.entries > this.limits.entries || this.#now() > this.#deadline) {
      this.partial = true;
      this.exhausted = true;
      return false;
    }
    return true;
  }
}

/** Keeps the largest `limit` candidates, cheaply. */
class Heaviest {
  readonly #limit: number;
  readonly items: Candidate[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(candidate: Candidate) {
    if (this.items.length < this.#limit) {
      this.items.push(candidate);
      return;
    }
    let smallest = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i]!.bytes < this.items[smallest]!.bytes) smallest = i;
    }
    if (candidate.bytes > this.items[smallest]!.bytes) this.items[smallest] = candidate;
  }
}

/** True if a Host path is one of PRIVATE_FOLDERS or inside one. */
export function isPrivateFolder(hostPath: string): boolean {
  return PRIVATE_FOLDERS.some((p) => hostPath === p || hostPath.startsWith(`${p}/`));
}

/**
 * Where an open directory can be reached by path without resolving any name a Container
 * controls: its handle under OWN_FD_DIR on Linux. Elsewhere (macOS, in development) the
 * path itself, with the inode check alone.
 */
const FD_PATHS = process.platform === 'linux';

/** Opens a directory without following a link, or says why not. */
async function openDirectory(target: string): Promise<FileHandle | 'link' | 'unreadable'> {
  try {
    return await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A link (ELOOP), or no longer a directory (ENOTDIR): swapped since lstat, so skipped.
    return code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT' ? 'link' : 'unreadable';
  }
}

/**
 * Walks one filesystem from its mount point. `hostPath` is the mount point on the Host, and
 * `realPath` where it is under the Host root. `onFolder` is called as each folder is walked.
 */
export async function walkFilesystem(
  realPath: string,
  hostPath: string,
  options: {
    onFolder?: () => void;
    signal?: AbortSignal;
    budget?: ScanBudget;
    /**
     * Skip /proc, /sys, /dev and /run directly under the start, as at a filesystem's root
     * (the default). Sizing one site's folder (Site Stats) walks all of it.
     */
    skipKernelFolders?: boolean;
  } = {},
): Promise<WalkResult> {
  const skipKernel = options.skipKernelFolders ?? true;
  const budget = options.budget ?? new ScanBudget();
  const heaviest = new Heaviest(CANDIDATES);
  const result = { walked: 0, unreadable: 0 };
  let sinceYield = 0;

  const root = await lstat(realPath);
  // A mount point that is itself a link would be walked wherever it points (#110).
  if (root.isSymbolicLink() || !root.isDirectory() || isPrivateFolder(hostPath)) {
    return { candidates: [], bytes: 0, ...result, partial: budget.partial };
  }

  const visit = async (
    real: string,
    host: string,
    seen: { dev: number; ino: number },
    depth: number,
  ): Promise<number> => {
    if (options.signal?.aborted) throw new Error('Scan stopped');
    result.walked += 1;
    options.onFolder?.();
    const handle = await openDirectory(real);
    if (handle === 'link') return 0;
    if (handle === 'unreadable') {
      result.unreadable += 1;
      return 0;
    }
    let total = 0;
    let biggestChild = 0;
    try {
      // The directory opened must be the one lstat saw, not something swapped in since.
      const opened = await handle.stat();
      if (opened.dev !== seen.dev || opened.ino !== seen.ino) return 0;
      const base = FD_PATHS ? `${OWN_FD_DIR}/${handle.fd}` : real;
      let dir;
      try {
        dir = await opendir(base);
      } catch {
        result.unreadable += 1;
        return 0;
      }
      for await (const entry of dir) {
        // Once the entries or the time are used up, every walk stops here.
        if (!budget.take()) break;
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await yieldToLoop();
        }
        if (skipKernel && depth === 0 && SKIP_AT_ROOT.has(entry.name)) continue;
        const childHost = host === '/' ? `/${entry.name}` : `${host}/${entry.name}`;
        if (isPrivateFolder(childHost)) continue;
        const childReal = path.join(base, entry.name);
        let info;
        try {
          info = await lstat(childReal);
        } catch {
          continue;
        }
        // Another filesystem is not this one's space: it is walked on its own if it is real.
        if (info.dev !== root.dev) continue;
        const blocks = info.blocks * 512;
        if (info.isDirectory()) {
          if (depth + 1 >= budget.limits.depth) {
            budget.partial = true;
            total += blocks;
            continue;
          }
          const size = blocks + (await visit(childReal, childHost, info, depth + 1));
          total += size;
          biggestChild = Math.max(biggestChild, size);
          continue;
        }
        if (info.nlink > 1 && !info.isSymbolicLink()) {
          const key = `${info.dev}:${info.ino}`;
          if (budget.seenLinks.has(key)) continue;
          // Past the cap a hard-linked file may be counted more than once (#109).
          if (budget.seenLinks.size < budget.limits.hardLinks) budget.seenLinks.add(key);
          else budget.partial = true;
        }
        total += blocks;
        biggestChild = Math.max(biggestChild, blocks);
      }
    } finally {
      await handle.close();
    }
    // A filesystem's root is the disk itself, which Disk space already shows.
    if (depth > 0 && total > 0 && biggestChild < total * DOMINANT_CHILD) {
      heaviest.add({ path: host, bytes: total });
    }
    return total;
  };

  // Stopping early already marked the budget partial (ScanBudget.take).
  const bytes = await visit(realPath, hostPath, root, 0);
  return { candidates: heaviest.items, bytes, ...result, partial: budget.partial };
}

export interface FolderScannerOptions {
  hostRoot: HostRoot;
  /** The real filesystems to walk, as Disk space lists them. */
  disks: () => Promise<DiskFilesystem[]>;
  /** Hours between scans; 0 scans only when asked. */
  intervalHours: number;
  /** How long after startup the first scan starts. */
  firstDelayMs?: number;
  now?: () => number;
  /** Overrides FOLDER_SCAN_LIMITS (tests). */
  limits?: Partial<ScanLimits>;
  log?: { warn: (object: object, message: string) => void };
}

/** What every stream is told when a scan fails (after "The last scan failed: "); the detail goes to the server log (#111). */
export const SCAN_FAILED = 'see the server log for why';

type Listener = (scan: FolderScan) => void;

/** Runs the scans: one at a time, on a schedule and when asked, and tells listeners. */
export class FolderScanner {
  readonly #options: FolderScannerOptions;
  readonly #now: () => number;
  readonly #listeners = new Set<Listener>();
  #scan: FolderScan = {
    state: 'waiting',
    folders: [],
    startedAt: null,
    finishedAt: null,
    walked: 0,
    unreadable: 0,
    partial: false,
    error: null,
    nextAt: null,
  };
  #timer: NodeJS.Timeout | null = null;
  #abort: AbortController | null = null;
  #running: Promise<void> | null = null;
  #lastSent = 0;

  constructor(options: FolderScannerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get snapshot(): FolderScan {
    return this.#scan;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    this.#schedule(this.#options.firstDelayMs ?? 30_000);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    await this.#running?.catch(() => undefined);
  }

  /** "Scan now": starts a scan unless one is running. */
  scanNow(): { result: 'started' | 'busy' } {
    if (this.#running) return { result: 'busy' };
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#running = this.#run().finally(() => {
      this.#running = null;
    });
    return { result: 'started' };
  }

  /** Waits for the scan running now, if any (for tests). */
  async settled(): Promise<void> {
    await this.#running;
  }

  #schedule(delayMs: number) {
    if (this.#options.intervalHours === 0) {
      this.#set({ nextAt: null });
      return;
    }
    this.#set({ nextAt: this.#now() + delayMs });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.scanNow();
    }, delayMs);
    this.#timer.unref();
  }

  #set(changes: Partial<FolderScan>, force = true) {
    this.#scan = { ...this.#scan, ...changes };
    const now = this.#now();
    // Progress is sent at most once a second; everything else at once.
    if (!force && now - this.#lastSent < 1000) return;
    this.#lastSent = now;
    for (const listener of this.#listeners) listener(this.#scan);
  }

  async #run(): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ state: 'scanning', startedAt: this.#now(), walked: 0, nextAt: null, error: null });
    try {
      const disks = await this.#options.disks();
      const candidates: (Candidate & { disk: DiskFilesystem })[] = [];
      const budget = new ScanBudget(this.#options.limits, this.#now);
      let walked = 0;
      let unreadable = 0;
      let progress = 0;
      for (const disk of disks) {
        if (isPrivateFolder(disk.mountPoint)) continue;
        let real: string;
        try {
          // Inside the Host root once every link is followed (#113), and itself no link (#110).
          real = await this.#options.hostRoot.resolve(disk.mountPoint);
          if ((await lstat(this.#options.hostRoot.path(disk.mountPoint))).isSymbolicLink()) {
            continue;
          }
        } catch (error) {
          // One mount point that has gone, or cannot be reached, skips only itself (#111).
          this.#options.log?.warn(
            { err: error, mountPoint: disk.mountPoint },
            'Folder scan skipped a filesystem',
          );
          continue;
        }
        const result = await walkFilesystem(real, disk.mountPoint, {
          signal: abort.signal,
          budget,
          onFolder: () => this.#set({ walked: ++progress }, false),
        });
        walked += result.walked;
        unreadable += result.unreadable;
        candidates.push(...result.candidates.map((c) => ({ ...c, disk })));
        if (budget.exhausted) break;
      }
      const byPath = new Map(candidates.map((c) => [c.path, c.disk]));
      const folders: FolderUsage[] = pickHeaviest(candidates).map(({ path: folder, bytes }) => {
        const disk = byPath.get(folder)!;
        return {
          path: folder,
          bytes,
          mountPoint: disk.mountPoint,
          diskBytes: disk.totalBytes,
          percentOfDisk: disk.totalBytes > 0 ? Math.min(100, (bytes / disk.totalBytes) * 100) : 0,
        };
      });
      this.#set({
        state: 'done',
        folders,
        walked,
        unreadable,
        partial: budget.partial,
        finishedAt: this.#now(),
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#options.log?.warn({ err: error }, 'Folder scan failed');
      this.#set({ state: 'failed', error: SCAN_FAILED, finishedAt: this.#now() });
    } finally {
      this.#abort = null;
    }
    if (!abort.signal.aborted) this.#schedule(this.#options.intervalHours * 3_600_000);
  }
}
