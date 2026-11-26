import { describe, expect, it } from 'vitest';
import { FakeDocker, makeContainer } from '../../test-support/fake-docker.ts';
import { VolumeService, volumeUsers } from './volumes.ts';

const quiet = { info: () => undefined, warn: () => undefined };

function setup() {
  const docker = new FakeDocker([
    makeContainer({
      id: 'db1',
      name: 'shop-db-1',
      composeProject: 'shop',
      mounts: [
        {
          type: 'volume',
          source: 'shop_pgdata',
          destination: '/var/lib/postgresql',
          readOnly: false,
        },
        { type: 'bind', source: '/srv/shop', destination: '/srv', readOnly: true },
      ],
    }),
    makeContainer({
      id: 'old1',
      name: 'old-job',
      state: 'exited',
      mounts: [{ type: 'volume', source: 'job_cache', destination: '/cache', readOnly: true }],
    }),
  ]);
  docker.volumes.set('stray', {
    name: 'stray',
    driver: 'local',
    createdAt: Date.parse('2026-11-20T00:00:00Z'),
    project: null,
    bytes: 70_000,
  });
  return { docker, volumes: new VolumeService(docker, quiet) };
}

describe('volumeUsers', () => {
  it('lists the Containers that mount each volume, bind mounts left out', () => {
    const { docker } = setup();
    return docker.listContainers().then((containers) => {
      const users = volumeUsers(containers);
      expect(users.get('shop_pgdata')).toEqual([
        {
          containerId: 'db1',
          containerName: 'shop-db-1',
          destination: '/var/lib/postgresql',
          readOnly: false,
        },
      ]);
      expect(users.has('/srv/shop')).toBe(false);
    });
  });
});

describe('VolumeService', () => {
  it('lists every volume with the Containers using it, stopped ones included', async () => {
    const { volumes } = setup();
    const snapshot = await volumes.snapshot();
    expect(snapshot.volumes.map((v) => [v.name, v.usedBy.map((u) => u.containerName)])).toEqual([
      ['job_cache', ['old-job']],
      ['shop_pgdata', ['shop-db-1']],
      ['stray', []],
    ]);
  });

  it('fills in sizes once Docker has measured them, asking once at a time', async () => {
    const { docker, volumes } = setup();
    const first = await volumes.snapshot();
    expect(first.sizesMeasuredAt).toBeNull();
    await volumes.refreshSizes();
    const second = await volumes.snapshot();
    expect(second.volumes.find((v) => v.name === 'stray')?.sizeBytes).toBe(70_000);
    expect(second.sizesMeasuredAt).not.toBeNull();
    expect(docker.diskUsageCalls).toBe(1);
  });

  it('deletes an unused volume when its name is typed', async () => {
    const { docker, volumes } = setup();
    expect(await volumes.delete('stray', 'stray')).toEqual({ result: 'deleted' });
    expect(docker.removedVolumes).toEqual(['stray']);
  });

  it('refuses a volume any Container uses, even a stopped one, and never asks Docker', async () => {
    const { docker, volumes } = setup();
    expect(await volumes.delete('job_cache', 'job_cache')).toEqual({
      result: 'in-use',
      containers: ['old-job'],
    });
    expect(await volumes.delete('shop_pgdata', 'shop_pgdata')).toMatchObject({ result: 'in-use' });
    expect(docker.removedVolumes).toEqual([]);
  });

  it('refuses a wrong typed name, and an unknown volume', async () => {
    const { docker, volumes } = setup();
    expect(await volumes.delete('stray', 'Stray')).toEqual({ result: 'mismatch' });
    expect(await volumes.delete('stray', undefined)).toEqual({ result: 'mismatch' });
    expect(await volumes.delete('nothing', 'nothing')).toEqual({ result: 'unknown' });
    expect(docker.removedVolumes).toEqual([]);
  });

  it("passes on Docker's refusal, for a volume that came into use in between", async () => {
    const { docker, volumes } = setup();
    docker.removeVolume = async () => {
      throw new Error('in use');
    };
    expect(await volumes.delete('stray', 'stray')).toMatchObject({ result: 'failed' });
  });
});
