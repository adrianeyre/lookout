import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
}

export interface ParsedHash extends Argon2Params {
  salt: Buffer;
  hash: Buffer;
}

/** OWASP's recommended Argon2id baseline (19 MiB, 2 passes, 1 lane). */
export const DEFAULT_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(password: string, salt: Buffer, params: Argon2Params, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: length,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

/** Parses a PHC-format Argon2id hash, or returns null if it is not one. */
export function parsePasswordHash(encoded: string): ParsedHash | null {
  const match = PHC.exec(encoded);
  if (!match) return null;
  const [memory, passes, parallelism] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const salt = Buffer.from(match[4]!, 'base64');
  const hash = Buffer.from(match[5]!, 'base64');
  if (
    salt.length < 8 ||
    hash.length < 16 ||
    parallelism < 1 ||
    passes < 1 ||
    memory < 8 * parallelism
  ) {
    return null;
  }
  return { memory, passes, parallelism, salt, hash };
}

/** Hashes a password into the PHC string format used by LOOKOUT_PASSWORD_HASH. */
export async function hashPassword(password: string, params = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, params, 32);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed, parsed.hash.length);
  return timingSafeEqual(candidate, parsed.hash);
}
