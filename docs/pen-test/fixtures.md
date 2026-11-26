# E2: the fixtures

> Private on the same terms as [the pen-testing PRD](../product-requirements-document/pen-testing.md) (see [README](README.md)).

The same synthetic Host every time. The fixtures are a **pure plan**, `apps/server/src/pen-test/fixtures/plan.ts` (data only, checked by `plan.test.ts` in `pnpm test`), and a **separate loader**, `fixtures/loader.ts`, which `pnpm pen-test:seed` runs against the deployment's throwaway daemon ([deployment.md](deployment.md)). Seeding removes every Container labelled `lookout.pen-test.fixture` and makes it again from the plan, and copies the fixture Host root afresh, so seeding twice gives the same set and reseeding after a destructive probe restores it.

**All data is synthetic.** Every value that looks like a secret is made up and contains `PEN-TEST-FAKE`, so a probe can grep any response, stream or log for it; `plan.test.ts` fails if one does not. The password is not a fixture: it is generated per deployment ([credentials-package.md](credentials-package.md)).

Every fixture Container runs the one fixture Image, `pen-test/fixture-image` (`fixture.mjs`, on Lookout's own pinned Node base), whose first argument picks what it does.

## Containers

| Handle | Name | State | What it is for |
| ------ | ---- | ----- | -------------- |
| `lookout` | `lookout` | running, healthy | Lookout itself, from the round's Image, started by the shipped `compose.yaml`; `lookout.self`. Its environment holds its own session secret and password hash (H1). Not created by the loader, only checked. |
| `socket-proxy` | `lookout-docker-proxy` | running (socket-proxy only) | The shipped socket proxy (ADR-0011). Until #101 it listened on the deployment's loopback, port 2375; it now has no network and listens on a Unix socket in a volume only it and Lookout mount. `lookout.self` (H2, P1). Only checked. |
| `victim` | `victim` | running | Made-up secrets in its environment (`DATABASE_URL`, `API_TOKEN`, `AWS_SECRET_ACCESS_KEY`), command (`--requirepass …`, `--db postgres://…`), labels (a Traefik `basicauth.users` hash, a backup URL) and a bind mount's source path (H8, K1). |
| `shop-web` | `shop-web-1` | running | The Compose Project `shop`, in good health. |
| `shop-worker` | `shop-worker-1` | running, unhealthy | The Flagged Container: a health check that always fails, in the `shop` project. |
| `stopped` | `stopped-removable` | exited (0) | A stopped Container that remove probes may destroy; reseed to get it back. |
| `broken` | `broken-start` | created | Its entrypoint does not exist, so starting it fails inside Docker: for the error text that reaches the browser (H11). |
| `hostile` | `hostile.container_-..x` | running | **The Hostile Container** (`GLOSSARY.md`). See below. |
| `site-healthy` | `site-healthy` | running | Serves the healthy Hosted Site. |
| `site-expired` | `site-expired-tls` | running | Serves the Hosted Site with the expired certificate. |
| `site-redirect` | `site-redirect-internal` | running | Serves the Hosted Site that redirects to an internal address. |

### The Hostile Container

- **Name:** Docker's grammar refuses markup in names, so the name tries the grammar's edges: dots, underscores, dashes and `..`.
- **Labels:** `lookout.url` names three SSRF targets: the deployment's loopback at the socket proxy's old port (`http://127.0.0.1:2375/containers/json`; since #101 nothing listens there, and since #103 a label may not name a port its Container does not publish), link-local metadata (`http://169.254.169.254/latest/meta-data/`) and IPv6 loopback (`http://[::1]:2375/_ping`). A Traefik router rule names `169.254.169.254` and `localhost`. Other labels carry markup (`<img src=x onerror=…>`), terminal escapes (SGR and an OSC 8 link), a right-to-left override, and a 64 KiB value.
- **Environment:** a 200-character variable name, markup, escapes, bidirectional characters and a 64 KiB value.
- **Logs:** markup, `<script>`, SGR and screen-clearing escapes, an OSC 8 link, bidirectional and control characters (NUL, BEL, BS, DEL), Markdown, a line on stderr, then a 256 KiB line with no newline, then nothing.

The values that would exhaust memory are **described by size only** (`PLAN.oversized`) and generated on demand by X1 (#69), never by the loader:

| Handle | Where | Size | Against |
| ------ | ----- | ---- | ------- |
| `x1-label` | label | 64 MiB | every `containers` event on `/api/stream` carries every label (H9) |
| `x1-environment` | environment | 64 MiB | inspect bodies are read whole (H9) |
| `x1-log-line` | log line without a newline | 512 MiB | `LineSplitter` keeps everything after the last newline (H9) |
| `x1-frame` | log frame header | 4 GiB − 1 | the frame decoder buffers to the size a header claims (H9) |

## Hosted Sites

Served inside the daemon on its loopback, where Lookout's checks connect (ADR-0010); nothing is fetched from outside.

| Handle | URL | Served by | Lookout should show |
| ------ | --- | --------- | ------------------- |
| `healthy` | `http://healthy.pen-test.example:8081/` | `site-healthy` | Up, 200. |
| `expired` | `https://expired.pen-test.example:8443/` | `site-expired` | Down: the certificate is self-signed and expired on 1 February 2024. |
| `redirect` | `http://redirect.pen-test.example:8082/` | `site-redirect` | A 302 to the socket proxy's address, shown and not followed. |

The Hostile Container's `lookout.url` and Traefik labels add more Hosted Sites; they are S1's (#67) to probe.

## The fixture Host root

`e2e/fixtures/host`, as `pnpm dev` and the Playwright tests use, copied to `/pen-test/host-root` inside the daemon and mounted read-only as Lookout's `/host`. Reseeding copies it afresh.

## The password

One password, generated per deployment; see [credentials-package.md](credentials-package.md).
