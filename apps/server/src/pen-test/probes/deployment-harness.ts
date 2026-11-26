/**
 * Shared by the `*.probe.ts` files, which run against the pen-test deployment in
 * `pnpm pen-test:probe`. Every request goes to the deployment's 127.0.0.1 port or runs
 * inside its throwaway daemon; nothing here reaches any other Docker or network.
 */
import { randomInt } from 'node:crypto';
import type { ContainersSnapshot } from '@lookout/shared';
import {
  dindDocker,
  readCredentials,
  runningConfiguration,
  type Configuration,
  type Credentials,
} from '../deployment.ts';
import { FIXTURE_IMAGE, HOST_IP } from '../fixtures/plan.ts';
import { signIn } from '../sign-in.ts';

export interface Deployment {
  configuration: Configuration;
  credentials: Credentials;
  cookie: string;
  /** A request to the deployment, signed in unless `cookie: null` is passed. */
  api(
    path: string,
    init?: Omit<RequestInit, 'headers'> & {
      cookie?: string | null;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  containers(): Promise<ContainersSnapshot>;
  /** A Container's ID by its name, in the deployment's daemon. */
  idOf(name: string): Promise<string>;
}

/**
 * After Lookout restarts, fetch's pool may still hold a socket the relay has closed; the
 * first request on it fails before reaching Lookout. Retry those, and only those.
 */
export async function retryOnClosedSocket<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const closed = error instanceof TypeError && error.message === 'fetch failed';
      if (!closed || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Reads a streamed response until `marker` has arrived, then lets the stream go. */
export async function readUntil(response: Response, marker: string): Promise<string> {
  if (!response.body) return '';
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(marker)) break;
  }
  return text;
}

export async function connect(): Promise<Deployment> {
  const configuration = runningConfiguration();
  if (!configuration) {
    throw new Error('The pen-test deployment is down: pnpm pen-test:up && pnpm pen-test:seed');
  }
  const credentials = readCredentials();
  const cookie = await signIn(credentials.url, credentials.password);
  const origin = new URL(credentials.url).origin;
  const deployment: Deployment = {
    configuration,
    credentials,
    cookie,
    api(path, init = {}) {
      const { cookie: given, headers: extra = {}, ...rest } = init;
      const sent = given === undefined ? cookie : given;
      const headers: Record<string, string> = {};
      if (rest.method && rest.method !== 'GET') headers.origin = origin;
      if (sent) headers.cookie = sent;
      Object.assign(headers, extra);
      return retryOnClosedSocket(() =>
        fetch(new URL(path, credentials.url), { redirect: 'manual', ...rest, headers }),
      );
    },
    async containers() {
      return (await (await deployment.api('/api/containers')).json()) as ContainersSnapshot;
    },
    async idOf(name) {
      const found = (await deployment.containers()).containers.find((c) => c.name === name);
      if (!found) throw new Error(`No Container ${name} in the deployment: pnpm pen-test:seed`);
      return found.id;
    },
  };
  return deployment;
}

/**
 * Runs a Node script in a one-off fixture Container inside the deployment, on a network of
 * its own with a random address, so its requests reach Lookout from an address of their
 * own (the sign-in limiter keys on it) and never from the Tester's relay.
 */
export function runInDeployment(
  script: string,
  options: { env?: Record<string, string>; network?: 'own' | 'host' } = {},
): string {
  const network = options.network ?? 'own';
  if (network === 'own') {
    const exists = dindDocker(['network', 'inspect', 'pen-test-probes'], { allowFail: true });
    if (exists === null) {
      dindDocker(['network', 'create', '--subnet', '10.213.0.0/16', 'pen-test-probes']);
    }
  }
  const address = `10.213.${randomInt(1, 254)}.${randomInt(2, 254)}`;
  const args = [
    'run',
    '--rm',
    ...(network === 'own'
      ? ['--network', 'pen-test-probes', '--ip', address]
      : ['--network', 'host']),
    '--entrypoint',
    'node',
  ];
  for (const [key, value] of Object.entries(options.env ?? {}))
    args.push('--env', `${key}=${value}`);
  args.push(
    '--env',
    `LOOKOUT=http://${HOST_IP}:7777`,
    FIXTURE_IMAGE,
    '--input-type=module',
    '--eval',
    script,
  );
  return dindDocker(args) ?? '';
}
