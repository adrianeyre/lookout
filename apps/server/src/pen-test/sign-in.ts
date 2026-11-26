/**
 * The probes' sign-in helper (E4, docs/pen-test/credentials-package.md): signs in to a
 * Lookout with the fixture password, exactly as the SPA does, and returns the session
 * cookie as a `name=value` pair for the Cookie header. It never reads or needs the session
 * secret, which testers do not get.
 */
import { readCredentials, type Credentials } from './deployment.ts';

export class SignInError extends Error {
  override name = 'SignInError';
  readonly status: number;
  constructor(status: number) {
    super(`Sign-in answered ${status}`);
    this.status = status;
  }
}

export async function signIn(baseUrl: string, password: string): Promise<string> {
  const response = await fetch(new URL('/api/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(baseUrl).origin },
    body: JSON.stringify({ password }),
    redirect: 'manual',
  });
  if (response.status !== 204) throw new SignInError(response.status);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('lookout_session='));
  if (!cookie) throw new Error('Sign-in set no session cookie');
  return cookie.split(';')[0]!;
}

/** Signs in to the running pen-test deployment with its credentials package. */
export async function signInToDeployment(
  credentials: Credentials = readCredentials(),
): Promise<{ cookie: string; credentials: Credentials }> {
  return { cookie: await signIn(credentials.url, credentials.password), credentials };
}
