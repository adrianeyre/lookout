import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from './origin.ts';
import { hashPassword, parsePasswordHash, verifyPassword } from './password.ts';
import { LoginRateLimiter } from './rate-limit.ts';
import { SessionStore, parseCookies, sessionCookieHeader } from './session.ts';

describe('password', () => {
  it('hashes to Argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('s3cret-password', { memory: 8192, passes: 1, parallelism: 1 });
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=8192,t=1,p=1\$/);
    expect(parsePasswordHash(hash)).not.toBeNull();
    expect(await verifyPassword('s3cret-password', hash)).toBe(true);
    expect(await verifyPassword('s3cret-passworD', hash)).toBe(false);
  });

  it('uses the OWASP baseline parameters by default', async () => {
    expect(await hashPassword('x')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('rejects hashes that are not Argon2id', () => {
    expect(
      parsePasswordHash('$argon2i$v=19$m=8192,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA'),
    ).toBeNull();
    expect(parsePasswordHash('$2b$12$abcdefghijklmnopqrstuv')).toBeNull();
    expect(parsePasswordHash('')).toBeNull();
  });
});

describe('SessionStore', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const make = (clock: { now: number }) =>
    new SessionStore('s'.repeat(32), 7 * DAY, () => clock.now);

  it('accepts its own cookies and rejects tampered ones', () => {
    const clock = { now: 1_000_000 };
    const store = make(clock);
    const { cookie, session } = store.create();
    expect(store.verify(cookie)).toEqual(session);

    const [payload, signature] = cookie.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ sid: session.sid, seen: clock.now + DAY }),
    ).toString('base64url');
    expect(store.verify(`${forged}.${signature}`)).toBeNull();
    expect(store.verify(`${payload}.${signature.slice(1)}`)).toBeNull();
    expect(store.verify(undefined)).toBeNull();
    expect(store.verify('garbage')).toBeNull();
  });

  it('rejects cookies signed with another secret', () => {
    const clock = { now: 0 };
    const { cookie } = new SessionStore('a'.repeat(32), DAY, () => clock.now).create();
    expect(new SessionStore('b'.repeat(32), DAY, () => clock.now).verify(cookie)).toBeNull();
  });

  it('expires sessions after the idle period, and refreshing extends them', () => {
    const clock = { now: 0 };
    const store = make(clock);
    const { cookie, session } = store.create();

    clock.now = 6 * DAY;
    const refreshed = store.refresh(session);
    expect(refreshed).not.toBeNull();

    clock.now = 8 * DAY;
    expect(store.verify(cookie)).toBeNull();
    expect(store.verify(refreshed!)).not.toBeNull();
  });

  it('does not refresh a freshly seen session', () => {
    const clock = { now: 0 };
    const store = make(clock);
    const { session } = store.create();
    clock.now = 30_000;
    expect(store.refresh(session)).toBeNull();
  });

  it('refuses a revoked session', () => {
    const clock = { now: 0 };
    const store = make(clock);
    const { cookie, session } = store.create();
    store.revoke(session);
    expect(store.verify(cookie)).toBeNull();
  });
});

describe('session cookie', () => {
  it('is HttpOnly and SameSite=Strict, and Secure only over HTTPS', () => {
    const plain = sessionCookieHeader('v', { secure: false, maxAgeSeconds: 60 });
    expect(plain).toBe('lookout_session=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=60');
    expect(sessionCookieHeader('v', { secure: true, maxAgeSeconds: 60 })).toMatch(/; Secure$/);
  });

  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; lookout_session=abc.def; b=2').get('lookout_session')).toBe(
      'abc.def',
    );
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after 5 failures in 15 minutes, per IP, until the window passes', () => {
    const clock = { now: 0 };
    const limiter = new LoginRateLimiter(5, 15 * 60_000, () => clock.now);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.retryAfterSeconds('10.0.0.1')).toBe(0);
      limiter.recordFailure('10.0.0.1');
      clock.now += 1000;
    }
    expect(limiter.retryAfterSeconds('10.0.0.1')).toBeGreaterThan(0);
    expect(limiter.retryAfterSeconds('10.0.0.2')).toBe(0);

    clock.now = 15 * 60_000 + 1;
    expect(limiter.retryAfterSeconds('10.0.0.1')).toBe(0);
  });

  it('clears an IP on a successful login', () => {
    const limiter = new LoginRateLimiter(5);
    for (let i = 0; i < 4; i += 1) limiter.recordFailure('ip');
    limiter.recordSuccess('ip');
    limiter.recordFailure('ip');
    expect(limiter.retryAfterSeconds('ip')).toBe(0);
  });
});

describe('isAllowedOrigin', () => {
  it('allows safe methods without an Origin', () => {
    expect(isAllowedOrigin('GET', undefined, 'lookout.lan:7777')).toBe(true);
  });

  it('allows a state-changing request from the same host', () => {
    expect(isAllowedOrigin('POST', 'http://lookout.lan:7777', 'lookout.lan:7777')).toBe(true);
    expect(isAllowedOrigin('POST', 'https://lookout.lan', 'lookout.lan')).toBe(true);
  });

  it('refuses foreign, missing and opaque origins', () => {
    expect(isAllowedOrigin('POST', 'https://evil.example', 'lookout.lan:7777')).toBe(false);
    expect(isAllowedOrigin('POST', 'http://lookout.lan:7778', 'lookout.lan:7777')).toBe(false);
    expect(isAllowedOrigin('POST', undefined, 'lookout.lan:7777')).toBe(false);
    expect(isAllowedOrigin('DELETE', 'null', 'lookout.lan:7777')).toBe(false);
  });
});
