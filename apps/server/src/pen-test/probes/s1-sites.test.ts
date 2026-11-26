/**
 * Pen-test scope issue S1 (#67): Hosted Site checks and label trust (H4), probed in-process.
 * Findings are in docs/pen-test/findings/S1.md. While a gap is open, an `it.fails` states the
 * property that should hold beside a `today_…` test pinning what happens now (PRD, "Checks
 * every scope issue carries").
 *
 * Docker merges an Image's `LABEL`s into its Container's labels, and Lookout reads only the
 * merged set, so a label here stands for one an Image publisher wrote (the deployment probe
 * s1-sites.probe.ts shows the merge with a real Image). Every real check below connects only
 * to listeners this file starts on 127.0.0.1; link-local, metadata and private addresses are
 * only ever handed to a recording checker, never dialled (s1-dial.test.ts shows the address
 * the real check would dial, with node:http stubbed).
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { HostedSite, SiteCheck, SitesSnapshot } from '@lookout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../../../test/helpers.ts';
import { FakeDocker, makeContainer } from '../../../test-support/fake-docker.ts';
import type { InspectedContainer } from '../../docker/parse.ts';
import type { CheckOptions, SiteChecker } from '../../sites/check.ts';
import { siteId } from '../../sites/discovery.ts';
import { MAX_SITES } from '../../sites/monitor.ts';
import { HOST, ORIGIN, startProbeApp, type ProbeApp } from './harness.ts';

// ---------------------------------------------------------------------------------------
// Harness

let probe: ProbeApp | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await probe?.close();
  probe = undefined;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Listener {
  port: number;
  requests: { method: string; url: string; host: string; userAgent: string }[];
}

/** A listener on 127.0.0.1 only, recording every request it receives. */
async function listen(
  handler: Handler,
  options: { https?: { key: string; cert: string } } = {},
): Promise<Listener> {
  const requests: Listener['requests'] = [];
  const wrapped: Handler = (request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      host: request.headers.host ?? '',
      userAgent: request.headers['user-agent'] ?? '',
    });
    handler(request, response);
  };
  const server = options.https ? createHttpsServer(options.https, wrapped) : createServer(wrapped);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** A Container whose labels came from its Image (`LABEL …` in a Dockerfile). */
function imageLabelled(
  labels: Record<string, string>,
  name = 'pulled-from-a-registry',
  publishes: number[] = [],
) {
  return makeContainer({
    id: `e${'0'.repeat(62)}e`,
    name,
    image: 'registry.example/innocent-looking:latest',
    labels,
    ports: publishes.map((port) => ({
      privatePort: port,
      publicPort: port,
      protocol: 'tcp' as const,
      ip: '0.0.0.0',
    })),
  });
}

/** A Container that serves its own Hosted Site on a port it publishes on the Host. */
const serving = (url: string, port: number) =>
  imageLabelled({ 'lookout.url': url }, 'serves-its-own-site', [port]);

interface Started {
  probe: ProbeApp;
  cookie: string;
}

async function start(
  containers: InspectedContainer[],
  options: { checker?: SiteChecker; sites?: string[]; now?: () => number } = {},
): Promise<Started> {
  probe = await startProbeApp({
    docker: new FakeDocker(containers),
    startSiteMonitor: false,
    ...(options.checker ? { siteChecker: options.checker } : {}),
    ...(options.now ? { now: options.now } : {}),
    config: { sites: options.sites ?? [], siteTimeoutMs: 3000 },
  });
  return { probe, cookie: await probe.signIn() };
}

/** The Hosted Sites, once discovery has seen the Container list. */
async function sites({ probe, cookie }: Started, atLeast = 1): Promise<HostedSite[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await probe.app.inject({ url: '/api/sites', headers: { cookie, host: HOST } });
    const snapshot = response.json<SitesSnapshot>();
    if (snapshot.sites.length >= atLeast) return snapshot.sites;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No Hosted Sites were discovered');
}

function checkNow({ probe, cookie }: Started, id: string, payload?: object) {
  return probe.app.inject({
    method: 'POST',
    url: `/api/sites/${id}/check`,
    headers: { cookie, origin: ORIGIN, host: HOST },
    ...(payload ? { payload } : {}),
  });
}

/** Check now on a Hosted Site by URL, through the API, with the real check engine. */
async function checkUrl(started: Started, url: string): Promise<HostedSite> {
  await sites(started);
  const response = await checkNow(started, siteId(url));
  expect(response.statusCode, response.body).toBe(200);
  return response.json<HostedSite>();
}

/** A checker that records what it was asked to check and connects nowhere. */
function recordingChecker() {
  const calls: { url: string; options: CheckOptions }[] = [];
  const checker: SiteChecker = async (url, options) => {
    calls.push({ url, options });
    return {
      timestamp: Date.now(),
      status: 'down',
      statusCode: null,
      error: 'Connection refused',
      responseMs: null,
      redirect: null,
      tls: null,
    } satisfies SiteCheck;
  };
  return { calls, checker };
}

/** Loopback, link-local (cloud metadata) and private (RFC 1918, ULA) addresses. */
const INTERNAL =
  /^(127\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|\[f[cd]|\[fe80|localhost$|0\.0\.0\.0)/;

// ---------------------------------------------------------------------------------------
// H4: what an Image publisher's labels make Lookout fetch

describe('S1 H4: labels choose what Lookout fetches', () => {
  /** What an Image on any registry may carry: no operator wrote any of it. */
  const HOSTILE_LABELS = {
    'lookout.url': [
      'http://127.0.0.1:2375/containers/json',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://[fd00:ec2::254]/latest/meta-data/',
      'http://10.0.0.1:8500/v1/agent/self',
      'http://192.168.1.1/cgi-bin/luci',
    ].join(','),
    'lookout.check': 'public',
    'traefik.http.routers.x.rule': 'Host(`169.254.169.254`) || Host(`metadata.google.internal`)',
  };

  it('checks no Hosted Site an Image names at a loopback, link-local or private address in public mode', async () => {
    const { calls, checker } = recordingChecker();
    const started = await start([imageLabelled(HOSTILE_LABELS)], { checker });
    for (const site of await sites(started, 5)) await checkNow(started, site.id);
    const dialled = calls
      .filter((call) => call.options.checkPublic)
      .map((call) => new URL(call.url).host);
    expect(dialled.filter((host) => INTERNAL.test(host))).toEqual([]);
  });

  it('every internal address an Image names is shown with the reason it is not checked, and never handed to the checker (regression)', async () => {
    const { calls, checker } = recordingChecker();
    const started = await start([imageLabelled(HOSTILE_LABELS)], { checker });
    const found = await sites(started, 5);
    for (const site of found) expect((await checkNow(started, site.id)).statusCode).toBe(200);
    const shown = (await sites(started, 5)).filter((site) => site.last !== null);
    const refused = shown
      .filter((site) => site.last?.error?.startsWith('Not checked: public mode'))
      .map((site) => site.url);
    expect(refused).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:2375/containers/json',
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'http://[fd00:ec2::254]/latest/meta-data/',
        'http://10.0.0.1:8500/v1/agent/self',
        'http://192.168.1.1/cgi-bin/luci',
        'http://169.254.169.254/',
      ]),
    );
    // A name is handed on; checkSite resolves it through the filtering lookup (s1-dial).
    expect(calls.map((call) => call.url)).toEqual(['http://metadata.google.internal/']);
  });

  it("a label cannot point checks at another service's loopback port and path", async () => {
    const admin = await listen((_request, response) => response.writeHead(200).end('ok'));
    const url = `http://admin.internal:${admin.port}/admin/flush?all=1`;
    // The Container publishes nothing; the port belongs to some other service on the Host.
    const started = await start([imageLabelled({ 'lookout.url': url })]);
    await checkUrl(started, url);
    expect(admin.requests).toEqual([]);
  });

  it('a label naming another loopback port gets no request, no status and no timing, only the reason (regression)', async () => {
    const admin = await listen((_request, response) =>
      response.writeHead(302, { location: 'http://127.0.0.1/internal/next?token=abc' }).end(),
    );
    const url = `http://admin.internal:${admin.port}/admin/flush?all=1`;
    const started = await start([imageLabelled({ 'lookout.url': url })]);
    const site = await checkUrl(started, url);
    expect(admin.requests).toEqual([]);
    expect(site.last).toMatchObject({
      status: 'down',
      statusCode: null,
      responseMs: null,
      redirect: null,
      error: `Not checked: port ${admin.port} is not one this Container publishes; list the URL in LOOKOUT_SITES to check it`,
    });
  });

  it('a name that resolves to loopback is not dialled in public mode (DNS rebinding)', async () => {
    const service = await listen((_request, response) => response.writeHead(204).end());
    // `localhost` resolves through the hosts file, not the network: a stand-in for any name
    // whose DNS answer is, or is rebound to, an internal address.
    const url = `http://localhost:${service.port}/`;
    const started = await start([imageLabelled({ 'lookout.url': url, 'lookout.check': 'public' })]);
    await checkUrl(started, url);
    expect(service.requests).toEqual([]);
  });

  it('public mode refuses a name that resolves to loopback, and the page says why (regression)', async () => {
    const service = await listen((_request, response) => response.writeHead(204).end());
    const url = `http://localhost:${service.port}/`;
    const started = await start([imageLabelled({ 'lookout.url': url, 'lookout.check': 'public' })]);
    const site = await checkUrl(started, url);
    expect(site.checkPublic).toBe(true);
    expect(service.requests).toEqual([]);
    expect(site.last).toMatchObject({
      status: 'down',
      error: 'Not checked: public mode never connects to an internal address',
    });
  });
});

describe('S1 H4: lookout.self from an Image', () => {
  const claimsSelf = () =>
    makeContainer({
      id: `f${'0'.repeat(62)}f`,
      name: 'miner',
      image: 'registry.example/miner:latest',
      labels: { 'lookout.self': 'true' },
      env: [{ name: 'POOL', value: 'made-up-pool' }],
      // What the Engine client reports when the Image itself carries the label (#105).
      selfClaimedByImage: true,
    });

  it('a Container that is not Lookout cannot make itself unstoppable by its labels', async () => {
    const started = await start([claimsSelf()]);
    const response = await started.probe.app.inject({
      method: 'POST',
      url: '/api/containers/miner/actions/stop',
      headers: { cookie: started.cookie, origin: ORIGIN, host: HOST },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
  });

  it("an Image's lookout.self=true no longer protects its Container, while the operator's own label still does (regression)", async () => {
    const operators = makeContainer({
      id: `a${'0'.repeat(62)}a`,
      name: 'lookout',
      labels: { 'lookout.self': 'true' },
    });
    const started = await start([claimsSelf(), operators]);
    const act = (name: string, action: string) =>
      started.probe.app.inject({
        method: 'POST',
        url: `/api/containers/${name}/actions/${action}`,
        headers: { cookie: started.cookie, origin: ORIGIN, host: HOST },
        payload: { confirmName: name },
      });
    expect((await act('miner', 'restart')).statusCode).toBe(200);
    const reveal = await started.probe.app.inject({
      url: '/api/containers/miner/env/POOL',
      headers: { cookie: started.cookie, host: HOST },
    });
    expect(reveal.statusCode).toBe(200);
    for (const action of ['stop', 'restart']) {
      expect((await act('lookout', action)).statusCode, action).toBe(403);
    }
  });
});

describe(`S1 H4: ${MAX_SITES} labelled Hosted Sites crowd out LOOKOUT_SITES`, () => {
  const SHOP = 'https://shop.example/';
  /** One label listing 500 hosts that sort before the operator's own. */
  const crowd = () =>
    imageLabelled({
      'lookout.url': Array.from(
        { length: MAX_SITES },
        (_, i) => `http://a${String(i).padStart(3, '0')}.example/`,
      ).join(','),
    });

  it("the operator's LOOKOUT_SITES are always checked, whatever Containers label", async () => {
    const { checker } = recordingChecker();
    const started = await start([crowd()], { checker, sites: [SHOP] });
    const found = await sites(started, 2);
    expect(found.map((site) => site.url)).toContain(SHOP);
  });

  it("one Container's label names at most 20 Hosted Sites, and the operator's own stays checked (regression)", async () => {
    const { calls, checker } = recordingChecker();
    const started = await start([crowd()], { checker, sites: [SHOP] });
    const found = await sites(started, 21);
    expect(found).toHaveLength(21);
    expect(found.map((site) => site.url)).toContain(SHOP);
    expect(found.filter((site) => site.containerName === 'pulled-from-a-registry')).toHaveLength(
      20,
    );
    expect((await checkNow(started, siteId(SHOP))).statusCode).toBe(200);
    expect(calls.map((call) => call.url)).toContain(SHOP);
  });
});

// ---------------------------------------------------------------------------------------
// Good and to confirm: the check engine's bounds, through the API with the real engine

describe('S1 confirm: what a check reads, follows and trusts', () => {
  it('follows no redirect, even to an internal address, and keeps at most 2 KiB of it', async () => {
    const internal = await listen((_request, response) => response.writeHead(200).end());
    const target = `http://127.0.0.1:${internal.port}/containers/json?${'q'.repeat(5000)}`;
    const redirector = await listen((_request, response) =>
      response.writeHead(302, { location: target }).end(),
    );
    const url = `http://redirect.example:${redirector.port}/`;
    const started = await start([serving(url, redirector.port)]);
    const site = await checkUrl(started, url);
    expect(internal.requests).toEqual([]);
    expect(site.last?.statusCode).toBe(302);
    expect(site.last?.redirect).toBe(target.slice(0, 2048));
    expect(site.last?.redirect).toHaveLength(2048);
  });

  it('reads no body: a never-ending body does not hold the check', async () => {
    let written = 0;
    let closed = false;
    const endless = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      const pump = () => {
        while (!closed && response.write(chunk)) written += chunk.length;
      };
      request.socket.on('close', () => (closed = true));
      response.on('drain', pump);
      pump();
    });
    const url = `http://endless.example:${endless.port}/`;
    const started = await start([serving(url, endless.port)]);
    const site = await checkUrl(started, url);
    expect(site.last).toMatchObject({ status: 'up', statusCode: 200 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
    // Only what the socket buffers before Lookout closes it; never the body.
    expect(written).toBeLessThan(16 * 1024 * 1024);
  });

  it('caps response headers at 16 KiB', async () => {
    const big = await listen((_request, response) =>
      response.writeHead(200, { 'x-filler': 'h'.repeat(20 * 1024) }).end(),
    );
    const url = `http://headers.example:${big.port}/`;
    const started = await start([serving(url, big.port)]);
    const site = await checkUrl(started, url);
    expect(site.last).toMatchObject({ status: 'down', error: 'Response headers too large' });
  });

  // OpenSSL reports expiry before the unknown issuer; Lookout shows expiry as expiry, not as
  // an untrusted issuer, so `trusted` reads true there and the error names the expiry.
  for (const [name, cert, key, expected] of [
    ['an untrusted issuer', 'leaf.pem', 'leaf-key.pem', { trusted: false }],
    [
      'an expired, untrusted certificate',
      'leaf-expired.pem',
      'leaf-expired-key.pem',
      { error: 'CERT_HAS_EXPIRED' },
    ],
  ] as const) {
    it(`verifies TLS: ${name} is down, described, and no request is sent over it`, async () => {
      const tls = (file: string) => readFileSync(fixture(`tls/${file}`), 'utf8');
      const secure = await listen((_request, response) => response.writeHead(200).end(), {
        https: { cert: tls(cert), key: tls(key) },
      });
      const url = `https://secure.example:${secure.port}/`;
      const started = await start([serving(url, secure.port)]);
      const site = await checkUrl(started, url);
      expect(secure.requests).toEqual([]);
      expect(site.last?.status).toBe('down');
      expect(site.last?.tls).toMatchObject({ subject: 'secure.example', ...expected });
    });
  }

  it('Check now takes an ID only: a URL, a path or a body URL reaches nothing', async () => {
    const canary = await listen((_request, response) => response.writeHead(200).end());
    const canaryUrl = `http://127.0.0.1:${canary.port}/`;
    const { calls, checker } = recordingChecker();
    const known = 'https://shop.example/';
    const started = await start([], { checker, sites: [known] });
    await sites(started);
    for (const id of [
      encodeURIComponent(canaryUrl),
      siteId(canaryUrl),
      `${siteId(known)}x`,
      siteId(known).toUpperCase(),
      '..%2f..%2fapi',
    ]) {
      expect((await checkNow(started, id)).statusCode, id).toBe(404);
    }
    const ok = await checkNow(started, siteId(known), { url: canaryUrl, site: canaryUrl });
    expect(ok.statusCode).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([known]);
    expect(canary.requests).toEqual([]);
  });

  it('Check now runs at most once every 5 s per Hosted Site, with Retry-After', async () => {
    let clock = Date.parse('2026-11-25T12:00:00Z');
    const { calls, checker } = recordingChecker();
    const known = 'https://shop.example/';
    const started = await start([], { checker, sites: [known], now: () => clock });
    await sites(started);
    expect((await checkNow(started, siteId(known))).statusCode).toBe(200);
    const limited = await checkNow(started, siteId(known));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('5');
    clock += 4999;
    expect((await checkNow(started, siteId(known))).statusCode).toBe(429);
    clock += 1;
    expect((await checkNow(started, siteId(known))).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
