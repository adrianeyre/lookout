import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { VolumesSnapshot } from '@lookout/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeDocker, makeContainer } from '../test-support/fake-docker.ts';
import { TEST_PASSWORD, testConfig } from '../test/helpers.ts';
import { buildApp } from './app.ts';

const ORIGIN = 'http://lookout.test';
const HOST = 'lookout.test';
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(docker: FakeDocker) {
  const dist = await mkdtemp(path.join(tmpdir(), 'lookout-web-'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Lookout</title>');
  app = await buildApp({
    config: testConfig(),
    docker,
    webDistDir: dist,
    startSampler: false,
    startSiteMonitor: false,
    startFolderScanner: false,
    startSiteStats: false,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { password: TEST_PASSWORD },
  });
  return { instance: app, cookie: String(login.headers['set-cookie']).split(';')[0]! };
}

function docker() {
  const fake = new FakeDocker([
    makeContainer({
      id: 'lookout1',
      name: 'lookout',
      labels: { 'lookout.self': 'true' },
      mounts: [{ type: 'volume', source: 'lookout-data', destination: '/data', readOnly: false }],
    }),
  ]);
  fake.volumes.set('stray', {
    name: 'stray',
    driver: 'local',
    createdAt: null,
    project: null,
    bytes: 5,
  });
  return fake;
}

const del = (
  instance: FastifyInstance,
  cookie: string,
  name: string,
  payload: unknown,
  origin = ORIGIN,
) =>
  instance.inject({
    method: 'POST',
    url: `/api/volumes/${name}/delete`,
    headers: { cookie, host: HOST, origin },
    payload: payload as Record<string, unknown>,
  });

describe('volumes API', () => {
  it('lists volumes and who uses them, behind a session', async () => {
    const { instance, cookie } = await start(docker());
    expect(
      (await instance.inject({ method: 'GET', url: '/api/volumes', headers: { host: HOST } }))
        .statusCode,
    ).toBe(401);
    const snapshot = (
      await instance.inject({ method: 'GET', url: '/api/volumes', headers: { cookie, host: HOST } })
    ).json<VolumesSnapshot>();
    expect(snapshot.volumes.map((v) => [v.name, v.usedBy.length])).toEqual([
      ['lookout-data', 1],
      ['stray', 0],
    ]);
  });

  it('deletes an unused volume, only from this origin and with its name typed', async () => {
    const fake = docker();
    const { instance, cookie } = await start(fake);
    expect(
      (await del(instance, cookie, 'stray', { confirmName: 'stray' }, 'http://evil.example'))
        .statusCode,
    ).toBe(403);
    expect((await del(instance, cookie, 'stray', {})).statusCode).toBe(400);
    expect((await del(instance, cookie, 'stray', { confirmName: 'nope' })).statusCode).toBe(400);
    expect(fake.removedVolumes).toEqual([]);
    const ok = await del(instance, cookie, 'stray', { confirmName: 'stray' });
    expect(ok.statusCode).toBe(200);
    expect(fake.removedVolumes).toEqual(['stray']);
    expect((await del(instance, cookie, 'stray', { confirmName: 'stray' })).statusCode).toBe(404);
  });

  it("refuses a volume in use, Lookout's own data volume included", async () => {
    const fake = docker();
    const { instance, cookie } = await start(fake);
    const response = await del(instance, cookie, 'lookout-data', { confirmName: 'lookout-data' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toMatch(/In use by lookout/);
    expect(fake.removedVolumes).toEqual([]);
  });

  it('refuses names that are not volume names, without asking Docker', async () => {
    const fake = docker();
    const { instance, cookie } = await start(fake);
    for (const evil of ['..', '%2E%2E', 'a%2Fb', '-rf', '.hidden']) {
      expect((await del(instance, cookie, evil, { confirmName: evil })).statusCode, evil).toBe(404);
    }
    expect(fake.removedVolumes).toEqual([]);
  });

  it('says Docker is unavailable', async () => {
    const fake = docker();
    const { instance, cookie } = await start(fake);
    fake.available = false;
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/api/volumes',
          headers: { cookie, host: HOST },
        })
      ).statusCode,
    ).toBe(503);
  });
});
