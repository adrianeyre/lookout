import { describe, expect, it } from 'vitest';
import { diskTotals, diskUsageFromEngine, groupSize } from './disk-usage.ts';

/** A trimmed GET /system/df answer, in the Engine's own shape. */
const ENGINE = {
  LayersSize: 999,
  Images: [
    { Id: 'sha256:web', Size: 300, Containers: 1 },
    { Id: 'sha256:db', Size: 200, Containers: 1 },
    { Id: 'sha256:old', Size: 50, Containers: 0 },
  ],
  Containers: [
    {
      Id: 'web1',
      Names: ['/shop-web-1'],
      ImageID: 'sha256:web',
      SizeRw: 10,
      State: 'running',
      Labels: { 'com.docker.compose.project': 'shop' },
      Mounts: [{ Type: 'bind', Source: '/srv' }],
    },
    {
      Id: 'db1',
      Names: ['/shop-db-1'],
      ImageID: 'sha256:db',
      SizeRw: 20,
      State: 'running',
      Labels: { 'com.docker.compose.project': 'shop' },
      Mounts: [{ Type: 'volume', Name: 'shop_pgdata' }],
    },
    {
      Id: 'gone',
      Names: ['/one-off'],
      ImageID: 'sha256:old',
      SizeRw: 5,
      State: 'exited',
      Labels: {},
    },
  ],
  Volumes: [
    {
      Name: 'shop_pgdata',
      Labels: { 'com.docker.compose.project': 'shop' },
      UsageData: { Size: 1000, RefCount: 1 },
    },
    {
      Name: 'shop_cache',
      Labels: { 'com.docker.compose.project': 'shop' },
      UsageData: { Size: 100, RefCount: 0 },
    },
    { Name: 'stray', Labels: null, UsageData: { Size: 70, RefCount: 0 } },
    { Name: 'uncounted', UsageData: { Size: -1, RefCount: -1 } },
  ],
  BuildCache: [
    { Size: 40, InUse: false, Shared: false },
    { Size: 60, InUse: true, Shared: false },
    { Size: 30, InUse: false, Shared: true },
  ],
};

describe('disk usage', () => {
  const report = diskUsageFromEngine(ENGINE);

  it('reads the Engine answer, treating unknown (-1) sizes as 0', () => {
    expect(report.containers[0]).toEqual({
      id: 'web1',
      name: 'shop-web-1',
      imageId: 'sha256:web',
      writableBytes: 10,
      running: true,
      project: 'shop',
      volumes: [],
    });
    expect(report.volumes.at(-1)).toEqual({
      name: 'uncounted',
      bytes: 0,
      refCount: 0,
      project: null,
    });
    expect(diskUsageFromEngine(null)).toEqual({
      images: [],
      containers: [],
      volumes: [],
      buildCache: [],
    });
  });

  it('totals the server like docker system df, with what could be reclaimed', () => {
    expect(diskTotals(report)).toEqual({
      images: { count: 3, bytes: 550, reclaimableBytes: 50 },
      containers: { count: 3, bytes: 35, reclaimableBytes: 5 },
      volumes: { count: 4, bytes: 1170, reclaimableBytes: 170 },
      buildCache: { count: 3, bytes: 130, reclaimableBytes: 40 },
    });
  });

  it('sizes a Compose Project: its Containers, their Images, and its volumes', () => {
    expect(groupSize(report, new Set(['web1']), 'shop')).toEqual({
      writableBytes: 30,
      imagesBytes: 500,
      volumesBytes: 1100,
    });
  });

  it('sizes a lone Container by what it runs and mounts', () => {
    expect(groupSize(report, new Set(['gone']), null)).toEqual({
      writableBytes: 5,
      imagesBytes: 50,
      volumesBytes: 0,
    });
  });
});
