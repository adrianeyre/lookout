import { describe, expect, it } from 'vitest';
import type { ContainerEvent, ContainerState } from '@lookout/shared';
import { FakeDocker, makeContainer } from './fake-docker.ts';

const container = (id: string, state: ContainerState) => makeContainer({ id, state });

describe('FakeDocker', () => {
  it('lists Containers and emits events as tests change them', async () => {
    const docker = new FakeDocker([container('a', 'running')]);
    expect((await docker.listContainers()).map((c) => c.id)).toEqual(['a']);

    const controller = new AbortController();
    const received: ContainerEvent[] = [];
    const listening = (async () => {
      for await (const event of docker.events(controller.signal)) {
        received.push(event);
        if (received.length === 2) controller.abort();
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    docker.upsert(container('a', 'exited'), 'die');
    docker.remove('a');
    await listening;
    expect(received.map((e) => e.action)).toEqual(['die', 'destroy']);
    expect(await docker.listContainers()).toEqual([]);
  });

  it('replays the last N log lines, then follows', async () => {
    const docker = new FakeDocker();
    for (let i = 0; i < 5; i += 1)
      docker.appendLog('a', { stream: 'stdout', timestamp: i, text: `line ${i}` });
    const controller = new AbortController();
    const lines: string[] = [];
    const following = (async () => {
      for await (const line of docker.logs('a', { tail: 2, follow: true }, controller.signal)) {
        lines.push(line.text);
        if (lines.length === 3) controller.abort();
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    docker.appendLog('a', { stream: 'stderr', timestamp: 6, text: 'line 5' });
    await following;
    expect(lines).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('counts open log streams and closes them on abort', async () => {
    const docker = new FakeDocker();
    const controller = new AbortController();
    const following = (async () => {
      for await (const line of docker.logs('a', { tail: 10, follow: true }, controller.signal)) {
        expect(line).toBeDefined();
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    expect(docker.openStreams('logs')).toBe(1);
    controller.abort();
    await following;
    expect(docker.openStreams('logs')).toBe(0);
  });

  it('ends open event streams with an error when Docker goes away', async () => {
    const docker = new FakeDocker();
    const listening = (async () => {
      for await (const event of docker.events(new AbortController().signal)) {
        expect(event).toBeDefined();
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    docker.available = false;
    await expect(listening).rejects.toThrow(/connection lost/);
  });

  it('fails like an unreachable daemon when unavailable', async () => {
    const docker = new FakeDocker();
    docker.available = false;
    expect(await docker.ping()).toBe(false);
    await expect(docker.listContainers()).rejects.toThrow(/docker.sock/);
  });
});
