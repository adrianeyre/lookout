# PRD: Pen-testing Lookout

**Status:** v0.3 (25 November 2026): every scope issue probed (A1, W1, K1, P1, S1, R1, X1, I1, I2, V1, V2), every hypothesis and "Good and to confirm" item has a dated verdict below, and every finding (#79-#93, #101-#132) is fixed and verified, except #102, accepted in ADR-0011 until 25 February 2027. The owner confirmed the window (E3, #61) and set the limits (X1b, #73).
**Date:** 25 November 2026
**Owner:** Adi
**Label:** `prd:pen-test`

This file is the brief. Decisions stay in [`docs/architectural-decision-record/`](../architectural-decision-record/), and what Lookout does stays in [the Lookout PRD](./lookout.md). Capitalised terms (Host, Container, Container Action, Hosted Site, Hostile Container, Live Window, Project Website…) are used exactly as [`GLOSSARY.md`](../../GLOSSARY.md) defines them.

> **Keep this file private.** The opening register below names files, lines and exploit chains against a tool that holds root-equivalent Docker access. Neither this file nor anything under `docs/pen-test/` may be published, and this repository must not be made public, while any hypothesis or finding here at `severity:high` or `severity:critical` is open. `site/build.ts` publishes `docs/images` and `site/public` only; a probe test fails if anything from this file or `docs/pen-test/` reaches the built site (`site/privacy.test.ts` in `pnpm test`, and `pnpm site:check` against `site/dist` in CI).

---

## Terms used in this file

These are words about the engagement, not about Lookout, so they live here and not in the glossary. They mean what they mean in the email platform's pen-testing PRD, so the rounds read alike.

| Term                    | Meaning                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Round**               | One pen-test engagement: a window, a scope, a set of findings and a sign-off. This file describes the first.                                                  |
| **Hypothesis**          | An entry in the opening register (H1, H2…): what the code reads like from outside, with the file that has to be disproved. Not yet a finding.                 |
| **Scope issue**         | A GitHub issue under `prd:pen-test` that partitions the surface (E1, A1, K1…) and lists what to probe there.                                                  |
| **Finding**             | A confirmed weakness, filed as its own issue with one `severity:*` label and a pointer to its scope issue.                                                   |
| **Verdict**             | What the round concluded about a hypothesis: confirmed (and filed as a finding), refuted, or confirmed as a documented decision.                              |
| **Pen-test deployment** | The dedicated Compose stack the round runs against: Lookout, a throwaway Docker daemon and a fixture Host. Never a real Host.                                  |
| **Tester's machine**    | The computer the pen-test deployment runs on. It is not the Host: during the round the Host is the deployment's fixture Host and its throwaway Docker daemon. |

---

## Current state of play

Lookout is one Fastify process serving the React SPA, its JSON API and its Server-Sent Event streams, in one Container on the Host ([ADR-0007](../architectural-decision-record/0007-vite-spa-and-fastify-single-process.md)). It runs with `network_mode: host`, mounts `/var/run/docker.sock` and the Host's `/` read-only ([ADR-0003](../architectural-decision-record/0003-deploy-as-container-with-host-access.md)), and is meant to be reached only over a LAN or VPN, behind one Argon2id password ([ADR-0008](../architectural-decision-record/0008-single-password-private-network.md)). It has no database and keeps sessions, the sign-in limiter and the Live Window in memory ([ADR-0004](../architectural-decision-record/0004-live-metrics-only.md)).

What is built and so in scope:

- **Sign-in and sessions:** one password, stateless HMAC-signed session cookies with an idle expiry, an in-memory revocation list for log out, a sign-in limiter, and an `Origin` check on every state-changing request.
- **Host Metrics:** read from the Host root under `/host`, sampled into the Live Window and streamed.
- **Containers:** listed, inspected and streamed from the Docker Engine API; logs followed; environment values revealed one at a time (FR-20); Container Actions (start, stop, restart, remove), refused on `lookout.self` ([ADR-0005](../architectural-decision-record/0005-container-actions-without-shell.md)).
- **Hosted Sites:** found from Container labels (Traefik routers, `lookout.url`) and `LOOKOUT_SITES`, checked over HTTP and TLS from the Host ([ADR-0010](../architectural-decision-record/0010-hosted-sites-checked-from-the-host.md)).
- **The optional socket proxy:** `compose.socket-proxy.yaml` narrows Lookout's Docker access to an allowlist ([ADR-0011](../architectural-decision-record/0011-optional-docker-socket-proxy.md)).
- **Delivery:** the Image on GHCR (`:X.Y`, `:latest`, `:edge`), the release and Image workflows, Dependabot, and the Project Website on GitHub Pages ([ADR-0009](../architectural-decision-record/0009-project-website-on-github-pages.md)).

**Nothing in this tree has ever been probed by anyone who did not write it.** The [v1](../security-review-v1.md) and [v1.1](../security-review-v1.1.md) security reviews were written by the people who built Lookout; this round treats every "Pass" in them as a hypothesis to confirm.

---

## Problem statement

**Before the next release of Lookout, or before this repository is made public, whichever comes first, someone working against Lookout rather than for it must probe this tree against a Lookout-shaped scope and file what they find, so the owner can sign off that Lookout does not hand its Host to anyone without the password, or to any Container on the Host, on evidence rather than on the care of whoever built it.**

Three reasons to do it now:

1. **It is root on the Host.** Anyone who signs in, or who gets past sign-in, holds Docker, and Docker is the Host ([ADR-0003](../architectural-decision-record/0003-deploy-as-container-with-host-access.md)).
2. **Every Container is an input.** Labels, names, environment and logs are written by whoever built each Image, and Lookout reads them all. A Hostile Container needs no password.
3. **The surface is small.** About 20 routes, one process and two Compose files. This is the cheapest the round will ever be.

### The gate

- **No release while the round is open, nor while a high or critical finding is open.** The release workflow's gate job (`scripts/release-gate.ts`, run before semantic-release) fails while the round's **tracking issue** is open (named by `PEN_TEST_TRACKING_ISSUE` in `release.yml`; empty while no round is in progress; the first round, tracked as #75 in the original repository, is complete), or while any open issue carries `prd:pen-test` and `severity:critical` or `severity:high`, and names what is blocking in the job summary. `:edge` still publishes. Built by #58.
- **The repository is not made public** while any hypothesis or finding here at `severity:high` or `severity:critical` is open. No check can stop a visibility change, so this rule is also stated in the README's development section.
- The gate lifts when the tracking issue is closed and every finding above `severity:low` is remediated, or waived in writing by the owner.

---

## Engagement shape

- **Who runs it:** the owner and agents working each scope issue through AI Office (`ai-office`, `role:coder`) against this file. Anything only the owner can do carries `needs-human`. **A second round by an external tester is recommended, not a gate:** Lookout is a single-user tool on its owner's own Host and holds no third party's data. Revisit this if Lookout gains users other than its owner, or if a release is recommended to others as safe on an untrusted network.
- **Type: grey-box.** Testers get read-only source, the pen-test deployment's URL, the fixture password, and the fixtures in E2. They do **not** get the deployment's `LOOKOUT_SESSION_SECRET`, a shell on the Tester's machine beyond running the deployment, or write access to the repository. Finding the session secret anyway is itself a finding.
- **Target: a dedicated pen-test deployment.** Its own Compose project, in which Lookout talks to a **throwaway Docker daemon** (`docker:dind`) holding the fixture Containers, and reads a **fixture Host root** in place of the real `/`, as `pnpm dev` does with `e2e/fixtures/host`. Published on `127.0.0.1` only. Never the Tester's machine's own Docker, and never a real Host. Teardown destroys the volumes, not just the containers.
- **Both shipped configurations:** the default `compose.yaml` (socket mounted directly) and `compose.socket-proxy.yaml` (ADR-0011), each with the Image built from the round's commit. Every probe names the configuration it ran against; anything the proxy is meant to stop is probed through the proxy. Lookout behind an HTTPS reverse proxy is covered by reasoning, and by one probe where a claim depends on it (H7).
- **What dind can't show:** escapes through `network_mode: host` and the real `/` mount. A one-off check on a disposable Linux VM (V2) covers them.
- **No request leaves it.** Hosted Sites are served inside the deployment; no network in it has a way out.
- **Data: synthetic only,** generated by the fixtures (E2). Environment values that look like secrets are made up.
- **Rules of engagement** (E3) are codified before the window opens: the window, the in-scope host, no destructive testing outside the pen-test deployment, and the remediation targets below. The window closes no later than **Friday 22 January 2027 at 17:00** UK time, and is extended only by a dated amendment to the rules of engagement made before it closes.

### Explicitly out of scope

- **Docker Engine, GHCR, GitHub, GitHub Pages and wollomatic/socket-proxy as platforms.** How Lookout _uses_ them (the Engine endpoints it calls, the proxy's allowlist, the workflows' tokens, what the site copies) is in scope; the platforms themselves are not.
- **Denial of service and volume testing.** A missing limit is in scope as a finding, worked out by arithmetic; exercising it is not. A race may be shown with at most 20 parallel requests.
- **Social engineering and physical access.**
- **Any real Host, LAN or tailnet,** the owner's above all, and the Tester's machine beyond the deployment.
- **The live Hosted Sites themselves.**
- **The Project Website** (`site/`), except what it publishes from the repository and the supply chain of its build, the vendored `site/stageshow` kit included.

---

## The tester's opening register

This is the reconnaissance a tester would do on day one, done in advance so the round starts from hypotheses rather than from a directory listing. **Each entry is a hypothesis, not a confirmed finding.** It says what the code reads like from outside and names the file that has to be disproved. Where a behaviour is deliberate and documented, that is said plainly; a documented decision is still a finding when nothing records when it has to stop being true.

Severities are the **opening** estimate, for triage order only. File and line references are as of commit `8007b1a`.

### H1: Lookout reveals its own session secret and password hash · high

`GET /api/containers/:id/env/:name` (`apps/server/src/app.ts:433-448`) has no `lookout.self` check; only Container Actions refuse it (`app.ts:474-479`, `packages/shared/src/actions.ts:21-23,34`). `compose.yaml:21-22` puts `LOOKOUT_PASSWORD_HASH` and `LOOKOUT_SESSION_SECRET` in Lookout's own environment, `parse.ts:142` keeps every variable, and the detail lists their names (`parse.ts:184-187`). Sessions are stateless HMAC (`auth/session.ts:14-18,84-91`), so whoever holds the secret mints a cookie with any session ID and any last-seen time, with no server record and no maximum lifetime. So:

- one signed-in moment (a stolen cookie, or H6) becomes access that outlives a password change, because ADR-0008's "change the env var and recreate" leaves the secret as it was;
- the hash can be attacked offline at the Argon2id cost in `auth/password.ts:15`;
- any docker-group user, and with the proxy any process on the Host's loopback (H2), reads both with `GET /containers/lookout/json`.

[v1 review](../security-review-v1.md) item 5 covers logs and unrevealed responses only. Probe: reveal both through the API, mint a cookie offline, change the password and recreate the Container, then replay it.

**Verdict, H1 (25 November 2026): confirmed, both halves, in both configurations.** K1 (#65) revealed `LOOKOUT_SESSION_SECRET` and `LOOKOUT_PASSWORD_HASH` from Lookout's own Container through the API; A1 (#63) minted a cookie offline from the revealed secret, changed the password as ADR-0008 says and recreated the Container, and both the issued and the minted cookie still worked. Findings: #79 (`severity:high`, the reveal) and #80 (`severity:medium`, a password change ends no session). Open: H1 needs its dated answer (success criterion 5).

**Fix, H1 (25 November 2026): fixed and verified.** A `lookout.self` Container's environment values, and its other masked values, are refused with 403 by ID and by name (#79). The session signing key now includes `LOOKOUT_PASSWORD_HASH` and 32 random bytes chosen at start, so a password change ends every session and nobody can mint a cookie offline, even with the secret and the hash (#80). Dated answer (success criterion 5): **fixed 25 November 2026, verified the same day** by K1's and A1's probes in both configurations.

### H2: The socket proxy hands Docker to every process on the Host's loopback · critical

`compose.socket-proxy.yaml:18,33,35` runs the proxy with `network_mode: host`, `-listenip=127.0.0.1` and `-allowfrom=127.0.0.1/32`, and no authentication. Any local user (`www-data`, `nobody`, a compromised web app), not only the docker group, and every Container on the Host network reaches it. Its allowlist (`:41-43`) returns every Container's environment (H1's secret included) and logs, and starts, stops, restarts and removes Containers. ADR-0011's "less than the docker group already allows any local user it includes" is true only for users already in that group, and nothing records the new access as accepted.

- `-allowDELETE` bounds the path, not the query: Lookout sends `force=false&v=false` (`docker/engine.ts:270`), a local caller may send `force=true&v=true`. Whether wollomatic anchors patterns, and how it treats the query string, is unconfirmed.
- Hosted Site checks dial `127.0.0.1:<port>` (`sites/check.ts:14,124`), so a `lookout.url` label can point Lookout at the proxy's port (GET only).

Opened at critical under the severity table: no password and no group membership is needed, only a foothold on the Host. Probe as an unprivileged Host user and from a host-network Container; `DELETE …?force=true&v=true` on a running Container with volumes; path tricks (`//`, `%2F`, `/v1.41/containers/x/json/../exec`, `/images/..%2f../json`, a trailing `/`).

**Verdict, H2 (25 November 2026, P1 #66 and V2 #74): confirmed, in `compose.socket-proxy.yaml`; sound in the default configuration.** In the deployment, a Host user as `nobody` and a host-network Container as `nobody` read every Container's environment through the proxy, Lookout's password hash included, and restarted and force-removed a running Container with its volume (`?force=true&v=true` → 204). On a real Linux VM (V2), an unprivileged user outside the docker group read a victim's made-up token the same way. All 15 path tricks were refused (wollomatic matches the anchored pattern against the path). Findings: #101 (`severity:critical`), #102 (`severity:medium`).

**Fix, H2 (25 November 2026): fixed and verified (#101); #102 accepted.** The proxy has no network and no TCP port: it listens on a Unix socket in a volume only it and Lookout mount, mode 0660 for Lookout's group in a root-owned directory, so no other process on the Host can reach it ([ADR-0011](../architectural-decision-record/0011-optional-docker-socket-proxy.md), amended). Verified in the deployment (connection refused from the Host and from a host-network Container) and on the V2 VM (`000` on 2375 and on the socket). The proxy still cannot see a remove's query, so Lookout itself could force-remove; ADR-0011 accepts that until **25 February 2027** (#102). **Dated answer (success criterion 5): fixed 25 November 2026, verified the same day.**

### H3: Parallel sign-ins pass the limiter, and each costs 19 MiB · high

`app.ts:281-291` checks the limiter before awaiting `verifyPassword` and records the failure after, so N requests sent at once all pass. Each verification is 19 MiB of Argon2id (`auth/password.ts:15,19-33`) with no concurrency cap, and `compose.yaml` sets no `mem_limit`, so memory on the Host is spent before sign-in. The limiter's map (`auth/rate-limit.ts:6,26,40-42`) is pruned only past 10,000 keys, and only of expired ones; each IPv6 address is its own key. `trustProxy: false` (`app.ts:165`) is right, but behind a reverse proxy or Tailscale Serve every caller shares one key, so five wrong tries lock the owner out for 15 minutes. The limiter is lost on restart (v1 review, accepted risks).

Probe with at most 20 parallel wrong passwords: count 401s against 429s. Work out the memory for N by arithmetic against the Host's RAM; never run it. Carried with H9 to X1.

**Verdict, H3 (25 November 2026, A1 #63): confirmed, in-process and in both configurations.** 20 parallel wrong passwords from one fresh address: 20 × 401, no 429, then 429. Each IPv6 address is its own key; the map keeps every key within a window and, past 10,000, every failure walks it. `trustProxy: false` holds (`X-Forwarded-For` ignored). Memory by arithmetic only: 19 MiB per check, 20 → 380 MiB, 1,000 → 19 GiB. Findings: #81 (`severity:medium`), #82 (`severity:low`). The figures are X1's (#69). Open: H3 needs its dated answer (success criterion 5).

**Fix, H3 (25 November 2026): fixed and verified.** A password check counts against its address from the moment it starts, at most 4 run at once from every address together, and anything over is a 429 with `Retry-After` (#81). Keys are an IPv4 address, or an IPv6 /64, with IPv4-mapped addresses folded to IPv4; at most 10,000 are held, the least recently failed forgotten first, in O(1) per failure (#82). The keying decision is recorded under the limits pre-condition below. Dated answer (success criterion 5): **fixed 25 November 2026, verified the same day** by A1's probes in both configurations (20 parallel wrong passwords: 4 checked, 16 × 429, then one more 401 and 429s).

### H4: Image publishers, not the operator, choose what Lookout fetches · medium

`sites/discovery.ts:91-106` takes any `http(s)` URL on any port from `lookout.url`, and `:122` reads `lookout.check=public`; the Traefik host pattern (`:32`) takes IP literals such as `169.254.169.254`. By default a check dials `127.0.0.1:<port>` in the Host's network namespace with the label's path and `Host` header (`check.ts:124,198-208`); in public mode it dials whatever DNS returns, with no address filter. The Websites page shows status, a `Location` of up to 2,048 characters (`check.ts:229-232`), certificate names and timing: a port scanner and a partial-read SSRF.

ADR-0010 and the [v1.1 review](../security-review-v1.1.md) item 3 accept this because "whoever controls labels controls Docker". But Docker merges an Image's `LABEL`s into the Container's labels (`parse.ts:116`), so the publisher of any Image pulled is a Hostile Container author, and nothing records when the acceptance stops being true. Likewise:

- `LABEL lookout.self=true` (`actions.ts:21-23`) makes a Container unstoppable from Lookout;
- `MAX_SITES` keeps the first 500 by URL, `LOOKOUT_SITES` included (`monitor.ts:25,167`, `discovery.ts:150`), so one label listing 500 hosts that sort first crowds out the operator's own.

Probe with an Image carrying these labels: which requests arrive, what the page shows of metadata and loopback admin ports, whether its Container Actions are refused, and whether `LOOKOUT_SITES` is crowded out.

**Verdict, H4 (25 November 2026, S1 #67 and V1 #72): confirmed, in-process and in both configurations.** Docker merges an Image's `LABEL`s into its Containers' labels, so an Image's publisher pointed checks at any port on the Host's loopback (the proxy's included) and, with `lookout.check=public`, at metadata, private and loopback addresses with no filter; 500 labelled URLs crowded `LOOKOUT_SITES` out; an Image's `lookout.self=true` made its Container unstoppable. ADR-0010, the v1.1 review and the README rested on "whoever controls labels controls Docker". Sound: no redirect followed, no body read, the 16 KiB header cap, truncation, TLS verified, Check now by ID and once every 5 s. Findings: #103 and #104 (`severity:medium`), #105 and #121 (`severity:low`).

**Fix, H4 (25 November 2026): fixed and verified.** At the Host a label URL is checked only on port 80, 443 or a port its Container publishes; in public mode no check connects to an internal address, judged on the address it connects to, so rebinding cannot pass; `LOOKOUT_SITES` comes first and one Container names at most 20; a label URL over 2,048 characters is skipped; an Image's own `lookout.self` does not make its Container self. ADR-0010, the v1.1 review (item 3, now "Fixed") and the README say so, with when it stops being true.

### H5: A session never really ends · medium

`session.ts:72-76` moves the last-seen time on every use, so a session in use never expires. Log out is an in-memory map (`:23,78-82`), so after a restart or an update a logged-out cookie works again within the idle period (7 days by default, up to 365, `config.ts:71`). Changing the password ends no session; only changing the secret does, and nothing documents that. `config.ts:107-112` checks only that the secret is 32 bytes or more, so 32 of one character is accepted. The v1 review says "restarting Lookout signs everyone out"; `session.ts:15-17` says sessions "survive a restart".

Probe: log out, restart, replay; replay after a password change; keep one session alive past 30 days with a moved clock; start with a one-character secret.

**Verdict (25 November 2026, A1 #63): confirmed, in-process and in both configurations.** A logged-out cookie works again after `docker restart lookout` (#83); a session used every 6 days is alive after 31 (#84); a password change ends no session (#80, under H1); a 32-byte one-character secret is accepted (#85, `severity:low`). Findings #83 and #84 are `severity:medium`.

**Fix, H5 (25 November 2026): fixed and verified** (the round-one probes, re-run in both configurations on 25 November 2026). The signing key includes a random value chosen at start, so restarting Lookout signs everyone out and a logged-out cookie never returns (#83); the v1 security review's "restarting Lookout signs everyone out" is now true. A session ends `LOOKOUT_SESSION_MAX_DAYS` (default 30) after sign-in however often it is used, and its cookie's `Max-Age` never outlives that (#84). A session secret with fewer than 10 different characters, one short pattern repeated, or a placeholder word is refused at start, unechoed (#85).

**Verdict, H5's documents (25 November 2026, V1 #72):** the README, the v1 review and `session.ts` now agree with the code since #83; the in-memory limiter's acceptance now records its end (#131).

### H6: DNS rebinding reaches sign-in from any page the owner visits · medium

`auth/origin.ts:7-18` compares `Origin` with the request's own `Host`, and nothing restricts which `Host` is served (`app.ts:224-228`), so a rebound name passes. `/api/login`, `/login` and `/healthz` are public (`app.ts:265-305,589`). A right guess sets a cookie on the attacker's origin with the whole API behind it; wrong guesses are counted against the owner's own address (H3). Binding to `127.0.0.1` or a LAN address doesn't stop the owner's browser. Probe with a rebinding harness against `127.0.0.1` and a LAN address, and with `Host: evil.example`.

**Verdict (25 November 2026, W1 #64): confirmed, in-process and in both configurations.** With `Host` and `Origin` of `evil.example` (what the browser sends once a rebound name resolves to `127.0.0.1` or a LAN address), sign-in answers 204 and the cookie reads the API; a missing, `null` or foreign `Origin` is still refused. A rebinding DNS server was not run, as no request may leave the deployment. Finding: #87 (`severity:medium`).

**Fix, H6 (25 November 2026): fixed and verified** (the round-one probes, re-run in both configurations on 25 November 2026). Every request's `Host` must be an IP address, `localhost`, or a name in `LOOKOUT_HOSTNAMES`; anything else gets `421` before any route, sign-in, page or asset (#87). An IP address cannot be rebound, since a rebound page's `Host` is the attacker's name.

### H7: "Behind an HTTPS reverse proxy the cookie becomes Secure" looks untrue · medium

`app.ts:219` sets `Secure` only when `request.protocol === 'https'`. Lookout has no TLS listener (`main.ts:30`) and, with `trustProxy: false`, ignores `X-Forwarded-Proto`, so the protocol is always `http`. The v1 review's accepted risks and the README claim the opposite, and no test checks `Secure`. Probe behind Caddy or Traefik with TLS and read `Set-Cookie`.

**Verdict (25 November 2026, A1 #63): confirmed, in-process and behind Caddy 2 with TLS in both configurations.** The cookie is `HttpOnly; SameSite=Strict; Path=/` and never `Secure`. Finding: #86 (`severity:medium`).

**Fix, H7 (25 November 2026): fixed and verified** (the round-one probes, re-run in both configurations on 25 November 2026). The cookie is `Secure` when the request came over TLS or `X-Forwarded-Proto`'s first value is `https` (#86). The header only ever adds `Secure`, which a browser on plain HTTP ignores, so a forged one only breaks the forger's own sign-in; it changes nothing else (`trustProxy` stays `false`). The README says which proxies send it, and `LOOKOUT_SECURE_COOKIE=true` is the explicit setting for one that does not.

**Verdict, H7's documents (25 November 2026, V1 #72): confirmed, and fixed.** The v1 review still said the cookie became `Secure` "automatically" behind an HTTPS proxy; it now names `X-Forwarded-Proto` and `LOOKOUT_SECURE_COOKIE`, and the README says which `Host` values are answered (#132, `severity:low`).

### H8: Secrets outside the environment are shown in full · medium

The one-at-a-time, logged reveal (FR-20, `app.ts:429-447`) covers environment values only. The detail (`parse.ts:184-187`) sends the command, entrypoint, labels and mounts unmasked, and the summary (`:166-181`) puts every label in every `containers` event on `/api/stream` (`app.ts:379,383`). `--requirepass …`, database URLs in a command and Traefik `basicauth.users` hashes in labels are common. Probe with a Container holding secrets in its command and labels, and grep every response and stream.

**Verdict (25 November 2026, K1 #65): confirmed, in-process and in both configurations.** Every made-up secret in the victim fixture's command, labels and mount path is in the detail, the list or the first `/api/stream` events; its environment values never are unless revealed. Finding: #91 (`severity:medium`).

**Fix, H8 (25 November 2026): fixed and verified** (the round-one probes, re-run in both configurations on 25 November 2026). Values that look like secrets in the command, entrypoint, labels and mount sources (a secret-named flag or variable, a URL with a password, a password hash, a basic-auth list, a secret-named path segment) are masked in the detail, the list and every stream event, and each is revealed on its own through `/api/containers/:id/secrets/:field/:key`, logged by place and never by value (#91). Label values stay raw inside the server for Hosted Site discovery.

### H9: A Hostile Container exhausts Lookout's memory through its logs · medium

`LineSplitter` (`parse.ts:249-263`) keeps everything after the last newline, with no bound, on the TTY path (`engine.ts:231-236`) and in the frame decoder, which buffers to the 32-bit size the header claims (`parse.ts:274-283`). Backpressure (`app.ts:533-537`) bounds lines per batch, not line length. Nothing bounds streams per session (`app.ts:328-371,499-552`), each log stream holds one Docker follow request, and `readBody` reads whole inspect bodies (`engine.ts:49-54`). Control, ANSI and bidirectional characters reach the page as React text: not script, but to confirm. Probe a Container that writes a long line with no newline, and many-megabyte labels and environment, by arithmetic past the first demonstration. Carried with H3 to X1.

**Verdict, H9 (25 November 2026, X1 #69): confirmed, in-process and in both configurations.** A log line with no newline was held whole (≈ 1 GiB per stream) and a frame header believed up to 4 GiB (#115); Engine answers were read whole (#116); the secret-masking pattern added by #91 took quadratic time, 1.6 s on a 64 KiB label, so one Container's label stalled every Container list (#117); one session opened any number of streams (#118); a stream nobody read held every event (#119). All `severity:medium`. The folder scan's hard-link set was unbounded too (#109, R1).

**Fix, H9 (25 November 2026): fixed and verified.** A log line is sent in pieces of at most 64 KiB and a frame's payload passes on as it arrives; an Engine answer over 4 MiB is refused and that Container listed without its details; masking is linear and a value over 8 KiB is masked unchecked (1 MiB checked in under 100 ms); at most 8 streams per session and 32 in all, then 429; a stream with 1 MiB unsent is closed. The figures are X1b's, below.

### H10: Lookout binds every interface when asked, and says nothing · low

`config.ts:58-61` takes `0.0.0.0` and `::` without a warning; with `network_mode: host` that includes a public interface, where ADR-0008 no longer holds and H3 is open to anyone. The default (`127.0.0.1`, and Compose refusing an unset value, `compose.yaml:23`) is sound. Probe: start with each, read the startup log.

**Verdict, H10 (25 November 2026, I1 #70): confirmed, in-process and in both configurations.** `0.0.0.0`, `::` and a public address started with only Fastify's "Server listening" line. Finding: #122 (`severity:low`). Also seen: Lookout's own service dropped no capability and had a writable root and no memory limit (#123), and a valid Argon2id hash of any cost was accepted (#124), both `severity:low`. Sound: missing variables refused, the Image non-root, its base pinned by digest, npm removed.

**Fix, H10 (25 November 2026): fixed and verified.** Lookout warns at start, naming `LOOKOUT_BIND_ADDRESS`, for every interface or any address that is not loopback, private, CGNAT, ULA or link-local; `compose.yaml` drops every capability, forbids new privileges, makes Lookout read-only and sets `mem_limit: 256m`; a hash below 7 MiB, or under 35 MiB × passes, is refused unechoed.

### H11: Docker's and the proxy's error text reaches the browser · low

`app.ts:119-131,490-493` return Docker's message in a 502, and `engine.ts:57-62` passes plain-text bodies through, the proxy's own included. Only a signed-in user sees it. Probe: provoke Engine and proxy errors and read the answers.

**Verdict, H11 (25 November 2026, K1 #65): confirmed.** A failed start answers a 502 with containerd's and runc's text in both configurations; in-process, Node's `connect ECONNREFUSED 127.0.0.1:2375` and a proxy's plain-text body pass through too. Docker's own message is FR-27's documented decision; with the proxy down, reads answer the fixed `503 Docker unavailable`. Finding: #92 (`severity:low`). Also seen: an over-long Container reference gets Fastify's 414 echoing the path, before the session hook: #93 (`severity:low`).

**Fix, H11 (25 November 2026): fixed and verified** (the round-one probes, re-run in both configurations on 25 November 2026). A failed Container Action answers Docker's own JSON message (FR-27) and otherwise the fixed "Docker could not complete the action"; Node's errors and a proxy's plain text stay in the server log (#92). Fastify's parameter limit is above anything Node accepts, so an over-long reference reaches the route's own checks (`404 No such Container`, or `401` without a session), and an unroutable URL gets the same closed set (#93).

### H12: Hosts pull a tag that moves, and nothing checks what they pull · medium

`compose.yaml:10` names `ghcr.io/adrianeyre/lookout:1.0`, which moves, and Dependabot ignores it (`.github/dependabot.yml:42-44`). Provenance and an SBOM are attached (`image.yml:99-100`) but nothing verifies them, and nothing is signed. `release.yml:60-69` runs `pnpm install`, then semantic-release, with `contents`, `issues` and `pull-requests: write`, so dependency code runs beside that token. The Image job shares the GitHub Actions cache (`image.yml:101-102`). Probe: who can push to GHCR and make `v*` tags, the rules on `main` and on tags, the `github-pages` environment's protection, pnpm's build-script default, and the cache's scope.

**Verdict, H12 (25 November 2026, I2 #71): confirmed.** `main` and `v*` tags had no rules (#125, `severity:medium`); Hosts pulled the moving `:1.0`, which Dependabot ignored, and nothing signed or verified the Image (#126, `severity:medium`); semantic-release ran beside issues and pull-requests write it did not need (#127, `severity:low`). Sound: actions pinned by SHA, `persist-credentials: false`, read-only defaults, `packages: write` only on the Image job, no `pull_request_target`, frozen lockfiles and no dependency build scripts, the Actions cache written only from `main`.

**Fix, H12 (25 November 2026): fixed and verified, with one residual accepted.** Rulesets on `main` (no deletion, no force-push) and `v*` tags (never moved or deleted), vulnerability alerts and required SHA pinning are on (#125). Requiring pull requests on `main` and restricting who creates `v*` tags are **not** applied, because GitHub Actions cannot bypass a ruleset on a personal repository and semantic-release pushes its release commit and tag with the workflow's token; accepted until 25 February 2027, or until releases use a GitHub App's token. The Image job signs a build-provenance attestation once the repository is public, the README shows `gh attestation verify` and pinning by digest, and Dependabot moves the `X.Y` tag (#126). The release job holds `contents: write` alone (#127).

### H13: The changelog is inserted as HTML · low

`apps/web/src/components/footer/content.tsx:31` uses `dangerouslySetInnerHTML` with `renderChangelog` (`packages/shared/src/changelog.ts`), whose source is `CHANGELOG.md`, written from pull-request titles, Dependabot's included. `escapeHtml` (`changelog.ts:8-13`) escapes `& " < >` but not `'`; every attribute is double-quoted and links must match `https?://` (`:24`). The dashboard's CSP stops inline script; the Project Website may have none (no meta tag in `site/index.html`; to confirm). Probe titles with quotes, `javascript:`, nested brackets and backticks.

**Verdict, H13 (25 November 2026, W1 #64): refuted for the dashboard.** Fifteen hostile titles (quotes, `javascript:` in any case, `data:`, `//host`, nested brackets, backticks, quotes inside a link target, markup in link text) render only `h3 h4 ul li p a strong code`, with `href target rel` on `a` alone and every `href` absolute `http(s)`; `'` is unescaped but every attribute is double-quoted. A title can still link any https site, which is the feature. The Project Website's half is I2's (#71).

**Verdict, H13's website half (25 November 2026, I2 #71): refuted for the escaping; the site had no CSP.** Fifteen hostile titles through the site's build came out as text with only `http(s)` links. The Project Website had no Content Security Policy (#128, `severity:low`). Also: no test pinned the images it publishes (#129) and nothing could show the vendored Stageshow kit was unmodified (#130), both `severity:low`.

**Fix, H13 (25 November 2026): fixed and verified.** Both pages carry a strict CSP meta tag and `pnpm site:check` fails on any violation (#128); `site/build.ts` publishes only the images on `PUBLISHED_IMAGES` (#129); `site/stageshow/SHA256SUMS`, checked by a test, records every kit file, all 155 of which matched upstream commit `299140f` (#130).

### H14: Host-root reads follow symlinks · low

`host-root.ts:17-24` checks containment by path text only, and `stat`, `statfs` and `df` (`metrics/disks.ts:116-125`, `metrics/block-size.ts:34`) follow symlinks on mount points taken from the Host's `/proc/1/mounts`; an absolute link resolves inside Lookout's Container, not the Host. The process runs as UID 1000 (`Dockerfile:64`) with `/` mounted, so the Host's UID 1000 files are readable. No route takes a path today (`apps/server/test/guards.test.ts:31`). Probe a mount point reached through a link, and confirm no route or label feeds a path into `HostRoot`.

**Verdict, H14 (25 November 2026, R1 #68 and V2 #74): confirmed in-process and in the deployment; refuted on a real Host's mount table.** Host-root reads, `df` and the folder walk followed links out of the Host root (#113, `severity:low`), and `df` was found through `PATH` (#114, `severity:low`). On a real Host the kernel lists mount points already resolved, so only root can plant such a link (V2). No route, label or setting feeds a path into `HostRoot`. The larger exposure was Lookout's user: UID 1000, the owner's own account on most Hosts, read their `~/.ssh` and `~/.docker` through the `/` mount, in the deployment and on the V2 VM (#106, `severity:high`). The Largest folders scan listed every folder beyond `statfs` against the v1 review (#107), advised running as root (#108), had unbounded hard links and no time limit (#109), all `severity:medium`; a swap race (#110), Node's error text (#111) and folder names without `<bdi>` (#112) were `severity:low`.

**Fix, H14 (25 November 2026): fixed and verified.** Lookout runs as UID and GID 65532, which no Host account uses: on the V2 VM it can no longer read the owner's files. Every Host-root read is refused if, once links are followed, it would leave the Host root; `df` runs as `/bin/df`. The folder scan never enters `/home` or `/root`, follows no link, checks each directory it opens is the one it listed, stops at 5,000,000 entries, 256 deep, 10 minutes and 1,000,000 hard links (marked partial), sends fixed error text and shows names in `<bdi>`; the v1 review and ADR-0003 say so.

### Good and to confirm

**Verdicts (25 November 2026).** Confirmed sound by A1 (#63): `trustProxy: false`; the 16 KiB body and 1,024-character password bounds; constant-time comparisons; the cookie's `HttpOnly`, `SameSite=Strict`, `Path=/`. By W1 (#64): `Origin` required on every non-`GET`; every route walked unauthenticated, path tricks (`/apiX`, `//api`, `/login/../api`, encoded slashes, trailing dots) all 401; no other `dangerouslySetInnerHTML`, logs and labels as text, and no CSP violation on any page of the deployment in Chromium. But the security headers are missing on the event streams (#88) and `no-store` is chosen by raw URL prefix (#90); bidirectional text is not isolated (#89). Fixed and verified, 25 November 2026: the streams send every security header and `no-store` (#88); `no-store` is the default on every answer a route does not cache itself, whatever its path's spelling (#90); every piece of Container text the SPA shows is in a `<bdi>` (#89). By K1 (#65): `CONTAINER_REF` and percent-encoding (odd references stop before Docker); Container Actions (a fixed map, `lookout.self` refused by ID and name in both configurations, the typed name on remove, `force=false&v=false`); the Engine client calls only ADR-0011's endpoints; log tails are 100, 500 or 1,000. "Configuration fails closed" holds for missing values and, since #85 (fixed and verified), for a weak session secret; and since #122 a public bind address is warned of at start. By V1 (#72), 25 November 2026: every item and accepted risk of the v1 and v1.1 reviews has a verdict ([findings/V1.md](../pen-test/findings/V1.md)); static files read into memory at start is sound. By I1 (#70): the Dockerfile's base pinned by digest, non-root, npm deleted; configuration fails closed, and since #122 warns on a public bind address. By I2 (#71): workflows pin actions by SHA, `persist-credentials: false`, read-only defaults, `packages: write` on the Image job alone; the site's published images are read and now pinned (#129). By S1 (#67): TLS verification, no redirect, no body, header cap, truncation, Check now by ID and once every 5 s. By R1 (#68): `df` through `execFile` with no shell (now by absolute path, #114). **Every item now has a verdict** (success criterion 4).


Each of these reads as sound. A scope issue confirms it with a probe, and a refuted one is a finding.

- `trustProxy: false` (`app.ts:165`): `X-Forwarded-For` is ignored and the limiter keys on the socket's address.
- Sign-in takes a body of at most 16 KiB and a password of at most 1,024 characters (`app.ts:166,276`).
- Password and HMAC comparisons are constant-time over equal lengths (`password.ts:72`, `session.ts:48`).
- The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/` (`session.ts:110-118`).
- `Origin` is required on every non-`GET`, a missing or `null` one refused (`origin.ts:12-13`), walked over every state-changing route (`app.test.ts:712`).
- Every registered route is walked unauthenticated and the public list is pinned (`app.test.ts:68-115`), so a new unguarded route fails; an unknown `/api` path answers 401.
- Container references match `CONTAINER_REF` (`app.ts:101,411`) and are percent-encoded (`engine.ts:145-147`).
- Container Actions: a fixed action map, refusals checked on the server, the typed name on remove, `force=false&v=false`.
- The Engine client calls only ADR-0011's endpoints.
- Log tails are 100, 500 or 1,000 (`app.ts:502-507`).
- Hosted Site checks verify TLS with `checkServerIdentity` (`check.ts:163-166`), follow no redirect, read no body, cap headers at 16 KiB and truncate `Location` and certificate names; Check now takes an ID, not a URL, once every 5 seconds per Hosted Site; only `http(s)` URLs are taken (`config.ts:142-158`).
- No other `dangerouslySetInnerHTML`; logs and labels render as text; the CSP is strict and `index.html` has no inline script.
- Static files are read into memory at start, with no path handling per request (`static.ts`).
- `df` runs through `execFile` with an absolute path and no shell.
- The Dockerfile's base is pinned by digest, runs as `node` and deletes npm; CI checks the Image is non-root and scans it with Trivy.
- Workflows pin actions by SHA, set `persist-credentials: false`, start read-only, and grant `packages: write` only to the Image job.
- Configuration fails closed: the hash and the secret are required, and the bind address defaults to `127.0.0.1`.
- `site/build.ts:155-168` publishes `docs/images/*.png` and `site/public` only; every published image is read for real Host data, and the set is pinned by a test.
- **Every item in the [v1](../security-review-v1.md) and [v1.1](../security-review-v1.1.md) reviews**, checklist and accepted risks alike, is confirmed by V1.

---

## Scope partition

Child issues under `prd:pen-test` partition the surface along Lookout's own lines. Each names its trust boundary, links the ADRs that govern it, points at the code, lists the hypotheses it answers, and says what to probe. Each produces a committed findings note at `docs/pen-test/findings/<ID>.md` with a verdict per probe, probe tests (see [the checks](#checks-every-scope-issue-carries)), one finding issue per confirmed weakness, and its H entries here amended with their verdicts. A scope issue probes and never fixes; each fix is its own issue against its finding.

- **Enablement (E1-E5)**
  - **E1** the pen-test deployment: its own Compose project with `docker:dind` and a fixture Host root, both shipped configurations, `127.0.0.1` only, no way out, Hosted Sites served inside it, torn down with its volumes; `pnpm pen-test:up` and `pnpm pen-test:down`.
  - **E2** fixtures, as a pure plan and a separate loader: Lookout itself and the socket proxy (both `lookout.self`); a **victim** Container with made-up secrets in its environment; a Compose Project with a Flagged Container; a stopped Container to remove; **the Hostile Container**, whose labels, name, environment and logs try SSRF, markup, terminal escapes and oversized values; three Hosted Sites (healthy, an expired certificate, one that redirects to an internal address); the fixture Host root; one password.
  - **E3** rules of engagement and statement of work.
  - **E4** the credentials package: the fixture password and its hash, and how it is delivered.
  - **E5** the findings workflow: the `severity:*` labels, the **Pen-test finding** issue template, and the triage page `docs/pen-test/README.md`.
- **Sign-in and the browser (A1, W1)**
  - **A1** sign-in and sessions (H1's session half, H3, H5, H7).
  - **W1** the browser boundary: `Origin`, the `Host` header and DNS rebinding, headers and CSP, what the SPA renders (H6, H13).
- **Docker (K1, P1)**
  - **K1** the Docker boundary: environment reveal, self-protection, Container Actions, the Engine client and its error text (H1, H8, H11).
  - **P1** the socket proxy and the Host's loopback (H2).
- **Hosted Sites (S1)**
  - **S1** Hosted Site checks and label trust (H4).
- **The Host (R1)**
  - **R1** the Host root and Host Metrics (H14).
- **Limits (X1, X1b)**
  - **X1** resource exhaustion, by arithmetic and demonstrations of at most 20 parallel requests (H3, H9).
  - **X1b** the owner sets the figures in [the limits pre-condition](#pre-condition-lookouts-limits-before-the-gate). `needs-human`.
- **Infrastructure and delivery (I1, I2)**
  - **I1** deployment configuration: the bind address, `network_mode: host`, Compose and the Dockerfile (H10).
  - **I2** supply chain and publishing: the workflows, GHCR, Dependabot, Pages and `site/` (H12, H13's website half).
- **Documents and the real Host (V1, V2)**
  - **V1** documents against code: every security-review "Pass" and accepted risk, and every ADR that accepts a risk with no recorded end (H4, H5 and H7 are the mismatches known today).
  - **V2** a one-off check on a disposable Linux VM of what dind can't show: escapes through `network_mode: host` and the real `/` mount. Read-only proof, then stop.

Two issues in the set **build rather than probe**:

- **The release gate:** the release workflow fails while any open issue carries `prd:pen-test` and `severity:critical` or `severity:high`, and the README's development section says the repository is not made public while one is open.
- **Keep the round private:** a probe test that fails when anything from this file or `docs/pen-test/` reaches what `site/build.ts` publishes.

A tracking issue lists them all.

---

## Checks every scope issue carries

These apply across Lookout's surface. A scope issue lists the ones that apply to it.

- **Refusals give nothing away.** An unauthenticated caller gets the same status, body and length whether the thing they asked about exists or not.
- **Every refusal comes from a closed set.** No route answers a well-formed request with a 500, and no Docker, proxy or Node text reaches a caller who didn't need it.
- **Odd input stops before Docker:** NUL bytes, encoded slashes, `..`, very long strings, and references past Docker's name grammar.
- **A Container is an input.** Its labels, name, environment, command and logs are written by whoever built its Image; nothing from them is trusted, rendered as markup, fetched unbounded or buffered unbounded.
- **Nothing is left to a collaborator to bound.** Every stream, buffer, map and list has its own limit; Docker, the proxy and the browser are not the limit.
- **A secret is shown only when asked for, one at a time,** wherever it sits: environment, command, labels or Lookout's own configuration.
- **Logs are a copy of the data.** Sweep them for secrets and environment values.
- **Internal headers are trusted only when the server set them.** Send each header the server reads, `X-Forwarded-For`, `X-Forwarded-Proto` and `Host` first, from outside.
- **Middleware that matches by path matches by segment.** Try `/apiX`, `//api`, `/login/../api`, encoded slashes and trailing dots against the session hook and the SPA fallback.
- **Configuration fails closed.** Unset each variable in turn; a short, repeated-character or example secret, and a public bind address, are refused or warned at start.
- **Probe both configurations** where the socket is involved: the default and the socket proxy.
- **A test that passes either way proves nothing.** Probes live in `apps/server/src/pen-test/probes/` and run in `pnpm test`; those that need the deployment run in `pnpm pen-test:probe`. While a gap is open a probe has an `it.fails` for the property that should hold beside a `today_…` test pinning what happens now; once fixed they become an `it` and a `(regression)` test. Turn tests, never delete them.

---

## Findings workflow

Every finding is its own GitHub issue, filed with the **Pen-test finding** template, carrying `prd:pen-test`, exactly one of `severity:critical`, `severity:high`, `severity:medium` or `severity:low`, and a pointer to the scope issue it was found under. It states the rule it breaks (PRD requirement and ADR), the steps to reproduce it, the configuration it was found in, what happened against what should have, and the test that would have caught it. That test joins the probes with the fix.

Remediation targets, in working days after triage confirms the finding. Triage happens the same working day a finding is filed.

| Severity | Target      | What it means here                                                                                                                                                                                                                       |
| -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| critical | 2           | Anyone without the password reads Host or Container data or an environment value, carries out a Container Action, or reaches Docker or the Host; or a Container on the Host makes Lookout do any of those.                                |
| high     | 10          | A signed-in session, or a compromised Lookout, gets more than ADR-0005 and ADR-0011 allow (exec, create, pull, an action on `lookout.self`, a Host file read beyond `statfs`), or the proxy passes an endpoint outside its allowlist. |
| medium   | 30          | A control is weaker than its documentation or security review says, or a boundary has no defence in depth.                                                                                                                              |
| low      | best effort | Hygiene, disclosure, or a documented decision with no recorded end.                                                                                                                                                                      |

- **In this first round a critical finding is filed as an issue straight away:** the testers report to the owner, the repository is private and the data is synthetic. In an external round a critical finding never starts life as an issue; it goes to the owner by an out-of-band channel the rules of engagement name, with no exploit detail in the first message, and if the owner doesn't acknowledge within 30 minutes testing pauses.
- **Scope issues are worked through AI Office** (`ai-office`, `role:coder`). **Every fix is `ai-office:manual`:** the owner merges each security fix; none merges itself.
- **`wontfix` needs a written rationale from the owner in the issue before the label goes on:** what is accepted, why, and the date it stops being true.
- **Fixed is not verified.** A finding is "fixed, unverified" until the probe that found it has been run again and passes.
- **A decision is not a fix.** A finding answered by a new ADR, or by a change to an existing one, stays open until the code matches the ADR, unless the ADR's decision is to accept the finding.
- **This file is amended in place** as hypotheses get verdicts and findings are fixed, so the next round doesn't start from stale text.
- Closing keywords are written plainly (`Fixes #123`), never inside bold or code, so they work.
- An issue that waits on the owner's decision carries `needs-human`.

---

## Pre-condition: Lookout's limits, before the gate

This section is the only record of Lookout's limits and why each is what it is. The code holds each figure as one named constant, named below; no comment, test or environment variable carries a second copy.

**Set by the owner on 25 November 2026 (X1b, #73), from X1's numbers ([findings/X1.md](../pen-test/findings/X1.md#numbers-for-x1b)).** Built and verified the same day.

| Limit | Figure | Where | Reasoning (X1's numbers) |
| --- | --- | --- | --- |
| Failed sign-ins per address | 5 per 15 minutes; a running check counts (#81); IPv6 by /64 (#82); no lockout per account | `LoginRateLimiter` | One password and one user: a per-account lockout would let anyone lock the owner out. 5 tries per address per window is the guessing budget. |
| Concurrent password checks (Argon2id) | 4 at once from every address together, then 429 with `Retry-After: 1` | `LoginRateLimiter` (`maxConcurrent`) | 4 × 19 MiB = 76 MiB at most; one check took 16 ms, so 4 keep sign-in quick for the owner. |
| Sign-in limiter's keys | 10,000; a limited key is never forgotten, and a new address is refused while every key held is limited (#120) | `LoginRateLimiter` (`maxKeys`) | 3.2 MiB at 10,000 keys; evicting limited keys let guessing restart. |
| Streams per session (`/api/stream`, stats, logs) | 8 per session, 32 in all, then 429 with `Retry-After: 5` (#118) | `MAX_STREAMS_PER_SESSION`, `MAX_STREAMS` (`app.ts`) | Each log stream holds a Docker follow request; the owner uses a handful of tabs. |
| Bytes held for a stream nobody reads | 1 MiB beyond the opening burst, then the stream is closed (#119) | `MAX_STREAM_BACKLOG_BYTES` (`app.ts`) | A stalled stream held 14.3 MiB of 16 MiB sent; 32 × 1 MiB bounds it. |
| A log line held without a newline | 64 KiB, then sent in pieces; a frame's payload passes on as it arrives, so a frame header's claimed size holds nothing (#115) | `MAX_LOG_LINE_CHARS` (`parse.ts`) | About 1 GiB per stream before. |
| An Engine response body read whole | 4 MiB, then refused and that Container listed without its details (#116) | `MAX_ENGINE_BODY_BYTES` (`engine.ts`) | An 8 MiB inspect body was read, kept and broadcast. |
| A value checked for secrets | 8 KiB; anything longer is masked unchecked, and the check is linear (#117) | `MAX_CHECKED_VALUE_CHARS` (`secrets.ts`) | The old pattern took 1.6 s on 64 KiB and minutes on 1 MiB. |
| Check now | Once every 5 seconds per Hosted Site, 4 checks at once | `SiteMonitor` | Unchanged: sound in S1. |
| Hosted Sites | 500, `LOOKOUT_SITES` first, at most 20 from one Container's labels (#104); a label URL over 2,048 characters skipped (#121) | `MAX_SITES`, `MAX_SITES_PER_CONTAINER` (`packages/shared/src/sites.ts`) | 500 × 64 KiB URLs was 31 MiB in every `sites` event. |
| The folder scan | 5,000,000 entries, 256 deep, 10 minutes, 1,000,000 hard links remembered; past any, the result is marked partial (#109) | `FOLDER_SCAN_LIMITS` (`packages/shared/src/folders.ts`) | About 70 B per hard link, unbounded before; a Container's folders made the scan endless. |
| Lookout's memory | `mem_limit: 256m` (#123); the proxy's `32m` | `compose.yaml`, `compose.socket-proxy.yaml` | 95 MB idle + 76 MiB Argon2id + 32 streams × 1 MiB + 4 MiB bodies ≈ 210 MiB. |
| A session's lifetime | `LOOKOUT_SESSION_MAX_DAYS`, 30 days by default, at least the idle period (#84) | `config.ts` | Unchanged. |

- **The address the sign-in limit keys on and `trustProxy` are one decision** (H3), recorded here. `trustProxy: true` with no named proxy is never acceptable.
- **The keying decision (25 November 2026, #82):** the limit keys on the socket address, IPv4 as is and IPv6 by /64, with `trustProxy: false`. Behind a reverse proxy every caller therefore shares the proxy's key, so five wrong passwords from anyone lock the owner out for 15 minutes. That is accepted while the README says to reach Lookout over a LAN or VPN directly, and **stops being true on 25 February 2027** (the next round), or sooner if a reverse proxy becomes a supported way to reach Lookout; then the decision is a named proxy and its header. **Confirmed by the owner on 25 November 2026 (X1b, #73).**
- Refusals answer `429` the same way whichever limit fired, with `Retry-After`.

---

## Pre-condition: an external round, recommended

This first round is run by the people and agents who built Lookout, working against a brief written by reading the tree from outside. That is better than nothing and is not independent. A second round by someone outside the project, against this file as amended by the first, is **recommended but not a gate**, because Lookout has one user and holds no one else's data. It becomes a gate, recorded here with its date, if Lookout gains users other than its owner, or is recommended to others for a network they don't control.

---

## Success criteria

1. Every scope issue is filed, labelled and anchored to this file before the window opens.
2. The pen-test deployment is stood up, seeded and reachable only by the testers, reaches no real Docker, Host or network, and is destroyed with its volumes at the end.
3. Every finding is filed as a labelled issue within one working day of being found.
4. Every hypothesis in the opening register, and every item under "Good and to confirm", has a verdict, recorded here.
5. **H1, H2 and H3 have a dated answer** before the round closes: fixed, or a recorded decision naming the date they stop being true.
6. Every finding above `severity:low` is remediated, or waived in writing by the owner, **before the gate**; the release gate and the privacy probe are built.
7. Every credential issued for the round is revoked, and the deployment's session secret discarded, when it ends.
