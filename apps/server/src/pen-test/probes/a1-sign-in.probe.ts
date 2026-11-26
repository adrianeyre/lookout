/**
 * A1 (#63) against the pen-test deployment: sign-in and sessions on the real Image, in the
 * configuration that is running. The in-process half is a1-sign-in.test.ts. The `today_…`
 * probes that found #80, #81, #83 and #86 are now `(regression)` probes.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_IP } from '../fixtures/plan.ts';
import { changePassword, dindDocker, loadPinnedImage, restartLookout } from '../deployment.ts';
import { signIn } from '../sign-in.ts';
import {
  connect,
  retryOnClosedSocket,
  runInDeployment,
  type Deployment,
} from './deployment-harness.ts';

const CADDY =
  'caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0';

let deployment: Deployment;
beforeAll(async () => {
  deployment = await connect();
});

/** A session cookie for any session ID, signed with the secret alone, as session.ts once did. */
function mint(secret: string, sid: string, seen: number): string {
  const payload = Buffer.from(JSON.stringify({ sid, iat: seen, seen }), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `lookout_session=${payload}.${signature}`;
}

const sessionStatus = async (cookie: string) =>
  (await deployment.api('/api/session', { cookie })).status;

describe('A1 H3: parallel wrong passwords', () => {
  it('20 parallel wrong passwords from one fresh address: at most 5 checked, the rest 429 (regression)', () => {
    const output = runInDeployment(`
      const body = JSON.stringify({ password: 'wrong-' + Math.random() });
      const send = () => fetch(process.env.LOOKOUT + '/api/login', {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', origin: process.env.LOOKOUT },
      }).then((r) => r.status);
      const statuses = await Promise.all(Array.from({ length: 20 }, send));
      // The parallel burst may leave tries unspent (only 4 checks run at once); spend them
      // one at a time, then one more must be refused.
      const serial = [];
      for (let i = 0; i < 5; i++) serial.push(await send());
      console.log(JSON.stringify({ statuses, serial }));
    `);
    const { statuses, serial } = JSON.parse(output.trim()) as {
      statuses: number[];
      serial: number[];
    };
    const all = [...statuses, ...serial];
    const unauthorized = all.filter((s) => s === 401).length;
    console.log(
      `[${deployment.configuration}] parallel 401: ${statuses.filter((s) => s === 401).length}, 429: ${statuses.filter((s) => s === 429).length}; then ${serial.join(' ')}`,
    );
    // Five tries per address in all, however they are sent; the last is always refused.
    expect(unauthorized).toBeLessThanOrEqual(5);
    expect(all.every((s) => s === 401 || s === 429)).toBe(true);
    expect(serial.at(-1)).toBe(429);
  });
});

describe('A1 H5: a session never really ends', () => {
  it('a logged-out cookie stays refused after Lookout restarts (regression)', async () => {
    const cookie = await signIn(deployment.credentials.url, deployment.credentials.password);
    const logout = await deployment.api('/api/logout', { method: 'POST', cookie });
    expect(logout.status).toBe(204);
    expect(await sessionStatus(cookie)).toBe(401);
    restartLookout();
    expect(await sessionStatus(cookie)).toBe(401);
  });
});

describe('A1 H1 (session half) and H5: a password change ends every session', () => {
  let issued: string;
  let minted: string;
  beforeAll(async () => {
    issued = await signIn(deployment.credentials.url, deployment.credentials.password);
    // The secret can no longer be revealed through the API (K1's H1 half, #79); read it from
    // inside the deployment, as an attacker with the Host's files could.
    // The H5 probe above restarted Lookout, which ends every session (#83), the harness's
    // own included: ask with the cookie just issued.
    const reveal = await deployment.api('/api/containers/lookout/env/LOOKOUT_SESSION_SECRET', {
      cookie: issued,
    });
    expect(reveal.status).toBe(403);
    const env = dindDocker(['inspect', '--format', '{{json .Config.Env}}', 'lookout'])!;
    const secret = (JSON.parse(env) as string[])
      .find((entry) => entry.startsWith('LOOKOUT_SESSION_SECRET='))!
      .slice('LOOKOUT_SESSION_SECRET='.length);
    minted = mint(secret, 'minted-offline-by-the-pen-test', Date.now());
  });

  it('a cookie minted offline from the secret is refused (regression)', async () => {
    expect(await sessionStatus(minted)).toBe(401);
  });

  it('neither the issued nor the minted cookie outlives a password change and recreate (regression)', async () => {
    const before = deployment.credentials.password;
    const credentials = await changePassword();
    expect(credentials.password).not.toBe(before);
    await expect(retryOnClosedSocket(() => signIn(credentials.url, before))).rejects.toThrow('401');
    expect(await sessionStatus(issued)).toBe(401);
    expect(await sessionStatus(minted)).toBe(401);
  });
});

describe('A1 H7: behind an HTTPS reverse proxy', () => {
  beforeAll(() => {
    loadPinnedImage(CADDY);
    dindDocker(['rm', '--force', 'pen-test-caddy'], { allowFail: true });
    dindDocker([
      'run',
      '--detach',
      '--name',
      'pen-test-caddy',
      '--network',
      'host',
      CADDY,
      'caddy',
      'reverse-proxy',
      '--from',
      'https://localhost:9443',
      '--to',
      `${HOST_IP}:7777`,
      '--internal-certs',
    ]);
  });
  afterAll(() => {
    dindDocker(['rm', '--force', 'pen-test-caddy'], { allowFail: true });
  });

  it('Caddy terminates TLS and the session cookie is Secure (regression)', async () => {
    const { password } = (await connect()).credentials;
    const output = runInDeployment(
      `
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch('https://localhost:9443/api/login', {
            method: 'POST', body: JSON.stringify({ password: process.env.PASSWORD }),
            headers: { 'content-type': 'application/json', origin: 'https://localhost:9443' },
          });
          console.log(JSON.stringify({ status: response.status, cookie: response.headers.get('set-cookie') }));
          process.exit(0);
        } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      process.exit(1);
      `,
      { network: 'host', env: { PASSWORD: password, NODE_TLS_REJECT_UNAUTHORIZED: '0' } },
    );
    const { status, cookie } = JSON.parse(output.trim()) as { status: number; cookie: string };
    expect(status).toBe(204);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/;\s*Secure/i);
  });
});
