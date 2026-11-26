/**
 * X1 (#69) against the pen-test deployment, in the configuration that is running: what the
 * real Image and the real Engine (json-file logs, its own frame headers) do with a long line
 * with no newline, a large label, and many streams from one session. Each value is shown
 * once at a small size (1 MiB); the large figures are arithmetic in docs/pen-test/findings/X1.md.
 * The in-process half, with each today_ test's it.fails partner, is x1-limits.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dindDocker } from '../deployment.ts';
import { FIXTURE_IMAGE } from '../fixtures/plan.ts';
import { connect, readUntil, type Deployment } from './deployment-harness.ts';

const MIB = 1024 * 1024;
const NO_NEWLINE = 'x1-no-newline';
const BIG_LABEL = 'x1-big-label';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
  for (const name of [NO_NEWLINE, BIG_LABEL]) {
    dindDocker(['rm', '--force', name], { allowFail: true });
  }
  // Writes 1 MiB with no newline, waits 5 s, then ends the line and idles.
  dindDocker([
    'run',
    '--detach',
    '--name',
    NO_NEWLINE,
    '--label',
    'lookout.pen-test.fixture=x1-no-newline',
    '--network',
    'none',
    '--entrypoint',
    'node',
    FIXTURE_IMAGE,
    '--eval',
    `process.stdout.write('L'.repeat(${MIB})); setTimeout(() => { process.stdout.write('\\n'); setInterval(() => {}, 1 << 30); }, 5000);`,
  ]);
  // A 1 MiB label: no argument can carry it (Linux's 128 KiB per argument) and Docker reads a
  // --label-file line of at most 64 KiB, so a one-off fixture Container creates it through the
  // throwaway daemon's own Engine API, the label in the JSON body.
  dindDocker([
    'run',
    '--rm',
    '--user',
    '0',
    '--network',
    'none',
    '--volume',
    '/var/run/docker.sock:/var/run/docker.sock',
    '--entrypoint',
    'node',
    FIXTURE_IMAGE,
    '--input-type=module',
    '--eval',
    `
    import { request } from 'node:http';
    const call = (method, path, body) => new Promise((resolve, reject) => {
      const req = request({ socketPath: '/var/run/docker.sock', method, path,
        headers: { 'content-type': 'application/json' } }, (res) => {
        let text = ''; res.on('data', (c) => (text += c));
        res.on('end', () => res.statusCode < 300 ? resolve(text) : reject(new Error(res.statusCode + ' ' + text)));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
    const created = JSON.parse(await call('POST', '/containers/create?name=${BIG_LABEL}', {
      Image: '${FIXTURE_IMAGE}', Cmd: ['idle'],
      Labels: { 'lookout.pen-test.fixture': 'x1-big-label', 'com.example.x1': '_'.repeat(${MIB}) },
      HostConfig: { NetworkMode: 'none' },
    }));
    await call('POST', '/containers/' + created.Id + '/start');
    `,
  ]);
});
afterAll(() => {
  for (const name of [NO_NEWLINE, BIG_LABEL]) {
    dindDocker(['rm', '--force', name], { allowFail: true });
  }
});

/** Lookout's memory in the deployment, as the daemon counts it. */
function lookoutMemory(): string {
  return (
    dindDocker(['stats', '--no-stream', '--format', '{{.MemUsage}}', 'lookout']) ?? ''
  ).trim();
}

/** Reads a log stream until `count` L's have arrived (or 20 s), returning every line sent. */
async function readLines(response: Response, count: number): Promise<{ text: string }[]> {
  const decoder = new TextDecoder();
  const lines: { text: string }[] = [];
  let pending = '';
  let ls = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const events = pending.split('\n\n');
    pending = events.pop() ?? '';
    for (const event of events) {
      const data = /^data: (.+)$/m.exec(event)?.[1];
      const parsed = data ? (JSON.parse(data) as unknown) : null;
      if (!Array.isArray(parsed)) continue;
      for (const line of parsed as { text: string }[]) {
        lines.push(line);
        ls += line.text.split('L').length - 1;
      }
    }
    if (ls >= count) break;
  }
  return lines;
}

describe('X1 H9: a log line with no newline', () => {
  it('1 MiB with no newline is sent in pieces of at most 64 KiB (regression)', async () => {
    const id = await deployment.idOf(NO_NEWLINE);
    const controller = new AbortController();
    const response = await deployment.api(`/api/containers/${id}/logs?tail=100`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    });
    expect(response.status).toBe(200);
    const lines = await readLines(response, MIB);
    controller.abort();
    const longest = Math.max(...lines.map((l) => l.text.length));
    const total = lines.reduce((sum, l) => sum + l.text.split('L').length - 1, 0);
    console.log(
      `[${deployment.configuration}] ${lines.length} lines, longest ${longest} characters, ${total} L's; Lookout ${lookoutMemory()}`,
    );
    expect(total).toBeGreaterThanOrEqual(MIB);
    expect(longest).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('X1 H9: a 1 MiB label', () => {
  it('the 1 MiB label is masked, never sent, in the containers event of /api/stream (regression)', async () => {
    await deployment.idOf(BIG_LABEL);
    const response = await deployment.api('/api/stream', { signal: AbortSignal.timeout(20_000) });
    const text = await readUntil(response, 'event: sites');
    const containers = /event: containers\ndata: (.+)\n/.exec(text)![1]!;
    console.log(`[${deployment.configuration}] containers event: ${containers.length} bytes`);
    expect(containers.length).toBeLessThan(MIB);
    expect(containers).not.toContain('_'.repeat(8 * 1024));
  });
});

describe('X1 H9: the Hostile Container’s 64 KiB label of letters', () => {
  it('every Container list answers within half a second; the masking check is linear (regression)', async () => {
    const started = performance.now();
    const response = await deployment.api('/api/containers');
    await response.text();
    const ms = performance.now() - started;
    console.log(`[${deployment.configuration}] GET /api/containers: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  });
});

describe('X1 H9: streams per session', () => {
  it('one session gets 8 of 20 log streams opened at once; the rest 429 (regression)', async () => {
    const id = await deployment.idOf('victim');
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    try {
      const responses = await Promise.all(
        controllers.map((c) =>
          deployment.api(`/api/containers/${id}/logs?tail=100`, { signal: c.signal }),
        ),
      );
      const statuses = responses.map((r) => r.status);
      console.log(
        `[${deployment.configuration}] 20 log streams asked for: ${statuses.filter((s) => s === 200).length} open, ${statuses.filter((s) => s === 429).length} refused; Lookout ${lookoutMemory()}`,
      );
      expect(statuses.filter((s) => s === 200)).toHaveLength(8);
      expect(statuses.filter((s) => s === 429)).toHaveLength(12);
    } finally {
      for (const c of controllers) c.abort();
    }
  });
});
