/**
 * P1 (#66) against the pen-test deployment: the socket proxy and the Host's loopback (H2).
 * In the deployment "the Host" is the throwaway daemon's container, and the proxy runs in
 * its network namespace exactly as shipped. Every request here is made from inside it, as
 * UID 65534 (nobody, in no docker group): either a process on the Host itself, or a
 * host-network Container. The in-process half is p1-proxy.test.ts. Since #101 the proxy
 * listens only on a Unix socket in a volume Lookout and it share, so the probes that read
 * and removed through the loopback port are now `(regression)` probes that find nothing
 * there, and the allowlist is probed through the socket, as Lookout's own user.
 *
 * Only a Container made for the purpose is restarted and removed; the fixtures are only
 * read. Nothing leaves the deployment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dindContainer, dindDocker, docker } from '../deployment.ts';
import { FAKE_MARKER, FIXTURE_IMAGE, FIXTURE_LABEL, PROXY_PORT } from '../fixtures/plan.ts';
import { connect, type Deployment } from './deployment-harness.ts';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});

const NOBODY = '65534:65534';
const SACRIFICE = 'p1-sacrificial';

interface Answer {
  method: string;
  target: string;
  status: number | null;
  error: string | null;
  head: string;
  body: string;
}

/** Raw HTTP/1.1, so no client normalises the target: `//`, `..` and `%2F` go as written. */
const RAW_CLIENT = `
import { connect } from 'node:net';
const requests = JSON.parse(process.env.REQUESTS);
const answers = [];
for (const [method, target] of requests) {
  answers.push(await new Promise((resolve) => {
    const socket = process.env.SOCKET
      ? connect(process.env.SOCKET)
      : connect(Number(process.env.PORT), '127.0.0.1');
    let data = Buffer.alloc(0);
    const done = (error) => {
      clearTimeout(timer);
      const text = data.toString('utf8');
      const split = text.indexOf('\\r\\n\\r\\n');
      const status = Number(/^HTTP\\/1\\.[01] (\\d{3})/.exec(text)?.[1] ?? 0) || null;
      resolve({ method, target, status, error, head: split < 0 ? text : text.slice(0, split),
        body: split < 0 ? '' : text.slice(split + 4) });
    };
    const timer = setTimeout(() => { socket.destroy(); done('timeout'); }, 5000);
    socket.on('connect', () => socket.write(method + ' ' + target +
      ' HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n'));
    socket.on('data', (chunk) => { if (data.length < 1 << 20) data = Buffer.concat([data, chunk]); });
    socket.on('error', (error) => done(error.code ?? String(error)));
    socket.on('close', () => done(null));
  }));
}
console.log(JSON.stringify(answers));
`;

/**
 * Sends raw requests to the proxy's port from a host-network Container running as nobody:
 * what any Container on the Host network, or any local user, can do.
 */
function fromHostNetwork(requests: [string, string][]): Answer[] {
  const output = dindDocker([
    'run',
    '--rm',
    '--network',
    'host',
    '--user',
    NOBODY,
    '--env',
    `REQUESTS=${JSON.stringify(requests)}`,
    '--env',
    `PORT=${PROXY_PORT}`,
    '--entrypoint',
    'node',
    FIXTURE_IMAGE,
    '--input-type=module',
    '--eval',
    RAW_CLIENT,
  ]);
  const last = (output ?? '').trim().split('\n').at(-1) ?? '[]';
  return JSON.parse(last) as Answer[];
}

/** The volume holding the proxy's socket, as Compose named it in the deployment. */
function socketVolume(): string {
  return dindDocker([
    'inspect',
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/run/lookout-docker"}}{{.Name}}{{end}}{{end}}',
    'lookout-docker-proxy',
  ])!.trim();
}

/**
 * Sends raw requests through the proxy's socket from a Container that mounts its volume,
 * as `user` (Lookout's own 65532 by default), with no network at all.
 */
function throughSocket(requests: [string, string][], user = '65532:65532'): Answer[] {
  const output = dindDocker([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    user,
    '--volume',
    `${socketVolume()}:/run/lookout-docker`,
    '--env',
    `REQUESTS=${JSON.stringify(requests)}`,
    '--env',
    'SOCKET=/run/lookout-docker/docker.sock',
    '--entrypoint',
    'node',
    FIXTURE_IMAGE,
    '--input-type=module',
    '--eval',
    RAW_CLIENT,
  ]);
  const last = (output ?? '').trim().split('\n').at(-1) ?? '[]';
  return JSON.parse(last) as Answer[];
}

/** A GET from a process on the Host itself (the daemon's container), as nobody. */
function fromHostUser(path: string): string | null {
  return docker(
    [
      'exec',
      '--user',
      NOBODY,
      dindContainer()!,
      'wget',
      '-q',
      '-T',
      '5',
      '-O',
      '-',
      `http://127.0.0.1:${PROXY_PORT}${path}`,
    ],
    { allowFail: true },
  );
}

function makeSacrifice(): string {
  dindDocker(['rm', '--force', '--volumes', SACRIFICE], { allowFail: true });
  dindDocker([
    'run',
    '--detach',
    '--name',
    SACRIFICE,
    '--label',
    `${FIXTURE_LABEL}=${SACRIFICE}`,
    // An anonymous volume, which `v=true` removes with the Container.
    '--volume',
    '/data',
    FIXTURE_IMAGE,
    'idle',
  ]);
  return dindDocker([
    'inspect',
    '--format',
    '{{range .Mounts}}{{.Name}}{{end}}',
    SACRIFICE,
  ])!.trim();
}

afterAll(() => {
  dindDocker(['rm', '--force', '--volumes', SACRIFICE], { allowFail: true });
});

const proxyOnly = () => deployment.configuration !== 'socket-proxy';

describe('P1 H2: who reaches the proxy', () => {
  it("an unprivileged Host user reaches no proxy on the loopback, and cannot enter the socket's volume (regression)", ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    expect(fromHostUser('/containers/json?all=1'), 'GET /containers/json as nobody').toBeNull();
    expect(fromHostUser('/containers/lookout/json')).toBeNull();
    const mountpoint = dindDocker([
      'volume',
      'inspect',
      '--format',
      '{{.Mountpoint}}',
      socketVolume(),
    ])!.trim();
    const listed = docker(['exec', '--user', NOBODY, dindContainer()!, 'ls', mountpoint], {
      allowFail: true,
    });
    console.log(
      `[socket-proxy] nobody on the Host: loopback refused; ls ${mountpoint}: ${listed ?? 'refused'}`,
    );
    expect(listed).toBeNull();
  });

  it("a host-network Container running as nobody reaches no proxy, so reads no Container's environment (regression)", ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    const answers = fromHostNetwork([
      ['GET', '/containers/json?all=1'],
      ['GET', '/containers/victim/json'],
      ['GET', '/v1.41/containers/lookout/json'],
    ]);
    for (const answer of answers) {
      expect(answer.status, answer.target).toBeNull();
      expect(answer.error, answer.target).toBe('ECONNREFUSED');
    }
  });

  it('a host-network Container running as nobody can neither restart nor force-remove a running Container (regression)', ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    const volume = makeSacrifice();
    expect(volume).not.toBe('');
    const [restart, remove] = fromHostNetwork([
      ['POST', `/containers/${SACRIFICE}/restart?t=1`],
      ['DELETE', `/containers/${SACRIFICE}?force=true&v=true`],
    ]);
    console.log(
      `[socket-proxy] restart ${restart!.status ?? restart!.error}, forced remove ${remove!.status ?? remove!.error}`,
    );
    expect(restart!.error).toBe('ECONNREFUSED');
    expect(remove!.error).toBe('ECONNREFUSED');
    expect(dindDocker(['inspect', '--format', '{{.State.Running}}', SACRIFICE])?.trim()).toBe(
      'true',
    );
    expect(dindDocker(['volume', 'inspect', volume], { allowFail: true })).not.toBeNull();
  });

  it("a Container that mounts the socket's volume as nobody or UID 1000 is refused by the socket's mode (sound)", ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    for (const user of [NOBODY, '1000:1000']) {
      const [ping] = throughSocket([['GET', '/_ping']], user);
      console.log(`[socket-proxy] ${user} through the socket: ${ping!.status ?? ping!.error}`);
      expect(ping!.status, user).toBeNull();
      expect(ping!.error, user).toBe('EACCES');
    }
    const [ping] = throughSocket([['GET', '/_ping']]);
    expect(ping!.status, "Lookout's own user").toBe(200);
  });

  it('a forced remove with volumes through the socket still passes: Lookout alone could send it (accepted in ADR-0011 until 25 February 2027, #102)', ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    makeSacrifice();
    const [remove] = throughSocket([['DELETE', `/containers/${SACRIFICE}?force=true&v=true`]]);
    console.log(`[socket-proxy] as Lookout's user, forced remove ${remove!.status}`);
    expect(remove!.status).toBe(204);
  });

  it('in the default configuration nothing listens on the loopback port, and nobody cannot open the socket (sound)', ({
    skip,
  }) => {
    if (!proxyOnly()) skip();
    const [ping] = fromHostNetwork([['GET', '/_ping']]);
    expect(ping!.status).toBeNull();
    expect(ping!.error).toBe('ECONNREFUSED');
    const writable = docker(
      ['exec', '--user', NOBODY, dindContainer()!, 'test', '-w', '/var/run/docker.sock'],
      { allowFail: true },
    );
    expect(writable).toBeNull();
  });

  it('listens on no address: 127.0.0.1, [::1] and the deployment address are all refused (sound)', ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    const script = RAW_CLIENT.replace("'127.0.0.1'", 'process.env.ADDRESS');
    for (const address of ['127.0.0.1', '::1', '172.30.213.2']) {
      const output = dindDocker([
        'run',
        '--rm',
        '--network',
        'host',
        '--user',
        NOBODY,
        '--env',
        `REQUESTS=${JSON.stringify([['GET', '/_ping']])}`,
        '--env',
        `PORT=${PROXY_PORT}`,
        '--env',
        `ADDRESS=${address}`,
        '--entrypoint',
        'node',
        FIXTURE_IMAGE,
        '--input-type=module',
        '--eval',
        script,
      ]);
      const [answer] = JSON.parse((output ?? '[]').trim().split('\n').at(-1)!) as Answer[];
      console.log(`[socket-proxy] ${address}: ${answer!.status ?? answer!.error}`);
      expect(answer!.status, address).toBeNull();
    }
  });
});

describe('P1 H2: path tricks against the real proxy', () => {
  // What each would reach if it got past the allowlist.
  const tricks: [string, string][] = [
    ['POST', '/containers/create'],
    ['POST', '/v1.41/containers/victim/exec'],
    ['GET', '/info'],
    ['POST', '//containers/create'],
    ['POST', '/containers%2Fcreate'],
    ['POST', '/v1.41/containers/victim/json/../exec'],
    ['POST', '/v1.41/containers/victim/start/../exec'],
    ['POST', '/v1.41/containers/victim/start/%2e%2e/exec'],
    ['GET', '/images/..%2f../json'],
    ['GET', '/images/..%2f..%2finfo/json'],
    ['GET', '/images/x%2f..%2f..%2fcontainers%2fvictim%2fexport/json'],
    ['POST', '/containers/victim%2fexec'],
    ['GET', '/v1.41/containers/../info'],
    ['GET', '/v1.41/_ping/../info'],
    ['GET', '/containers/victim/export'],
    ['GET', '/containers/victim/archive?path=/'],
  ];
  // A trailing `/` aims at an allowed endpoint; it may pass, but must reach nothing else.
  const trailing: [string, string][] = [
    ['GET', '/containers/json/'],
    ['POST', '/containers/victim/start/'],
    ['DELETE', '/containers/no-such-container/'],
  ];

  it('no trick reaches an endpoint outside the allowlist (each answered 403, or by Docker with a redirect or 404)', ({
    skip,
  }) => {
    if (proxyOnly()) skip();
    // Through the socket, as Lookout's own user: since #101 the only way to the proxy.
    const answers = throughSocket([...tricks, ...trailing]);
    for (const answer of answers) {
      console.log(
        `[socket-proxy] ${answer.method} ${answer.target} → ${answer.status ?? answer.error} ${answer.body.slice(0, 80).replace(/\s+/g, ' ')}`,
      );
    }
    for (const answer of answers.slice(0, tricks.length)) {
      // 2xx would mean exec, create, info, export or archive answered.
      expect(answer.status, `${answer.method} ${answer.target}`).not.toBeNull();
      expect(
        answer.status! < 200 || answer.status! >= 300,
        `${answer.method} ${answer.target}`,
      ).toBe(true);
    }
    // No exec instance was made on the victim by any of them.
    const execs = dindDocker(['inspect', '--format', '{{json .ExecIDs}}', 'victim'])!.trim();
    expect(execs === 'null' || execs === '[]').toBe(true);
    for (const answer of answers.slice(tricks.length)) {
      expect(answer.status, `${answer.method} ${answer.target}`).not.toBeNull();
    }
  });
});

describe("P1 H2: a lookout.url label at the proxy's port", () => {
  it('gets only a status on the Websites page: never a body, never a write', async () => {
    const url = `http://127.0.0.1:${PROXY_PORT}/containers/json`;
    let site:
      | { status: string; last: { statusCode: number | null; error: string | null } | null }
      | undefined;
    for (let attempt = 0; attempt < 90; attempt++) {
      const { sites } = (await (await deployment.api('/api/sites')).json()) as {
        sites: (typeof site & { url: string })[];
      };
      site = sites.find((s) => s.url === url);
      if (site?.last) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(site?.last, 'the Hostile Container labels this URL (fixtures.md)').toBeTruthy();
    const shown = JSON.stringify(site);
    console.log(
      `[${deployment.configuration}] ${url}: ${site!.status} ${site!.last!.statusCode ?? site!.last!.error}`,
    );
    expect(shown).not.toContain(FAKE_MARKER);
    expect(shown).not.toMatch(/"Id"|"Env"|"Names"/);
    // Since #101 nothing listens on the proxy's old port in either configuration.
    expect(site!.status).toBe('down');
  });
});
