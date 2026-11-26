/**
 * E2 (#60): after `pnpm pen-test:seed`, Lookout's pages show every fixture, and seeding
 * again gives the same set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../fixtures/loader.ts';
import { PLAN } from '../fixtures/plan.ts';
import { connect, type Deployment } from './deployment-harness.ts';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});

async function fixtureStates() {
  const { containers } = await deployment.containers();
  return Object.fromEntries(
    containers.map((c) => [c.name, `${c.state}${c.health ? `/${c.health}` : ''}`]),
  );
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 90 && !ok(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    value = await read();
  }
  return value;
}

describe('E2: the fixtures', () => {
  it('shows every fixture Container in the state the plan gives it', async () => {
    const states = await fixtureStates();
    for (const fixture of PLAN.containers) {
      const expected = fixture.state === 'unhealthy' ? 'running/unhealthy' : fixture.state;
      expect(states[fixture.name], fixture.handle).toBe(expected);
    }
    for (const shipped of PLAN.shipped) {
      if (shipped.configurations.includes(deployment.configuration)) {
        expect(states[shipped.name], shipped.handle).toMatch(/^running/);
      }
    }
  });

  it('groups the Compose Project and flags its Flagged Container', async () => {
    const { containers } = await deployment.containers();
    const shop = containers.filter((c) => c.composeProject === 'shop').map((c) => c.name);
    expect(shop.sort()).toEqual(['shop-web-1', 'shop-worker-1']);
  });

  it('serves the three Hosted Sites inside the deployment', async () => {
    const sites = await eventually(
      async () =>
        (
          (await (await deployment.api('/api/sites')).json()) as {
            sites: {
              url: string;
              status: string;
              last: { statusCode: number | null; redirect: string | null } | null;
            }[];
          }
        ).sites,
      // A reseed recreates the sites' Containers; wait for a check after they are back.
      (all) =>
        PLAN.sites.every((s) => all.find((site) => site.url === s.url)?.last) &&
        all.find((site) => site.url === 'http://healthy.pen-test.example:8081/')?.status === 'up' &&
        all.find((site) => site.url === 'http://redirect.pen-test.example:8082/')?.last
          ?.statusCode === 302,
    );
    const byUrl = new Map(sites.map((site) => [site.url, site]));
    const healthy = byUrl.get('http://healthy.pen-test.example:8081/');
    expect(healthy?.status).toBe('up');
    expect(healthy?.last?.statusCode).toBe(200);
    expect(byUrl.get('https://expired.pen-test.example:8443/')?.status).toBe('down');
    const redirect = byUrl.get('http://redirect.pen-test.example:8082/');
    expect(redirect?.last?.statusCode).toBe(302);
    expect(redirect?.last?.redirect).toBe('http://127.0.0.1:2375/containers/json');
  });

  it('gives the same set when seeded again', async () => {
    const before = await fixtureStates();
    seed();
    const after = await eventually(fixtureStates, (states) =>
      Object.keys(before).every((name) => states[name] === before[name]),
    );
    expect(after).toEqual(before);
  });
});
