import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'lookout_session';

/** How stale `seen` may get before a request refreshes the cookie. */
const REFRESH_AFTER_MS = 60_000;

export interface Session {
  sid: string;
  /** When the session was created by signing in, ms since the epoch. */
  iat: number;
  /** When the session was last used, ms since the epoch. */
  seen: number;
}

export interface SessionOptions {
  /**
   * LOOKOUT_PASSWORD_HASH. It is part of the signing key, so changing the password ends
   * every session, issued or minted (#80).
   */
  passwordHash?: string;
  /** The longest a session lasts from sign-in, however often it is used (#84). */
  maxLifetimeMs?: number;
}

/** Thirty days: the default absolute session lifetime (LOOKOUT_SESSION_MAX_DAYS). */
export const DEFAULT_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stateless sessions: the cookie holds the session ID, when it was issued and when it was
 * last used, signed with HMAC-SHA256.
 *
 * The signing key is derived from LOOKOUT_SESSION_SECRET, LOOKOUT_PASSWORD_HASH and 32 random
 * bytes chosen when Lookout starts. So:
 * - restarting Lookout signs everyone out, and a logged-out cookie never comes back (#83);
 * - changing the password ends every session (#80);
 * - nobody can mint a cookie offline, even with the secret and the hash, because the random
 *   part never leaves this process (H1).
 * Logout adds the session ID to an in-memory revocation list that lasts as long as the
 * session could. A session ends after its idle period, and after its maximum lifetime
 * however often it is used (#84).
 */
export class SessionStore {
  readonly #key: Buffer;
  readonly #idleMs: number;
  readonly #maxLifetimeMs: number;
  readonly #now: () => number;
  readonly #revoked = new Map<string, number>();

  constructor(
    secret: string,
    idleMs: number,
    now: () => number = Date.now,
    options: SessionOptions = {},
  ) {
    this.#key = createHmac('sha256', secret)
      .update('lookout-session-key\0')
      .update(randomBytes(32))
      .update('\0')
      .update(options.passwordHash ?? '')
      .digest();
    this.#idleMs = idleMs;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_SESSION_MAX_MS;
    this.#now = now;
  }

  get idleMs(): number {
    return this.#idleMs;
  }

  create(): { session: Session; cookie: string } {
    const now = this.#now();
    const session = { sid: randomBytes(18).toString('base64url'), iat: now, seen: now };
    return { session, cookie: this.#encode(session) };
  }

  /**
   * Returns the session if the cookie value is authentic, not revoked, not idle-expired and
   * within its maximum lifetime.
   */
  verify(value: string | undefined): Session | null {
    if (!value) return null;
    const dot = value.indexOf('.');
    if (dot <= 0) return null;
    const payload = value.slice(0, dot);
    const signature = Buffer.from(value.slice(dot + 1), 'base64url');
    const expected = this.#sign(payload);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;

    let session: Session;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as Session).sid !== 'string' ||
        typeof (parsed as Session).iat !== 'number' ||
        typeof (parsed as Session).seen !== 'number'
      ) {
        return null;
      }
      const { sid, iat, seen } = parsed as Session;
      session = { sid, iat, seen };
    } catch {
      return null;
    }

    const now = this.#now();
    if (now - session.seen > this.#idleMs) return null;
    if (now - session.iat > this.#maxLifetimeMs) return null;
    if (this.#revoked.has(session.sid)) return null;
    return session;
  }

  /** A refreshed cookie value when the session's last-seen time is getting stale. */
  refresh(session: Session): string | null {
    const now = this.#now();
    if (now - session.seen < REFRESH_AFTER_MS) return null;
    return this.#encode({ sid: session.sid, iat: session.iat, seen: now });
  }

  /** Seconds the cookie should live: the idle period, or less near the maximum lifetime. */
  maxAgeSeconds(session: Pick<Session, 'iat'>): number {
    const remaining = session.iat + this.#maxLifetimeMs - this.#now();
    return Math.max(0, Math.floor(Math.min(this.#idleMs, remaining) / 1000));
  }

  revoke(session: Session): void {
    const now = this.#now();
    for (const [sid, until] of this.#revoked) if (until <= now) this.#revoked.delete(sid);
    // A session cannot outlive its idle period or its lifetime, so neither can its revocation.
    this.#revoked.set(
      session.sid,
      Math.min(now + this.#idleMs, session.iat + this.#maxLifetimeMs) + 1,
    );
  }

  #encode(session: Session): string {
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    return `${payload}.${this.#sign(payload).toString('base64url')}`;
  }

  #sign(payload: string): Buffer {
    return createHmac('sha256', this.#key).update(payload).digest();
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

export function sessionCookieHeader(
  value: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(secure: boolean): string {
  return sessionCookieHeader('', { secure, maxAgeSeconds: 0 });
}
