import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainersSnapshot } from '@lookout/shared';
import { FakeDocker, makeContainer } from '../../test-support/fake-docker.ts';
import { StatsHub } from './stats.ts';
import { ContainerStore } from './store.ts';

const log = { warn: vi.fn(), info: vi.fn() };
const stores: ContainerStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.stop()));
});

function startStore(docker: FakeDocker) {
  const store = new ContainerStore(docker, { log, retryMs: 20, debounceMs: 5 });
  stores.push(store);
  const snapshots: ContainersSnapshot[] = [];
  store.subscribe((snapshot) => snapshots.push(snapshot));
  store.start();
  const latest = () => snapshots.at(-1);
  return { store, snapshots, latest };
}

describe('ContainerStore', () => {
  it('lists every Container once Docker answers', async () => {
    const docker = new FakeDocker([
      makeContainer({ id: 'b', name: 'web', composeProject: 'shop' }),
      makeContainer({ id: 'a', name: 'api', state: 'exited', exitCode: 1 }),
    ]);
    const { latest } = startStore(docker);
    await vi.waitFor(() => expect(latest()?.available).toBe(true));
    expect(latest()!.containers.map((c) => c.name)).toEqual(['api', 'web']);
    expect(latest()!.containers[0]).not.toHaveProperty('env');
  });

  it('applies Docker events without listing everything again', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'a', name: 'web' })]);
    const { latest } = startStore(docker);
    await vi.waitFor(() => expect(latest()?.available).toBe(true));
    const list = vi.spyOn(docker, 'listContainers');

    docker.upsert(makeContainer({ id: 'a', name: 'web', state: 'exited', exitCode: 137 }), 'die');
    await vi.waitFor(() => expect(latest()!.containers[0]!.state).toBe('exited'));
    docker.upsert(makeContainer({ id: 'b', name: 'new' }), 'create');
    await vi.waitFor(() => expect(latest()!.containers).toHaveLength(2));
    docker.remove('a');
    await vi.waitFor(() => expect(latest()!.containers.map((c) => c.id)).toEqual(['b']));
    expect(list).not.toHaveBeenCalled();
  });

  it('ignores health-check exec events', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'a' })]);
    const { latest } = startStore(docker);
    await vi.waitFor(() => expect(latest()?.available).toBe(true));
    const inspect = vi.spyOn(docker, 'inspectContainer');
    docker.emitEvent({ containerId: 'a', action: 'exec_start: /bin/sh -c curl', timestamp: 0 });
    docker.emitEvent({ containerId: 'a', action: 'health_status: unhealthy', timestamp: 0 });
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
  });

  it('reports Docker unavailable, keeps retrying, and recovers', async () => {
    const docker = new FakeDocker([makeContainer({ id: 'a' })]);
    docker.available = false;
    const { store, latest } = startStore(docker);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.snapshot).toEqual({ available: false, containers: [] });

    docker.available = true;
    await vi.waitFor(() => expect(latest()).toMatchObject({ available: true }));
    expect(latest()!.containers).toHaveLength(1);

    // Docker stops while connected: the list is cleared and marked unavailable.
    docker.available = false;
    await vi.waitFor(() => expect(latest()).toEqual({ available: false, containers: [] }));
    docker.available = true;
    await vi.waitFor(() => expect(latest()?.available).toBe(true));
  });
});

describe('StatsHub', () => {
  it('opens no stats streams until someone subscribes, and closes them all after', async () => {
    const docker = new FakeDocker([
      makeContainer({ id: 'a' }),
      makeContainer({ id: 'b' }),
      makeContainer({ id: 'c', state: 'exited', exitCode: 0 }),
    ]);
    const { store, latest } = startStore(docker);
    await vi.waitFor(() => expect(latest()?.available).toBe(true));
    const hub = new StatsHub(docker, store, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.openStreams).toBe(0);
    expect(docker.openStreams('stats')).toBe(0);

    const received: string[][] = [];
    const unsubscribe = hub.subscribe((stats) => received.push(stats.map((s) => s.containerId)));
    // Only running Containers have stats.
    await vi.waitFor(() => expect(docker.openStreams('stats')).toBe(2));
    docker.setStats({ containerId: 'a', cpuPercent: 5, memoryUsedBytes: 1, memoryLimitBytes: 2 });
    await vi.waitFor(() => expect(received.at(-1)).toEqual(['a']));

    // A Container that stops has its stream closed.
    docker.upsert(makeContainer({ id: 'b', state: 'exited', exitCode: 0 }), 'die');
    await vi.waitFor(() => expect(docker.openStreams('stats')).toBe(1));

    unsubscribe();
    await vi.waitFor(() => expect(docker.openStreams('stats')).toBe(0));
    expect(hub.openStreams).toBe(0);
  });
});
