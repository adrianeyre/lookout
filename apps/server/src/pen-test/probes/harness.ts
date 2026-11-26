/**
 * The in-process harness for pen-test probes that run in `pnpm test` (PRD "Checks every
 * scope issue carries"). It builds the real app against the fake Docker, the way
 * app.test.ts does, so a probe exercises the same hooks, routes and refusals as a Host.
 * Probes that need the pen-test deployment are `*.probe.ts` files and run in
 * `pnpm pen-test:probe` instead.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { FakeDocker } from '../../../test-support/fake-docker.ts';
import { TEST_PASSWORD, testConfig } from '../../../test/helpers.ts';
import { buildApp, type AppOptions } from '../../app.ts';
import type { Config } from '../../config.ts';

export const ORIGIN = 'http://lookout.test';
export const HOST = 'lookout.test';
export { TEST_PASSWORD };

/** A built SPA with an index page, one hashed asset and a favicon. */
export async function makeWebDist(): Promise<string> {
  const dist = await mkdtemp(path.join(tmpdir(), 'lookout-probe-web-'));
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Lookout</title>');
  await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(path.join(dist, 'favicon.ico'), 'ico');
  return dist;
}

export interface ProbeApp {
  app: FastifyInstance;
  docker: FakeDocker;
  /** Signs in and returns the `name=value` cookie pair. */
  signIn(headers?: Record<string, string>): Promise<string>;
  close(): Promise<void>;
}

/** Builds and readies the app. Close it in afterEach. */
export async function startProbeApp(
  options: Partial<Omit<AppOptions, 'config'>> & { config?: Partial<Config> } = {},
): Promise<ProbeApp> {
  const { config, ...rest } = options;
  const docker = (rest.docker as FakeDocker | undefined) ?? new FakeDocker();
  const app = await buildApp({
    docker,
    webDistDir: await makeWebDist(),
    startSampler: false,
    startSiteMonitor: false,
    ...rest,
    config: testConfig(config),
  });
  await app.ready();
  return {
    app,
    docker,
    async signIn(headers = {}) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin: ORIGIN, host: HOST, ...headers },
        payload: { password: TEST_PASSWORD },
      });
      if (response.statusCode !== 204) {
        throw new Error(`Sign-in answered ${response.statusCode}: ${response.body}`);
      }
      return cookiePair(response);
    },
    close: () => app.close(),
  };
}

/** The `name=value` pair of a response's Set-Cookie header. */
export function cookiePair(response: LightMyRequestResponse): string {
  return String(response.headers['set-cookie']).split(';')[0]!;
}
