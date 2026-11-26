import { afterEach, describe, expect, it } from 'vitest';
import { TEST_PASSWORD } from '../../test/helpers.ts';
import { SignInError, signIn } from './sign-in.ts';
import { startProbeApp, type ProbeApp } from './probes/harness.ts';

let probe: ProbeApp | undefined;
afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

async function listening(): Promise<string> {
  probe = await startProbeApp();
  return probe.app.listen({ host: '127.0.0.1', port: 0 });
}

describe('the probes’ sign-in helper (E4)', () => {
  it('signs in with the password and returns a cookie that reaches the API', async () => {
    const url = await listening();
    const cookie = await signIn(url, TEST_PASSWORD);
    expect(cookie).toMatch(/^lookout_session=[\w-]+\.[\w-]+$/);
    const session = await fetch(new URL('/api/session', url), { headers: { cookie } });
    expect(session.status).toBe(200);
  });

  it('throws with the status for a wrong password', async () => {
    const url = await listening();
    await expect(signIn(url, 'wrong')).rejects.toEqual(new SignInError(401));
  });
});
