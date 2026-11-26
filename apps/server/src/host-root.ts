import { readFile, readdir, realpath, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

/**
 * The only way to read the Host's filesystem. Every Host Metric must be read through here,
 * so that paths resolve under LOOKOUT_HOST_ROOT and never hit the Container's own /proc
 * (ADR-0003). Reading /proc directly works for some files and silently lies for others.
 *
 * Containment is checked twice: by path text (`path`), and, before anything is read, by
 * where the path really leads once every link in it is followed (`resolve`, #113, H14). An
 * absolute link on the Host resolves inside Lookout's own Container, not the Host, and a
 * relative one can climb out of the Host root, so anything that leads outside is refused.
 */
export class HostRoot {
  readonly root: string;
  #realRoot: Promise<string> | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolves a Host path such as "proc/meminfo" or "/mnt/data" under the Host root. */
  path(hostPath: string): string {
    const resolved = path.resolve(this.root, `.${path.posix.sep}${hostPath.replace(/^\/+/, '')}`);
    if (!within(resolved, this.root)) {
      throw new Error(`Host path escapes the Host root: ${hostPath}`);
    }
    return resolved;
  }

  /**
   * The real path of a Host path, with every link followed, refused if it leads out of the
   * Host root. Throws (as a missing file does) rather than returning anything outside.
   */
  async resolve(hostPath: string): Promise<string> {
    const [real, realRoot] = await Promise.all([realpath(this.path(hostPath)), this.#root()]);
    if (!within(real, realRoot)) {
      throw new Error('Host path leads out of the Host root through a link');
    }
    return real;
  }

  readText(hostPath: string): Promise<string> {
    return this.resolve(hostPath).then((real) => readFile(real, 'utf8'));
  }

  async readTextOrNull(hostPath: string): Promise<string | null> {
    try {
      return await this.readText(hostPath);
    } catch {
      return null;
    }
  }

  /** The names in a Host directory, or null if it cannot be read. */
  async readDirOrNull(hostPath: string): Promise<string[] | null> {
    try {
      return await readdir(await this.resolve(hostPath));
    } catch {
      return null;
    }
  }

  async statfs(hostPath: string) {
    return statfs(await this.resolve(hostPath), { bigint: true });
  }

  async stat(hostPath: string) {
    return stat(await this.resolve(hostPath), { bigint: true });
  }

  #root(): Promise<string> {
    this.#realRoot ??= realpath(this.root).catch((error: unknown) => {
      // Not cached: the Host root may be mounted later.
      this.#realRoot = null;
      throw error;
    });
    return this.#realRoot;
  }
}

/**
 * Lookout's own open file handles, by number: not the Host's /proc, which is only ever read
 * through HostRoot. The folder walk reaches each child through its parent's handle here, so
 * no name a Container controls is resolved twice (#110).
 */
// eslint-disable-next-line no-restricted-syntax -- Lookout's own handles, not the Host's /proc
export const OWN_FD_DIR = '/proc/self/fd';

/** True if `child` is `parent` or inside it. */
function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}
