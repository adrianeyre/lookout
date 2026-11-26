# v1.2 security review: Site Stats

Site Stats ([ADR-0013](architectural-decision-record/0013-daily-stats-history-on-disk.md), [ADR-0014](architectural-decision-record/0014-visitor-stats-from-access-logs.md)) give Lookout three new things:

- **Untrusted input:** the reverse proxy's access logs, whose lines anyone on the internet partly writes (paths, `Host`, `User-Agent`, `Referer`, `CF-Connecting-IP`).
- **A larger store on disk:** `stats.db` in `LOOKOUT_DATA_DIR`.
- **A new Engine endpoint:** `GET /system/df`.

As v1.1 followed the [v1.1 security review](security-review-v1.1.md), v1.2 follows this one (issue #12). It records what was checked and the test for each.

Reviewed: 26 November 2026, at the commit that adds this file.

## Checklist

| # | Item | Result | Evidence |
| --- | --- | --- | --- |
| 1 | **Hostile log lines:** malformed, over-long, or not a request | Pass | A line that is not JSON, not an object, or has no usable `ts`, `status`, `host`, `method` or `uri` is counted as malformed and skipped, never fatal: `caddyJson › skips Caddy's own messages and counts nonsense as malformed`. A line over 64 KiB is skipped (`skips malformed and over-long lines, and Caddy's own messages`), and so is one longer than a whole read, without buffering it (`skips a line far longer than one read`). |
| 2 | **Hostile Host headers** | Pass | A request is kept under its `Host` name only when it parses as a host name with an optional port; anything with `@`, `/`, `\`, `?`, `#` or a space is refused (`host keys › keys requests by Host name…`). At most 200 hosts are counted a day, so a stream of made-up names cannot grow the store or memory without limit (`counts at most MAX_HOSTS_PER_DAY hosts a day`). |
| 3 | **Spoofed `CF-Connecting-IP`** | Pass | Believed only when the request reached the proxy from loopback, where a local tunnel connects from, and only if it is an IP address: `clientIp › believes CF-Connecting-IP only from loopback…` and `ignores a spoofed CF-Connecting-IP from anywhere else`. |
| 4 | **No IP address is stored** | Pass | Visitor addresses are held in memory for the open hour and day only. The store's schema has no column for them, and `keeps stats in LOOKOUT_DATA_DIR across a restart` checks that the visitor's address is in no file in the data directory. Paths are stored without their query string or fragment, which can hold tokens (`pathOf › strips the query string and fragment…`, `keeps top pages without their query strings…`), and referrers as a domain only. |
| 5 | **Reading the Host's files** | Pass | `LOOKOUT_ACCESS_LOGS` must be an absolute path under `LOOKOUT_HOST_ROOT`, with no `..` and wildcards only in the file name (`refuses LOOKOUT_ACCESS_LOGS=%s`). Its folder is resolved through `HostRoot`, so a link leading out of the Host root is refused (`never leaves the Host root through a linked folder`). Each file is opened read-only with `O_NOFOLLOW` and must be a regular file (`never follows a link, so a log cannot be pointed at another file`). |
| 6 | **Site folders (`URL=/folder`)** | Pass | Operator config only. The folder must be absolute, have no `..`, must not be `/`, and must not be in `/home` or `/root` (`refuses the site folder in %s`). It is resolved through `HostRoot` (`never measures a folder that leads out of the Host root through a link`) and walked with the Largest folders walk: lstat only, never a file's contents, never a link, within `FOLDER_SCAN_LIMITS`. Nothing is ever written there. |
| 7 | **New routes** | Pass | `GET /api/stats`, `GET /api/stats/sites/:id` and `POST /api/stats/measure` need a session: the v1 walk over every protected route includes them, and `needs a session` checks the new page route too. The site route takes a Hosted Site ID (16 hex characters) and a range from a closed set, and never a URL or path (`answers 400 for an unknown range and 404 for an unknown site`); the path traversal walk over every `:id` route includes it. |
| 8 | **Measure now** | Pass | It takes nothing, only reads, and runs one at a time: `Measure now measures once at a time, and only from this origin` (a 409 while one runs, a 403 from another origin, no Container Action). `runs one measurement at a time` in `SizeMeasurer`. |
| 9 | **The socket proxy** | Pass | `GET /system/df` is added to the allowlist in `compose.socket-proxy.yaml` and ADR-0011. Every prune endpoint (`/system/prune`, `/volumes/prune`, `/images/prune`, `/build/prune`) and the rest of `/system` stay refused: `P1 H2: the allowlist refuses everything outside ADR-0011`. |
| 10 | **Exactly-once counting** | Pass | Where each file was left is written in the same transaction as the totals its lines made (`writes its place in the same transaction as the totals`), keyed by device and inode: `carries on after a restart without counting anything twice`, `finishes a rotated file and starts the new one from its beginning`, `starts a truncated file again`. |
| 11 | **Resources** | Pass | One read pass takes at most 16 MiB of log, in 1 MiB chunks, yielding between them. At most 200,000 visitor addresses are held at once across every open period (about 20 MB), then each new one counts as new (`holds at most maxVisitorsHeld addresses…`). Top pages and referrers are capped at 500 a day (`stops adding new pages past MAX_TOP_KEYS`). The store is pruned hourly to 48 hours of hourly and `LOOKOUT_STATS_RETENTION_DAYS` of daily rows (`prunes hourly rows past 48 hours and daily rows past retention`). `/system/df` is read once a day and on Measure now, up to 64 MiB. |
| 12 | **A broken store** | Pass | If `stats.db` cannot be opened or was written by a newer Lookout, Lookout still starts and the stats say why (`keeps running, and says why, when the stats store cannot be opened`, `refuses a store written by a newer Lookout`). |

## Findings fixed in this release

- **A Hosted Site found after its requests were read lost them.** Totals were first kept by Hosted Site ID, so requests read before Docker named the site's Container (at start, or for a Container started later) were dropped. They are now kept by host, and a site reads its URL's host (`counts requests for a Hosted Site found after they were read`).
- **The visitor cap was per period.** With 200 hosts it allowed millions of addresses in memory. It is now one cap across every period.

## Accepted risks (by design)

- **Visitors are an estimate.** Addresses are not stored, so someone seen before and after a restart counts twice that day, and past the memory cap each new address counts as new. People behind one NAT count as one visitor. **Stops being true** if visitor addresses are ever stored (they must not be, ADR-0014).
- **Anyone can make requests look like bots or people.** The user agent is the client's to choose. Bot counts are a guide, not a defence.
- **Raw access logs hold IP addresses.** They are the proxy's files, kept under its own retention (the README suggests 7 days), never copied by Lookout.

## How to repeat this review

```sh
pnpm test        # apps/server/src/stats, app-stats.test.ts, config.test.ts, the P1 proxy probes
pnpm test:e2e    # e2e/site-stats.spec.ts, and the axe and 360px checks on a Site Stats page
```
