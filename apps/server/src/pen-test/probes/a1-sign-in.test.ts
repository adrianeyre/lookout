/**
 * Pen-test scope A1 (#63): sign-in and sessions. In-process probes against the real app and
 * the fake Docker; see docs/pen-test/findings/A1.md for the verdicts. While a gap is open an
 * `it.fails` states the property that should hold, beside a `today_…` test pinning what
 * happens now (PRD "Checks every scope issue carries"). Once fixed, the `it.fails` became an
 * `it` and the `today_…` test a `(regression)` test.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDocker, makeContainer } from '../../../test-support/fake-docker.ts';
import { CONFIG_TEST_PASSWORD_HASH, TEST_PASSWORD_HASH } from '../../../test/helpers.ts';
import { hashPassword } from '../../auth/password.ts';
import { LoginRateLimiter, limiterKey } from '../../auth/rate-limit.ts';
import { SESSION_COOKIE, SessionStore } from '../../auth/session.ts';
import { bindAddressWarning, ConfigError, loadConfig } from '../../config.ts';
import {
  HOST,
  ORIGIN,
  TEST_PASSWORD,
  cookiePair,
  startProbeApp,
  type ProbeApp,
} from './harness.ts';

const SECRET = 'a-test-session-secret-that-is-long-enough';
const DAY = 24 * 60 * 60 * 1000;
const CHEAP = { memory: 8192, passes: 1, parallelism: 1 };

let apps: ProbeApp[] = [];
afterEach(async () => {
  await Promise.all(apps.map((probe) => probe.close()));
  apps = [];
});

async function start(...args: Parameters<typeof startProbeApp>): Promise<ProbeApp> {
  const probe = await startProbeApp(...args);
  apps.push(probe);
  return probe;
}

/**
 * Mints a session cookie offline from the secret alone, as session.ts signed one before #80
 * and #83: an attacker holding LOOKOUT_SESSION_SECRET can still do exactly this.
 */
function mint(secret: string, session: { sid: string; seen: number }): string {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${SESSION_COOKIE}=${payload}.${signature}`;
}

async function sessionStatus(probe: ProbeApp, cookie: string): Promise<number> {
  const response = await probe.app.inject({ url: '/api/session', headers: { cookie } });
  return response.statusCode;
}

function wrongLogin(probe: ProbeApp, extra: { remoteAddress?: string; headers?: object } = {}) {
  return probe.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: ORIGIN, host: HOST, ...extra.headers },
    payload: { password: 'not the password' },
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

const baseEnv = {
  // At the minimum cost loadConfig accepts (#124).
  LOOKOUT_PASSWORD_HASH: CONFIG_TEST_PASSWORD_HASH,
  LOOKOUT_SESSION_SECRET: SECRET,
};

describe('A1 H1 (session half): whoever holds the session secret mints sessions', () => {
  it('a cookie minted offline from the secret, with any sid, is refused (regression)', async () => {
    const probe = await start();
    const now = Date.now();
    for (const session of [
      { sid: 'minted-by-an-attacker', seen: now },
      { sid: 'minted-by-an-attacker', iat: now, seen: now },
    ]) {
      expect(
        await sessionStatus(probe, mint(SECRET, session as { sid: string; seen: number })),
      ).toBe(401);
    }
  });

  it('a session minted before a password change is refused after it', async () => {
    const minted = mint(SECRET, { sid: 'minted', seen: Date.now() });
    const before = await start();
    const issued = await before.signIn();
    // ADR-0008's remedy: change LOOKOUT_PASSWORD_HASH and recreate. The secret stays.
    const after = await start({
      config: { passwordHash: await hashPassword('a new password', CHEAP) },
    });
    expect(await sessionStatus(after, issued)).toBe(401);
    expect(await sessionStatus(after, minted)).toBe(401);
  });

  it('neither the issued nor the minted cookie outlives a password change (regression)', async () => {
    const minted = mint(SECRET, { sid: 'minted', seen: Date.now() });
    const before = await start();
    const issued = await before.signIn();
    expect(await sessionStatus(before, issued)).toBe(200);
    const after = await start({
      config: { passwordHash: await hashPassword('a new password', CHEAP) },
    });
    expect(await sessionStatus(after, issued)).toBe(401);
    expect(await sessionStatus(after, minted)).toBe(401);
  });

  it('a cookie signed with any other secret is refused', async () => {
    const probe = await start();
    const forged = mint('another-secret-that-is-also-32-bytes-long', {
      sid: 'x',
      seen: Date.now(),
    });
    expect(await sessionStatus(probe, forged)).toBe(401);
  });
});

describe('A1 H3: parallel sign-ins and the limiter', () => {
  it('at most 5 of 20 parallel wrong passwords are verified (the rest get 429)', async () => {
    const probe = await start();
    const answers = await Promise.all(Array.from({ length: 20 }, () => wrongLogin(probe)));
    const verified = answers.filter((r) => r.statusCode === 401).length;
    expect(verified).toBeLessThanOrEqual(5);
  });

  it('20 parallel wrong passwords: the rest get 429 with Retry-After (regression)', async () => {
    const probe = await start();
    const answers = await Promise.all(Array.from({ length: 20 }, () => wrongLogin(probe)));
    const statuses = answers.map((r) => r.statusCode);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    expect(statuses.filter((status) => status === 401).length).toBeGreaterThan(0);
    for (const limited of answers.filter((r) => r.statusCode === 429)) {
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    }
    // The 21st, sent once they have all finished, is still limited.
    const after = await Promise.all(Array.from({ length: 5 }, () => wrongLogin(probe)));
    expect(after.some((r) => r.statusCode === 429)).toBe(true);
  });

  it('caps password checks running at once, from every address together', () => {
    const limiter = new LoginRateLimiter(5, 15 * 60_000, () => 0, { maxConcurrent: 4 });
    const attempts = Array.from({ length: 4 }, (_, i) => limiter.begin(`192.0.2.${i + 1}`));
    expect(attempts.every((attempt) => 'finish' in attempt)).toBe(true);
    expect(limiter.begin('198.51.100.1')).toEqual({ retryAfterSeconds: 1 });
    (attempts[0] as { finish(ok: boolean): void }).finish(false);
    expect('finish' in limiter.begin('198.51.100.1')).toBe(true);
  });

  it('sequential wrong passwords are limited after 5, with Retry-After', async () => {
    const probe = await start();
    for (let i = 0; i < 5; i++) expect((await wrongLogin(probe)).statusCode).toBe(401);
    const limited = await wrongLogin(probe);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // The right password is refused too while limited.
    const right = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: TEST_PASSWORD },
    });
    expect(right.statusCode).toBe(429);
  });

  it('keys on the socket address: X-Forwarded-For is ignored (trustProxy: false)', async () => {
    const probe = await start();
    for (let i = 0; i < 5; i++) {
      await wrongLogin(probe, { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
    }
    const limited = await wrongLogin(probe, { headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect(limited.statusCode).toBe(429);
  });

  it('an IPv6 /64 shares one limiter key', () => {
    const limiter = new LoginRateLimiter(5, 15 * 60_000, () => 0);
    for (let i = 0; i < 5; i++) limiter.recordFailure(`2001:db8::${i + 1}`);
    expect(limiter.retryAfterSeconds('2001:db8::99')).toBeGreaterThan(0);
  });

  it('another address in the same IPv6 /64 is limited too (regression)', async () => {
    const probe = await start();
    for (let i = 0; i < 5; i++) {
      await wrongLogin(probe, { remoteAddress: '2001:db8::1' });
    }
    expect((await wrongLogin(probe, { remoteAddress: '2001:db8::1' })).statusCode).toBe(429);
    expect((await wrongLogin(probe, { remoteAddress: '2001:db8::2' })).statusCode).toBe(429);
    // Another /64, and an IPv4-mapped address, are their own keys.
    expect((await wrongLogin(probe, { remoteAddress: '2001:db8:0:1::1' })).statusCode).toBe(401);
    expect((await wrongLogin(probe, { remoteAddress: '::ffff:192.0.2.7' })).statusCode).toBe(401);
  });

  it('keys an IPv6 address by its /64 and an IPv4-mapped one by its IPv4 address', () => {
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('2001:DB8:0:0:ffff::2')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(limiterKey('::ffff:192.0.2.7')).toBe('192.0.2.7');
    expect(limiterKey('192.0.2.7')).toBe('192.0.2.7');
    expect(limiterKey('::1')).toBe('0:0:0:0::/64');
  });

  it('the limiter holds a bounded number of keys within one window', () => {
    let now = 0;
    const { limiter, keys } = observedLimiter(() => now);
    for (let i = 0; i < 10_500; i++) {
      now += 1;
      limiter.recordFailure(`2001:db8::${i.toString(16)}`);
    }
    expect(keys()).toBeLessThanOrEqual(10_000);
  });

  it('holds at most 10,000 keys from 10,500 different /64s in one window (regression)', () => {
    let now = 0;
    const { limiter, keys } = observedLimiter(() => now);
    for (let i = 0; i < 10_500; i++) {
      now += 1;
      limiter.recordFailure(`2001:db8:${i.toString(16)}::1`);
    }
    expect(keys()).toBe(10_000);
    // The most recent are kept; the least recently failed were forgotten first.
    for (let i = 0; i < 4; i++) limiter.recordFailure('2001:db8:2903::1');
    expect(limiter.retryAfterSeconds('2001:db8:2903::1')).toBeGreaterThan(0);
    // Past the window, the next failure forgets every expired key.
    now += 15 * 60_000 + 1;
    limiter.recordFailure('2001:db8:ffff::1');
    expect(keys()).toBe(1);
  });
});

/**
 * A limiter with its private failure map captured, so a probe can read how many keys it
 * holds: the map is the first one written to when a failure is recorded. Holds one key, for
 * 192.0.2.1, to start.
 */
function observedLimiter(now: () => number): { limiter: LoginRateLimiter; keys: () => number } {
  const limiter = new LoginRateLimiter(5, 15 * 60_000, now);
  const spy = vi.spyOn(Map.prototype, 'set');
  limiter.recordFailure('192.0.2.1');
  const map = spy.mock.contexts[0] as Map<unknown, unknown>;
  spy.mockRestore();
  return { limiter, keys: () => map.size };
}

describe('A1 H5: a session never really ends', () => {
  it('a logged-out cookie stays refused after a restart', async () => {
    const before = await start();
    const cookie = await before.signIn();
    const logout = await before.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: ORIGIN, host: HOST },
    });
    expect(logout.statusCode).toBe(204);
    expect(await sessionStatus(before, cookie)).toBe(401);
    const restarted = await start();
    expect(await sessionStatus(restarted, cookie)).toBe(401);
  });

  it('a restart signs everyone out, logged out or not (regression)', async () => {
    const before = await start();
    const loggedOut = await before.signIn();
    const signedIn = await before.signIn();
    await before.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie: loggedOut, origin: ORIGIN, host: HOST },
    });
    expect(await sessionStatus(before, loggedOut)).toBe(401);
    expect(await sessionStatus(before, signedIn)).toBe(200);
    const restarted = await start();
    expect(await sessionStatus(restarted, loggedOut)).toBe(401);
    expect(await sessionStatus(restarted, signedIn)).toBe(401);
  });

  it('a session in use still ends after 30 days', async () => {
    expect(await sessionAliveAfter(31 * DAY)).toBe(false);
  });

  it('a session in use is kept alive within 30 days, then ends (regression)', async () => {
    expect(await sessionAliveAfter(29 * DAY)).toBe(true);
    expect(await sessionAliveAfter(31 * DAY)).toBe(false);
  });

  it('never sets a cookie to outlive the session it carries', async () => {
    let now = Date.parse('2026-11-25T09:00:00Z');
    const probe = await start({ now: () => now });
    let cookie = await probe.signIn();
    let setCookie = '';
    // Used every 6 days, then 29 days in: one day of the 30 is left, under the idle period.
    for (const step of [6, 6, 6, 6, 5]) {
      now += step * DAY;
      const response = await probe.app.inject({ url: '/api/session', headers: { cookie } });
      expect(response.statusCode).toBe(200);
      cookie = cookiePair(response);
      setCookie = String(response.headers['set-cookie']);
    }
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(DAY / 1000);
  });

  it('an idle session ends after the idle period', async () => {
    let now = Date.parse('2026-11-25T09:00:00Z');
    const probe = await start({ now: () => now });
    const cookie = await probe.signIn();
    now += 7 * DAY + 1;
    expect(await sessionStatus(probe, cookie)).toBe(401);
  });

  it('a repeated-character 32-byte session secret is refused at start', () => {
    expect(() => loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: 'a'.repeat(32) })).toThrow(
      ConfigError,
    );
  });

  it('a 32-byte one-character, repeated-pattern or placeholder secret is refused, unechoed (regression)', () => {
    for (const secret of [
      'a'.repeat(32),
      '0123456789abcdef'.repeat(2),
      'abcd'.repeat(10),
      'change-me-change-me-change-me-please-0123',
      'your-secret-here-0123456789-abcdefghij',
    ]) {
      expect(() => loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: secret }), secret).toThrow(
        /LOOKOUT_SESSION_SECRET/,
      );
      try {
        loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: secret });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
    // What `openssl rand -base64 32` makes is accepted.
    const random = randomBytes(32).toString('base64');
    expect(loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: random }).sessionSecret).toBe(random);
  });

  it('a secret under 32 bytes, or none, is refused', () => {
    expect(() => loadConfig({ ...baseEnv, LOOKOUT_SESSION_SECRET: 'a'.repeat(31) })).toThrow(
      /at least 32 bytes/,
    );
    expect(() => loadConfig({ LOOKOUT_PASSWORD_HASH: TEST_PASSWORD_HASH })).toThrow(
      /LOOKOUT_SESSION_SECRET is required/,
    );
    expect(() => loadConfig({ LOOKOUT_SESSION_SECRET: SECRET })).toThrow(
      /LOOKOUT_PASSWORD_HASH is required/,
    );
  });
});

/** Uses a session every 6 days (under the 7-day idle period) until `span` has passed. */
async function sessionAliveAfter(span: number): Promise<boolean> {
  let now = Date.parse('2026-11-25T09:00:00Z');
  const end = now + span;
  const probe = await start({ now: () => now });
  let cookie = await probe.signIn();
  while (now < end) {
    now += 6 * DAY;
    const response = await probe.app.inject({ url: '/api/session', headers: { cookie } });
    if (response.statusCode !== 200) return false;
    if (response.headers['set-cookie']) cookie = cookiePair(response);
  }
  return true;
}

describe('A1 H7: Secure behind an HTTPS reverse proxy', () => {
  it('a sign-in forwarded from HTTPS gets a Secure cookie', async () => {
    const probe = await start();
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: 'https://lookout.test', host: HOST, 'x-forwarded-proto': 'https' },
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/;\s*Secure/);
  });

  it('the cookie carries Secure only when the sign-in came over HTTPS (regression)', async () => {
    const probe = await start();
    for (const [proto, secure] of [
      ['https', true],
      ['HTTPS, http', true],
      ['http', false],
      [undefined, false],
    ] as const) {
      const response = await probe.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: {
          origin: `${secure ? 'https' : 'http'}://lookout.test`,
          host: HOST,
          ...(proto ? { 'x-forwarded-proto': proto } : {}),
        },
        payload: { password: TEST_PASSWORD },
      });
      expect(response.statusCode, String(proto)).toBe(204);
      expect(/;\s*Secure/.test(String(response.headers['set-cookie'])), String(proto)).toBe(secure);
      // Refreshes and log out carry it too.
      const cookie = cookiePair(response);
      const logout = await probe.app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: {
          cookie,
          origin: `${secure ? 'https' : 'http'}://lookout.test`,
          host: HOST,
          ...(proto ? { 'x-forwarded-proto': proto } : {}),
        },
      });
      expect(/;\s*Secure/.test(String(logout.headers['set-cookie'])), String(proto)).toBe(secure);
    }
  });
});

describe('A1 H7: the explicit setting', () => {
  it('LOOKOUT_SECURE_COOKIE=true makes the cookie Secure with no X-Forwarded-Proto at all', async () => {
    const probe = await start({ config: { secureCookie: true } });
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toMatch(/;\s*Secure/);
  });
});

describe('A1 confirm: sound controls', () => {
  it('the cookie is HttpOnly, SameSite=Strict and Path=/', async () => {
    const probe = await start();
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: TEST_PASSWORD },
    });
    const attributes = String(response.headers['set-cookie']).split(/;\s*/);
    expect(attributes).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'SameSite=Strict']));
  });

  it('refuses a sign-in body over 16 KiB with 413, before verifying', async () => {
    const probe = await start();
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST, 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'x'.repeat(17 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
  });

  it('refuses a password over 1,024 characters with 400', async () => {
    const probe = await start();
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: 'x'.repeat(1025) },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses signatures of the wrong length, empty or malformed cookies without throwing', () => {
    const store = new SessionStore(SECRET, 7 * DAY);
    const valid = store.create().cookie;
    const [payload] = valid.split('.');
    for (const value of [
      `${payload}.`,
      `${payload}.AAAA`,
      `${payload}.${'A'.repeat(200)}`,
      '.sig',
      'no-dot',
      '',
      `${Buffer.from('not json').toString('base64url')}.x`,
    ]) {
      expect(store.verify(value)).toBeNull();
    }
    expect(store.verify(valid)).not.toBeNull();
  });

  it('a refused session gives nothing away: 401 is identical for a real and an unknown Container', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc123', name: 'real' })]);
    const probe = await start({ docker });
    const answers = await Promise.all(
      ['/api/containers/real', '/api/containers/abc123', '/api/containers/nope'].map((url) =>
        probe.app.inject({ url }),
      ),
    );
    for (const response of answers) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(answers[0]!.body);
      expect(response.headers['content-length']).toBe(answers[0]!.headers['content-length']);
    }
  });

  it('a wrong password gives nothing away beyond "incorrect"', async () => {
    const probe = await start();
    const response = await wrongLogin(probe);
    expect(response.json()).toEqual({ error: 'Incorrect password' });
  });
});

describe('A1 checks: configuration fails closed', () => {
  it('refuses to start without a password hash or a session secret', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('warns or refuses at start when bound to every interface', () => {
    // main.ts logs this warning at start (#122); I1's probes read it from the startup log.
    expect(bindAddressWarning('0.0.0.0')).toMatch(/LOOKOUT_BIND_ADDRESS/);
  });

  it('0.0.0.0 and :: are accepted as config, and warned about at start (regression)', () => {
    expect(loadConfig({ ...baseEnv, LOOKOUT_BIND_ADDRESS: '0.0.0.0' }).bindAddress).toBe('0.0.0.0');
    expect(loadConfig({ ...baseEnv, LOOKOUT_BIND_ADDRESS: '::' }).bindAddress).toBe('::');
    expect(bindAddressWarning('::')).toMatch(/every interface/);
    expect(bindAddressWarning('127.0.0.1')).toBeNull();
  });

  it('defaults the bind address to 127.0.0.1', () => {
    expect(loadConfig(baseEnv).bindAddress).toBe('127.0.0.1');
  });
});

describe('A1 checks: internal headers are trusted only when the server set them', () => {
  it('X-Forwarded-Host and X-Forwarded-Proto do not change the Origin check', async () => {
    const probe = await start();
    const response = await probe.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: {
        origin: 'http://evil.example',
        host: HOST,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });
});
