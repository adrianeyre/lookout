/**
 * K1 (#65) against the pen-test deployment, in the configuration that is running: the
 * environment reveal on Lookout's own Container, secrets outside the environment, Docker's
 * and the proxy's error text, and Container Actions on lookout.self. The in-process half is
 * k1-docker.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dindDocker, waitForLookout } from '../deployment.ts';
import { seed } from '../fixtures/loader.ts';
import { FAKE_MARKER, PLAN } from '../fixtures/plan.ts';
import { connect, readUntil, type Deployment } from './deployment-harness.ts';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});
// The remove probe destroys a fixture; put it back.
afterAll(() => seed());

const victim = PLAN.containers.find((c) => c.handle === 'victim')!;

async function firstStreamEvents(): Promise<string> {
  const response = await deployment.api('/api/stream', { signal: AbortSignal.timeout(10_000) });
  return readUntil(response, 'event: sites');
}

describe('K1 H1 (reveal half): Lookout never reveals its own secrets', () => {
  for (const name of ['LOOKOUT_SESSION_SECRET', 'LOOKOUT_PASSWORD_HASH']) {
    it(`refuses ${name} of the lookout.self Container (regression)`, async () => {
      const response = await deployment.api(`/api/containers/lookout/env/${name}`);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/argon2|=/);
    });
  }
});

describe('K1 H8: secrets outside the environment', () => {
  const outsideEnv = victim.secrets.filter((s) => !Object.values(victim.env).includes(s));
  const envValues = Object.values(victim.env);

  it('no made-up secret in the command, labels or mounts is in the detail, list or stream (regression)', async () => {
    const id = await deployment.idOf('victim');
    const responses = [
      await (await deployment.api(`/api/containers/${id}`)).text(),
      await (await deployment.api('/api/containers')).text(),
      await firstStreamEvents(),
    ].join('\n');
    // JSON escapes `$` in no way, but `"` and `\` would be; none of the secrets has them.
    for (const secret of outsideEnv) expect(responses, secret).not.toContain(secret);
  });

  it('never sends an environment value unless it is revealed by name', async () => {
    const id = await deployment.idOf('victim');
    const responses = [
      await (await deployment.api(`/api/containers/${id}`)).text(),
      await (await deployment.api('/api/containers')).text(),
      await firstStreamEvents(),
    ].join('\n');
    for (const value of envValues) {
      // DATABASE_URL is also on the command line; masked there too since #91.
      expect(responses).not.toContain(value);
    }
    expect(FAKE_MARKER.length).toBeGreaterThan(0);
  });
});

describe('K1 H11: error text', () => {
  it("a failed start returns Docker's own runtime error text in the 502 (FR-27, a documented decision)", async () => {
    const id = await deployment.idOf('broken-start');
    const response = await deployment.api(`/api/containers/${id}/actions/start`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(502);
    const { error } = (await response.json()) as { error: string };
    console.log(`[${deployment.configuration}] 502 body: ${error.slice(0, 160)}`);
    expect(error).toMatch(/no such file|executable file not found|OCI runtime/i);
  });

  it.runIf(process.env.PEN_TEST_CONFIGURATION !== 'default')(
    'answers a closed 503 when the socket proxy is down (socket-proxy only)',
    async ({ skip }) => {
      if (deployment.configuration !== 'socket-proxy') skip();
      const id = await deployment.idOf('victim');
      dindDocker(['stop', 'lookout-docker-proxy']);
      try {
        const response = await deployment.api(`/api/containers/${id}`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Docker unavailable' });
      } finally {
        dindDocker(['start', 'lookout-docker-proxy']);
        waitForLookout();
        // Lookout retries Docker on its own; wait until it lists Containers again.
        for (let attempt = 0; attempt < 60; attempt++) {
          if ((await deployment.containers()).containers.some((c) => c.name === 'lookout')) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
  );
});

describe('K1: Container Actions on lookout.self', () => {
  const selves = () =>
    PLAN.shipped.filter((s) => s.configurations.includes(deployment.configuration));

  it('refuses every action on every lookout.self Container, by ID and by name', async () => {
    for (const self of selves()) {
      const id = await deployment.idOf(self.name);
      for (const ref of [id, id.slice(0, 12), self.name]) {
        for (const action of ['start', 'stop', 'restart', 'remove']) {
          const response = await deployment.api(`/api/containers/${ref}/actions/${action}`, {
            method: 'POST',
            body: JSON.stringify({ confirmName: self.name }),
            headers: { 'content-type': 'application/json' },
          });
          expect(response.status, `${action} ${ref}`).toBe(403);
        }
      }
      const state = dindDocker(['inspect', '--format', '{{.State.Status}}', self.name])?.trim();
      expect(state).toBe('running');
    }
  });

  it('removes a stopped Container only with its typed name', async () => {
    const id = await deployment.idOf('stopped-removable');
    const send = (body: unknown) =>
      deployment.api(`/api/containers/${id}/actions/remove`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    expect((await send({})).status).toBe(400);
    expect((await send({ confirmName: 'stopped' })).status).toBe(400);
    expect((await send({ confirmName: 'stopped-removable' })).status).toBe(200);
    expect(dindDocker(['inspect', 'stopped-removable'], { allowFail: true })).toBeNull();
  });

  it('stops odd references before Docker', async () => {
    for (const ref of ['..', '%2e%2e', 'a%2Fb', 'a%00b', '-x', 'x'.repeat(129)]) {
      const response = await deployment.api(`/api/containers/${ref}`);
      expect(response.status, ref).toBe(404);
    }
  });
});
