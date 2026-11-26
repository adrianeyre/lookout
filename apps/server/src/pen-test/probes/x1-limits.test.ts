/**
 * Pen-test scope issue X1 (#69): resource exhaustion, probed in-process. Findings are in
 * docs/pen-test/findings/X1.md. Every big number there is worked out by arithmetic; each is
 * shown here once, at a small size (a 1 MiB line, an 8 MiB body, 20 parallel requests at
 * most), never as a load. While a gap is open an `it.fails` states the property that should
 * hold, beside a `today_…` test pinning what happens now.
 */
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  FOLDER_SCAN_LIMITS,
  type ContainerSummary,
  type LogLine,
  type SiteCheck,
} from '@lookout/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, hashPassword, verifyPassword } from '../../auth/password.ts';
import { LoginRateLimiter } from '../../auth/rate-limit.ts';
import { EngineDockerClient, isOversized } from '../../docker/engine.ts';
import { LineSplitter, LogFrameDecoder } from '../../docker/parse.ts';
import { looksSecretValue } from '../../docker/secrets.ts';
import { ScanBudget, walkFilesystem } from '../../folders/scan.ts';
import { discoverSites } from '../../sites/discovery.ts';
import { MAX_SITES, SiteMonitor } from '../../sites/monitor.ts';
import { FakeDocker, makeContainer } from '../../../test-support/fake-docker.ts';
import { HOST, ORIGIN, startProbeApp, type ProbeApp } from './harness.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

/** The figures X1 recommends to X1b (findings/X1.md, "Numbers for X1b"). */
const RECOMMENDED = {
  lineBytes: 64 * KIB,
  engineBodyBytes: 4 * MIB,
  streamsPerSession: 8,
  stalledStreamBytes: 1 * MIB,
  siteUrlLength: 2048,
} as const;

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** Heap in use after a full collection. */
function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let probe: ProbeApp | null = null;
const servers: Server[] = [];
const sockets: Socket[] = [];
const aborts: AbortController[] = [];
afterEach(async () => {
  for (const controller of aborts.splice(0)) controller.abort();
  for (const socket of sockets.splice(0)) socket.destroy();
  await probe?.close();
  probe = null;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

let listeningAt = { url: '', cookie: '' };
const probeUrl = () => listeningAt.url;
const probeCookie = () => listeningAt.cookie;

/** The real app on a real port, signed in. */
async function listening(docker: FakeDocker) {
  probe = await startProbeApp({ docker, logFlushMs: 10 });
  await probe.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = probe.app.server.address() as AddressInfo;
  const cookie = await probe.signIn();
  listeningAt = { url: `http://127.0.0.1:${port}`, cookie };
  const get = (url: string) => {
    const controller = new AbortController();
    aborts.push(controller);
    return fetch(`http://127.0.0.1:${port}${url}`, {
      headers: { cookie },
      signal: controller.signal,
    });
  };
  return { port, cookie, get, app: probe.app };
}

/** Reads a streamed response until `marker` has arrived. */
async function readUntil(response: Response, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(marker)) break;
  }
  return text;
}

/** A fake Engine on a real port: inspect answers with `labels`, logs by `writeLogs`. */
async function fakeEngine(options: {
  labels?: Record<string, string>;
  tty?: boolean;
  writeLogs?: (response: ServerResponse) => void;
}): Promise<EngineDockerClient> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://docker');
    if (/^\/containers\/[^/]+\/json$/.test(url.pathname)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          Id: 'abc123',
          Name: '/hostile',
          Image: 'sha256:feed',
          Config: { Image: 'example:1', Tty: options.tty ?? false, Labels: options.labels ?? {} },
          State: { Status: 'running', StartedAt: '2026-11-25T00:00:00Z' },
        }),
      );
      return;
    }
    if (url.pathname.startsWith('/images/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"RepoDigests":[]}');
      return;
    }
    if (url.pathname.endsWith('/logs') && options.writeLogs) {
      response.writeHead(200);
      options.writeLogs(response);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no"}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return new EngineDockerClient({ host: '127.0.0.1', port });
}

/** A Docker log frame: [stream, 0, 0, 0, size] then the payload. */
function frame(payload: Buffer, claimedSize = payload.length): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(claimedSize, 4);
  return Buffer.concat([header, payload]);
}

/** Follows a Container's logs through the Engine client, collecting what it yields. */
function follow(client: EngineDockerClient) {
  const controller = new AbortController();
  aborts.push(controller);
  const lines: LogLine[] = [];
  const done = (async () => {
    for await (const line of client.logs('abc123', { tail: 100, follow: true }, controller.signal))
      lines.push(line);
  })().catch(() => undefined);
  return { lines, done, stop: () => controller.abort() };
}

/** Writes `bytes` of 'L' with no newline in 16 KiB pieces, framed as json-file does or raw. */
function writeLongLine(response: ServerResponse, bytes: number, framed: boolean) {
  const piece = Buffer.alloc(16 * KIB, 'L');
  for (let written = 0; written < bytes; written += piece.length) {
    response.write(framed ? frame(piece) : piece);
  }
}

describe('X1 H9: a log line with no newline', () => {
  /** Pushes 1 MiB with no newline in 16 KiB chunks; returns every line handed on. */
  function pushMiB(splitter: LineSplitter): string[] {
    const out: string[] = [];
    for (let i = 0; i < 64; i++) out.push(...splitter.push('L'.repeat(16 * KIB)));
    return out;
  }

  it('LineSplitter hands a 1 MiB line with no newline on in 64 KiB pieces, never whole (regression)', () => {
    const splitter = new LineSplitter();
    const pieces = pushMiB(splitter);
    expect(pieces).toHaveLength(15);
    const [held] = splitter.flush();
    expect(held).toHaveLength(RECOMMENDED.lineBytes);
    expect([...pieces, held!].join('')).toHaveLength(MIB);
  });

  it('LineSplitter holds at most 64 KiB of a line with no newline', () => {
    const splitter = new LineSplitter();
    const out = [...pushMiB(splitter), ...splitter.flush()];
    for (const line of out) expect(line.length).toBeLessThanOrEqual(RECOMMENDED.lineBytes);
  });

  it('each 16 KiB chunk is read once, however long the line held (regression)', () => {
    // 8 MiB in 16 KiB chunks: 512 pushes. Each used to split all that was held so far.
    const splitter = new LineSplitter();
    const started = performance.now();
    const out: string[] = [];
    for (let i = 0; i < 512; i++) out.push(...splitter.push('L'.repeat(16 * KIB)));
    const ms = performance.now() - started;
    console.log(
      `[in-process] LineSplitter, 8 MiB with no newline in 16 KiB chunks: ${ms.toFixed(0)} ms`,
    );
    out.push(...splitter.flush());
    expect(out).toHaveLength(128);
    expect(out.every((line) => line.length === RECOMMENDED.lineBytes)).toBe(true);
  });

  it('a header claiming 4 GiB holds nothing: its payload is passed on as it comes (regression)', () => {
    const decoder = new LogFrameDecoder();
    const out: LogLine[] = [];
    const piece = Buffer.alloc(64 * KIB, 'L');
    out.push(...decoder.push(frame(piece, 2 ** 32 - 1)));
    for (let i = 1; i < 16; i++) out.push(...decoder.push(piece));
    expect(out).toHaveLength(15);
    for (const line of out) expect(line.text.length).toBeLessThanOrEqual(RECOMMENDED.lineBytes);
  });

  it('the frame decoder never waits for more than 64 KiB of one frame', () => {
    const decoder = new LogFrameDecoder();
    const out: LogLine[] = [];
    const piece = Buffer.alloc(64 * KIB, 'L');
    out.push(...decoder.push(frame(piece, 2 ** 32 - 1)));
    out.push(...decoder.push(piece));
    expect(out.length).toBeGreaterThan(0);
  });

  for (const tty of [true, false]) {
    const kind = tty
      ? 'a TTY Container (raw stream)'
      : 'a non-TTY Container (16 KiB json-file frames)';
    it(`through the Engine client, ${kind}: 1 MiB with no newline is sent in 64 KiB pieces (regression)`, async () => {
      let logs!: ServerResponse;
      const client = await fakeEngine({ tty, writeLogs: (response) => (logs = response) });
      const followed = follow(client);
      await vi.waitFor(() => expect(logs).toBeDefined());
      writeLongLine(logs, MIB, !tty);
      await vi.waitFor(() => expect(followed.lines).toHaveLength(15));
      logs.write(tty ? Buffer.from('\n') : frame(Buffer.from('\n')));
      await vi.waitFor(() => expect(followed.lines).toHaveLength(16));
      for (const line of followed.lines) {
        expect(line.text).toHaveLength(RECOMMENDED.lineBytes);
      }
      followed.stop();
    });
  }
});

describe('X1 H9: Engine bodies are read whole', () => {
  const big = { 'com.example.big': 'B'.repeat(8 * MIB) };

  it('an 8 MiB inspect body is abandoned past 4 MiB: the Container is listed with nothing read from it (regression)', async () => {
    const client = await fakeEngine({ labels: big });
    const inspected = await client.inspectContainer('abc123');
    expect(isOversized(inspected!)).toBe(true);
    expect(inspected!.labels).toEqual({});
    expect(inspected!.env).toEqual([]);
  });

  // Turned with a different shape than first written: rather than throw (which would end
  // the Container list, and so hide every Container, for one Container's labels), the
  // client never holds the answer and lists the Container as one it could not read.
  it('never keeps an Engine answer over 4 MiB, and refuses detail and actions on it', async () => {
    const client = await fakeEngine({ labels: big });
    expect(JSON.stringify(await client.inspectContainer('abc123')).length).toBeLessThan(
      RECOMMENDED.engineBodyBytes,
    );
    probe = await startProbeApp({ docker: client as unknown as FakeDocker });
    const cookie = await probe.signIn();
    for (const [method, url] of [
      ['GET', '/api/containers/abc123'],
      ['POST', '/api/containers/abc123/actions/stop'],
    ] as const) {
      const response = await probe.app.inject({
        method,
        url,
        headers: { cookie, host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
        ...(method === 'POST' ? { payload: '{}' } : {}),
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: "Docker's answer for this Container is too large to read",
      });
    }
  });

  it('a 1 MiB label goes out masked, not whole, in the containers event (regression)', async () => {
    const docker = new FakeDocker([
      // Underscores, not letters: a long run of letters trips the masking regex (below).
      makeContainer({ id: 'big', name: 'big', labels: { 'com.example.big': '_'.repeat(MIB) } }),
    ]);
    const { get } = await listening(docker);
    const first = await readUntil(await get('/api/stream'), 'event: sites');
    const containers = /event: containers\ndata: (.+)\n/.exec(first)![1]!;
    expect(containers.length).toBeLessThan(8 * KIB);
  });
});

describe('X1 H9: masking a long label blocks the event loop', () => {
  /** How long the secret-value check takes on `kib` KiB of letters. */
  function maskMs(kib: number): number {
    const value = 'L'.repeat(kib * KIB);
    const started = performance.now();
    looksSecretValue(value);
    return performance.now() - started;
  }

  it('1 MiB of letters is checked in well under 100 ms, and masked unchecked (regression)', () => {
    maskMs(1); // warm up
    const ms = maskMs(1024);
    console.log(`[in-process] looksSecretValue on 1 MiB of letters: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
    expect(looksSecretValue('L'.repeat(MIB))).toBe(true);
  });

  // Turned with a sharper shape: values over 8 KiB are no longer checked at all, so a ratio
  // of two sizes would time nothing. What matters is the worst value that is checked.
  it('checking a value for a secret is linear in its length', () => {
    maskMs(1);
    const worst = [
      'L'.repeat(8 * KIB),
      'a:'.repeat(4 * KIB),
      'a://'.repeat(2 * KIB),
      `a://${':'.repeat(8 * KIB - 4)}`,
      `${'a'.repeat(4 * KIB)}://${'b:'.repeat(2 * KIB - 2)}`,
    ];
    for (const value of worst) {
      expect(value.length).toBeLessThanOrEqual(8 * KIB);
      const started = performance.now();
      looksSecretValue(value);
      expect(performance.now() - started).toBeLessThan(10);
    }
    // And it still finds what the pattern found.
    expect(looksSecretValue('postgres://app:hunter2@db:5432/app')).toBe(true);
    expect(looksSecretValue(`${'L'.repeat(8000)}x://u:p@h`)).toBe(true);
    expect(looksSecretValue('https://example.com/a:b@c')).toBe(false);
    expect(looksSecretValue('123://u:p@h')).toBe(false);
    expect(looksSecretValue('x://u:@h')).toBe(false);
  });
});

describe('X1 H9: streams per session', () => {
  it('one session gets 8 of 20 log streams, and 8 Docker follow requests; the rest 429 (regression)', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc', name: 'web' })]);
    const { get } = await listening(docker);
    // 20 at once, the rules of engagement's most.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => get('/api/containers/abc/logs')),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(RECOMMENDED.streamsPerSession);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12);
    const refused = responses.find((r) => r.status === 429)!;
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(await refused.json()).toEqual({ error: 'Too many open streams' });
    await vi.waitFor(() => expect(docker.openStreams('logs')).toBe(8));
  });

  it('one session gets 8 of 20 live streams (regression)', async () => {
    const { get } = await listening(new FakeDocker());
    const responses = await Promise.all(Array.from({ length: 20 }, () => get('/api/stream')));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(RECOMMENDED.streamsPerSession);
  });

  it('a closed stream is given back: the session may open another', async () => {
    const { get } = await listening(new FakeDocker());
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const open = await Promise.all(
      controllers.map((controller) =>
        fetch(`${probeUrl()}/api/stream`, {
          headers: { cookie: probeCookie() },
          signal: controller.signal,
        }),
      ),
    );
    expect(open.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect((await get('/api/stream')).status).toBe(429);
    controllers[0]!.abort();
    await vi.waitFor(async () => expect((await get('/api/stream')).status).toBe(200));
    for (const controller of controllers) controller.abort();
  });

  it('Lookout holds at most 32 streams from every session together', async () => {
    const { get } = await listening(new FakeDocker());
    const cookies = [probeCookie()];
    for (let i = 0; i < 4; i++) cookies.push(await probe!.signIn());
    const opened: number[] = [];
    for (const cookie of cookies) {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => {
          const controller = new AbortController();
          aborts.push(controller);
          return fetch(`${probeUrl()}/api/stream`, {
            headers: { cookie },
            signal: controller.signal,
          });
        }),
      );
      opened.push(responses.filter((r) => r.status === 200).length);
    }
    expect(opened).toEqual([8, 8, 8, 8, 0]);
    expect((await get('/api/stream')).status).toBe(429);
  });

  it('refuses a session more than 8 open streams', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'abc', name: 'web' })]);
    const { get } = await listening(docker);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => get('/api/containers/abc/logs')),
    );
    const open = responses.filter((r) => r.status === 200).length;
    expect(open).toBeLessThanOrEqual(RECOMMENDED.streamsPerSession);
  });
});

describe('X1 H9: a live stream nobody reads', () => {
  /**
   * Opens /api/stream on a raw socket that never reads, then changes a Container with a
   * 256 KiB label 64 times (16 MiB of events). Returns what the server holds for it.
   */
  async function stalledStream(): Promise<number> {
    const docker = new FakeDocker([makeContainer({ id: 'big', name: 'big' })]);
    const { port, cookie, app } = await listening(docker);
    const accepted: Socket[] = [];
    app.server.on('connection', (socket: Socket) => accepted.push(socket));
    const client = connect({ host: '127.0.0.1', port });
    sockets.push(client);
    await new Promise((resolve) => client.once('connect', resolve));
    client.pause();
    client.write(
      `GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\n`,
    );
    await vi.waitFor(() => expect(accepted).toHaveLength(1));
    await sleep(100);
    for (let i = 0; i < 64; i++) {
      docker.upsert(
        makeContainer({
          id: 'big',
          name: 'big',
          labels: { 'com.example.big': `${i}`.padEnd(256 * KIB, '_') },
        }),
      );
      await sleep(70); // past the store's 50 ms broadcast debounce
    }
    const held = accepted[0]!.destroyed ? 0 : accepted[0]!.writableLength;
    console.log(
      `[in-process] a stalled /api/stream after 16 MiB of events holds ${(held / MIB).toFixed(1)} MiB`,
    );
    return held;
  }

  it('a stalled /api/stream is closed rather than holding every event (regression)', async () => {
    // 0: the server closed it once its backlog passed 1 MiB.
    expect(await stalledStream()).toBe(0);
  }, 30_000);

  it('a stalled /api/stream holds at most 1 MiB, then is closed', async () => {
    expect(await stalledStream()).toBeLessThanOrEqual(RECOMMENDED.stalledStreamBytes);
  }, 30_000);
});

describe('X1 H3: sign-in, re-measured after #81 and #82', () => {
  it('one Argon2id check at production cost (m=19456, t=2, p=1)', async () => {
    const hash = await hashPassword('made-up-pen-test-password', DEFAULT_PARAMS);
    const started = performance.now();
    expect(await verifyPassword('wrong', hash)).toBe(false);
    const ms = performance.now() - started;
    console.log(
      `[in-process] one Argon2id verification: ${ms.toFixed(0)} ms, ${DEFAULT_PARAMS.memory} KiB`,
    );
    expect(DEFAULT_PARAMS.memory * KIB).toBe(19 * MIB);
  });

  it('at most 4 password checks run at once, from 20 addresses in parallel (sound)', async () => {
    const hash = await hashPassword('made-up-pen-test-password', DEFAULT_PARAMS);
    probe = await startProbeApp({ config: { passwordHash: hash } });
    const app = probe.app;
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/login',
          remoteAddress: `10.69.0.${i + 1}`,
          headers: { origin: ORIGIN, host: HOST },
          payload: { password: 'wrong' },
        }),
      ),
    );
    const checked = responses.filter((r) => r.statusCode === 401).length;
    const refused = responses.filter((r) => r.statusCode === 429);
    console.log(
      `[in-process] 20 parallel sign-ins from 20 addresses: ${checked} checked, ${refused.length} × 429`,
    );
    expect(checked).toBeLessThanOrEqual(4);
    expect(refused.length).toBeGreaterThanOrEqual(16);
    for (const r of refused) expect(r.headers['retry-after']).toBe('1');
  });

  it('the limiter with 10,000 keys of 5 failures each holds about 3 MiB (sound)', () => {
    const before = heapUsed();
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10_000; i++) {
      const address = `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`;
      for (let j = 0; j < 5; j++) limiter.recordFailure(address);
    }
    const bytes = heapUsed() - before;
    console.log(`[in-process] limiter, 10,000 keys × 5 failures: ${(bytes / MIB).toFixed(2)} MiB`);
    expect(limiter.retryAfterSeconds('2001:db8:0:0::1')).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(8 * MIB);
  });

  it('past 10,000 other addresses, a limited address is still limited; new ones wait (regression)', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(5, 15 * 60_000, () => now);
    for (let j = 0; j < 5; j++) limiter.recordFailure('192.0.2.1');
    expect(limiter.retryAfterSeconds('192.0.2.1')).toBeGreaterThan(0);
    // 10,000 others with one failure each push out only keys that are not limited (#120).
    for (let i = 0; i < 10_000; i++)
      limiter.recordFailure(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.retryAfterSeconds('192.0.2.1')).toBeGreaterThan(0);

    // Every key held limited: a new address is refused, with when to try again.
    const full = new LoginRateLimiter(5, 15 * 60_000, () => now, { maxKeys: 3 });
    for (const address of ['192.0.2.1', '192.0.2.2', '192.0.2.3'])
      for (let j = 0; j < 5; j++) full.recordFailure(address);
    const refused = full.begin('192.0.2.9');
    expect('retryAfterSeconds' in refused && refused.retryAfterSeconds).toBe(15 * 60);
    expect(full.retryAfterSeconds('192.0.2.1')).toBeGreaterThan(0);
    // Once the window has passed they are forgotten and the new address may try.
    now += 15 * 60_000 + 1;
    expect('finish' in full.begin('192.0.2.9')).toBe(true);
  });

  it('a limited address stays limited however many others fail', () => {
    const limiter = new LoginRateLimiter();
    for (let j = 0; j < 5; j++) limiter.recordFailure('192.0.2.1');
    for (let i = 0; i < 10_000; i++)
      limiter.recordFailure(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.retryAfterSeconds('192.0.2.1')).toBeGreaterThan(0);
  });

  it('today_nothing limits failures across addresses: 30 addresses fail 150 times in one window', () => {
    const limiter = new LoginRateLimiter();
    let allowed = 0;
    for (let a = 1; a <= 30; a++) {
      for (let j = 0; j < 6; j++) {
        if (limiter.retryAfterSeconds(`192.0.2.${a}`) === 0) {
          allowed += 1;
          limiter.recordFailure(`192.0.2.${a}`);
        }
      }
    }
    expect(allowed).toBe(150);
  });
});

describe('X1: Hosted Sites', () => {
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined };
  const up = (): SiteCheck => ({
    timestamp: 0,
    status: 'up',
    statusCode: 200,
    error: null,
    responseMs: 1,
    redirect: null,
    tls: null,
  });

  function monitor(urls: string[], checker: (url: string) => Promise<SiteCheck>) {
    return new SiteMonitor({
      urls,
      intervalMs: 60_000,
      timeoutMs: 1000,
      slowMs: 500,
      tls: { warnDays: 14, criticalDays: 3 },
      liveWindowMs: 15 * 60_000,
      log,
      checker,
    });
  }

  it('Check now on 20 Hosted Sites at once runs at most 4 checks, and each once per 5 s (sound)', async () => {
    let running = 0;
    let most = 0;
    const checker = async () => {
      running += 1;
      most = Math.max(most, running);
      await sleep(20);
      running -= 1;
      return up();
    };
    const urls = Array.from({ length: 20 }, (_, i) => `http://site-${i}.pen-test.example/`);
    const sites = monitor(urls, checker);
    const ids = sites.snapshot.sites.map((s) => s.id);
    const first = await Promise.all(ids.map((id) => sites.checkNow(id)));
    expect(first.every((r) => r.result === 'checked')).toBe(true);
    expect(most).toBe(4);
    const again = await sites.checkNow(ids[0]!);
    expect(again.result).toBe('limited');
    expect((await sites.checkNow('0000000000000000')).result).toBe('unknown');
    sites.stop();
  });

  it(`keeps at most ${MAX_SITES} Hosted Sites (sound; who is crowded out is S1's)`, () => {
    const urls = Array.from(
      { length: 600 },
      (_, i) => `http://s${String(i).padStart(3, '0')}.pen-test.example/`,
    );
    const sites = monitor(urls, async () => up());
    expect(sites.snapshot.sites).toHaveLength(MAX_SITES);
    sites.stop();
  });

  const longUrls = Array.from(
    { length: 8 },
    (_, i) => `http://127.0.0.1:${8000 + i}/${'p'.repeat(64 * KIB)}`,
  ).join(',');
  const labelled = {
    id: 'h',
    name: 'hostile',
    labels: { 'lookout.url': longUrls },
  } as unknown as ContainerSummary;

  it('a Hosted Site URL from a label over 2,048 characters is skipped, so none of 8 × 64 KiB is kept (#121) (regression)', () => {
    const { sites, skipped } = discoverSites([labelled], []);
    expect(sites).toEqual([]);
    expect(skipped).toHaveLength(8);
  });

  it('a Hosted Site URL over 2,048 characters is skipped', () => {
    const { sites } = discoverSites([labelled], []);
    for (const site of sites)
      expect(site.url.length).toBeLessThanOrEqual(RECOMMENDED.siteUrlLength);
  });
});

describe('X1: the Largest folders scan', () => {
  it('remembers at most FOLDER_SCAN_LIMITS.hardLinks hard-linked files, then says the result is partial (#109) (regression)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lookout-x1-links-'));
    try {
      await mkdir(path.join(root, 'a'));
      await mkdir(path.join(root, 'b'));
      const files = 500;
      for (let i = 0; i < files; i++) {
        await writeFile(path.join(root, 'a', `f${i}`), 'x'.repeat(8 * KIB));
        await link(path.join(root, 'a', `f${i}`), path.join(root, 'b', `f${i}`));
      }
      // Under the cap each file is counted once although it is in both folders.
      const once = await walkFilesystem(root, '/');
      const total = once.candidates.reduce((sum, c) => sum + c.bytes, 0);
      const perFile = total / files;
      expect(perFile).toBeGreaterThanOrEqual(8 * KIB);
      expect(perFile).toBeLessThan(12 * KIB);
      expect(once.partial).toBe(false);
      expect(FOLDER_SCAN_LIMITS.hardLinks).toBe(1_000_000);
      // Past it, no more keys are held: the walk goes on and says it is partial.
      const budget = new ScanBudget({ hardLinks: 100 });
      const capped = await walkFilesystem(root, '/', { budget });
      expect(budget.seenLinks.size).toBe(100);
      expect(capped.partial).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
