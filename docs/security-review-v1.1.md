# v1.1 security review: outbound Hosted Site checks

Hosted Site checks (PRD §14, [ADR-0010](architectural-decision-record/0010-hosted-sites-checked-from-the-host.md)) are the first requests Lookout makes of its own. As v1.0.0 followed the [v1 security review](security-review-v1.md), the v1.1 release follows this one (issue #42). It records what was checked, how each item is tested, and what was fixed.

Reviewed: 25 November 2026, at the commit that adds this file.

## Checklist

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | **SSRF:** no route accepts a URL | Pass | `Hosted Sites › no API route accepts a URL to check (ADR-0010)` walks **every** registered route, signed in, putting a canary server's URL (as `127.0.0.1` and as a hostname on its port) in every path parameter, in `url`/`target`/`site` query parameters and in the JSON body. The canary receives no connection and no Hosted Site is added. Check URLs come only from `LOOKOUT_SITES` (validated at startup) and Container labels (validated at discovery). |
| 2 | **SSRF:** "Check now" can only reach operator config | Pass | The route takes a Hosted Site ID (16 hex characters, the start of the URL's SHA-256), looked up in the in-memory list built from config. Anything else is a 404 before any lookup: `Check now with an unknown ID returns 404 and makes no request` (an unknown ID, a malformed one, an encoded URL and `..`), and `SiteMonitor › Check now with an unknown ID makes no request`. It is limited to once per Hosted Site every 5 s (`allows Check now once every 5 s per Hosted Site`, and a 429 with `Retry-After` through the API), is CSRF protected by the `Origin` check (the v1 walk over every state-changing route now includes it), and needs a session (the v1 walk over every protected route includes it). |
| 3 | **Label trust** | **Fixed** (amended 25 November 2026) | First accepted on the premise that only someone with access to Docker can set a label. That premise is false: Docker merges an Image's `LABEL`s into its Containers' labels, so an Image's publisher chooses labels with no Docker access at all (pen-test findings #103, #104, #105, #121). Labels now choose only within bounds the operator set: at the Host, a label or Traefik URL is checked only on port 80, 443 or a port its Container publishes; with `lookout.check: public`, a check never connects to a loopback, link-local (metadata), private, CGNAT, ULA, multicast or reserved address, checked on the address it actually connects to, so DNS rebinding cannot pass; one Container's labels name at most 20 Hosted Sites, `LOOKOUT_SITES` always comes first within the 500, and a URL over 2,048 characters is skipped; and an Image's own `lookout.self` label does not make its Container self. A refused site shows on the Websites page with its reason. `LOOKOUT_SITES` stays the operator's and is not restricted. Labels are still validated: only http and https URLs, no credentials, and hostnames without wildcards (`discovery.test.ts`, `address.test.ts`, `s1-sites.test.ts`). |
| 4 | **Responses:** bodies are never read; headers and sizes are bounded | Pass | The response is destroyed as soon as its headers arrive, and redirects are not followed: `never reads the body: a huge response is not downloaded` (a 256 MiB body; only what the kernel buffers is ever sent) and `is up for a 3xx, which it does not follow`. Headers are capped at 16 KiB (`refuses oversized response headers`), a redirect target at 2 KiB (`keeps at most 2 KiB of a redirect target`), and every check at `LOOKOUT_SITE_TIMEOUT_MS`. What reaches the browser is the status code, the timing, the redirect target and the certificate summary, all shown as text, never as markup or a link. |
| 5 | **TLS:** verification is always on | Pass | `rejectUnauthorized: true` on every check, with the certificate's own hostname checked, not the `127.0.0.1` dialled. A certificate that fails is described but no request is sent over it: `never disables verification: an untrusted certificate is shown, the site is down, and no request is sent`, plus the expired and wrong-hostname cases. A new guard test fails if any production code sets `rejectUnauthorized: false` or names `NODE_TLS_REJECT_UNAUTHORIZED`, and if the production entry point passes extra certificate authorities (only Playwright does). |
| 6 | **TLS:** `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment | Pass | Setting it does not weaken checks, because verification is asked for explicitly: `stays verified even when NODE_TLS_REJECT_UNAUTHORIZED=0 is set`. |
| 7 | **Resources:** many Hosted Sites, timeouts, and cost against NFR-1 | **Fixed** | At most 4 checks run at once, each bounded by the timeout; a Hosted Site already being checked is never queued twice, so a slow interval cannot pile up work (`runs at most concurrency checks at once`). History is capped to the Live Window. Measured with the real check engine against a local target: about **0.2 ms of CPU per check**, so 100 Hosted Sites at the default 60 s interval cost about 0.05% of one core and 500 about 0.2%. Retained heap after GC was the same (about 14 MB, mostly code) for 100 and 500 Hosted Sites. The Image with two Hosted Sites used 46 MiB, within NFR-1's 100 MB. |

## Findings fixed in this release

- **The number of Hosted Sites was unbounded.** A Container whose labels named thousands of hosts would have had them all checked. Lookout now checks at most 500, the first by URL, and logs a warning once (`checks at most 500 Hosted Sites, warning once`).
- **Certificate names were unbounded.** The subject and issuer come from the site's certificate, untrusted, and were kept whole. They are now cut to 256 characters.
- **A TLS protocol error was shown as `EPROTO`.** An https URL pointing at a plain-http port now says "TLS handshake failed".
- **Docker `ping` always failed** (found while testing the socket proxy for #45). Docker answers `/_ping` with plain-text `OK`, which the Engine client tried to parse as JSON, so `/api/docker/status` reported Docker unavailable. It now checks only the status (`pings with Docker's plain-text OK answer`).

## Accepted risks (by design)

- **Checks at the Host see only the Host.** They cannot detect DNS, port-forwarding or upstream faults (ADR-0002, ADR-0010). `lookout.check: public` checks through public DNS for the Containers that want it, never to an internal address. **Stops being true** if Lookout is asked to monitor sites it does not host; revisited by the next pen-test round, 25 February 2027.
- **A check reaches whatever listens on the Host's loopback at the URL's port.** That is how a check at the Host works. Since 25 November 2026 a label can reach only port 80, 443 or a port its own Container publishes; any other port must be listed in `LOOKOUT_SITES` by the operator (item 3). **Stops being true** on 25 February 2027 (the next round), or sooner if a check ever reads a body or sends anything but a `GET`.
- **Hosted Site state lives in memory**, like the Live Window (ADR-0004). It starts empty after a restart. There are no alerts. **Stops being true** if alerts are added, which would need state that survives a restart.

## How to repeat this review

```sh
pnpm test        # the regression tests named above (apps/server/src/sites, app.test.ts, guards.test.ts)
pnpm test:e2e    # e2e/websites.spec.ts against fake http and https targets
```
