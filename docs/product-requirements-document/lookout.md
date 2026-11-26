# Lookout: Product Requirements Document

- **Repository:** [github.com/adrianeyre/lookout](https://github.com/adrianeyre/lookout)
- **Status:** Draft, v1 scope agreed; v1.1 (Hosted Sites, §14) agreed
- **Date:** 2026-11-25
- **Vocabulary:** Terms in **bold capitals** (Host, Host Metric, Container, Image, Compose Project, Flagged Container, Container Action, Live Window, Hosted Site, Flagged Hosted Site) are defined in [`GLOSSARY.md`](../../GLOSSARY.md).
- **Decisions:** See [`docs/architectural-decision-record/`](../architectural-decision-record/).

## 1. Summary

Lookout is a lightweight, self-hosted web dashboard for the single Linux **Host** it is deployed on. It shows live **Host Metrics** (CPU, memory, disk, network, and similar) and lists every **Container** on the Host. From the list you can see each Container's status and details, follow its logs, and carry out **Container Actions** (start, stop, restart, remove).

It replaces separate tools such as Netdata/Glances (for the Host) and Portainer/Dozzle (for Docker) with one small, focused UI ([ADR-0001](../architectural-decision-record/0001-build-rather-than-adopt.md)).

## 2. Goals

1. Answer "is my server healthy?" within a few seconds of opening the page.
2. Spot Flagged Containers straight away, and act on them without SSH.
3. Deploy and update with one `docker compose` command.
4. Stay small: low memory and CPU use, few dependencies, no database.

## 3. Non-goals (v1)

These are deliberately out of scope. Each one should get its own ADR if it is ever added.

| Out of scope | Rationale |
|---|---|
| Monitoring more than one Host (agents/hub) | [ADR-0002](../architectural-decision-record/0002-single-host-only.md) |
| Stored metric history / long-term charts | [ADR-0004](../architectural-decision-record/0004-live-metrics-only.md) |
| Browser shell (`docker exec`), pulling/updating Images | [ADR-0005](../architectural-decision-record/0005-container-actions-without-shell.md) |
| Alerts/notifications (email, ntfy, Discord…) | Dashboard only in v1 and v1.1, including for Hosted Sites; revisit later |
| Multiple users / roles | [ADR-0008](../architectural-decision-record/0008-single-password-private-network.md) |
| CPU/drive temperatures | Sensor support varies too much between machines |
| Top processes | Would need the host's PID namespace, which widens the attack surface |
| A list of Images on disk (sizes, dangling) | Containers come first; possible future page |
| Exposure to the public internet | [ADR-0008](../architectural-decision-record/0008-single-password-private-network.md) |

## 4. Users

There is one user: the owner and operator of the Host. They reach Lookout from a laptop or phone over their LAN or a VPN (for example Tailscale). They are technically capable but don't want to SSH in to check on things.

## 5. User stories

1. As the operator, I open Lookout and see at a glance whether CPU, memory, swap or disk are under pressure.
2. As the operator, I see how many Containers are running and whether any are Flagged, without leaving the page I'm on.
3. As the operator, I browse Containers grouped by Compose Project and see each one's state, health, uptime and resource use.
4. As the operator, I open a Container and read its configuration and live logs to work out why it's misbehaving.
5. As the operator, I restart a Flagged Container from my phone.
6. As the operator, I remove a stopped Container I no longer need, and I can't do it by accident.
7. As the operator, I can't lock myself out by stopping Lookout from inside Lookout.

## 6. Functional requirements

### 6.1 Global layout

- **FR-1** The app has two pages, **Host** and **Containers**. The Host page is the default. From v1.1 there is a third page, **Websites** (§14, SITE-1).
- **FR-2** A persistent header summary appears on every page, for example: `Containers: 4 running · 1 flagged | CPU 12% | Mem 61% | Disk 72%`. Each figure takes the warning colours from FR-12.
- **FR-3** The UI follows the system light/dark theme by default. A **Menu** at the top right of every page holds **Widgets** (a side menu of the page's Widgets to show or hide, and Reset layout), **Settings**, and then **Log out**. Settings (`/settings`) offers the mode (System, the default, Light or Dark) and six themes (Teal, the default, Ocean, Violet, Rose, Forest and Slate). A choice shows at once and is kept in the browser's local storage, never on the server. Every mode and theme meets WCAG 2.2 level AA; a unit test checks each one's contrast and the end-to-end tests run axe on each.
- **FR-4** The UI works on phone-width screens (≥ 360px) with no horizontal page scroll.
- **FR-14a Largest folders:** the Host page has a **Largest folders** Widget: the ten folders using the most disk space anywhere on the Host's real filesystems, heaviest first, each with its size and a bar of its share of its filesystem. Sizes count disk blocks like `du`, with hard links counted once, and never cross into another filesystem (so `/proc`, `/sys` and Docker's overlay mounts are never walked). A folder that is mostly one child gives way to that child, and no folder shown is inside another. Lookout scans shortly after starting, then every `LOOKOUT_FOLDER_SCAN_HOURS` (6 by default; 0 for only when asked), one entry at a time so it never competes with the dashboard, and **Scan now** starts one at once (one at a time, CSRF-checked). The result is kept in memory only. Folders Lookout cannot read are counted, and the Widget says its sizes leave them out and how to include them (running as root).
- **FR-4a Widgets:** every page's sections are **Widgets** on a 12-column **Grid**, like soundcheck's. Each can be dragged by its bar (a placeholder shows where it will land) or resized by its corner, snapping to whole cells; from the keyboard its grip moves it with the arrow keys and resizes it with Shift and the arrows, and each change is announced. Widgets can be pinned to the top of the window or above the footer, or hidden, and the Menu's **Widgets** side menu shows or hides each one and resets the layout. A Widget resized by hand keeps exactly that height, taller or shorter than its content (which then scrolls), until Reset layout. A Widget being dragged tilts slightly, the Widgets beside a dropped one shake, and Widgets a change moves glide to their new places; none of these move with reduced motion. The Grid never has a whole blank row: any row no Widget covers is closed up. Each page's layout is kept in the browser. Below 48rem the Widgets stack in order and are not dragged.
- **FR-5** Data updates live with no manual refresh. If the live connection drops, the UI says so and reconnects automatically.

### 6.2 Host page

- **FR-6** **Overview:** hostname, OS/distribution, kernel version, uptime.
- **FR-7** **CPU:** overall usage %, per-core usage %, and 1/5/15-minute load averages.
- **FR-8** **Memory:** used, available and total, with usage %. **Swap:** used, total, and usage %.
- **FR-9** **Disk space:** one entry per real mounted filesystem on the Host (pseudo filesystems such as tmpfs, overlay, proc, sysfs and squashfs are excluded), showing mount point, device, filesystem type, used, free, total and usage %.
- **FR-10** **Disk I/O:** read and write throughput (bytes/s) per physical block device.
- **FR-11** **Network:** receive and transmit throughput (bytes/s) per interface. Loopback and Docker virtual interfaces (`veth*`) are hidden by default and can be shown with a toggle.
- **FR-12** **Thresholds:** percentage metrics (CPU, memory, swap, each disk) show amber at ≥ 80% and red at ≥ 90%. Both thresholds can be configured (see §9).
- **FR-13** **Sparklines:** CPU, memory, disk I/O and network show a sparkline of the Live Window (default 15 minutes, sampled every 2 s). The Live Window is in memory only and starts empty after a restart.

### 6.3 Containers page: list

- **FR-14** Lists **all** Containers, both running and stopped.
- **FR-15** Containers are grouped by Compose Project (from the `com.docker.compose.project` label). Containers without a Compose Project are grouped under "Standalone".
- **FR-16** Each row shows: name, Image (repository:tag), state (`running`, `exited`, `restarting`, `paused`, `created`, `dead`), health check status (if defined), uptime or "exited N ago" with exit code, CPU %, memory used / limit, and published ports.
- **FR-17** Flagged Containers (state `restarting`, health `unhealthy`, or `exited` with a non-zero exit code) are highlighted and can be filtered to.
- **FR-18** The list can be filtered by name/Image text, by state, and by "Flagged only".
- **FR-19** The list updates live as Containers change state (driven by Docker events) and as CPU/memory stats change.

### 6.4 Containers page: detail

- **FR-20** Selecting a Container opens a detail view showing everything in FR-16 plus:
  - Container ID and Image ID/digest
  - command / entrypoint
  - environment variables, with **values masked by default** and revealed per variable on click; never revealable for a `lookout.self` Container, whose environment holds Lookout's own secrets (pen-test #79)
  - values in the command, entrypoint, labels and mount sources that look like secrets (a password flag, a token, a URL with a password, a basic-auth list) are masked the same way, in the list and live stream too, and revealed one at a time, logged by place and never by value (pen-test #91)
  - mounts (source → destination, read-only flag)
  - networks and IP addresses
  - restart policy, restart count, last exit code, started/finished timestamps
  - labels
- **FR-21** **Logs:** a live log tail that interleaves stdout and stderr (stderr shown differently), with:
  - "last N lines" selection (100 / 500 / 1000, default 500)
  - follow mode that auto-scrolls and pauses when the user scrolls up
  - client-side text search with highlighted matches
  - timestamps on/off
- **FR-22** The log stream stops when the detail view is closed.

### 6.5 Container Actions

- **FR-23** Available actions depend on state:
  - **Start**: when not running
  - **Stop**: when running
  - **Restart**: when running
  - **Remove**: **only when stopped** (no force-remove of running Containers)
- **FR-24** **Stop** and **Restart** need a confirmation dialog.
- **FR-25** **Remove** needs the user to type the Container's name to confirm. Remove does not delete volumes.
- **FR-26** Lookout's own Container (identified by the label `lookout.self=true` in its Compose file) is listed like any other, but Stop, Restart and Remove are disabled in the UI **and** refused by the server.
- **FR-27** Each action shows progress and then success or failure (with the Docker error message: Docker's own JSON message only; a connection error, a proxy's refusal or anything else shows "Docker could not complete the action", pen-test #92). The list reflects the new state through live updates.
- **FR-28** Actions not offered in v1: exec/shell, pause/unpause, kill, rename, pull, recreate, editing configuration.

### 6.6 Authentication

- **FR-29** Every page and API endpoint except the login page and the app's own liveness check needs an authenticated session.
- **FR-30** Login is by one password. The server holds only a hash of it (supplied by env var); the plaintext password is never stored.
- **FR-31** A successful login sets a signed, `HttpOnly`, `SameSite=Strict` session cookie (also `Secure` when served over HTTPS, directly, through a proxy that sends `X-Forwarded-Proto: https`, or always with `LOOKOUT_SECURE_COOKIE=true`). Sessions expire after a configurable idle period (default 7 days) and a configurable absolute lifetime (default 30 days). Restarting Lookout or changing the password ends every session: the signing key includes the password hash and a random value chosen at start (pen-test #80, #83, #84, #86).
- **FR-32** Login attempts are rate-limited (default 5 failures per 15 minutes per client IP, an IPv6 /64 counting as one; a check still running counts; at most 4 checks at once; pen-test #81, #82).
- **FR-33** There is a logout control in the header.
- **FR-34** Requests that change state (Container Actions, logout) are protected against CSRF (SameSite=Strict cookie plus an `Origin` header check). Every request must name Lookout in its `Host` header (an IP address, `localhost` or `LOOKOUT_HOSTNAMES`), so a DNS-rebound name gets a 421 before any route (pen-test #87).

## 7. Non-functional requirements

- **NFR-1 Footprint:** idle memory use under 100 MB RSS; CPU use under 2% of one core at the default sample rate with one browser connected.
- **NFR-2 Latency:** Host Metrics in the UI are no older than sample interval + 1 s. A Container state change appears in the list within 2 s.
- **NFR-3 Accuracy:** Host Metrics describe the **Host**, not Lookout's own Container ([ADR-0003](../architectural-decision-record/0003-deploy-as-container-with-host-access.md)).
- **NFR-4 Security:** Lookout is reached only over LAN/VPN. It binds to a configurable address and should not bind to `0.0.0.0` on a publicly reachable interface. Host filesystem mounts are read-only. Secrets (password hash, session secret) come only from environment variables.
- **NFR-5 Resilience:** if the Docker daemon is unreachable, the Host page keeps working and the Containers page shows a clear "Docker unavailable" state, retrying in the background.
- **NFR-6 Platforms:** Linux Hosts on `amd64` and `arm64` (for example a Raspberry Pi 4/5) running Docker Engine 24 or later.
- **NFR-7 Browser support:** current Chrome, Firefox and Safari, on desktop and mobile.

## 8. Technical approach (summary)

Details and reasoning are in the ADRs.

- **Language:** TypeScript end to end, strict and ESM. Node 26 and pnpm 12 are pinned with `engines`/`devEngines`, and the same versions are used in the Dockerfile and CI.
- **Shape:** a Vite + React single-page app and a Fastify (Node.js LTS) server in one process and one Container. The server serves the built SPA and the API ([ADR-0007](../architectural-decision-record/0007-vite-spa-and-fastify-single-process.md)).
- **Live data:** Server-Sent Events for Host Metrics, Container list updates and log streams; plain JSON HTTP for reads and Container Actions ([ADR-0006](../architectural-decision-record/0006-server-sent-events-for-live-data.md)).
- **Host Metrics source:** read directly from `/proc`, `/sys` and `statfs` under a configurable host root (default `/host`) ([ADR-0003](../architectural-decision-record/0003-deploy-as-container-with-host-access.md)).
- **Docker access:** the Docker Engine API over `/var/run/docker.sock` using `dockerode`; Docker events drive list updates.
- **Repo layout:** a pnpm workspace:
  - `apps/web`: Vite React SPA
  - `apps/server`: Fastify server
  - `packages/shared`: types for Host Metrics, Containers, and SSE event payloads, shared by both ends
- **Testing:** Vitest for unit tests (metric parsers tested against `/proc` fixtures; Docker access behind an interface so it can be faked) plus component tests for the SPA.
- **End-to-end tests:** Playwright smoke tests run in CI against a fixture host root and a fake Docker. They cover the browser-level acceptance criteria: 360px layout, light/dark themes, and live updates.
- **Code quality:** CI runs ESLint, Prettier and typecheck on every PR. GitHub Actions are pinned to commit SHAs, and Dependabot keeps npm packages, the Dockerfile base image and Actions up to date.
- **Brand:** a telescope, in a night-sky tile with a gold star and lens. The app's logo, icon, favicon, PWA icons and `og-image.png` live in `apps/web/src/brand` and `apps/web/public`; the Project Website's copies of the same mark, its icons and its social card are in `site/brand` and `site/public` (WEB-11).
- **Build & release:** a multi-stage Dockerfile produces a small Node runtime Image. GitHub Actions builds a multi-arch (`linux/amd64`, `linux/arm64`) Image and pushes it to `ghcr.io/adrianeyre/lookout`. The Host only pulls; nothing is compiled on the Host.
  - Every merge to `main` publishes `:edge`.
  - Releases use conventional commits and semantic-release. Each release creates a `vX.Y.Z` tag, a GitHub Release and a `CHANGELOG.md` entry, and publishes `:X.Y.Z`, `:X.Y` and `:latest`. Lookout's footer shows the running version.
  - semantic-release is switched on only after the v1 security review, so the first versioned release follows it.
- **Persistence:** none. No database, and nothing written to disk ([ADR-0004](../architectural-decision-record/0004-live-metrics-only.md)).

## 9. Configuration

All configuration is by environment variable.

| Variable | Default | Purpose |
|---|---|---|
| `LOOKOUT_PASSWORD_HASH` | *(required)* | Argon2id hash of the login password |
| `LOOKOUT_SESSION_SECRET` | *(required)* | Secret for signing session cookies (≥ 32 random bytes) |
| `LOOKOUT_BIND_ADDRESS` | `127.0.0.1` | Address to listen on (set to the LAN/Tailscale IP) |
| `LOOKOUT_PORT` | `7777` | Port to listen on |
| `LOOKOUT_HOST_ROOT` | `/host` | Where the Host's root filesystem is mounted inside the Container |
| `LOOKOUT_SAMPLE_INTERVAL_MS` | `2000` | How often Host Metrics are sampled |
| `LOOKOUT_LIVE_WINDOW_MINUTES` | `15` | Length of the in-memory Live Window |
| `LOOKOUT_WARN_PERCENT` | `80` | Amber threshold |
| `LOOKOUT_CRITICAL_PERCENT` | `90` | Red threshold |
| `LOOKOUT_SESSION_IDLE_DAYS` | `7` | Session idle expiry |
| `LOOKOUT_SESSION_MAX_DAYS` | `30` | Absolute session lifetime from sign-in; at least the idle expiry (pen-test #84) |
| `LOOKOUT_SECURE_COOKIE` | `false` | Always mark the session cookie `Secure`, behind an HTTPS proxy that sends no `X-Forwarded-Proto` (pen-test #86) |
| `LOOKOUT_HOSTNAMES` | *(none)* | Host names answered besides IP addresses and `localhost`; any other `Host` is refused (pen-test #87) |
| `LOOKOUT_SITES` | *(none)* | v1.1: comma-separated Hosted Site URLs, http or https only (§14) |
| `LOOKOUT_SITE_CHECK_INTERVAL_SECONDS` | `60` | v1.1: how often each Hosted Site is checked |
| `LOOKOUT_SITE_TIMEOUT_MS` | `10000` | v1.1: a check with no response after this long is down |
| `LOOKOUT_SITE_SLOW_MS` | `2000` | v1.1: a response slower than this is slow |
| `LOOKOUT_TLS_WARN_DAYS` | `14` | v1.1: amber when a certificate expires within this many days |
| `LOOKOUT_TLS_CRITICAL_DAYS` | `7` | v1.1: red within this many days |
| `LOOKOUT_FOLDER_SCAN_HOURS` | `6` | Hours between scans of the largest folders (FR-14a); 0 scans only when asked |

The repo will include a CLI helper (`pnpm hash-password`) that produces the password hash. The README must warn that `$` characters in the hash need escaping as `$$` inside a Compose file.

## 10. Deployment

Reference `compose.yaml`, shipped in the [lookout repo](https://github.com/adrianeyre/lookout):

```yaml
services:
  lookout:
    image: ghcr.io/adrianeyre/lookout:latest
    container_name: lookout
    restart: unless-stopped
    network_mode: host
    labels:
      lookout.self: "true"
    environment:
      LOOKOUT_PASSWORD_HASH: ${LOOKOUT_PASSWORD_HASH}
      LOOKOUT_SESSION_SECRET: ${LOOKOUT_SESSION_SECRET}
      LOOKOUT_BIND_ADDRESS: ${LOOKOUT_BIND_ADDRESS}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host:ro,rslave
```

To update: `docker compose pull && docker compose up -d`.

## 11. Acceptance criteria (v1 done)

1. Starting from a fresh Linux Host with Docker, the README steps get Lookout running in under 5 minutes.
2. Every Host Metric in §6.2 matches `free`, `df`, `uptime` and `/proc/net/dev` on the Host to within normal sampling variance.
3. Stopping a Container from the CLI shows up in Lookout within 2 s. Restarting a Container from Lookout works and shows up within 2 s.
4. Lookout refuses to stop, restart or remove its own Container, even when called directly through the API.
5. Without a valid session, every protected endpoint returns 401 and no data.
6. With the Docker socket unmounted, the Host page still works and the Containers page shows "Docker unavailable".
7. The UI works without horizontal scrolling at 360px wide, in both light and dark themes.
8. CI publishes a multi-arch Image to `ghcr.io/adrianeyre/lookout`, and the first release (`v1.0.0`) follows a passed security review.
10. Playwright smoke tests cover criteria 3, 5, 6 and 7 in CI.
9. The project website is live at `lookout.adrianeyre.co.uk` and meets WEB-1 to WEB-11.

## 12. Project website

A public, static website about Lookout, built from `site/` in the [lookout repo](https://github.com/adrianeyre/lookout) and published by GitHub Pages. It follows the same pattern as the ai-office project website ([ADR-0009](../architectural-decision-record/0009-project-website-on-github-pages.md)). It is separate from the dashboard itself, which is never public.

- **WEB-1 Address:** served at **`lookout.adrianeyre.co.uk`**, set through a `CNAME` file. The domain and the repo URL are each named once, in `site/build.ts`, and every link on the page comes from them. Renaming the repo later means changing one constant.
- **WEB-2 Build:** `pnpm site:build` uses Vite to assemble the page and a 404 page in `site/dist/`. `pnpm site:dev` serves it during editing, and `pnpm site:preview` serves the built output. The screenshots are copied from `docs/images/` at build time, with AVIF and WebP copies at the widths the page needs, so nothing is stored twice in Git.
- **WEB-3 Publishing:** the workflow `.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `site/**`, `docs/images/**`, `CHANGELOG.md` or the lockfile, after every Release, and can also be run by hand. The build job has read-only permissions; only the deploy job gets `pages: write` and `id-token: write`. Actions are pinned to commit SHAs.
- **WEB-4 Sections**, in order:
  1. **Hero:** name, one-line pitch ("See your server's health and its containers at a glance"), and the hero demo (WEB-5)
  2. **What it does:** Host Metrics and Containers in one lightweight UI
  3. **Features:** live Host Metrics, Containers grouped by Compose Project, live logs, Container Actions with guard-rails, Flagged Containers, Websites (Hosted Sites and TLS), the optional socket proxy, light/dark mode, works on a phone
  4. **Screenshots** (WEB-6), with a lightbox
  5. **Security:** a prominent warning that Lookout has root-equivalent Docker access and must only be reached over LAN/VPN ([ADR-0008](../architectural-decision-record/0008-single-password-private-network.md))
  6. **Requirements:** a Linux Host on amd64 or arm64, Docker Engine 24 or later with Compose
  7. **Quick start:** hash a password, write `compose.yaml` (§10), `docker compose up -d`
  8. **Full setup guide:** every setting in §9, binding to a LAN/Tailscale address, updating, troubleshooting
  9. **Documentation:** links to the README, PRD, ADRs and glossary in the repo
  10. **Licence:** MIT
  11. **Get Lookout:** a call to action linking to the repo and `ghcr.io/adrianeyre/lookout`
  12. **FAQ:** common questions, shown as disclosures and published as `FAQPage` structured data
  13. **Site map:** on-this-page links and project links
  14. **Footer:** a bar, sticky on wide screens, like the curriculum-vitae project's. "Website design" links to the repo in a new tab; Version (the changelog, from `CHANGELOG.md`), Credits, Privacy Policy, Terms and Conditions, Cookie Policy and Accessibility each open a native modal `<dialog>`. They open through `commandfor`, so they work without JavaScript, and `/#privacy` and the like open them directly.
- **WEB-5 Hero demo:** one animated React demo of the Lookout dashboard: sparklines moving, a Container turning Flagged, and the user restarting it until it recovers. It is built on the Stageshow kit, vendored unmodified in `site/stageshow/` and restyled only from `site/demos/`. It honours `prefers-reduced-motion` by showing a still frame. There are no other demos in v1.
- **WEB-6 Screenshots:** produced by a screenshot harness (`apps/web/screenshots/`) that renders the real UI components with fixed, made-up data (a fictional Host and Containers). Images go in `docs/images/`, are shared by the README and the site, and show both light and dark themes. **They are never captured from a real Host**, because real captures would leak hostnames, Container names, IP addresses and env vars.
- **WEB-7 Privacy:** no analytics, tracking, advertising, cookies or browser storage, and no third-party requests. Fonts (Inter, JetBrains Mono) are self-hosted with their OFL licences, and the Privacy Policy says exactly this.
- **WEB-8 Discoverability:** from `site/seo.ts`, the build generates a title of at most 60 characters and a description of at most 160, a canonical URL, robots directives, Open Graph and Twitter/X card tags with a 1200×630 `og-image.png` under 300 kB (so a pasted link shows the title, description and image), JSON-LD (`WebSite`, `WebPage`, `Person`, `SoftwareApplication`, `SoftwareSourceCode`, `FAQPage`), `sitemap.xml` with its images, `robots.txt`, `site.webmanifest`, `browserconfig.xml`, `llms.txt` and `humans.txt`. `pnpm site:check` verifies all of it.
- **WEB-9 Quality:** the page is static HTML that still reads properly without JavaScript (the demo only enhances it). It meets WCAG 2.2 AA, has no horizontal scroll at 360px, and follows the system light/dark theme.
- **WEB-10 Third-party notices:** the Stageshow kit (MIT), fonts (OFL-1.1) and any brand marks are listed in `THIRD-PARTY-NOTICES.md`.
- **WEB-11 Icons:** a telescope. `pnpm site:brand` renders, from `site/brand/*.svg`: `favicon.ico` (16, 32, 48), an SVG favicon, PNG favicons (16, 32, 48, 96), an opaque 180px `apple-touch-icon` for iOS, 192 and 512px icons with maskable and monochrome variants for Android, a Safari pinned-tab mask, Windows tiles, and the social card. The output is committed, so publishing needs no browser.

## 13. Future ideas

These are not committed to: alerts/notifications, the Image list and pruning, metric history (SQLite), temperatures, top processes, a browser shell, multi-Host support, Compose-project-level actions.

## 14. v1.1: Websites (Hosted Sites)

The operator wants to see which websites the Host serves and whether they are up. v1.1 adds a third page, **Websites**, listing every **Hosted Site** with an HTTP check, a TLS certificate check and the state of the Container behind it. It follows v1.0.0, and nothing in v1 scope changes. Decisions are in [ADR-0010](../architectural-decision-record/0010-hosted-sites-checked-from-the-host.md).

### 14.1 Hosted Sites

- **SITE-1 Websites page:** a third page, **Websites** (`/websites`), in the main navigation after Containers.
- **SITE-2 Discovery:** Hosted Sites come from three places. The same URL from several of them is one Hosted Site, not a duplicate.
  - **Traefik router labels:** each host in a `traefik.http.routers.<name>.rule` label's `Host(...)` matchers (including several hosts and `||`) becomes a Hosted Site linked to that Container. The scheme is `https` when the router has a `tls` label or option or a `websecure`/`https` entrypoint, otherwise `http`. Containers labelled `traefik.enable=false` are skipped. Rules with no `Host(...)`, such as `HostRegexp` or path-only rules, are skipped and reported in the server log at debug level.
  - **A `lookout.url` label** on any Container (several URLs may be comma-separated), linked to that Container.
  - **`LOOKOUT_SITES`:** comma-separated URLs. Startup refuses an invalid URL, a URL with credentials, or any scheme other than http/https.
  - The list follows Docker events, so Hosted Sites appear and disappear as Containers come and go. While Docker is unavailable the last known list is kept.
- **SITE-3 Where checks connect:** by default a check connects to the Host itself (`127.0.0.1`) on the URL's port, sending the site's hostname as the `Host` header and the TLS SNI, so it works without hairpin NAT or split DNS. A Container labelled `lookout.check: public` has its Hosted Sites checked through normal DNS instead. Checks cannot see DNS or port-forwarding faults outside the Host, because ADR-0002 rules out a vantage point elsewhere.
- **SITE-4 The check:** one `GET` that does not follow redirects. Only the status line, the headers and the timing are read; the body is never read or stored, and response headers are capped at 16 KiB.
  - **Up:** a response below 500, including 401, 403, 404 and 3xx.
  - **Slow:** up, but slower than `LOOKOUT_SITE_SLOW_MS` (default 2000).
  - **Down:** a 5xx, a timeout (`LOOKOUT_SITE_TIMEOUT_MS`, default 10000), a refused or reset connection, a DNS error or a TLS error.
- **SITE-5 TLS:** for https Hosted Sites the peer certificate from the check's handshake gives the expiry, the issuer and whether it matches the hostname.
  - **Amber** when it expires within `LOOKOUT_TLS_WARN_DAYS` (default 14). **Red** within `LOOKOUT_TLS_CRITICAL_DAYS` (default 7), or when it has expired, doesn't match the hostname, or isn't trusted.
  - TLS verification is never disabled. A certificate that fails verification still has its details shown, but no request is sent over that connection and the Hosted Site is down.
  - http Hosted Sites show "No TLS".
- **SITE-6 Schedule:** every Hosted Site is checked every `LOOKOUT_SITE_CHECK_INTERVAL_SECONDS` (default 60), and straight away when it first appears. **Check now** on a row rechecks that Hosted Site at once. It is a POST that takes the Hosted Site's ID, never a URL, is CSRF protected like every state-changing request (FR-34), and is limited to one check per Hosted Site every 5 s. An unknown ID returns 404 and makes no request.
- **SITE-7 State:** in memory only, like the Live Window (ADR-0004): the last result, "up since", "down since", and a response-time history covering the Live Window. Everything starts empty after a restart.
- **SITE-8 Each row shows:** the URL, up/slow/down, the status code (or the error), the response time, the redirect target for a 3xx, "up for N" or "down for N", the TLS summary, a response-time sparkline, the Container it belongs to (with its state and health), and Check now.
- **SITE-9 Flagged Hosted Sites:** a Hosted Site that is down, or whose TLS certificate is at red, is a **Flagged Hosted Site**. Flagged Hosted Sites are highlighted (an icon and words, not colour alone) and sorted first. The list can be filtered by text (URL or Container name), by up/slow/down, and by "Flagged only", matching the Containers page filters (FR-18).
- **SITE-10 Containers:** a Hosted Site from a label or from discovery links to its Container's detail view and shows that Container's state, health and Flagged state beside it. The Container detail view lists the Hosted Sites it serves.
- **SITE-11 Header summary:** when there are Hosted Sites, the header summary (FR-2) gains `Sites: 6 up · 1 down`, with the down count highlighted when it is above zero. It still fits at 360px.
- **SITE-12 Not in v1.1:** alerts and notifications, stored history, checks from outside the Host (ADR-0002), and adding or checking a URL from the UI or the API.

### 14.2 Non-functional

- Hosted Site checks are the first requests Lookout makes of its own. They run at most four at a time, each bounded by the timeout, so many Hosted Sites cannot open many sockets at once. Their cost counts against NFR-1.
- The v1.1 release follows a security review of outbound checks ([`docs/security-review-v1.1.md`](../security-review-v1.1.md)), as v1.0.0 followed the v1 review.

### 14.3 Acceptance criteria (v1.1 done)

1. Unit tests cover the up/slow/down rules (401, 3xx, 5xx, a timeout and a refused connection), the TLS thresholds with fixed clocks and fixture certificates, and the Traefik rule parser with real Traefik v3 label sets.
2. A test proves that no API route accepts a URL to check, and that Check now with an unknown ID returns 404 and makes no request.
3. Playwright: a fake target switched from 200 to 503 turns its row down within one check interval; a certificate expiring in 5 days shows red; a Container with Traefik labels adds its Hosted Site live; stopping the Container behind a Hosted Site shows both as Flagged, linked to each other; Check now updates a row without waiting for the interval.
4. The Websites page, its filters and the header summary work at 360px with no horizontal scroll, in light and dark.

