# E4: the credentials package

> Private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md) (see [README](README.md)).

## What testers get

- **The deployment's URL:** `http://127.0.0.1:7780` (or `PEN_TEST_PORT`).
- **The fixture password**, which signs in to Lookout in the deployment.
- Read-only source, and the fixtures in [fixtures.md](fixtures.md).

Both are in `pen-test/.state/credentials.json` (mode 600, untracked), written by `pnpm pen-test:up`, with the configuration and the commit the deployment runs.

## What testers do not get

- **The deployment's `LOOKOUT_SESSION_SECRET`.** It is withheld on purpose: **finding it is itself a finding** (H1). It is generated inside the deployment and written only to the throwaway daemon's `/pen-test/lookout/.env`; it is never on the Tester's machine's disk, in the credentials package, in the repository or in any log.
- The password's hash, except as Lookout itself exposes it (also part of H1).
- **A shell** on the Tester's machine beyond running the deployment (`pnpm pen-test:*`); `docker exec` into the daemon is for the scripts and probes, not for reading the secret.
- **Write access** to the repository.

## How the credentials are made and delivered

`pnpm pen-test:up`, the first time on a fresh deployment:

1. generates a password of 18 random bytes (`crypto.randomBytes`, base64url), and its Argon2id hash with Lookout's production parameters;
2. generates a session secret of 32 random bytes (base64);
3. writes the hash and the secret into the deployment's `.env`, inside the throwaway daemon's volume (mode 600), and nowhere else;
4. writes the URL and the password to `pen-test/.state/credentials.json`, which `.gitignore` excludes and `.dockerignore` keeps out of every Image build.

Nothing is committed: every fresh deployment generates its own, and the repository holds no credential. Switching configuration keeps them; `pnpm pen-test:down` ends them. The probes change the password once (A1, H1's session half) the way ADR-0008 tells an owner to, and update the package.

## The sign-in helper

Probes sign in with `apps/server/src/pen-test/sign-in.ts`:

```ts
import { signIn, signInToDeployment } from './sign-in.ts';

const cookie = await signIn('http://127.0.0.1:7780', password); // "lookout_session=…"
const { cookie, credentials } = await signInToDeployment(); // reads the package
```

It signs in exactly as the SPA does (`POST /api/login` with the same `Origin`) and returns the cookie as a `name=value` pair for a `Cookie` header. It never needs the session secret. `sign-in.test.ts` checks it against the app in `pnpm test`; every `*.probe.ts` uses it against the deployment.

## When the round ends

Success criterion 7: every credential issued for the round is revoked and the session secret discarded.

1. `pnpm pen-test:down`: removes the deployment's volumes (and with them the `.env` holding the hash and the secret) and deletes `pen-test/.state`, the credentials package. It fails if any container, network or volume of the deployment is left.
2. Check no copy of the password survived anywhere else (a tester's notes, a scope issue, a log); if one did, delete it.
3. Note on the tracking issue (#75): "Credentials revoked and the session secret discarded on _date_", by the owner.

The password and secret are never reused: the next round's `pnpm pen-test:up` generates new ones.
