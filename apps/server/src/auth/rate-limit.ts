import { isIPv4, isIPv6 } from 'node:net';

/**
 * The key a client address is limited under (#82): an IPv4 address as is, an IPv4-mapped
 * IPv6 address as its IPv4 address, and any other IPv6 address as its /64, the smallest
 * block one subscriber is usually given. Anything else (no address at all) is its own key.
 */
export function limiterKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  const bare = address.replace(/%.*$/, '');
  if (!isIPv6(bare)) return address;
  return `${expandIPv6(bare).slice(0, 4).join(':')}::/64`;
}

/** The eight hextets of a valid IPv6 address, as lowercase hex without leading zeros. */
function expandIPv6(address: string): string[] {
  let text = address.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((part) => Number.parseInt(part, 16).toString(16));
}

export interface LimiterOptions {
  /**
   * Most keys held at once (#82). Past it the least recently failed key that is not limited
   * is forgotten; a limited key never is, and while every key held is limited a new address
   * is refused until the oldest expires (#120).
   */
  maxKeys?: number;
  /** Most password checks running at once, from every address together (#81). */
  maxConcurrent?: number;
}

/** A reserved password check: report how it went once it has finished. */
export interface LoginAttempt {
  finish(succeeded: boolean): void;
}

/**
 * Counts failed sign-ins per client address (see limiterKey) in a sliding window. A check
 * that is still running counts against its address as if it had failed, so parallel
 * guesses cannot outrun the limit (#81), and only so many checks run at once in all.
 */
export class LoginRateLimiter {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #maxConcurrent: number;
  /** Failure times per key, ordered by each key's latest failure (oldest first). */
  readonly #failures = new Map<string, number[]>();
  /** Checks running now, per key. */
  readonly #pending = new Map<string, number>();
  #running = 0;

  constructor(
    maxFailures = 5,
    windowMs = 15 * 60_000,
    now: () => number = Date.now,
    options: LimiterOptions = {},
  ) {
    this.#maxFailures = maxFailures;
    this.#windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#maxConcurrent = options.maxConcurrent ?? 4;
  }

  /** Seconds until the client may try again, or 0 if it may try now. */
  retryAfterSeconds(address: string): number {
    const key = limiterKey(address);
    const recent = this.#recent(key);
    if (recent.length >= this.#maxFailures) {
      const oldest = recent[recent.length - this.#maxFailures]!;
      return Math.max(1, Math.ceil((oldest + this.#windowMs - this.#now()) / 1000));
    }
    // Checks still running would use up what is left: ask again once they have finished.
    if (recent.length + (this.#pending.get(key) ?? 0) >= this.#maxFailures) return 1;
    return 0;
  }

  /**
   * Reserves a password check for this address, or says how many seconds to wait: because
   * the address is limited, or because enough checks are already running.
   */
  begin(address: string): LoginAttempt | { retryAfterSeconds: number } {
    const retryAfterSeconds = this.retryAfterSeconds(address);
    if (retryAfterSeconds > 0) return { retryAfterSeconds };
    if (this.#running >= this.#maxConcurrent) return { retryAfterSeconds: 1 };

    const key = limiterKey(address);
    // Full of limited addresses: a new one waits rather than push a limited one out (#120).
    if (!this.#failures.has(key) && !this.#pending.has(key) && !this.#hasRoom()) {
      return { retryAfterSeconds: this.#secondsUntilOldestExpires() };
    }
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    this.#running += 1;
    let finished = false;
    return {
      finish: (succeeded) => {
        if (finished) return;
        finished = true;
        this.#running -= 1;
        const left = (this.#pending.get(key) ?? 1) - 1;
        if (left > 0) this.#pending.set(key, left);
        else this.#pending.delete(key);
        if (succeeded) this.recordSuccess(address);
        else this.recordFailure(address);
      },
    };
  }

  recordFailure(address: string): void {
    const key = limiterKey(address);
    this.#dropExpired();
    // Never forget a limited key to make room (#120); a new key with no room is not kept.
    if (!this.#failures.has(key) && !this.#makeRoom()) return;
    const recent = this.#recent(key);
    recent.push(this.#now());
    // Re-inserting moves the key to the end, so the map stays ordered by latest failure.
    this.#failures.delete(key);
    this.#failures.set(key, recent);
  }

  recordSuccess(address: string): void {
    this.#failures.delete(limiterKey(address));
  }

  #recent(key: string): number[] {
    const cutoff = this.#now() - this.#windowMs;
    const recent = (this.#failures.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length === 0) this.#failures.delete(key);
    return recent;
  }

  /** Forgets keys whose latest failure is out of the window: O(1) per failure, off the front. */
  #dropExpired(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [key, times] of this.#failures) {
      if (times[times.length - 1]! > cutoff) break;
      this.#failures.delete(key);
    }
  }

  /** The least recently failed key that is not limited, if the map is at its cap. */
  #evictable(): string | undefined {
    for (const key of this.#failures.keys()) {
      if (!this.#limited(key)) return key;
    }
    return undefined;
  }

  /** Whether a new key may be held: below the cap, or one key that is not limited to forget. */
  #hasRoom(): boolean {
    this.#dropExpired();
    return this.#failures.size < this.#maxKeys || this.#evictable() !== undefined;
  }

  /**
   * Makes room for a new key: past the cap the least recently failed key that is not limited
   * is forgotten (#82). A limited key is never forgotten before its window ends (#120).
   */
  #makeRoom(): boolean {
    if (this.#failures.size < this.#maxKeys) return true;
    const key = this.#evictable();
    if (key === undefined) return false;
    this.#failures.delete(key);
    return true;
  }

  #limited(key: string): boolean {
    return this.#recent(key).length >= this.#maxFailures;
  }

  #secondsUntilOldestExpires(): number {
    const first = this.#failures.values().next().value;
    const latest = first?.[first.length - 1] ?? this.#now();
    return Math.max(1, Math.ceil((latest + this.#windowMs - this.#now()) / 1000));
  }
}
