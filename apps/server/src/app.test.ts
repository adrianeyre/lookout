import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createServer } from 'node:http';
import type {
  ContainersSnapshot,
  FolderScan,
  HostedSite,
  SiteCheck,
  SitesSnapshot,
} from '@lookout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeDocker, makeContainer } from '../test-support/fake-docker.ts';
import {
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  fixture,
  makeHostRoot,
  testConfig,
} from '../test/helpers.ts';
import { buildApp, dockerErrorMessage, type AppOptions } from './app.ts';
import { EngineError } from './docker/engine.ts';
import type { SiteChecker } from './sites/check.ts';
import { siteId } from './sites/discovery.ts';

const ORIGIN = 'http://lookout.test';
const HOST = 'lookout.test';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function makeWebDist(): Promise<string> {
  const dist = await mkdtemp(path.join(tmpdir(), 'lookout-web-'));
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Lookout</title>');
  await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(path.join(dist, 'favicon.ico'), 'ico');
  return dist;
}

async function start(options: Partial<AppOptions> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    config: testConfig(),
    docker: new FakeDocker(),
    webDistDir: await makeWebDist(),
    startSampler: false,
    ...options,
  });
  await app.ready();
  return app;
}

async function signIn(instance: FastifyInstance): Promise<string> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { password: TEST_PASSWORD },
  });
  expect(response.statusCode).toBe(204);
  const setCookie = String(response.headers['set-cookie']);
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  return setCookie.split(';')[0]!;
}

describe('authentication', () => {
  it('protects every registered route that is not explicitly public', async () => {
    const instance = await start();
    const protectedRoutes = instance.registeredRoutes.filter((route) => !route.public);
    // Sanity check: the list really includes the API, the SSE stream and the pages.
    expect(protectedRoutes.map((r) => r.url)).toEqual(
      expect.arrayContaining([
        '/api/session',
        '/api/stream',
        '/api/logout',
        '/',
        '/containers',
        '/containers/:id',
        '/api/containers',
        '/api/containers/stats',
        '/api/containers/:id',
        '/api/containers/:id/env/:name',
        '/api/containers/:id/logs',
        '/api/containers/:id/actions/:action',
        '/websites',
        '/settings',
        '/api/sites',
        '/api/sites/:id/check',
        '/api/folders',
        '/api/folders/scan',
      ]),
    );

    for (const route of protectedRoutes) {
      const url = route.url.replace(/:\w+/g, 'x').replace('*', 'x');
      const response = await instance.inject({
        method: route.method as 'GET',
        url,
        headers: { origin: ORIGIN, host: HOST },
      });
      if (route.page) {
        expect(response.statusCode, `${route.method} ${url}`).toBe(302);
        expect(response.headers.location).toBe('/login');
      } else {
        expect(response.statusCode, `${route.method} ${url}`).toBe(401);
        expect(response.json()).toEqual({ error: 'Not signed in' });
      }
    }
  });

  it('only leaves login, liveness and static assets public', async () => {
    const instance = await start();
    const publicRoutes = instance.registeredRoutes.filter((r) => r.public).map((r) => r.url);
    expect(publicRoutes.sort()).toEqual(
      ['/api/login', '/assets/index-abc123.js', '/favicon.ico', '/healthz', '/login'].sort(),
    );
  });

  it('returns 401 for unknown API paths without a session', async () => {
    const instance = await start();
    const response = await instance.inject({ url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(401);
  });

  it('signs in with the right password and reaches protected routes', async () => {
    const instance = await start();
    const cookie = await signIn(instance);
    const session = await instance.inject({ url: '/api/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true });

    const page = await instance.inject({ url: '/', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Lookout</title>');

    const login = await instance.inject({ url: '/login', headers: { cookie } });
    expect(login.statusCode).toBe(302);
  });

  it('refuses the wrong password', async () => {
    const instance = await start();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects the 6th failed login within 15 minutes, even with the right password', async () => {
    const instance = await start();
    for (let i = 0; i < 5; i += 1) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin: ORIGIN, host: HOST },
        payload: { password: `wrong-${i}` },
      });
      expect(response.statusCode).toBe(401);
    }
    const sixth = await instance.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: TEST_PASSWORD },
    });
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(sixth.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a POST with a foreign Origin, even with a valid session', async () => {
    const instance = await start();
    const cookie = await signIn(instance);
    const response = await instance.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: 'https://evil.example', host: HOST },
    });
    expect(response.statusCode).toBe(403);
    const noOrigin = await instance.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, host: HOST },
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('logout ends the session', async () => {
    const instance = await start();
    const cookie = await signIn(instance);
    const logout = await instance.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: ORIGIN, host: HOST },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
    const after = await instance.inject({ url: '/api/session', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('expires a session after the idle period', async () => {
    const clock = { now: Date.now() };
    const instance = await start({
      config: testConfig({ sessionIdleMs: 60 * 60 * 1000 }),
      now: () => clock.now,
    });
    const cookie = await signIn(instance);
    clock.now += 60 * 60 * 1000 + 1;
    const response = await instance.inject({ url: '/api/session', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });

  it('never logs the password or its hash', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const instance = await start({ logger: { level: 'trace', stream } });
    await signIn(instance);
    await instance.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { password: 'a-wrong-password' },
    });
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(TEST_PASSWORD);
    expect(log).not.toContain('a-wrong-password');
    expect(log).not.toContain(TEST_PASSWORD_HASH);
    expect(log).not.toContain('lookout_session=');
  });
});

describe('routes', () => {
  it('serves liveness without a session', async () => {
    const instance = await start();
    const response = await instance.inject({ url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('serves fingerprinted assets with a long cache lifetime', async () => {
    const instance = await start();
    const response = await instance.inject({ url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toMatch(/immutable/);
  });

  it('reports whether Docker is available', async () => {
    const docker = new FakeDocker();
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    expect(
      (await instance.inject({ url: '/api/docker/status', headers: { cookie } })).json(),
    ).toEqual({
      available: true,
    });
    docker.available = false;
    expect(
      (await instance.inject({ url: '/api/docker/status', headers: { cookie } })).json(),
    ).toEqual({
      available: false,
    });
  });

  it('streams Host samples over SSE', async () => {
    const hostRoot = await makeHostRoot({
      'proc/meminfo': readFileSync(fixture('meminfo'), 'utf8'),
      'proc/stat': readFileSync(fixture('stat-1'), 'utf8'),
      'proc/loadavg': '0.10 0.20 0.30 1/1 1\n',
      'proc/uptime': '100 50\n',
      'proc/1/mounts': '/dev/sda1 / ext4 rw 0 0\n',
      'etc/hostname': 'harbour\n',
    });
    const instance = await start({
      config: testConfig({ hostRoot, sampleIntervalMs: 250 }),
      startSampler: true,
    });
    await instance.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.server.address() as { port: number };
    const cookie = await signIn(instance);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: host')) {
      const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    const data = /event: host\ndata: (.+)\n/.exec(text)?.[1];
    const sample = JSON.parse(data!) as {
      overview: { hostname: string };
      memory: { usagePercent: number };
    };
    expect(sample.overview.hostname).toBe('harbour');
    expect(sample.memory.usagePercent).toBe(36.1);
  });
});

/** Reads named SSE events from a response until `until` says to stop. */
async function readEvents(
  response: Response,
  until: (events: { event: string; data: unknown }[]) => boolean,
): Promise<{ event: string; data: unknown }[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  while (!until(events)) {
    const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  return events;
}

async function listening(options: Partial<AppOptions> = {}) {
  const instance = await start(options);
  await instance.listen({ host: '127.0.0.1', port: 0 });
  const { port } = instance.server.address() as { port: number };
  const cookie = await signIn(instance);
  const get = (url: string, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}${url}`, { headers: { cookie }, signal: signal ?? null });
  return { instance, cookie, get };
}

describe('live stream', () => {
  it('sends settings, the Live Window and the Container list when it opens', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'a', name: 'web' })]);
    const { get } = await listening({
      docker,
      config: testConfig({ warnPercent: 70, criticalPercent: 85, liveWindowMinutes: 5 }),
    });
    // Wait until the store has listed Docker.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const controller = new AbortController();
    const response = await get('/api/stream', controller.signal);
    const events = await readEvents(response, (e) => e.some((x) => x.event === 'containers'));
    controller.abort();
    expect(events.map((e) => e.event).slice(0, 3)).toEqual(['settings', 'window', 'containers']);
    expect(events[0]!.data).toEqual({
      thresholds: { warnPercent: 70, criticalPercent: 85 },
      sampleIntervalMs: 2000,
      liveWindowMinutes: 5,
    });
    expect(events[1]!.data).toEqual({ capacity: 150, sampleIntervalMs: 2000, points: [] });
    expect(events[2]!.data).toMatchObject({ available: true, containers: [{ name: 'web' }] });
  });
});

describe('Containers API', () => {
  const secretContainer = () =>
    makeContainer({
      id: 'abc',
      name: 'api',
      env: [
        { name: 'DATABASE_PASSWORD', value: 'hunter2' },
        { name: 'MODE', value: 'production' },
      ],
    });

  it('sends environment variable names but never values in the list or detail', async () => {
    const docker = new FakeDocker([secretContainer()]);
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const list = await instance.inject({ url: '/api/containers', headers: { cookie } });
    expect(list.json()).toMatchObject({ available: true, containers: [{ name: 'api' }] });
    expect(list.body).not.toContain('hunter2');
    expect(list.body).not.toContain('production');

    const detail = await instance.inject({ url: '/api/containers/abc', headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ name: 'api', envNames: ['DATABASE_PASSWORD', 'MODE'] });
    expect(detail.body).not.toContain('hunter2');
    expect(detail.body).not.toContain('production');
  });

  it('reveals one variable at a time, uncached', async () => {
    const instance = await start({ docker: new FakeDocker([secretContainer()]) });
    const cookie = await signIn(instance);
    const response = await instance.inject({
      url: '/api/containers/abc/env/DATABASE_PASSWORD',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: 'DATABASE_PASSWORD', value: 'hunter2' });
    expect(response.body).not.toContain('production');
    expect(response.headers['cache-control']).toBe('no-store');

    const missing = await instance.inject({
      url: '/api/containers/abc/env/NOPE',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('answers 404 for an unknown Container and 503 while Docker is unavailable', async () => {
    const docker = new FakeDocker([secretContainer()]);
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    const missing = await instance.inject({ url: '/api/containers/zzz', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    const invalid = await instance.inject({
      url: '/api/containers/..%2Fetc',
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(404);
    docker.available = false;
    const down = await instance.inject({ url: '/api/containers/abc', headers: { cookie } });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: 'Docker unavailable' });
  });

  it('refuses a log tail that is not offered', async () => {
    const instance = await start({ docker: new FakeDocker([secretContainer()]) });
    const cookie = await signIn(instance);
    const response = await instance.inject({
      url: '/api/containers/abc/logs?tail=99999',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('Container Actions', () => {
  const containers = () => [
    makeContainer({ id: 'web1', name: 'web', state: 'running' }),
    makeContainer({ id: 'old1', name: 'old', state: 'exited', exitCode: 0 }),
    makeContainer({
      id: 'self1',
      name: 'lookout',
      state: 'running',
      labels: { 'lookout.self': 'true' },
    }),
  ];

  async function act(
    instance: FastifyInstance,
    cookie: string,
    id: string,
    action: string,
    payload: Record<string, unknown> = {},
  ) {
    return instance.inject({
      method: 'POST',
      url: `/api/containers/${id}/actions/${action}`,
      headers: { cookie, origin: ORIGIN, host: HOST },
      payload,
    });
  }

  it("refuses stop, restart and remove on Lookout's own Container with 403, doing nothing", async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    for (const action of ['stop', 'restart', 'remove', 'start']) {
      const response = await act(instance, cookie, 'self1', action, { confirmName: 'lookout' });
      expect(response.statusCode, action).toBe(403);
      expect(response.json<{ error: string }>().error).toMatch(/own Container/);
    }
    // By name too, not only by ID.
    expect((await act(instance, cookie, 'lookout', 'stop')).statusCode).toBe(403);
    expect(docker.actions).toEqual([]);
    expect((await docker.inspectContainer('self1'))?.state).toBe('running');
  });

  it('rejects an action that is not valid for the current state, without calling Docker', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    expect((await act(instance, cookie, 'web1', 'start')).statusCode).toBe(409);
    expect((await act(instance, cookie, 'old1', 'stop')).statusCode).toBe(409);
    expect((await act(instance, cookie, 'old1', 'restart')).statusCode).toBe(409);
    expect(docker.actions).toEqual([]);
  });

  it('refuses to remove a running Container', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    const response = await act(instance, cookie, 'web1', 'remove', { confirmName: 'web' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(/stopped/);
    expect(docker.actions).toEqual([]);
  });

  it('removes a stopped Container only when its exact name is confirmed', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    expect((await act(instance, cookie, 'old1', 'remove')).statusCode).toBe(400);
    expect((await act(instance, cookie, 'old1', 'remove', { confirmName: 'Old' })).statusCode).toBe(
      400,
    );
    expect(docker.actions).toEqual([]);
    const response = await act(instance, cookie, 'old1', 'remove', { confirmName: 'old' });
    expect(response.statusCode).toBe(200);
    expect(docker.actions).toEqual([{ action: 'remove', id: 'old1' }]);
    expect(await docker.inspectContainer('old1')).toBeNull();
  });

  it('starts, stops and restarts, and the change reaches the Container list', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    expect((await act(instance, cookie, 'web1', 'restart')).json()).toEqual({
      action: 'restart',
      containerId: 'web1',
    });
    expect((await act(instance, cookie, 'web1', 'stop')).statusCode).toBe(200);
    await expect
      .poll(async () => {
        const list = await instance.inject({ url: '/api/containers', headers: { cookie } });
        return list.json<ContainersSnapshot>().containers.find((c) => c.id === 'web1')?.state;
      })
      .toBe('exited');
    expect((await act(instance, cookie, 'web1', 'start')).statusCode).toBe(200);
    expect(docker.actions.map((a) => a.action)).toEqual(['restart', 'stop', 'start']);
  });

  it("returns Docker's error message when an action fails", async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    docker.failNextAction('driver failed programming external connectivity');
    const response = await act(instance, cookie, 'web1', 'restart');
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'driver failed programming external connectivity' });
  });

  it('needs a session and a same-origin request', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    const anonymous = await instance.inject({
      method: 'POST',
      url: '/api/containers/web1/actions/stop',
      headers: { origin: ORIGIN, host: HOST },
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
    const crossSite = await instance.inject({
      method: 'POST',
      url: '/api/containers/web1/actions/stop',
      headers: { cookie, origin: 'https://evil.example', host: HOST },
      payload: {},
    });
    expect(crossSite.statusCode).toBe(403);
    expect(docker.actions).toEqual([]);
  });

  it('only knows the four actions, and only well-formed Container references', async () => {
    const docker = new FakeDocker(containers());
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    for (const action of ['exec', 'kill', 'pause', 'pull']) {
      expect((await act(instance, cookie, 'web1', action)).statusCode, action).toBe(404);
    }
    expect((await act(instance, cookie, '..%2F..%2Fself1', 'stop')).statusCode).toBe(404);
    expect(docker.actions).toEqual([]);
  });
});

describe('dockerErrorMessage', () => {
  it("gives Docker's own JSON message and nothing else (FR-27, #92)", () => {
    expect(
      dockerErrorMessage(new EngineError(409, { message: 'conflict: unable to remove' })),
    ).toBe('conflict: unable to remove');
    // Node's errors, a proxy's plain text, an empty message and anything else: the fixed text.
    for (const error of [
      new Error('boom'),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2375'), { code: 'ECONNREFUSED' }),
      new EngineError(403, null, 'socket-proxy: request blocked'),
      new EngineError(500, { message: '' }),
      Object.assign(new Error('x'), { json: { message: 'looks like Docker but is not' } }),
      null,
    ]) {
      expect(dockerErrorMessage(error)).toBe('Docker could not complete the action');
    }
  });
});

describe('log stream', () => {
  it('sends the last N lines, then follows, interleaving stdout and stderr', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc' })]);
    for (let i = 0; i < 150; i += 1) {
      docker.appendLog('abc', { stream: 'stdout', timestamp: i, text: `old ${i}` });
    }
    const { get } = await listening({ docker, logFlushMs: 10 });
    const controller = new AbortController();
    const response = await get('/api/containers/abc/logs?tail=100', controller.signal);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const lines = (events: { event: string; data: unknown }[]) =>
      events.filter((e) => e.event === 'lines').flatMap((e) => e.data as { text: string }[]);

    setTimeout(() => {
      docker.appendLog('abc', { stream: 'stderr', timestamp: 200, text: 'boom' });
    }, 50);
    const events = await readEvents(response, (e) => lines(e).some((l) => l.text === 'boom'));
    controller.abort();
    expect(events[0]).toEqual({ event: 'reset', data: { tail: 100 } });
    const received = lines(events);
    expect(received).toHaveLength(101);
    expect(received[0]!.text).toBe('old 50');
    expect(received.at(-1)).toEqual({ stream: 'stderr', timestamp: 200, text: 'boom' });
  });

  it('closes the Docker log stream when the browser closes the view', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc' })]);
    docker.appendLog('abc', { stream: 'stdout', timestamp: 1, text: 'hello' });
    const { get } = await listening({ docker, logFlushMs: 10 });
    const controller = new AbortController();
    const response = await get('/api/containers/abc/logs', controller.signal);
    await readEvents(response, (e) => e.some((x) => x.event === 'lines'));
    expect(docker.openStreams('logs')).toBe(1);

    controller.abort();
    await vi.waitFor(() => expect(docker.openStreams('logs')).toBe(0));
  });

  it('closes the Docker log stream when the session ends', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc' })]);
    const { instance, cookie, get } = await listening({ docker, heartbeatMs: 20 });
    const response = await get('/api/containers/abc/logs');
    await readEvents(response, (e) => e.some((x) => x.event === 'reset'));
    expect(docker.openStreams('logs')).toBe(1);
    await instance.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { cookie, origin: ORIGIN, host: HOST },
    });
    await vi.waitFor(() => expect(docker.openStreams('logs')).toBe(0));
  });
});

describe('Container stats stream', () => {
  it('opens Docker stats streams only while a browser is subscribed', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc' })]);
    const { get } = await listening({ docker, statsFlushMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(docker.openStreams('stats')).toBe(0);

    const controller = new AbortController();
    const response = await get('/api/containers/stats', controller.signal);
    await vi.waitFor(() => expect(docker.openStreams('stats')).toBe(1));
    docker.setStats({
      containerId: 'abc',
      cpuPercent: 12.5,
      memoryUsedBytes: 10,
      memoryLimitBytes: 20,
    });
    const events = await readEvents(response, (e) => e.some((x) => x.event === 'stats'));
    expect(events.find((e) => e.event === 'stats')!.data).toEqual([
      { containerId: 'abc', cpuPercent: 12.5, memoryUsedBytes: 10, memoryLimitBytes: 20 },
    ]);

    controller.abort();
    await vi.waitFor(() => expect(docker.openStreams('stats')).toBe(0));
  });
});

describe('shutdown', () => {
  it('ends open live streams so closing does not hang', async () => {
    const instance = await start();
    await instance.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.server.address() as { port: number };
    const cookie = await signIn(instance);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);

    const started = Date.now();
    await instance.close();
    app = undefined;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * The v1 security review (issue #29). Each item has a regression test here or alongside
 * the code it covers; see docs/security-review-v1.md for the full list and justifications.
 */
describe('v1 security review', () => {
  const secret = () =>
    makeContainer({
      id: 'abc',
      name: 'api',
      state: 'exited',
      exitCode: 1,
      env: [{ name: 'DATABASE_PASSWORD', value: 'hunter2-db-secret' }],
    });

  it('refuses every state-changing route cross-origin or without an Origin, even signed in', async () => {
    const docker = new FakeDocker([secret()]);
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    const changing = instance.registeredRoutes.filter((r) => r.method !== 'GET');
    expect(changing.map((r) => r.url)).toEqual(
      expect.arrayContaining(['/api/login', '/api/logout', '/api/containers/:id/actions/:action']),
    );
    for (const route of changing) {
      const url = route.url.replace(':id', 'abc').replace(':action', 'start');
      for (const origin of ['https://evil.example', 'null', undefined]) {
        const response = await instance.inject({
          method: route.method as 'POST',
          url,
          headers: { cookie, host: HOST, ...(origin ? { origin } : {}) },
          payload: {},
        });
        expect(response.statusCode, `${route.method} ${url} from ${origin}`).toBe(403);
      }
    }
    expect(docker.actions).toEqual([]);
    // The session survived: the refused logout did nothing.
    expect((await instance.inject({ url: '/api/session', headers: { cookie } })).statusCode).toBe(
      200,
    );
  });

  it('sends security headers on pages, assets, API answers and errors', async () => {
    const instance = await start();
    const cookie = await signIn(instance);
    for (const [url, headers] of [
      ['/', { cookie }],
      ['/login', {}],
      ['/assets/index-abc123.js', {}],
      ['/api/containers', { cookie }],
      ['/api/containers', {}],
      ['/api/nope', { cookie }],
    ] as const) {
      const response = await instance.inject({ url, headers });
      const label = `${url} ${response.statusCode}`;
      expect(response.headers['content-security-policy'], label).toMatch(/frame-ancestors 'none'/);
      expect(response.headers['content-security-policy'], label).toMatch(/script-src 'self'(;|$)/);
      expect(response.headers['x-content-type-options'], label).toBe('nosniff');
      expect(response.headers['referrer-policy'], label).toBe('no-referrer');
      expect(response.headers['x-frame-options'], label).toBe('DENY');
      if (url.startsWith('/api/'))
        expect(response.headers['cache-control'], label).toBe('no-store');
    }
  });

  it('keeps env values, the password hash and the session secret out of logs', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const docker = new FakeDocker([secret()]);
    const config = testConfig();
    const instance = await start({ docker, config, logger: { level: 'trace', stream } });
    const cookie = await signIn(instance);
    const reveal = await instance.inject({
      url: '/api/containers/abc/env/DATABASE_PASSWORD',
      headers: { cookie },
    });
    expect(reveal.json()).toMatchObject({ value: 'hunter2-db-secret' });
    docker.failNextAction('boom');
    await instance.inject({
      method: 'POST',
      url: '/api/containers/abc/actions/start',
      headers: { cookie, origin: ORIGIN, host: HOST },
      payload: {},
    });
    await instance.inject({ url: '/api/containers/abc', headers: { cookie } });
    const log = lines.join('');
    expect(log).toContain('Revealed env');
    expect(log).toContain('DATABASE_PASSWORD');
    expect(log).not.toContain('hunter2-db-secret');
    expect(log).not.toContain(config.sessionSecret);
    expect(log).not.toContain(TEST_PASSWORD_HASH);
    expect(log).not.toContain(cookie.split('=')[1]);
  });

  it('never sends env values in the list, detail or live stream snapshot', async () => {
    const docker = new FakeDocker([secret()]);
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const url of ['/api/containers', '/api/containers/abc', '/api/containers/api']) {
      const response = await instance.inject({ url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain('hunter2-db-secret');
      expect(response.body, url).not.toMatch(/"env":/);
    }
  });

  it('rejects path traversal through Container references on every :id route', async () => {
    const docker = new FakeDocker([secret()]);
    const inspect = vi.spyOn(docker, 'inspectContainer');
    const instance = await start({ docker });
    const cookie = await signIn(instance);
    const routes = instance.registeredRoutes.filter((r) => r.url.includes(':id') && !r.page);
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const route of routes) {
      for (const evil of ['..', '..%2F..%2Fetc', '%2E%2E', '.hidden', 'a%00b', 'a%2Fb']) {
        const url = route.url.replace(':id', evil).replace(':name', 'X').replace(':action', 'stop');
        const response = await instance.inject({
          method: route.method as 'GET',
          url,
          headers: { cookie, origin: ORIGIN, host: HOST },
          ...(route.method === 'POST' ? { payload: {} } : {}),
        });
        expect([404, 400], `${route.method} ${url}`).toContain(response.statusCode);
      }
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(docker.actions).toEqual([]);
  });
});

describe('Hosted Sites', () => {
  const SHOP = 'https://shop.example/';
  const upCheck = (): SiteCheck => ({
    timestamp: Date.now(),
    status: 'up',
    statusCode: 200,
    error: null,
    responseMs: 30,
    redirect: null,
    tls: null,
  });

  async function startWithSites(checker: SiteChecker, docker = new FakeDocker()) {
    const instance = await start({
      docker,
      config: testConfig({ sites: [SHOP] }),
      siteChecker: checker,
      startSiteMonitor: false,
    });
    return { instance, cookie: await signIn(instance) };
  }

  const checkNow = (instance: FastifyInstance, cookie: string, id: string) =>
    instance.inject({
      method: 'POST',
      url: `/api/sites/${id}/check`,
      headers: { cookie, origin: ORIGIN, host: HOST },
    });

  it('Check now with an unknown ID returns 404 and makes no request', async () => {
    const checker = vi.fn<SiteChecker>(async () => upCheck());
    const { instance, cookie } = await startWithSites(checker);
    for (const id of ['0123456789abcdef', 'not-an-id', encodeURIComponent(SHOP), '%2E%2E']) {
      const response = await checkNow(instance, cookie, id);
      expect(response.statusCode, id).toBe(404);
    }
    expect(checker).not.toHaveBeenCalled();
  });

  it('Check now checks a known Hosted Site straight away, at most once every 5 s', async () => {
    const checker = vi.fn<SiteChecker>(async () => upCheck());
    const { instance, cookie } = await startWithSites(checker);
    const id = siteId(SHOP);
    const first = await checkNow(instance, cookie, id);
    expect(first.statusCode).toBe(200);
    expect(first.json<HostedSite>()).toMatchObject({ id, url: SHOP, status: 'up' });
    expect(checker).toHaveBeenCalledWith(SHOP, expect.objectContaining({ checkPublic: false }));

    const second = await checkNow(instance, cookie, id);
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(checker).toHaveBeenCalledTimes(1);

    const list = await instance.inject({ url: '/api/sites', headers: { cookie } });
    expect(list.json<SitesSnapshot>().sites).toEqual([
      expect.objectContaining({ url: SHOP, status: 'up' }),
    ]);
  });

  it('sends Hosted Sites on the live stream', async () => {
    const docker = new FakeDocker([
      makeContainer({ id: 'b', name: 'blog', labels: { 'lookout.url': 'http://blog.example/' } }),
    ]);
    const { get } = await listening({
      docker,
      config: testConfig({ sites: [SHOP] }),
      siteChecker: async () => upCheck(),
      startSiteMonitor: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const controller = new AbortController();
    const response = await get('/api/stream', controller.signal);
    const events = await readEvents(response, (e) => e.some((x) => x.event === 'sites'));
    controller.abort();
    const sites = events.find((e) => e.event === 'sites')!.data as SitesSnapshot;
    expect(sites.settings).toMatchObject({ checkIntervalMs: 60_000, slowMs: 2000 });
    expect(sites.sites.map((site) => [site.url, site.containerName])).toEqual([
      ['http://blog.example/', 'blog'],
      [SHOP, null],
    ]);
  });

  it('no API route accepts a URL to check (ADR-0010)', async () => {
    // A canary server: any connection to it means a URL from the request was fetched.
    let connections = 0;
    const canary = createServer((_request, response) => response.end());
    canary.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => canary.listen(0, '127.0.0.1', resolve));
    const port = (canary.address() as { port: number }).port;
    const urls = [`http://127.0.0.1:${port}/canary`, `http://evil.example:${port}/canary`];

    const docker = new FakeDocker([secret()]);
    // The real check engine, so any URL that reached it would really be fetched.
    const instance = await start({ docker, config: testConfig({ sites: [] }) });
    const cookie = await signIn(instance);
    try {
      for (const route of instance.registeredRoutes) {
        // The two live streams take no parameters and never end on their own.
        if (route.url === '/api/stream' || route.url === '/api/containers/stats') {
          expect(route.url).not.toMatch(/:/);
          continue;
        }
        for (const url of urls) {
          const encoded = encodeURIComponent(url);
          const path = route.url.replace(/:\w+/g, encoded).replace('*', encoded);
          const response = await instance.inject({
            method: route.method as 'GET',
            url: `${path}?url=${encoded}&target=${encoded}&site=${encoded}`,
            headers: { cookie, origin: ORIGIN, host: HOST },
            ...(route.method === 'GET'
              ? {}
              : { payload: { url, target: url, site: url, sites: [url], password: 'x' } }),
          });
          expect(response.statusCode, `${route.method} ${path}`).not.toBe(500);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(0);
      // The walk included /api/logout, so sign in again to look.
      const list = await instance.inject({
        url: '/api/sites',
        headers: { cookie: await signIn(instance) },
      });
      expect(list.json<SitesSnapshot>().sites).toEqual([]);
    } finally {
      canary.close();
    }
  });

  function secret() {
    return makeContainer({ id: 'abc', name: 'api', state: 'exited', exitCode: 1 });
  }
});

describe('largest folders', () => {
  async function startWithHost() {
    const root = await makeHostRoot({
      'proc/1/mounts': '/dev/sda1 / ext4 rw 0 0\n',
      'srv/media/a.bin': 'a'.repeat(200_000),
      'srv/media/b.bin': 'b'.repeat(200_000),
      'opt/app/c.bin': 'c'.repeat(50_000),
    });
    const instance = await start({
      config: testConfig({ hostRoot: root }),
      blockUnitProbe: async (_path, _blocks, bsize) => bsize,
      startFolderScanner: false,
    });
    return { instance, cookie: await signIn(instance) };
  }

  const scanNow = (instance: FastifyInstance, cookie: string, origin = ORIGIN) =>
    instance.inject({
      method: 'POST',
      url: '/api/folders/scan',
      headers: { cookie, origin, host: HOST },
    });

  async function finished(instance: FastifyInstance, cookie: string): Promise<FolderScan> {
    for (let i = 0; i < 100; i++) {
      const scan = (
        await instance.inject({ url: '/api/folders', headers: { cookie } })
      ).json<FolderScan>();
      if (scan.state !== 'scanning') return scan;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The scan did not finish');
  }

  it('waits for the first scan, with nothing scheduled when the interval is 0', async () => {
    const { instance, cookie } = await startWithHost();
    const scan = (
      await instance.inject({ url: '/api/folders', headers: { cookie } })
    ).json<FolderScan>();
    expect(scan).toMatchObject({ state: 'waiting', folders: [], nextAt: null });
  });

  it('Scan now starts one scan at a time, and finds the heaviest folders', async () => {
    const { instance, cookie } = await startWithHost();
    const first = await scanNow(instance, cookie);
    expect(first.statusCode).toBe(202);
    expect(first.json<FolderScan>().state).toBe('scanning');
    const second = await scanNow(instance, cookie);
    expect(second.statusCode).toBe(409);

    const scan = await finished(instance, cookie);
    expect(scan.state).toBe('done');
    expect(scan.folders[0]).toMatchObject({ path: '/srv/media', mountPoint: '/' });
    expect(scan.folders.map((f) => f.path)).not.toContain('/proc');
  });

  it('Scan now is refused from another site (CSRF)', async () => {
    const { instance, cookie } = await startWithHost();
    const response = await scanNow(instance, cookie, 'https://evil.example');
    expect(response.statusCode).toBe(403);
  });
});
