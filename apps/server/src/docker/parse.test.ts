import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  LogFrameDecoder,
  detailOf,
  envFrom,
  eventFromEngine,
  inspectedFromEngine,
  statsFromEngine,
  summaryOf,
  type EngineInspect,
} from './parse.ts';

describe('inspectedFromEngine', () => {
  const engine: EngineInspect = {
    Id: 'abc123',
    Name: '/shop-web-1',
    Created: '2026-11-01T09:00:00.000000000Z',
    Image: 'sha256:feed',
    RestartCount: 2,
    Config: {
      Image: 'nginx:1.29',
      Env: ['PATH=/usr/bin', 'API_KEY=s3cret=yes', 'EMPTY'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      Entrypoint: '/docker-entrypoint.sh',
      Labels: { 'com.docker.compose.project': 'shop' },
    },
    State: {
      Status: 'running',
      ExitCode: 0,
      StartedAt: '2026-11-25T08:00:00.5Z',
      FinishedAt: '0001-01-01T00:00:00Z',
      Health: { Status: 'healthy' },
    },
    HostConfig: { RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 } },
    Mounts: [
      { Type: 'bind', Source: '/srv/html', Destination: '/usr/share/nginx/html', RW: false },
      {
        Type: 'volume',
        Name: 'shop_cache',
        Source: '/var/lib/docker/volumes/x',
        Destination: '/cache',
        RW: true,
      },
    ],
    NetworkSettings: {
      Ports: {
        '443/tcp': null,
        '80/tcp': [
          { HostIp: '0.0.0.0', HostPort: '8080' },
          { HostIp: '::', HostPort: '8080' },
        ],
      },
      Networks: {
        shop_default: { IPAddress: '172.18.0.2', Gateway: '172.18.0.1', GlobalIPv6Address: '' },
      },
    },
  };

  it('maps everything the list and detail view show', () => {
    expect(inspectedFromEngine(engine, 'nginx@sha256:beef')).toEqual({
      id: 'abc123',
      name: 'shop-web-1',
      image: 'nginx:1.29',
      state: 'running',
      health: 'healthy',
      composeProject: 'shop',
      createdAt: Date.parse('2026-11-01T09:00:00Z'),
      startedAt: Date.parse('2026-11-25T08:00:00.5Z'),
      finishedAt: null,
      exitCode: 0,
      ports: [
        { privatePort: 80, publicPort: 8080, protocol: 'tcp', ip: '0.0.0.0' },
        { privatePort: 80, publicPort: 8080, protocol: 'tcp', ip: '::' },
        { privatePort: 443, publicPort: null, protocol: 'tcp', ip: null },
      ],
      labels: { 'com.docker.compose.project': 'shop' },
      imageId: 'sha256:feed',
      imageDigest: 'nginx@sha256:beef',
      command: ['nginx', '-g', 'daemon off;'],
      entrypoint: ['/docker-entrypoint.sh'],
      env: [
        { name: 'PATH', value: '/usr/bin' },
        { name: 'API_KEY', value: 's3cret=yes' },
        { name: 'EMPTY', value: '' },
      ],
      mounts: [
        { type: 'bind', source: '/srv/html', destination: '/usr/share/nginx/html', readOnly: true },
        { type: 'volume', source: 'shop_cache', destination: '/cache', readOnly: false },
      ],
      networks: [
        { name: 'shop_default', ipAddress: '172.18.0.2', ipv6Address: null, gateway: '172.18.0.1' },
      ],
      restartPolicy: 'on-failure:3',
      restartCount: 2,
    });
  });

  it("reads an exited Container's exit code and finish time", () => {
    const exited = inspectedFromEngine({
      Id: 'def',
      State: {
        Status: 'exited',
        ExitCode: 137,
        StartedAt: '2026-11-25T08:00:00Z',
        FinishedAt: '2026-11-25T09:00:00Z',
      },
    });
    expect(exited).toMatchObject({ state: 'exited', exitCode: 137, health: null });
    expect(exited.finishedAt).toBe(Date.parse('2026-11-25T09:00:00Z'));
    expect(exited.restartPolicy).toBe('no');
  });

  it('gives a never-started Container no exit code', () => {
    const created = inspectedFromEngine({
      Id: '0123456789abcdef',
      State: { Status: 'created', ExitCode: 0, StartedAt: '0001-01-01T00:00:00Z' },
    });
    expect(created).toMatchObject({ name: '0123456789ab', exitCode: null, startedAt: null });
  });
});

describe('detailOf and summaryOf', () => {
  it('never include environment values', () => {
    const container = inspectedFromEngine({
      Id: 'a',
      Config: { Env: ['TOKEN=hunter2', 'MODE=prod'] },
    });
    const detail = detailOf(container);
    expect(detail.envNames).toEqual(['TOKEN', 'MODE']);
    expect(JSON.stringify(detail)).not.toContain('hunter2');
    expect(JSON.stringify(summaryOf(container))).not.toContain('hunter2');
    expect(summaryOf(container)).not.toHaveProperty('envNames');
  });
});

describe('envFrom', () => {
  it('splits on the first =', () => {
    expect(envFrom(['A=b=c', 'B'])).toEqual([
      { name: 'A', value: 'b=c' },
      { name: 'B', value: '' },
    ]);
  });
});

describe('eventFromEngine', () => {
  it('maps Container events and ignores others', () => {
    expect(
      eventFromEngine({ Type: 'container', Action: 'die', Actor: { ID: 'abc' }, timeNano: 1.5e18 }),
    ).toEqual({ containerId: 'abc', action: 'die', timestamp: 1.5e12 });
    expect(eventFromEngine({ Type: 'network', Action: 'connect', Actor: { ID: 'n' } })).toBeNull();
  });
});

describe('statsFromEngine', () => {
  it('calculates CPU % and memory like `docker stats`', () => {
    const stats = statsFromEngine('abc', {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000 },
        system_cpu_usage: 20_000_000,
        online_cpus: 4,
      },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
      memory_stats: {
        usage: 100 * 1024 * 1024,
        limit: 1024 * 1024 * 1024,
        stats: { inactive_file: 20 * 1024 * 1024 },
      },
    });
    expect(stats).toEqual({
      containerId: 'abc',
      cpuPercent: 40,
      memoryUsedBytes: 80 * 1024 * 1024,
      memoryLimitBytes: 1024 * 1024 * 1024,
    });
  });
});

describe('LineSplitter', () => {
  it('joins lines split across chunks', () => {
    const lines = new LineSplitter();
    expect(lines.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(lines.push(':2}\n')).toEqual(['{"b":2}']);
    expect(lines.flush()).toEqual([]);
  });
});

describe('LogFrameDecoder', () => {
  const frame = (stream: 1 | 2, text: string) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it('splits stdout and stderr frames into timestamped lines', () => {
    const decoder = new LogFrameDecoder();
    const bytes = Buffer.concat([
      frame(1, '2026-11-25T10:00:00.000000000Z started\n'),
      frame(2, '2026-11-25T10:00:01.000000000Z oops\n'),
    ]);
    // Deliver in awkward pieces to check reassembly.
    const lines = [...decoder.push(bytes.subarray(0, 5)), ...decoder.push(bytes.subarray(5))];
    expect(lines).toEqual([
      { stream: 'stdout', timestamp: Date.parse('2026-11-25T10:00:00Z'), text: 'started' },
      { stream: 'stderr', timestamp: Date.parse('2026-11-25T10:00:01Z'), text: 'oops' },
    ]);
  });
});
