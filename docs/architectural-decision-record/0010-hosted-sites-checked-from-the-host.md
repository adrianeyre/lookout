---
status: accepted
---

# Hosted Sites are checked from the Host

From v1.1, [Lookout](https://github.com/adrianeyre/lookout) checks the **Hosted Sites** the Host serves (PRD §14). A check connects to the Host itself (`127.0.0.1`) on the URL's port, and sends the site's hostname as the HTTP `Host` header and the TLS SNI. It does not resolve the hostname through DNS. A self-hosted site behind a home router often can't be reached by its public name from inside the network (no hairpin NAT), or resolves differently inside it (split DNS); connecting to the Host avoids both and checks what the Host actually serves. A Container labelled `lookout.check: public` opts its Hosted Sites into checks through normal DNS and their public URL.

Because [ADR-0002](./0002-single-host-only.md) rules out a vantage point outside the Host, these checks cannot see DNS, port-forwarding or upstream network faults. They answer "is the Host serving this site?", not "can the world reach it?".

Hosted Site checks are the first requests Lookout makes of its own, so they have guard-rails:

- **Check URLs come from `LOOKOUT_SITES` and from Container labels** (Traefik routers and `lookout.url`). Nothing in the UI or the API accepts a URL. A label is not always the operator's: Docker merges an Image's labels (its `LABEL` lines) into its Containers' labels, so whoever published an Image chooses labels without any access to Docker (pen-test finding #103, amended 25 November 2026). Labels therefore choose only within bounds the operator set:
  - at the Host, a label or Traefik URL is checked only on port 80, 443 or a port its Container publishes on the Host; any other port must be listed in `LOOKOUT_SITES`;
  - with `lookout.check: public`, a check never connects to a loopback, link-local (cloud metadata), private, CGNAT, ULA, multicast or reserved address, judged on the address it actually connects to, so DNS rebinding cannot pass;
  - one Container's labels name at most 20 Hosted Sites, `LOOKOUT_SITES` always comes first within the 500 checked, and a URL longer than 2,048 characters is skipped (#104, #121);
  - an Image's own `lookout.self` label does not make its Container Lookout's (#105).

  A refused label URL shows on the Websites page with the reason. `LOOKOUT_SITES` is the operator's and is not restricted.
- **"Check now" takes a Hosted Site ID, not a URL.** An unknown ID returns 404 and makes no request, and each Hosted Site can be checked on demand at most once every 5 s.
- **TLS verification is never disabled.** A certificate that fails verification is still described (expiry, issuer, hostname), but no request is sent over that connection and the Hosted Site is down.
- **Response bodies are never read or stored.** A check reads the status line and headers (capped at 16 KiB), keeps the status code, the timing and at most 2 KiB of a redirect target, then closes the connection. Redirects are not followed.

## Consequences

- Results live in memory only, like the Live Window ([ADR-0004](./0004-live-metrics-only.md)), and start empty after a restart. There are no alerts.
- A Hosted Site served by another machine, or on a port nothing on the Host listens on, shows as down unless its Container is labelled `lookout.check: public` (a `LOOKOUT_SITES` entry has no Container, so it is always checked at the Host).
- Checking from outside the Host, or following redirects, would supersede this ADR.
- **What a label may still choose** (a `GET` with no body read, to its own Container's published ports or a public address) is accepted. It **stops being true** if a check ever reads a body or sends anything but a `GET`, and is revisited by the next pen-test round, on 25 February 2027 at the latest.
