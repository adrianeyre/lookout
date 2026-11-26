/**
 * S1 (#67) against the pen-test deployment, in the configuration that is running: an Image
 * built inside the throwaway daemon whose `LABEL`s carry `lookout.url` and `lookout.self`,
 * a recording listener on the deployment's loopback standing in for some other service's
 * admin port, and the fixture Hosted Sites (expired TLS, a redirect to an internal address).
 * Every request stays inside the deployment: the labelled URLs are checked at the Host (no
 * public mode here), and nothing is dialled outside the daemon's own loopback. The
 * in-process half is s1-sites.test.ts and s1-dial.test.ts. #103 and #105 turned the `today_`
 * probes here into regressions.
 */
import type { HostedSite, SitesSnapshot } from '@lookout/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dindDocker } from '../deployment.ts';
import { FIXTURE_IMAGE, PLAN, PROXY_PORT } from '../fixtures/plan.ts';
import { connect, type Deployment } from './deployment-harness.ts';

const S1_LABEL = 'lookout.pen-test.s1';
const IMAGE = 'lookout-pen-test-s1-labelled:local';
const RECORDER = 's1-recorder';
const LABELLED = 's1-image-labelled';
const ADMIN_PORT = 9101;
const ADMIN_URL = `http://admin.s1.pen-test.example:${ADMIN_PORT}/admin/flush?all=1`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/containers/json`;

/** A listener on the deployment's loopback that logs every request as a JSON line. */
const RECORDER_SCRIPT = `
import { createServer } from 'node:http';
createServer((request, response) => {
  console.log(JSON.stringify({ method: request.method, url: request.url, host: request.headers.host }));
  response.writeHead(200).end('admin');
}).listen(${ADMIN_PORT}, '127.0.0.1');
`;

/** Nothing here comes from an operator: it is what a publisher puts in an Image. */
const DOCKERFILE = `FROM ${FIXTURE_IMAGE}
LABEL lookout.url="${ADMIN_URL},${PROXY_URL}" \\
      lookout.self="true"
CMD ["idle"]
`;

let deployment: Deployment;

function cleanUp(): void {
  const ids = dindDocker(['ps', '--all', '--quiet', '--filter', `label=${S1_LABEL}`])
    ?.split('\n')
    .filter(Boolean);
  if (ids && ids.length > 0) dindDocker(['rm', '--force', '--volumes', ...ids]);
  dindDocker(['image', 'rm', '--force', IMAGE], { allowFail: true });
}

beforeAll(async () => {
  deployment = await connect();
  cleanUp();
  dindDocker(['build', '--quiet', '--tag', IMAGE, '-'], { input: DOCKERFILE });
  dindDocker([
    'run',
    '--detach',
    '--name',
    RECORDER,
    '--label',
    `${S1_LABEL}=recorder`,
    '--network',
    'host',
    '--entrypoint',
    'node',
    FIXTURE_IMAGE,
    '--input-type=module',
    '--eval',
    RECORDER_SCRIPT,
  ]);
  // No --label for lookout.*: every one of them comes from the Image.
  dindDocker(['run', '--detach', '--name', LABELLED, '--label', `${S1_LABEL}=labelled`, IMAGE]);
});
afterAll(() => cleanUp());

/** Waits until Lookout has checked the Hosted Site at `url` at least once. */
async function checked(url: string): Promise<HostedSite> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const snapshot = (await (await deployment.api('/api/sites')).json()) as SitesSnapshot;
    const site = snapshot.sites.find((s) => s.url === url);
    if (site?.last) return site;
    if (Date.now() > deadline) throw new Error(`${url} was never checked`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function recorded(): { method: string; url: string; host: string }[] {
  return (dindDocker(['logs', RECORDER]) ?? '')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { method: string; url: string; host: string });
}

describe('S1 H4: an Image chooses what Lookout fetches', () => {
  it('Docker merges the Image LABELs into the Container labels Lookout reads', () => {
    const labels = JSON.parse(
      dindDocker(['inspect', '--format', '{{json .Config.Labels}}', LABELLED])!,
    ) as Record<string, string>;
    expect(labels['lookout.url']).toBe(`${ADMIN_URL},${PROXY_URL}`);
    expect(labels['lookout.self']).toBe('true');
  });

  it("the Image's lookout.url gets no request through to another service's loopback port, only the reason (#103) (regression)", async () => {
    const site = await checked(ADMIN_URL);
    console.log(`[${deployment.configuration}] admin site: ${JSON.stringify(site.last)}`);
    expect(site.containerName).toBe(LABELLED);
    expect(site.last).toMatchObject({
      status: 'down',
      statusCode: null,
      responseMs: null,
      error: `Not checked: port ${ADMIN_PORT} is not one this Container publishes; list the URL in LOOKOUT_SITES to check it`,
    });
    expect(recorded()).toEqual([]);
  });

  it("the Image's lookout.url cannot point checks at the socket proxy's port (#103) (regression)", async () => {
    const site = await checked(PROXY_URL);
    console.log(`[${deployment.configuration}] proxy-port site: ${JSON.stringify(site.last)}`);
    expect(site.last).toMatchObject({
      status: 'down',
      statusCode: null,
      error: `Not checked: port ${PROXY_PORT} is not one this Container publishes; list the URL in LOOKOUT_SITES to check it`,
    });
  });

  it("the Image's lookout.self=true no longer makes its Container unstoppable from Lookout (#105) (regression)", async () => {
    const id = await deployment.idOf(LABELLED);
    const response = await deployment.api(`/api/containers/${id}/actions/restart`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    // Lookout's own Container, labelled by the operator in compose.yaml, is still refused.
    const own = await deployment.api('/api/containers/lookout/actions/restart', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(own.status).toBe(403);
  });
});

describe('S1 confirm: the fixture Hosted Sites', () => {
  const site = (handle: string) => PLAN.sites.find((s) => s.handle === handle)!.url;

  it('a redirect to an internal address is shown, not followed', async () => {
    const redirect = await checked(site('redirect'));
    expect(redirect.last).toMatchObject({ statusCode: 302, redirect: PROXY_URL });
  });

  it('an expired, self-signed certificate is down, with its certificate described', async () => {
    const expired = await checked(site('expired'));
    expect(expired.last?.status).toBe('down');
    expect(expired.last?.statusCode).toBeNull();
    expect(expired.last?.tls?.error ?? '').toMatch(/EXPIRED|SELF_SIGNED/);
  });

  it('the healthy Hosted Site is up', async () => {
    expect((await checked(site('healthy'))).last).toMatchObject({ status: 'up', statusCode: 200 });
  });
});
