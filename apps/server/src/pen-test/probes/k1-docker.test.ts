/**
 * Pen-test scope issue K1 (#65): the Docker boundary, probed in-process. Findings are in
 * docs/pen-test/findings/K1.md. While a gap is open, an `it.fails` states the property that
 * should hold beside a `today_…` test pinning what happens now (PRD, "Checks every scope
 * issue carries"); once fixed they became an `it` and a `(regression)` test. All secrets
 * below are made up.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  SECRET_MASK,
  secretPath,
  type ContainerDetail,
  type ContainersSnapshot,
  type SecretValue,
} from '@lookout/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { LogOptions } from '../../docker/client.ts';
import { EngineDockerClient } from '../../docker/engine.ts';
import type { InspectedContainer } from '../../docker/parse.ts';
import { FakeDocker, makeContainer } from '../../../test-support/fake-docker.ts';
import { HOST, ORIGIN, startProbeApp, type ProbeApp } from './harness.ts';

/** Made-up secrets; every one of them is swept for in the server's logs at the end. */
const SECRET = {
  sessionSecret: 'made-up-pen-test-session-secret-0123456789abcdef',
  passwordHash:
    '$argon2id$v=19$m=19456,t=2,p=1$bWFkZS11cC1zYWx0$bWFkZS11cC1oYXNoLWZvci1wZW4tdGVzdA',
  requirepass: 'made-up-requirepass-s3cret',
  entrypointToken: 'made-up-entrypoint-token-7f3a',
  basicauth: 'admin:$apr1$madeup$Zx9MadeUpHashValue0',
  databaseUrl: 'postgres://app:made-up-db-password@db:5432/app',
  mountToken: 'made-up-mount-token-abc123',
  dbPassword: 'made-up-env-db-password',
} as const;

const LOOKOUT = makeContainer({
  id: 'a00000000000000000000000000000000000000000000000000000000000001a',
  name: 'lookout',
  labels: { 'lookout.self': 'true' },
  env: [
    { name: 'LOOKOUT_PASSWORD_HASH', value: SECRET.passwordHash },
    { name: 'LOOKOUT_SESSION_SECRET', value: SECRET.sessionSecret },
    { name: 'LOOKOUT_BIND_ADDRESS', value: '127.0.0.1' },
  ],
});

const PROXY = makeContainer({
  id: 'b00000000000000000000000000000000000000000000000000000000000002b',
  name: 'lookout-docker-proxy',
  labels: { 'lookout.self': 'true' },
  command: ['-listenip=127.0.0.1', '-allowfrom=127.0.0.1/32'],
  env: [{ name: 'PATH', value: '/usr/local/bin:/usr/bin:/bin' }],
});

/**
 * A Container whose `lookout.self` came from its Image, not from the operator (H4, S1's):
 * since #105 it is not Lookout's own, so it is not protected as self.
 */
const IMAGE_SELF = makeContainer({
  id: 'd00000000000000000000000000000000000000000000000000000000000004d',
  name: 'claims-to-be-lookout',
  state: 'exited',
  labels: { 'lookout.self': 'true', 'org.opencontainers.image.title': 'not Lookout' },
  selfClaimedByImage: true,
});

const VICTIM = makeContainer({
  id: 'c00000000000000000000000000000000000000000000000000000000000003c',
  name: 'victim',
  command: ['redis-server', '--requirepass', SECRET.requirepass],
  entrypoint: ['/entry.sh', `--token=${SECRET.entrypointToken}`],
  labels: {
    'traefik.http.middlewares.auth.basicauth.users': SECRET.basicauth,
    'app.database-url': SECRET.databaseUrl,
  },
  mounts: [
    {
      type: 'bind',
      source: `/srv/secrets/${SECRET.mountToken}`,
      destination: '/run/secrets/token',
      readOnly: true,
    },
  ],
  env: [{ name: 'DB_PASSWORD', value: SECRET.dbPassword }],
});

const STOPPED = makeContainer({
  id: 'e0000000000000000000000000000005',
  name: 'stopped',
  state: 'exited',
});

/** Out-of-band secrets: everything except the environment values. */
const OUTSIDE_ENV = [
  SECRET.requirepass,
  SECRET.entrypointToken,
  SECRET.basicauth,
  SECRET.databaseUrl,
  SECRET.mountToken,
];

/** A FakeDocker that also records which references reached inspect and logs. */
class RecordingDocker extends FakeDocker {
  readonly inspected: string[] = [];
  readonly tails: number[] = [];

  override async inspectContainer(id: string): Promise<InspectedContainer | null> {
    this.inspected.push(id);
    return super.inspectContainer(id);
  }

  override logs(id: string, options: LogOptions, signal: AbortSignal) {
    this.tails.push(options.tail);
    return super.logs(id, options, signal);
  }
}

// Everything every app in this file logs, swept for secrets at the end.
const logText: string[] = [];
const logStream = new PassThrough();
logStream.on('data', (chunk: Buffer) => logText.push(chunk.toString()));
/** Every status and error body any probe saw, for the closed-set check. */
const refusals = new Map<string, number>();

let probe: ProbeApp | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

async function start() {
  const docker = new RecordingDocker([LOOKOUT, PROXY, IMAGE_SELF, VICTIM, STOPPED]);
  probe = await startProbeApp({ docker, logger: { level: 'info', stream: logStream } });
  return { probe, docker, cookie: await probe.signIn() };
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  cookie: string,
  payload?: object,
): Promise<{ status: number; body: string }> {
  const response = await probe!.app.inject({
    method,
    url,
    headers: { cookie, origin: ORIGIN, host: HOST },
    ...(payload ? { payload } : {}),
  });
  if (response.statusCode >= 400) {
    refusals.set(`${response.statusCode} ${response.body}`, response.statusCode);
  }
  return { status: response.statusCode, body: response.body };
}

/** Waits for the Container list to be read from Docker. */
async function settled(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const response = await probe!.app.inject({
      url: '/api/containers',
      headers: { cookie: await probe!.signIn() },
    });
    if (response.json<ContainersSnapshot>().containers.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The Container list was never read');
}

describe('K1 H1 (reveal half): environment values of lookout.self Containers', () => {
  it('refuses to reveal any environment value of a lookout.self Container', async () => {
    const { cookie } = await start();
    const response = await call(
      'GET',
      `/api/containers/${LOOKOUT.id}/env/LOOKOUT_SESSION_SECRET`,
      cookie,
    );
    expect(response.status).toBe(403);
  });

  it("refuses Lookout's own session secret and password hash, by ID and by name, logging the refusal (regression)", async () => {
    const { cookie } = await start();
    const from = logText.length;
    for (const ref of [LOOKOUT.id, LOOKOUT.name]) {
      for (const name of [
        'LOOKOUT_SESSION_SECRET',
        'LOOKOUT_PASSWORD_HASH',
        'LOOKOUT_BIND_ADDRESS',
      ]) {
        const response = await call('GET', `/api/containers/${ref}/env/${name}`, cookie);
        expect(response, `${ref} ${name}`).toEqual({
          status: 403,
          body: JSON.stringify({ error: "Lookout never reveals its own Container's secrets" }),
        });
      }
    }
    expect(logText.slice(from).join('')).toContain('Reveal on own Container refused');
    // The detail still names them, values never.
    const detail = await call('GET', `/api/containers/${LOOKOUT.name}`, cookie);
    expect((JSON.parse(detail.body) as { envNames: string[] }).envNames).toEqual(
      expect.arrayContaining(['LOOKOUT_SESSION_SECRET', 'LOOKOUT_PASSWORD_HASH']),
    );
  });

  it("refuses the socket proxy's environment too: it is lookout.self (regression)", async () => {
    const { cookie } = await start();
    const response = await call('GET', `/api/containers/${PROXY.name}/env/PATH`, cookie);
    expect(response.status).toBe(403);
  });

  it("refuses a masked value of a lookout.self Container's command or labels too", async () => {
    const { cookie } = await start();
    const response = await call('GET', `/api/containers/${LOOKOUT.id}/secrets/command/0`, cookie);
    expect(response.status).toBe(403);
  });

  it('still reveals an environment value of any other Container', async () => {
    const { cookie } = await start();
    const response = await call('GET', `/api/containers/${VICTIM.id}/env/DB_PASSWORD`, cookie);
    expect(JSON.parse(response.body)).toEqual({ name: 'DB_PASSWORD', value: SECRET.dbPassword });
  });

  it('reveals one value per request, never values in the detail, and logs the name only', async () => {
    const { cookie } = await start();
    const detail = await call('GET', `/api/containers/${LOOKOUT.id}`, cookie);
    expect(detail.body).not.toContain(SECRET.sessionSecret);
    expect(detail.body).not.toContain(SECRET.passwordHash);
    const from = logText.length;
    await call('GET', `/api/containers/${VICTIM.id}/env/DB_PASSWORD`, cookie);
    const logged = logText.slice(from).join('');
    expect(logged).toContain('Revealed env');
    expect(logged).toContain('DB_PASSWORD');
    expect(logged).not.toContain(SECRET.dbPassword);
  });
});

describe('K1 H8: secrets outside the environment', () => {
  it('does not send secrets in the command, entrypoint, labels or mounts unasked', async () => {
    const { cookie } = await start();
    const detail = await call('GET', `/api/containers/${VICTIM.id}`, cookie);
    for (const secret of OUTSIDE_ENV) expect(detail.body).not.toContain(secret);
  });

  it('masks them in the detail and reveals each one on its own, logged by place not value (regression)', async () => {
    const { cookie } = await start();
    const detail = JSON.parse(
      (await call('GET', `/api/containers/${VICTIM.id}`, cookie)).body,
    ) as ContainerDetail;
    expect(detail.command).toEqual(['redis-server', '--requirepass', SECRET_MASK]);
    expect(detail.entrypoint).toEqual(['/entry.sh', `--token=${SECRET_MASK}`]);
    expect(detail.labels).toEqual({
      'traefik.http.middlewares.auth.basicauth.users': SECRET_MASK,
      'app.database-url': SECRET_MASK,
    });
    expect(detail.mounts[0]!.source).toBe(SECRET_MASK);
    expect(detail.masked).toEqual({ command: [2], entrypoint: [1], mounts: [0] });
    expect(detail.maskedLabels.sort()).toEqual([
      'app.database-url',
      'traefik.http.middlewares.auth.basicauth.users',
    ]);

    const from = logText.length;
    const reveals: [string, string][] = [
      [secretPath(VICTIM.id, 'command', 2), SECRET.requirepass],
      [secretPath(VICTIM.id, 'entrypoint', 1), `--token=${SECRET.entrypointToken}`],
      [
        secretPath(VICTIM.id, 'label', 'traefik.http.middlewares.auth.basicauth.users'),
        SECRET.basicauth,
      ],
      [secretPath(VICTIM.id, 'label', 'app.database-url'), SECRET.databaseUrl],
      [secretPath(VICTIM.id, 'mount', 0), `/srv/secrets/${SECRET.mountToken}`],
    ];
    for (const [url, value] of reveals) {
      const response = await call('GET', url, cookie);
      expect(response.status, url).toBe(200);
      expect((JSON.parse(response.body) as SecretValue).value, url).toBe(value);
    }
    const logged = logText.slice(from).join('');
    expect(logged.match(/Revealed secret/g)?.length).toBe(reveals.length);
    for (const secret of OUTSIDE_ENV) expect(logged).not.toContain(secret);
    // The environment is still names only.
    expect(JSON.stringify(detail)).not.toContain(SECRET.dbPassword);
  });

  it('reveals only masked items: anything else, or an odd key, is a 404 before or without Docker text', async () => {
    const { cookie } = await start();
    for (const url of [
      secretPath(VICTIM.id, 'command', 0),
      secretPath(VICTIM.id, 'command', 9),
      secretPath(VICTIM.id, 'mount', 1),
      secretPath(VICTIM.id, 'label', 'nope'),
      secretPath(VICTIM.id, 'label', '__proto__'),
      `/api/containers/${VICTIM.id}/secrets/env/DB_PASSWORD`,
      `/api/containers/${VICTIM.id}/secrets/command/01`,
      `/api/containers/${VICTIM.id}/secrets/command/-1`,
    ]) {
      expect(await call('GET', url, cookie), url).toEqual({
        status: 404,
        body: JSON.stringify({ error: 'No such masked value' }),
      });
    }
  });

  it('does not put label secrets in every Container list', async () => {
    const { cookie } = await start();
    await settled();
    const list = await call('GET', '/api/containers', cookie);
    expect(list.body).not.toContain(SECRET.basicauth);
  });

  it('masks label secrets in the Container list and every containers event (regression)', async () => {
    const { probe: instance, cookie } = await start();
    await settled();
    const list = await call('GET', '/api/containers', cookie);
    for (const secret of OUTSIDE_ENV) expect(list.body).not.toContain(secret);
    const victim = (JSON.parse(list.body) as ContainersSnapshot).containers.find(
      (c) => c.id === VICTIM.id,
    )!;
    expect(victim.maskedLabels.sort()).toEqual([
      'app.database-url',
      'traefik.http.middlewares.auth.basicauth.users',
    ]);
    // lookout.self is not a secret, so the UI can still tell Lookout's own Containers apart.
    const self = (JSON.parse(list.body) as ContainersSnapshot).containers.find(
      (c) => c.id === LOOKOUT.id,
    )!;
    expect(self.labels['lookout.self']).toBe('true');

    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = instance.app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('event: sites')) {
      const { value, done } = (await reader.read()) as { value?: Uint8Array; done: boolean };
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    const containers = /event: containers\ndata: (.+)\n/.exec(text)?.[1] ?? '';
    expect(containers).toContain(VICTIM.id);
    for (const secret of OUTSIDE_ENV) expect(containers).not.toContain(secret);
  });
});

describe('K1 H11: Engine, proxy and Node error text', () => {
  it("today_returns Docker's own message for a failed Container Action (FR-27, a documented decision)", async () => {
    const { docker, cookie } = await start();
    docker.failNextAction(
      'Error response from daemon: OCI runtime create failed: runc create failed: exec: "nope": executable file not found in $PATH',
    );
    const response = await call('POST', `/api/containers/${STOPPED.id}/actions/start`, cookie, {});
    expect(response.status).toBe(502);
    expect(response.body).toContain('OCI runtime create failed: runc create failed');
  });

  it('never returns Node or connection error text from a failed Container Action', async () => {
    const { docker, cookie } = await start();
    docker.failNextAction('connect ECONNREFUSED 127.0.0.1:2375', 'connection');
    const response = await call('POST', `/api/containers/${STOPPED.id}/actions/start`, cookie, {});
    expect(response.body).not.toContain('ECONNREFUSED');
  });

  it("answers Node's connection error with the fixed text, logging it on the server (regression)", async () => {
    const { docker, cookie } = await start();
    docker.failNextAction('connect ECONNREFUSED 127.0.0.1:2375', 'connection');
    const response = await call('POST', `/api/containers/${STOPPED.id}/actions/start`, cookie, {});
    expect(response.status).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: 'Docker could not complete the action' });
  });

  it('answers a Docker that cannot be reached with a fixed 503, not its error', async () => {
    const { docker, cookie } = await start();
    docker.available = false;
    const response = await call('GET', `/api/containers/${VICTIM.id}`, cookie);
    expect(response).toEqual({
      status: 503,
      body: JSON.stringify({ error: 'Docker unavailable' }),
    });
  });
});

/** A fake Engine (or socket proxy) on a real port that records every request. */
class RecordingEngine {
  readonly requests: { method: string; path: string; query: string }[] = [];
  /** Answers for a path, replacing the default. */
  readonly overrides = new Map<string, (response: ServerResponse) => void>();
  readonly #server: Server = createServer((request, response) => this.#answer(request, response));

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    return { host: '127.0.0.1', port: (this.#server.address() as AddressInfo).port };
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  #answer(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://docker');
    this.requests.push({ method: request.method ?? '', path: url.pathname, query: url.search });
    const override = this.overrides.get(`${request.method} ${url.pathname}`);
    if (override) return override(response);
    const json = (body: unknown) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = url.pathname;
    if (path === '/_ping') return response.writeHead(200).end('OK');
    if (path === '/containers/json') return json([{ Id: 'abc123' }]);
    if (/^\/containers\/[^/]+\/json$/.test(path)) {
      return json({
        Id: 'abc123',
        Name: '/victim',
        Image: 'sha256:feed',
        Config: { Image: 'example:1', Tty: false, Labels: {} },
        State: { Status: 'exited', StartedAt: '0001-01-01T00:00:00Z' },
      });
    }
    if (path.startsWith('/images/')) return json({ RepoDigests: [] });
    if (path === '/events' || path.endsWith('/stats')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(
        path === '/events'
          ? `${JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: 'abc123' }, time: 1 })}\n`
          : `${JSON.stringify({ read: '2026-11-25T00:00:00Z', cpu_stats: {}, precpu_stats: {}, memory_stats: {} })}\n`,
      );
      return;
    }
    if (path.endsWith('/logs')) {
      const text = Buffer.from('2026-11-25T00:00:00.000000000Z hello\n');
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(text.length, 4);
      return response.writeHead(200).end(Buffer.concat([header, text]));
    }
    return response.writeHead(204).end();
  }
}

/** The socket proxy's allowlist, read from the shipped Compose file and anchored. */
function proxyAllowlist(): Record<string, RegExp> {
  const file = fileURLToPath(new URL('../../../../../compose.socket-proxy.yaml', import.meta.url));
  const allow: Record<string, RegExp> = {};
  for (const match of readFileSync(file, 'utf8').matchAll(
    /^\s*- -allow(GET|POST|DELETE)=(.+)$/gm,
  )) {
    allow[match[1]!] = new RegExp(`^(?:${match[2]!.trim()})$`);
  }
  return allow;
}

/** ADR-0011's list, written out. */
const ADR_0011 = [
  /^GET \/_ping$/,
  /^GET \/events$/,
  /^GET \/containers\/json$/,
  /^GET \/containers\/[^/]+\/(json|logs|stats)$/,
  /^GET \/images\/[^/]+\/json$/,
  /^POST \/containers\/[^/]+\/(start|stop|restart)$/,
  /^DELETE \/containers\/[^/]+$/,
];

describe('K1: the Engine client calls only ADR-0011 endpoints', () => {
  const engine = new RecordingEngine();
  afterAll(() => engine.stop());

  it('every request the client can make is on the proxy allowlist and in ADR-0011', async () => {
    const client = new EngineDockerClient(await engine.start());
    const controller = new AbortController();
    expect(await client.ping()).toBe(true);
    await client.listContainers();
    await client.inspectContainer('abc123');
    const first = async <T>(iterable: AsyncIterable<T>) => {
      for await (const item of iterable) return item;
      return undefined;
    };
    await first(client.events(controller.signal));
    await first(client.stats('abc123', controller.signal));
    await first(client.logs('abc123', { tail: 100, follow: true }, controller.signal));
    await client.startContainer('abc123');
    await client.stopContainer('abc123');
    await client.restartContainer('abc123');
    await client.removeContainer('abc123');
    controller.abort();

    const allow = proxyAllowlist();
    expect(Object.keys(allow).sort()).toEqual(['DELETE', 'GET', 'POST']);
    const seen = new Set(engine.requests.map((r) => `${r.method} ${r.path}`));
    expect(seen.size).toBeGreaterThanOrEqual(11);
    for (const request of engine.requests) {
      const line = `${request.method} ${request.path}`;
      expect(allow[request.method]?.test(request.path), line).toBe(true);
      expect(
        ADR_0011.some((pattern) => pattern.test(line)),
        line,
      ).toBe(true);
    }
    // Remove is never forced and never deletes volumes; the query is not on the allowlist,
    // so only Lookout's own code keeps it so (H2's half belongs to P1).
    const remove = engine.requests.find((r) => r.method === 'DELETE');
    expect(remove?.query).toBe('?force=false&v=false');
  });

  it("answers the proxy's plain-text refusal with the fixed text, and Docker's JSON message as FR-27 says (regression)", async () => {
    const proxy = new RecordingEngine();
    proxy.overrides.set('POST /containers/abc123/start', (response) =>
      response
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('socket-proxy: request blocked\n'),
    );
    proxy.overrides.set('POST /containers/abc123/restart', (response) =>
      response.writeHead(500, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          message:
            'OCI runtime exec failed: /run/containerd/io.containerd.runtime.v2.task/moby/abc123',
        }),
      ),
    );
    const client = new EngineDockerClient(await proxy.start());
    try {
      probe = await startProbeApp({
        docker: client as unknown as FakeDocker,
        logger: { level: 'info', stream: logStream },
      });
      const cookie = await probe.signIn();
      const start = await call('POST', '/api/containers/abc123/actions/start', cookie, {});
      expect(start.status).toBe(502);
      expect(JSON.parse(start.body)).toEqual({ error: 'Docker could not complete the action' });
      // The stub's inspect answers "exited", which restart refuses before Docker; Docker's
      // own JSON message is pinned by the FR-27 test above.
    } finally {
      await proxy.stop();
    }
  });

  it('answers a stopped Engine (nothing listening) with the fixed text, not its address', async () => {
    const proxy = new RecordingEngine();
    const address = await proxy.start();
    const client = new EngineDockerClient(address);
    try {
      probe = await startProbeApp({
        docker: client as unknown as FakeDocker,
        logger: { level: 'info', stream: logStream },
      });
      const cookie = await probe.signIn();
      await proxy.stop();
      const response = await call('POST', '/api/containers/abc123/actions/start', cookie, {});
      expect(response.body).not.toContain('ECONNREFUSED');
      expect(response.body).not.toContain(String(address.port));
    } finally {
      await proxy.stop().catch(() => undefined);
    }
  });

  it("ends a failed log stream without sending Docker's error text", async () => {
    const proxy = new RecordingEngine();
    proxy.overrides.set('GET /containers/abc123/logs', (response) =>
      response.writeHead(500).end(JSON.stringify({ message: 'made-up-internal-engine-detail' })),
    );
    const client = new EngineDockerClient(await proxy.start());
    try {
      probe = await startProbeApp({
        docker: client as unknown as FakeDocker,
        logger: { level: 'info', stream: logStream },
      });
      const cookie = await probe.signIn();
      await probe.app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = probe.app.server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/containers/abc123/logs?tail=100`, {
        headers: { cookie },
      });
      const text = await response.text();
      expect(text).toContain('event: reset');
      expect(text).not.toContain('made-up-internal-engine-detail');
    } finally {
      await proxy.stop();
    }
  });
});

describe('K1: Container Actions', () => {
  const ACTIONS = ['start', 'stop', 'restart', 'remove'] as const;

  it('refuses every action on lookout.self, by ID and by name, before Docker', async () => {
    const { docker, cookie } = await start();
    for (const container of [LOOKOUT, PROXY]) {
      for (const ref of [container.id, container.name, container.id.slice(0, 12)]) {
        for (const action of ACTIONS) {
          const response = await call('POST', `/api/containers/${ref}/actions/${action}`, cookie, {
            confirmName: container.name,
          });
          if (ref === container.id.slice(0, 12)) {
            // The fake resolves only full IDs and names; Docker also takes a prefix.
            expect([403, 404], `${action} ${ref}`).toContain(response.status);
          } else {
            expect(response.status, `${action} ${ref}`).toBe(403);
          }
        }
      }
    }
    expect(docker.actions).toEqual([]);
  });

  it('does not treat a Container whose Image claims lookout.self as Lookout (#105)', async () => {
    const { docker, cookie } = await start();
    const response = await call(
      'POST',
      `/api/containers/${IMAGE_SELF.name}/actions/start`,
      cookie,
      {},
    );
    expect(response.status).toBe(200);
    expect(docker.actions).toHaveLength(1);
  });

  it('refuses remove without the typed name, or with the wrong one, before Docker', async () => {
    const { docker, cookie } = await start();
    for (const payload of [
      {},
      { confirmName: 'Stopped' },
      { confirmName: 'stopped ' },
      { confirmName: STOPPED.id },
    ]) {
      const response = await call(
        'POST',
        `/api/containers/${STOPPED.id}/actions/remove`,
        cookie,
        payload,
      );
      expect(response.status).toBe(400);
    }
    // A body that is not JSON.
    const raw = await probe!.app.inject({
      method: 'POST',
      url: `/api/containers/${STOPPED.id}/actions/remove`,
      headers: { cookie, origin: ORIGIN, host: HOST, 'content-type': 'text/plain' },
      payload: 'stopped',
    });
    expect([400, 415]).toContain(raw.statusCode);
    expect(docker.actions).toEqual([]);
  });

  it('refuses unknown actions before Docker', async () => {
    const { docker, cookie } = await start();
    for (const action of ['kill', 'exec', 'pause', 'START', 'start ', 'constructor', '__proto__']) {
      const response = await call(
        'POST',
        `/api/containers/${STOPPED.id}/actions/${encodeURIComponent(action)}`,
        cookie,
        {},
      );
      expect(response.status, action).toBe(404);
    }
    expect(docker.inspected).toEqual([]);
    expect(docker.actions).toEqual([]);
  });

  /** References past Docker's name grammar or the route's own bound. */
  const ODD_REFS = [
    '..',
    '%2e%2e',
    '.hidden',
    '-dash',
    '_under',
    'stopped%2Fjson',
    'stopped%2f..%2fjson',
    '..%2F..%2Fimages%2Fjson',
    'stopped%00',
    'stopped%0a',
    'stopped%20',
    'st%C3%B6pped',
    'stopped%3Fforce%3Dtrue',
    'stopped%23',
    // Past the route's own 128 (CONTAINER_REF) but within Fastify's 100-character param cap
    // it would be refused by find-my-way first; see the over-long probe below.
    'a'.repeat(99) + '%2F',
  ];

  it('stops odd references before Docker on every Container route', async () => {
    const { docker, cookie } = await start();
    for (const ref of ODD_REFS) {
      const routes: ['GET' | 'POST', string][] = [
        ['GET', `/api/containers/${ref}`],
        ['GET', `/api/containers/${ref}/env/PATH`],
        ['GET', `/api/containers/${ref}/logs?tail=100`],
        ...ACTIONS.map((action): ['POST', string] => [
          'POST',
          `/api/containers/${ref}/actions/${action}`,
        ]),
      ];
      for (const [method, url] of routes) {
        const response = await call(
          method,
          url,
          cookie,
          method === 'POST' ? { confirmName: ref } : undefined,
        );
        expect(response.status, `${method} ${url}`).toBe(404);
      }
    }
    expect(docker.inspected).toEqual([]);
    expect(docker.actions).toEqual([]);
  });

  it('passes a well-formed reference with dots through to Docker percent-encoded', async () => {
    const { docker, cookie } = await start();
    const response = await call('GET', '/api/containers/a..b', cookie);
    expect(response.status).toBe(404);
    expect(docker.inspected).toEqual(['a..b']);
  });

  it('compares the environment variable name only after inspecting; the name never reaches Docker', async () => {
    const { docker, cookie } = await start();
    for (const name of ['..%2F..%2Fjson', '%00', 'A'.repeat(90)]) {
      const response = await call('GET', `/api/containers/${VICTIM.id}/env/${name}`, cookie);
      expect(response.status).toBe(404);
    }
    expect(docker.inspected.every((ref) => ref === VICTIM.id)).toBe(true);
  });
});

describe('K1: over-long references', () => {
  const LONG = 'a'.repeat(129);

  it('refuses an over-long reference with the same closed-set 404 as any other', async () => {
    const { cookie } = await start();
    const response = await call('GET', `/api/containers/${LONG}`, cookie);
    expect(response).toEqual({ status: 404, body: JSON.stringify({ error: 'No such Container' }) });
  });

  it('answers 404 signed in and 401 without, never echoing the path or naming the framework (regression)', async () => {
    const { docker, cookie } = await start();
    // Past the route's own 128 (CONTAINER_REF), and past Fastify's default 100 as well.
    for (const length of [129, 1000, 8000]) {
      const long = 'a'.repeat(length);
      for (const [headers, status, error] of [
        [{ cookie }, 404, 'No such Container'],
        [{}, 401, 'Not signed in'],
      ] as const) {
        const response = await probe!.app.inject({ url: `/api/containers/${long}`, headers });
        expect(response.statusCode, `${length} ${status}`).toBe(status);
        expect(response.json()).toEqual({ error });
        expect(response.body).not.toContain(long);
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      }
    }
    expect(docker.inspected).toEqual([]);
  });

  it('answers a URL Fastify cannot decode with the closed set too', async () => {
    const { cookie } = await start();
    for (const [headers, status] of [
      [{ cookie }, 404],
      [{}, 401],
    ] as const) {
      const response = await probe!.app.inject({ url: '/api/containers/%zz', headers });
      expect([status, 400]).toContain(response.statusCode);
      expect(response.body).not.toContain('FST_');
      expect(response.body).not.toContain('%zz');
    }
  });
});

describe('K1: log tails', () => {
  it('refuses tails other than 100, 500 and 1000 before Docker', async () => {
    const { docker, cookie } = await start();
    for (const tail of ['0', '99', '1001', 'all', '-1', '', '100abc', 'Infinity', '1000000']) {
      const response = await call('GET', `/api/containers/${VICTIM.id}/logs?tail=${tail}`, cookie);
      expect(response.status, `tail=${tail}`).toBe(400);
    }
    expect(docker.inspected).toEqual([]);
  });

  it('coerces spellings such as 1e3, 0x64 and " 100" to a number, so only 100, 500 or 1000 reaches Docker', async () => {
    const { probe: instance, docker, cookie } = await start();
    await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = instance.app.server.address() as AddressInfo;
    for (const tail of ['1e3', '0x64', '%20100', '500.0', '5e2']) {
      const controller = new AbortController();
      const response = await fetch(
        `http://127.0.0.1:${port}/api/containers/${VICTIM.id}/logs?tail=${tail}`,
        {
          headers: { cookie },
          signal: controller.signal,
        },
      );
      expect(response.status, `tail=${tail}`).toBe(200);
      controller.abort();
    }
    for (let i = 0; i < 50 && docker.tails.length < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(docker.tails).toEqual([1000, 100, 100, 500, 500]);
  });
});

describe('K1: checks across the boundary', () => {
  it('answered no well-formed request with a 500; every refusal came from a closed set', () => {
    const statuses = [...refusals.values()];
    expect(statuses).not.toContain(500);
    expect(statuses).not.toContain(414);
    const bodies = [...refusals.keys()].map((key) => key.replace(/^\d+ /, ''));
    const closed = new Set([
      '{"error":"No such Container"}',
      '{"error":"Not found"}',
      '{"error":"No such Container Action"}',
      '{"error":"No such environment variable"}',
      '{"error":"Docker unavailable"}',
      '{"error":"Lookout cannot act on its own Container"}',
      '{"error":"Type the Container\'s name to confirm removal"}',
      '{"error":"tail must be one of 100, 500, 1000"}',
      '{"error":"Lookout never reveals its own Container\'s secrets"}',
      '{"error":"No such masked value"}',
      '{"error":"Not signed in"}',
      '{"error":"Docker could not complete the action"}',
    ]);
    // A 502 may carry Docker's own JSON message (FR-27); never Node's or the proxy's (#92).
    const open = bodies.filter((body) => !closed.has(body));
    expect(open.every((body) => refusals.get(`502 ${body}`) === 502)).toBe(true);
    for (const body of open) {
      expect(body).not.toMatch(/ECONNREFUSED|ENOENT|socket-proxy/);
    }
  });

  it('never wrote an environment value or out-of-band secret to the server log', () => {
    const logged = logText.join('');
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of Object.values(SECRET)) expect(logged).not.toContain(secret);
  });
});
