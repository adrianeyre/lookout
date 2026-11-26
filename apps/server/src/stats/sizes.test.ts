import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContainerSummary } from '@lookout/shared';
import { describe, expect, it } from 'vitest';
import { FakeDocker, makeContainer } from '../../test-support/fake-docker.ts';
import { HostRoot } from '../host-root.ts';
import { SizeMeasurer, sizeSubject, type SizeSite } from './sizes.ts';
import { StatsStore } from './store.ts';
import { dayStart } from './time.ts';

const NOW = Date.parse('2026-11-26T12:30:00Z');
const quiet = { info: () => undefined, warn: () => undefined };

const web = makeContainer({
  id: 'web1',
  name: 'shop-web-1',
  composeProject: 'shop',
  imageId: 'sha256:web',
});
const db = makeContainer({
  id: 'db1',
  name: 'shop-db-1',
  composeProject: 'shop',
  imageId: 'sha256:db',
});
const lone = makeContainer({ id: 'lone1', name: 'blog', imageId: 'sha256:blog' });
const summaries = [web, db, lone] as unknown as ContainerSummary[];

const sites: SizeSite[] = [
  { id: 'shop', url: 'https://shop.example/', containerId: 'web1' },
  { id: 'blog', url: 'https://blog.example/', containerId: 'lone1' },
  { id: 'cdn', url: 'https://cdn.example.com/', containerId: null },
  { id: 'none', url: 'https://other.example/', containerId: null },
];

describe('sizeSubject', () => {
  const folders = { 'https://cdn.example.com/': '/srv/cdn' };

  it('measures a Container’s Compose Project, a lone Container, or a named folder', () => {
    expect(sizeSubject(sites[0]!, summaries, folders)).toMatchObject({
      source: 'project',
      subject: 'shop',
    });
    expect(sizeSubject(sites[1]!, summaries, folders)).toMatchObject({
      source: 'container',
      subject: 'blog',
    });
    expect(sizeSubject(sites[2]!, summaries, folders)).toMatchObject({
      source: 'folder',
      subject: '/srv/cdn',
    });
    expect(sizeSubject(sites[3]!, summaries, folders)).toMatchObject({
      source: 'none',
      subject: null,
    });
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'lookout-host-'));
  await mkdir(path.join(root, 'srv/cdn/img'), { recursive: true });
  await writeFile(path.join(root, 'srv/cdn/index.html'), Buffer.alloc(100_000, 1));
  await writeFile(path.join(root, 'srv/cdn/img/logo.png'), Buffer.alloc(300_000, 1));
  const docker = new FakeDocker([web, db, lone]);
  const store = StatsStore.open(null);
  const measurer = new SizeMeasurer({
    docker,
    hostRoot: new HostRoot(root),
    store,
    sites: () => sites,
    containers: () => summaries,
    folders: { 'https://cdn.example.com/': '/srv/cdn' },
    log: quiet,
    now: () => NOW,
  });
  return { docker, store, measurer };
}

describe('SizeMeasurer', () => {
  it('stores each site’s size and Docker’s disk usage for today', async () => {
    const { store, measurer } = await setup();
    expect(measurer.measureNow()).toEqual({ result: 'started' });
    expect(measurer.state).toBe('measuring');
    await measurer.settled();
    expect(measurer.state).toBe('idle');
    expect(measurer.lastMeasuredAt).toBe(NOW);
    const [shop] = store.siteSizesSince('shop', 0);
    expect(shop).toMatchObject({
      start: dayStart(NOW),
      source: 'project',
      subject: 'shop',
      // Two Images and two writable layers in the project, and its volume.
      images: 200_000_000,
      writable: 2_000_000,
      volumes: 50_000_000,
      folder: null,
    });
    const [cdn] = store.siteSizesSince('cdn', 0);
    expect(cdn!.source).toBe('folder');
    expect(cdn!.folder).toBeGreaterThanOrEqual(400_000);
    expect(cdn!.images).toBeNull();
    expect(store.siteSizesSince('none', 0)).toEqual([]);
    expect(store.latestDockerDf()?.images.count).toBe(3);
  });

  it('runs one measurement at a time', async () => {
    const { docker, measurer } = await setup();
    docker.diskUsageDelayMs = 50;
    expect(measurer.measureNow().result).toBe('started');
    expect(measurer.measureNow().result).toBe('busy');
    await measurer.settled();
    expect(docker.diskUsageCalls).toBe(1);
    expect(measurer.measureNow().result).toBe('started');
    await measurer.settled();
  });

  it('never measures a folder that leads out of the Host root through a link', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lookout-host-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'lookout-outside-'));
    await writeFile(path.join(outside, 'secret'), Buffer.alloc(10_000, 1));
    await mkdir(path.join(root, 'srv'), { recursive: true });
    await symlink(outside, path.join(root, 'srv/cdn'));
    const store = StatsStore.open(null);
    const measurer = new SizeMeasurer({
      docker: new FakeDocker([]),
      hostRoot: new HostRoot(root),
      store,
      sites: () => [sites[2]!],
      containers: () => [],
      folders: { 'https://cdn.example.com/': '/srv/cdn' },
      log: quiet,
      now: () => NOW,
    });
    measurer.measureNow();
    await measurer.settled();
    expect(store.siteSizesSince('cdn', 0)[0]?.folder).toBeNull();
  });

  it('says so when Docker cannot be asked, and stores nothing', async () => {
    const { docker, store, measurer } = await setup();
    docker.available = false;
    measurer.measureNow();
    await measurer.settled();
    expect(measurer.error).toMatch(/Docker could not be asked/);
    expect(store.latestDockerDf()).toBeNull();
  });
});
