/**
 * `pnpm dev`: runs the server with development defaults for anything not set in the
 * environment or in a .env file at the repo root. Not part of the Image.
 *
 * - On Linux the Host root defaults to "/"; elsewhere it uses the e2e fixture Host.
 * - Without LOOKOUT_PASSWORD_HASH the password is "lookout".
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth/password.ts';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
// The .env file is written for Compose, which reads $$ as a literal $; Node does not.
if (env.LOOKOUT_PASSWORD_HASH)
  env.LOOKOUT_PASSWORD_HASH = env.LOOKOUT_PASSWORD_HASH.replaceAll('$$', '$');
env.LOOKOUT_HOST_ROOT ??=
  process.platform === 'linux'
    ? '/'
    : fileURLToPath(new URL('../../../e2e/fixtures/host', import.meta.url));
// A fixed secret keeps you signed in across --watch restarts. Development only.
env.LOOKOUT_SESSION_SECRET ??= 'development-only-session-secret-do-not-use-in-production';
if (!env.LOOKOUT_PASSWORD_HASH) {
  env.LOOKOUT_PASSWORD_HASH = await hashPassword('lookout');
  console.warn('[dev] LOOKOUT_PASSWORD_HASH is not set, so the password is "lookout".');
}
console.warn(`[dev] Host root: ${env.LOOKOUT_HOST_ROOT}`);

await import('../src/main.ts');
