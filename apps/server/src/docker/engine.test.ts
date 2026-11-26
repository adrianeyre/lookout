import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSelf } from '@lookout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerErrorMessage } from '../app.ts';
import { EngineDockerClient, engineAddress } from './engine.ts';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** A fake Docker Engine on a real Unix socket, recording every request. */
async function fakeEngine(handler: Handler) {
  const socketPath = path.join(
    await mkdtemp(path.join(tmpdir(), 'lookout-engine-')),
    'docker.sock',
  );
  const requests: { method: string; path: string; query: Record<string, string> }[] = [];
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://docker');
    requests.push({
      method: request.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  return { client: new EngineDockerClient({ socketPath }), requests };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

describe('EngineDockerClient Container Actions', () => {
  it('removes with force=false and v=false, so never a running Container or its volumes', async () => {
    const { client, requests } = await fakeEngine((_req, res) => res.writeHead(204).end());
    await client.removeContainer('abc');
    expect(requests).toEqual([
      { method: 'DELETE', path: '/containers/abc', query: { force: 'false', v: 'false' } },
    ]);
  });

  it('starts, stops and restarts the named Container', async () => {
    const { client, requests } = await fakeEngine((_req, res) => res.writeHead(204).end());
    await client.startContainer('a');
    await client.stopContainer('a');
    await client.restartContainer('a b');
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /containers/a/start',
      'POST /containers/a/stop',
      'POST /containers/a%20b/restart',
    ]);
  });

  it("rejects with Docker's own message", async () => {
    const { client } = await fakeEngine((_req, res) =>
      json(res, 409, {
        message: 'cannot remove container "/web": container is running: stop the container',
      }),
    );
    const error = await client.removeContainer('web').catch((e: unknown) => e);
    expect(dockerErrorMessage(error)).toBe(
      'cannot remove container "/web": container is running: stop the container',
    );
  });
});

describe('EngineDockerClient reads', () => {
  it('lists every Container by inspecting each, with its Image digest', async () => {
    const { client, requests } = await fakeEngine((req, res) => {
      const url = new URL(req.url!, 'http://docker');
      if (url.pathname === '/containers/json')
        return json(res, 200, [{ Id: 'a1' }, { Id: 'gone' }]);
      if (url.pathname === '/containers/a1/json') {
        return json(res, 200, {
          Id: 'a1',
          Name: '/web',
          Image: 'sha256:img',
          Config: { Image: 'nginx:1', Env: ['A=1'] },
          State: { Status: 'running', StartedAt: '2026-11-25T08:00:00Z' },
        });
      }
      if (decodeURIComponent(url.pathname) === '/images/sha256:img/json') {
        return json(res, 200, { RepoDigests: ['nginx@sha256:abc'] });
      }
      return json(res, 404, { message: 'No such container' });
    });
    const list = await client.listContainers();
    expect(list.map((c) => [c.name, c.state, c.imageDigest])).toEqual([
      ['web', 'running', 'nginx@sha256:abc'],
    ]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/containers/json',
      query: { all: 'true' },
    });
    expect(await client.inspectContainer('gone')).toBeNull();
  });

  it('streams events, filtered to Containers, until aborted', async () => {
    const { client, requests } = await fakeEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(
        `${JSON.stringify({ Type: 'container', Action: 'start', Actor: { ID: 'a1' }, timeNano: 1e15 })}\n`,
      );
    });
    const controller = new AbortController();
    const events = client.events(controller.signal)[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ containerId: 'a1', action: 'start' });
    expect(JSON.parse(requests[0]!.query.filters!)).toEqual({ type: ['container'] });
    controller.abort();
    expect((await events.next()).done).toBe(true);
  });

  it('decodes multiplexed stdout and stderr log frames', async () => {
    const frame = (stream: 1 | 2, text: string) => {
      const body = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(body.length, 4);
      return Buffer.concat([header, body]);
    };
    const { client, requests } = await fakeEngine((req, res) => {
      if (req.url!.startsWith('/containers/a1/json')) {
        return json(res, 200, { Id: 'a1', Config: { Tty: false } });
      }
      res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream' });
      res.end(
        Buffer.concat([
          frame(1, '2026-11-25T08:00:00.000000000Z hello\n'),
          frame(2, '2026-11-25T08:00:01.000000000Z oops\n'),
        ]),
      );
    });
    const lines = [];
    for await (const line of client.logs(
      'a1',
      { tail: 100, follow: false },
      new AbortController().signal,
    )) {
      lines.push(line);
    }
    expect(lines.map((l) => [l.stream, l.text])).toEqual([
      ['stdout', 'hello'],
      ['stderr', 'oops'],
    ]);
    expect(requests[1]).toMatchObject({
      path: '/containers/a1/logs',
      query: { follow: 'false', stdout: 'true', stderr: 'true', timestamps: 'true', tail: '100' },
    });
  });

  it("pings with Docker's plain-text OK answer", async () => {
    const { client } = await fakeEngine((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OK');
    });
    expect(await client.ping()).toBe(true);
  });

  it('reports an error status as ping false', async () => {
    const { client } = await fakeEngine((_req, res) => res.writeHead(500).end('down'));
    expect(await client.ping()).toBe(false);
  });

  it('reports Docker unreachable as ping false', async () => {
    const client = new EngineDockerClient({ socketPath: '/nonexistent/docker.sock' });
    expect(await client.ping()).toBe(false);
    await expect(client.listContainers()).rejects.toThrow();
  });
});

describe('engineAddress', () => {
  it('reads DOCKER_HOST, defaulting to the local socket', () => {
    expect(engineAddress({})).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(engineAddress({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({
      socketPath: '/run/user/1000/docker.sock',
    });
    expect(engineAddress({ DOCKER_HOST: 'tcp://10.0.0.5:2375' })).toEqual({
      host: '10.0.0.5',
      port: 2375,
    });
  });
});

describe('EngineDockerClient: lookout.self from an Image (#105)', () => {
  it("marks a Container whose Image carries lookout.self, so the label is not the operator's", async () => {
    const { client } = await fakeEngine((req, res) => {
      const url = new URL(req.url!, 'http://docker');
      const inspect = (id: string, image: string) =>
        json(res, 200, {
          Id: id,
          Name: `/${id}`,
          Image: image,
          Config: { Image: id, Labels: { 'lookout.self': 'true' } },
          State: { Status: 'running' },
        });
      if (url.pathname === '/containers/json') {
        return json(res, 200, [{ Id: 'lookout' }, { Id: 'miner' }]);
      }
      if (url.pathname === '/containers/lookout/json') return inspect('lookout', 'sha256:own');
      if (url.pathname === '/containers/miner/json') return inspect('miner', 'sha256:bad');
      if (decodeURIComponent(url.pathname) === '/images/sha256:own/json') {
        return json(res, 200, { RepoDigests: [], Config: { Labels: { 'org.example': 'x' } } });
      }
      if (decodeURIComponent(url.pathname) === '/images/sha256:bad/json') {
        return json(res, 200, { RepoDigests: [], Config: { Labels: { 'lookout.self': 'true' } } });
      }
      return json(res, 404, { message: 'No such container' });
    });
    const list = await client.listContainers();
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(byName.lookout!.selfClaimedByImage).toBeUndefined();
    expect(byName.miner!.selfClaimedByImage).toBe(true);
    expect(isSelf(byName.lookout!)).toBe(true);
    expect(isSelf(byName.miner!)).toBe(false);
  });
});
