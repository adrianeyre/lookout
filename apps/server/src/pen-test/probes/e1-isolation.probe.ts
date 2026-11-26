/**
 * E1 (#56): the pen-test deployment is isolated. Nothing in it reaches the internet, it
 * publishes only on 127.0.0.1, and Lookout in it sees the throwaway daemon's Containers,
 * never the Tester's machine's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, dindDocker, docker, inDind, outer } from '../deployment.ts';
import { FIXTURE_IMAGE } from '../fixtures/plan.ts';
import { connect, readUntil, type Deployment } from './deployment-harness.ts';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});

const lines = (text: string | null) =>
  (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

describe('E1: the pen-test deployment', () => {
  it('publishes ports on 127.0.0.1 only', () => {
    const services = lines(outer(['ps', '--format', 'json'])).map(
      (line) =>
        JSON.parse(line) as {
          Name: string;
          Publishers: { URL: string; PublishedPort: number }[] | null;
        },
    );
    expect(services.map((s) => s.Name).sort()).toEqual([`${PROJECT}-dind-1`, `${PROJECT}-relay-1`]);
    const published = services.flatMap((s) =>
      (s.Publishers ?? []).filter((p) => p.PublishedPort > 0).map((p) => `${s.Name} ${p.URL}`),
    );
    expect(published.length).toBeGreaterThan(0);
    for (const entry of published) expect(entry).toMatch(/ 127\.0\.0\.1$/);
  });

  it('gives the throwaway daemon and the relay no way out', () => {
    // busybox wget in both; a timeout or "unreachable" is the pass.
    for (const service of ['dind', 'relay']) {
      const reached = outer(
        ['exec', '-T', service, 'wget', '-q', '-T', '4', '-O', '/dev/null', 'http://1.1.1.1/'],
        { allowFail: true },
      );
      expect(reached, `${service} reached 1.1.1.1`).toBeNull();
    }
  });

  it('gives no Container inside the daemon a way out, Lookout and the proxy included', () => {
    const running = lines(dindDocker(['ps', '--quiet']));
    expect(running.length).toBeGreaterThan(0);
    // Lookout and the proxy share the daemon's own namespace (network_mode: host).
    const namespaces = ['host', ...running.map((id) => `container:${id}`)];
    for (const namespace of namespaces) {
      const output = dindDocker(
        ['run', '--rm', '--network', namespace, FIXTURE_IMAGE, 'egress-check'],
        { allowFail: true },
      );
      expect(output?.trim(), `${namespace} reached the internet`).toBe('isolated');
    }
  }, 600_000);

  it("shows the throwaway daemon's Containers, never the Tester's machine's", async () => {
    const inLookout = (await deployment.containers()).containers.map((c) => c.name).sort();
    const inDaemon = lines(dindDocker(['ps', '--all', '--format', '{{.Names}}'])).sort();
    expect(inLookout).toEqual(inDaemon);
    const testers = lines(docker(['ps', '--all', '--format', '{{.Names}}'])).filter(
      (name) => !name.startsWith(`${PROJECT}-`),
    );
    for (const name of testers) expect(inLookout).not.toContain(name);
  });

  it('reads the fixture Host root, not a real one', async () => {
    const hostname = inDind(['cat', '/pen-test/host-root/etc/hostname'])?.trim();
    const response = await deployment.api('/api/stream', { signal: AbortSignal.timeout(5000) });
    const text = await readUntil(response, `"hostname":"`);
    expect(text).toContain(`"hostname":"${hostname}"`);
  });
});
