import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePasswordHash } from './password.ts';

/** The file in LOOKOUT_DATA_DIR that holds a password changed from Settings. */
export const PASSWORD_FILE = 'password.json';

interface SavedPassword {
  /** The Argon2id hash of the password chosen in Settings. */
  hash: string;
  /** SHA-256 of the LOOKOUT_PASSWORD_HASH it replaced, so a new one in .env wins (recovery). */
  replaces: string;
}

const fingerprint = (hash: string) => createHash('sha256').update(hash).digest('hex');

interface Log {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
}

/**
 * The login password's hash: LOOKOUT_PASSWORD_HASH, or the one last chosen in Settings.
 *
 * A password changed in Settings is kept in `password.json` in LOOKOUT_DATA_DIR (a volume
 * only Lookout mounts), as an Argon2id hash only, written with mode 600. It is used only while
 * LOOKOUT_PASSWORD_HASH is still the hash it replaced: putting a new hash in .env (a forgotten
 * password) always wins, and the saved one is ignored from then on. With no data directory
 * the password can only be changed in .env, and Settings says so.
 */
export class PasswordStore {
  #hash: string;
  readonly #configHash: string;
  readonly #dataDir: string | null;

  private constructor(hash: string, configHash: string, dataDir: string | null) {
    this.#hash = hash;
    this.#configHash = configHash;
    this.#dataDir = dataDir;
  }

  static async open(configHash: string, dataDir: string | null, log?: Log): Promise<PasswordStore> {
    if (dataDir === null) return new PasswordStore(configHash, configHash, null);
    let saved: unknown;
    try {
      saved = JSON.parse(await readFile(join(dataDir, PASSWORD_FILE), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log?.warn({}, `Ignoring an unreadable ${PASSWORD_FILE}; using LOOKOUT_PASSWORD_HASH`);
      }
      return new PasswordStore(configHash, configHash, dataDir);
    }
    const { hash, replaces } = (saved ?? {}) as Partial<SavedPassword>;
    if (typeof hash !== 'string' || parsePasswordHash(hash) === null) {
      log?.warn({}, `Ignoring an invalid ${PASSWORD_FILE}; using LOOKOUT_PASSWORD_HASH`);
      return new PasswordStore(configHash, configHash, dataDir);
    }
    if (replaces !== fingerprint(configHash)) {
      log?.info(
        {},
        'LOOKOUT_PASSWORD_HASH has changed since the password was last changed in Settings, so it is used',
      );
      return new PasswordStore(configHash, configHash, dataDir);
    }
    return new PasswordStore(hash, configHash, dataDir);
  }

  /** The hash a login is checked against now. */
  get hash(): string {
    return this.#hash;
  }

  /** Whether Settings can change the password: only with a data directory to keep it in. */
  get changeable(): boolean {
    return this.#dataDir !== null;
  }

  /** Keeps `hash` as the password from now on, surviving restarts. */
  async change(hash: string): Promise<void> {
    if (this.#dataDir === null) throw new Error('No data directory to keep the password in');
    const saved: SavedPassword = { hash, replaces: fingerprint(this.#configHash) };
    const file = join(this.#dataDir, PASSWORD_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    // Written whole and then renamed, so a crash never leaves half a file.
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600 });
    await rename(temporary, file);
    this.#hash = hash;
  }
}
