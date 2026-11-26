import { constants, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { HostRoot } from '../host-root.ts';
import { MAX_LINE_BYTES, type AccessEntry, type AccessLogFormat } from './access-log.ts';
import type { LogOffset, StatsStore } from './store.ts';

/** How much of a file one pass reads before yielding and writing its progress. */
export const READ_CHUNK_BYTES = 1024 * 1024;
/** The most bytes one tick reads in all, so a big backlog is worked through a bit at a time. */
export const TICK_BYTES = 16 * 1024 * 1024;

export type FollowerStatus = 'starting' | 'no-logs' | 'ok';

export interface FollowerLogger {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

export interface FollowerOptions {
  /** LOOKOUT_ACCESS_LOGS: a path under the Host root, `*` and `?` allowed in the file name. */
  pattern: string;
  hostRoot: HostRoot;
  store: StatsStore;
  format: AccessLogFormat;
  /** Called with each request read. */
  onEntry: (entry: AccessEntry) => void;
  /** Called, in the same transaction as the offsets, after each chunk: write the totals. */
  onFlush: () => void;
  log: FollowerLogger;
  now?: () => number;
  pollMs?: number;
}

/** A file name pattern with `*` and `?` as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

interface FileState {
  /** Inside a line too long to read: skip to its end. */
  skipping: boolean;
}

/**
 * Follows the reverse proxy's access logs (ADR-0014). Every file matching LOOKOUT_ACCESS_LOGS is
 * read from where it was left, which is kept by file identity (device and inode) in the stats
 * store, in the same transaction as the totals the lines made: a restart carries on where it
 * stopped and counts nothing twice. Rotation is a rename, so a rotated file keeps its identity
 * and is finished; the new file starts at 0. A file that shrank was truncated and starts again.
 *
 * Files are opened without following links, through the Host root, read-only.
 */
export class AccessLogFollower {
  readonly #options: Required<Omit<FollowerOptions, 'now' | 'pollMs'>> & {
    now: () => number;
    pollMs: number;
  };
  readonly #dir: string;
  readonly #match: RegExp;
  readonly #files = new Map<string, FileState>();
  #offsets: Map<string, LogOffset> | null = null;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #tick: Promise<void> | null = null;
  status: FollowerStatus = 'starting';
  /** Lines that were not a request this format understands. */
  malformed = 0;
  /** Requests read in all, since start. */
  read = 0;
  #warned = false;

  constructor(options: FollowerOptions) {
    this.#options = { now: Date.now, pollMs: 2000, ...options };
    const root = options.hostRoot.root;
    const relative = options.pattern.slice(root.length);
    this.#dir = path.posix.dirname(relative);
    this.#match = globToRegExp(path.posix.basename(relative));
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#options.log.info({ pattern: this.#options.pattern }, 'Following access logs');
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    clearTimeout(this.#timer);
    await this.#tick;
  }

  /** Reads everything new now; for tests and before a page reads the totals. */
  async poll(): Promise<void> {
    if (this.#tick) return this.#tick;
    this.#tick = this.#readAll().finally(() => {
      this.#tick = null;
    });
    return this.#tick;
  }

  #schedule(delayMs: number) {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.poll()
        .catch((error: unknown) =>
          this.#options.log.warn({ err: error }, 'Reading access logs failed'),
        )
        .finally(() => this.#schedule(this.#options.pollMs));
    }, delayMs);
  }

  async #readAll(): Promise<void> {
    const { hostRoot, store } = this.#options;
    this.#offsets ??= store.offsets();
    let dir: string;
    let names: string[];
    try {
      dir = await hostRoot.resolve(this.#dir);
      names = (await readdir(dir)).filter((name) => this.#match.test(name)).sort();
    } catch {
      this.#setStatus('no-logs');
      return;
    }
    let budget = TICK_BYTES;
    const seen = new Set<string>();
    let readable = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      let handle;
      try {
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch {
        continue;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) continue;
        readable += 1;
        const key = `${info.dev}:${info.ino}`;
        seen.add(key);
        const saved = this.#offsets.get(key);
        let offset = saved?.offset ?? 0;
        if (offset > info.size) offset = 0;
        const state = this.#files.get(key) ?? { skipping: false };
        this.#files.set(key, state);
        while (offset < info.size && budget > 0) {
          const length = Math.min(READ_CHUNK_BYTES, info.size - offset, budget);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead === 0) break;
          const consumed = this.#lines(
            buffer.subarray(0, bytesRead),
            state,
            bytesRead === READ_CHUNK_BYTES,
          );
          if (consumed === 0) break;
          offset += consumed;
          budget -= consumed;
          const record = { fileKey: key, path: path.posix.join(this.#dir, name), offset };
          this.#offsets.set(key, record);
          store.transaction(() => {
            this.#options.onFlush();
            store.putOffset(record, this.#options.now());
          });
          await yieldToLoop();
        }
      } finally {
        await handle.close();
      }
    }
    // Files gone (rotated away and deleted) no longer need their place kept.
    for (const key of [...this.#offsets.keys()]) {
      if (!seen.has(key)) {
        this.#offsets.delete(key);
        this.#files.delete(key);
        store.deleteOffset(key);
      }
    }
    this.#setStatus(readable > 0 ? 'ok' : 'no-logs');
  }

  /**
   * Handles the whole lines in `chunk` and returns how many bytes they took. A partial last line
   * waits for the next read, unless the chunk is full and has no line end at all: then the line
   * is longer than MAX_LINE_BYTES allows, and it is skipped to its end.
   */
  #lines(chunk: Buffer, state: FileState, full: boolean): number {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0x0a, start);
      if (end === -1) break;
      if (state.skipping) {
        state.skipping = false;
      } else if (end - start > MAX_LINE_BYTES) {
        this.malformed += 1;
      } else {
        const line = chunk.toString('utf8', start, end).trim();
        if (line !== '') this.#line(line);
      }
      start = end + 1;
    }
    if (start === 0 && full) {
      // No line end in a whole chunk: one line too long to read.
      if (!state.skipping) this.malformed += 1;
      state.skipping = true;
      return chunk.length;
    }
    return start;
  }

  #line(line: string): void {
    const parsed = this.#options.format.parse(line);
    if ('malformed' in parsed) {
      this.malformed += 1;
      return;
    }
    if ('skip' in parsed) return;
    this.read += 1;
    this.#options.onEntry(parsed.entry);
  }

  #setStatus(status: FollowerStatus) {
    if (status === 'no-logs' && !this.#warned) {
      this.#warned = true;
      this.#options.log.warn(
        { pattern: this.#options.pattern },
        'No access log matches LOOKOUT_ACCESS_LOGS, or none can be read',
      );
    }
    if (status === 'ok') this.#warned = false;
    this.status = status;
  }
}
