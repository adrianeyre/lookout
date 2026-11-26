---
status: accepted
---

# Site Stats keep daily totals on disk

[ADR-0004](./0004-live-metrics-only.md) kept everything in memory: Lookout answered "how is the Host right now?" and nothing else. Operators also want to know how each Hosted Site is doing over time: visitors per day, uptime, and how much disk and Docker space it takes. Those figures mean little without days or weeks behind them, so this ADR **partly supersedes ADR-0004**.

**Site Stats** keep hourly and daily totals in SQLite, through Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html), so there is no native dependency and nothing new to install. The file is `stats.db` in **`LOOKOUT_DATA_DIR`** ([ADR-0012](./0012-password-changed-in-settings.md)), the only place Lookout writes. The rest of Lookout's filesystem stays read-only.

- **What is kept:** per Hosted Site, per hour and per day:
  - traffic totals from the access logs ([ADR-0014](./0014-visitor-stats-from-access-logs.md));
  - uptime from the checks Lookout already runs;
  - the latest certificate expiry.
- **Daily only:** each site's disk and Docker space, and Docker's own disk usage, both measured once a day.
- **Never kept:** a client IP address.
- **How long:** hourly totals for 48 hours. Daily totals for `LOOKOUT_STATS_RETENTION_DAYS`, 90 by default and adjustable from 7 to 365. Anything older is deleted every hour, so the file stops growing.
- **Without `LOOKOUT_DATA_DIR`:** the store is kept in memory, works the same, and is lost on restart. The Websites page says so.
- **If the file cannot be opened** (a bad volume, a newer schema): Lookout still starts, and the stats explain why they are missing.

**Live Host Metrics are unchanged.** They still live only in the in-memory Live Window. A database for CPU samples every 2 s is the cost ADR-0004 refused, and it still is.

We chose this over:

- **Prometheus and Grafana**, as ADR-0004 suggested: three more Containers to run and keep updated for a few hundred small rows, and a second dashboard to sign in to.
- **GoAccess**: it reports visitors only, and gives nothing on uptime or sizes.

## Consequences

- Lookout now writes more than one small file. `stats.db` holds counts and sizes only, a few hundred kilobytes for a typical Host. `docker compose down -v` deletes it with the password file.
- The schema is versioned with SQLite's `user_version` and migrated forward at start. An older Lookout refuses a file a newer one wrote, rather than guessing.
- Measuring sizes means asking Docker for `/system/df`. On a busy Host that is slow, so it is done once a day at 03:00 server time and on **Measure now**, never per page view. It only reads: nothing is pruned.
- Days and hours are the server's local ones (the Container's `TZ`, UTC unless it is set).
