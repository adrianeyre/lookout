---
status: accepted
---

# Visitor stats come from the reverse proxy's access logs

To count each Hosted Site's visitors, Lookout reads the reverse proxy's access logs through the read-only `/host` mount ([ADR-0003](./0003-deploy-as-container-with-host-access.md)). **`LOOKOUT_ACCESS_LOGS`** names them: an absolute path under `LOOKOUT_HOST_ROOT`, with `*` and `?` allowed in the file name, such as `/host/var/log/caddy/*.log`. Without it, the visitor figures are hidden.

[Caddy's JSON access log](https://caddyserver.com/docs/caddyfile/directives/log) is the only format for now. The parser sits behind a small interface (`AccessLogFormat`), so Traefik or nginx formats can be added without touching the rest.

## What is counted

Each request counts towards the host its `Host` header names, and a Hosted Site reads its URL's host. A site that appears after its requests were read still gets them. Counting is per hour and per day:

- **Requests:** every one, bots included.
- **Bots:** requests whose user agent looks like a crawler, monitor, link preview or HTTP library, or that have no user agent at all. They are counted apart from people.
- **Visitors:** distinct client addresses among people, with an IPv6 /64 counting as one, as the login limit counts them.
- **Page views:** successful `GET`s answered with `text/html`, by people.
- **Status classes** (2xx, 3xx, 4xx, 5xx) and **response times** as a small histogram, from which p50 and p95 are read.
- **Top pages and referrer domains** per day. A path is kept without its query string or fragment, because those can carry tokens. A referrer is kept as its domain only.

Lookout's own Hosted Site checks (its user agent) are never counted.

## What protects it

- **Only counts are stored, never an IP address.** Visitor addresses are held in memory only for the open hour and day. So after a restart, someone seen both before and after it counts twice that day.
- **CF-Connecting-IP is believed only from loopback.** A local tunnel such as cloudflared connects from there. From anywhere else anyone could send the header and make up visitors.
- **Files are opened read-only, without following links, through the Host root.** A log, or a folder above it, that leads outside the Host root is never read.
- **Lines are bounded.** A line over 64 KiB, or one that is not a request, is skipped and counted, never fatal.
- **Hosts are bounded.** At most 200 hosts are counted a day, so made-up `Host` headers cannot grow the store without limit.
- **Exactly-once reading.** Where each file was left is stored with the totals, in the same transaction, keyed by device and inode. A restart counts nothing twice. A rotated (renamed) file is finished, a new one starts at 0, and a truncated one starts again.

We chose this over a tracking script, which sees only browsers that run it, misses static files, APIs and the CDN, and needs every app's HTML edited.

## Consequences

- The proxy must write its access log to a file Lookout's user (UID 65532) can read. The README shows a Caddy `log` block that does, rotated and kept for 7 days. The raw logs, which hold IP addresses, stay in the proxy's files under its retention, never in Lookout's.
- A request reached through a tunnel that does not set `CF-Connecting-IP` counts as the tunnel's own address: one visitor.
