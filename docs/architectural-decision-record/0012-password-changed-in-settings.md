---
status: accepted
---

# The password can be changed in Settings, kept as a hash in a data volume

Until now the only way to change Lookout's password was to run `hash-password`, edit `LOOKOUT_PASSWORD_HASH` in `.env` and recreate the Container ([ADR-0008](./0008-single-password-private-network.md)). Lookout kept nothing on disk: its root filesystem is read-only and everything it shows lives in memory.

Settings now has a **Password** Widget. It asks for the current password and the new one twice, and `POST /api/password` checks the current password exactly as a sign-in does: under the same per-address limit of 5 failures per 15 minutes, the same cap on concurrent Argon2id checks, the session and `Origin` checks every state-changing route has, and with 403 (not 401) for a wrong password so the browser keeps its session. New passwords must be at least 8 characters, as `hash-password` requires.

The new hash is written to `password.json` in **`LOOKOUT_DATA_DIR`**, written whole and renamed into place with mode `0600`. `compose.yaml` sets it to `/data` on a named volume, `lookout-data`, which the Image creates owned by Lookout's user (65532) with mode `0700`. This is the only place Lookout writes. Without `LOOKOUT_DATA_DIR` the endpoint answers 409 and Settings explains how to change the password in `.env`.

The file records a SHA-256 fingerprint of the `LOOKOUT_PASSWORD_HASH` it replaced. At start, the saved hash is used only while `.env` still holds that same hash. So the recovery path for a forgotten password stays what it was: put a new hash in `.env` and recreate the Container, and the `.env` hash wins.

Because the password hash is part of the session signing key ([ADR-0008](./0008-single-password-private-network.md), #80), a change rebuilds the session store. Every session ends, including open event streams at their next heartbeat, and the browser that made the change is given a fresh cookie.

## Consequences

- Lookout is no longer stateless on disk, but only for one small file holding an Argon2id hash. No password, session or metric is written. `docker compose down -v` removes the volume and brings back the `.env` password.
- Whoever holds a signed-in session still cannot change the password without knowing it, and a guess there costs as much as a guess at the sign-in page.
- `LOOKOUT_DATA_DIR` names a path inside Lookout's own Container, never a Host path: it never reaches `HostRoot`. Pen-test probe R1 checks this.
- The socket-proxy override (`compose.socket-proxy.yaml`) mounts the same volume, since it replaces Lookout's `volumes` list.
