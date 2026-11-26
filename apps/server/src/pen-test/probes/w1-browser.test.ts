/**
 * Pen-test probes for scope issue W1 (#64), the browser boundary: the Origin check and the
 * Host header (H6), security headers on every response, path tricks against the session hook
 * and the SPA fallback, and headers the server should only trust when it set them. The SPA's
 * rendering and the changelog (H13) are probed in apps/web/src/pen-test-w1.test.tsx. Verdicts
 * are in docs/pen-test/findings/W1.md.
 *
 * While a gap is open, an `it.fails` states the property that should hold, beside a
 * `today_…` test pinning what happens now. Once fixed, the `it.fails` became an `it` and the
 * `today_…` test a `(regression)` test.
 */
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDocker, makeContainer } from '../../../test-support/fake-docker.ts';
import { CONTENT_SECURITY_POLICY, isAllowedHost } from '../../app.ts';
import { HOST, ORIGIN, TEST_PASSWORD, startProbeApp, type ProbeApp } from './harness.ts';

/** A name a rebinding attacker controls, resolving first to them and then to Lookout. */
const EVIL_HOST = 'evil.example';
const EVIL_ORIGIN = `http://${EVIL_HOST}`;
/** Appears in the Container list, so a response that leaks the list is easy to spot. */
const MARKER = 'w1-probe-marker';

let probe: ProbeApp | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

async function start(): Promise<ProbeApp> {
  probe = await startProbeApp({
    docker: new FakeDocker([makeContainer({ id: 'abc123', name: MARKER })]),
  });
  return probe;
}

/** The security headers every response carries (v1 security review, item 6). */
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function securityHeadersOf(headers: IncomingHttpHeaders | LightMyRequestResponse['headers']) {
  return Object.fromEntries(Object.keys(SECURITY_HEADERS).map((name) => [name, headers[name]]));
}

/** Opens a stream over a real socket and returns its headers, then hangs up. */
async function streamHeaders(
  instance: ProbeApp,
  path: string,
  cookie: string,
): Promise<IncomingHttpHeaders> {
  if (!instance.app.server.listening) await instance.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = instance.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { cookie } }, (response) => {
      resolve(response.headers);
      response.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

describe('W1: H6, DNS rebinding and the Host header', () => {
  const rebound = { host: EVIL_HOST, origin: EVIL_ORIGIN };

  it("refuses to sign in on a Host that is not Lookout's own", async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: rebound,
      payload: { password: TEST_PASSWORD },
    });
    expect(response.statusCode).not.toBe(204);
  });

  it('refuses sign-in, the API and log out on a rebound Host, before any route (regression)', async () => {
    const instance = await start();
    const { app } = instance;
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: rebound,
      payload: { password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(421);
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(login.json()).toEqual({ error: 'Lookout does not answer to this host name' });

    // Even a real session cookie gets nothing on a rebound name.
    const cookie = await instance.signIn();
    const list = await app.inject({ url: '/api/containers', headers: { ...rebound, cookie } });
    expect(list.statusCode).toBe(421);
    expect(list.body).not.toContain(MARKER);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { ...rebound, cookie },
    });
    expect(logout.statusCode).toBe(421);
    // Pages and assets too: a rebound page cannot even load the SPA.
    expect((await app.inject({ url: '/login', headers: rebound })).statusCode).toBe(421);
  });

  it('refuses a Host with a port, a LAN-style name or user info the same way (regression)', async () => {
    const { app } = await start();
    for (const host of [
      'evil.example:7777',
      '192-168-1-10.rebind.example:7777',
      'lookout.test.evil.example',
      'evil.example@lookout.test',
    ]) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host, origin: `http://${host}` },
        payload: { password: TEST_PASSWORD },
      });
      expect(login.statusCode, host).toBe(421);
    }
  });

  it('answers on an IP address, localhost and a name in LOOKOUT_HOSTNAMES, with any port', async () => {
    const { app } = await start();
    for (const host of [
      '127.0.0.1:7777',
      '100.101.102.103',
      '[::1]:7777',
      'localhost:7777',
      'LOOKOUT.TEST:7777',
      'lookout.test.',
    ]) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host, origin: `http://${host}` },
        payload: { password: TEST_PASSWORD },
      });
      expect(login.statusCode, host).toBe(204);
    }
  });

  it('refuses a state-changing request with no Origin, a null one, or a foreign one', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    for (const origin of [undefined, 'null', EVIL_ORIGIN, 'http://lookout.test.evil.example']) {
      const response = await instance.app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { host: HOST, cookie, ...(origin ? { origin } : {}) },
      });
      expect(response.statusCode, String(origin)).toBe(403);
    }
  });

  it('does not trust X-Forwarded-Host to make a foreign Origin match', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    const response = await instance.app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { host: HOST, origin: EVIL_ORIGIN, 'x-forwarded-host': EVIL_HOST, cookie },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('W1: security headers on every response', () => {
  it('sends them on pages, assets, API answers, redirects and every refusal', async () => {
    const instance = await start();
    const { app } = instance;
    const cookie = await instance.signIn();
    const json = { 'content-type': 'application/json' };
    const answers: [string, Promise<LightMyRequestResponse>][] = [
      ['page', app.inject({ url: '/', headers: { cookie } })],
      ['login page', app.inject({ url: '/login' })],
      ['asset', app.inject({ url: '/assets/index-abc123.js' })],
      ['healthz', app.inject({ url: '/healthz' })],
      ['API answer', app.inject({ url: '/api/containers', headers: { cookie } })],
      ['302 to login', app.inject({ url: '/containers' })],
      ['400', app.inject({ url: '/api/containers/abc123/logs?tail=7', headers: { cookie } })],
      ['401', app.inject({ url: '/api/containers' })],
      ['403', app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })],
      ['404', app.inject({ url: '/api/containers/nope', headers: { cookie } })],
      [
        '413',
        app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { host: HOST, origin: ORIGIN, ...json },
          payload: JSON.stringify({ password: 'x'.repeat(20_000) }),
        }),
      ],
    ];
    for (const [what, answer] of answers) {
      const response = await answer;
      expect(securityHeadersOf(response.headers), `${what} (${response.statusCode})`).toEqual(
        SECURITY_HEADERS,
      );
    }

    // 429: five wrong passwords, then the limiter answers.
    let limited: LightMyRequestResponse | undefined;
    for (let i = 0; i < 6; i++) {
      limited = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host: HOST, origin: ORIGIN },
        payload: { password: 'wrong' },
      });
    }
    expect(limited!.statusCode).toBe(429);
    expect(securityHeadersOf(limited!.headers)).toEqual(SECURITY_HEADERS);
  });

  const STREAMS = ['/api/stream', '/api/containers/stats', '/api/containers/abc123/logs?tail=100'];

  it('sends them, and no-store, on every Server-Sent Events stream', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    for (const path of STREAMS) {
      const headers = await streamHeaders(instance, path, cookie);
      expect(securityHeadersOf(headers), path).toEqual(SECURITY_HEADERS);
      expect(headers['cache-control'], path).toContain('no-store');
    }
  });

  it('sends them on a stream even though the hijacked reply skips onSend (regression)', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    for (const path of STREAMS) {
      const headers = await streamHeaders(instance, path, cookie);
      expect(headers['content-type'], path).toBe('text/event-stream; charset=utf-8');
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(headers[name], `${path} ${name}`).toBe(value);
      }
      expect(headers['cache-control'], path).toBe('no-store, no-transform');
    }
  });
});

describe('W1: path tricks against the session hook and the SPA fallback', () => {
  const TRICKS = [
    '/apiX',
    '//api/containers',
    '/login/../api/containers',
    '/api%2Fcontainers',
    '/api/containers.',
    '/api/containers/',
    '/API/containers',
    '/%61pi/containers',
    '/api/containers%00',
    '/./api/containers',
    '/healthz/../api/containers',
    '/assets/../api/containers',
    '/api//containers',
    '/%2Fapi/containers',
    '/api/containers;x',
    '/api/containers%2F',
    '/login%2F..%2Fapi%2Fcontainers',
    '/api/containers/abc123/env/..%2F..%2F..%2Fapi%2Fcontainers',
  ];

  it('never answers a trick without a session with Container data', async () => {
    const { app } = await start();
    for (const url of TRICKS) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(401);
      expect(response.body, url).not.toContain(MARKER);
    }
  });

  it('serves the SPA only on its own pages: a trick is never a 200 page without a session', async () => {
    const { app } = await start();
    for (const url of ['/containers/..', '/websites/', '/settings.', '/%2e%2e/containers', '/x']) {
      const response = await app.inject({ url });
      expect([302, 401], url).toContain(response.statusCode);
    }
  });

  // Middleware that matches by path matches by segment: the router decodes "%61pi" to "api"
  // and serves /api/containers, but the no-store hook tests the raw URL's prefix.
  it('marks every API answer no-store, however its path is spelled', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    const response = await instance.app.inject({ url: '/%61pi/containers', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('serves /%61pi/containers and every other spelling as the API, with no-store (regression)', async () => {
    const instance = await start();
    const cookie = await instance.signIn();
    for (const url of [
      '/%61pi/containers',
      '/api/containers',
      '/%61%70%69/containers',
      '/api/%63ontainers',
    ]) {
      const response = await instance.app.inject({ url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain(MARKER);
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
    // Refusals and pages are no-store too; only the SPA's own files choose otherwise.
    expect((await instance.app.inject({ url: '/api/containers' })).headers['cache-control']).toBe(
      'no-store',
    );
    expect((await instance.app.inject({ url: '/healthz' })).headers['cache-control']).toBe(
      'no-store',
    );
  });
});

describe('W1: internal headers are trusted only when the server set them', () => {
  it('ignores X-Forwarded-For: the limiter keys on the socket, not the header', async () => {
    const { app } = await start();
    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { host: HOST, origin: ORIGIN, 'x-forwarded-for': `203.0.113.${i}` },
        payload: { password: 'wrong' },
      });
    }
    expect(last!.statusCode).toBe(429);
  });

  it('ignores X-Forwarded-Proto and X-Forwarded-Host when it answers', async () => {
    const { app } = await start();
    const response = await app.inject({
      url: '/containers',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': EVIL_HOST },
    });
    expect(response.statusCode).toBe(302);
    // A relative redirect: no header the client sent ends up in it.
    expect(response.headers.location).toBe('/login');
  });
});

describe('W1: the Host allowlist itself', () => {
  it('refuses a missing or empty Host, and takes names case-insensitively', () => {
    expect(isAllowedHost(undefined, [])).toBe(false);
    expect(isAllowedHost('', [])).toBe(false);
    expect(isAllowedHost('Lookout.Test:7777', ['lookout.test'])).toBe(true);
    expect(isAllowedHost('[2001:db8::1]:7777', [])).toBe(true);
    expect(isAllowedHost('localhost.evil.example', [])).toBe(false);
    expect(isAllowedHost('lookout.test:notaport', ['lookout.test'])).toBe(false);
  });
});
