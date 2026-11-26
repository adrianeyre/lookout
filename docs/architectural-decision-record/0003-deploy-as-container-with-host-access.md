---
status: accepted
---

# Deploy as a Container with the Docker socket, a read-only host root mount, and host networking

[Lookout](https://github.com/adrianeyre/lookout) ships as a Docker Image (`ghcr.io/adrianeyre/lookout`) and runs through Docker Compose. We chose this over a native systemd service so that installs and updates are a single `docker compose pull && up -d`, with no Node.js on the Host. To see the **Host** and not its own Container, it runs with:

- `/var/run/docker.sock` mounted, to list and control Containers
- the Host's `/` mounted read-only at `/host` (`LOOKOUT_HOST_ROOT`). All Host Metrics are read from `/host/proc`, `/host/sys`, and `statfs` on `/host/<mountpoint>`, never from the Container's own `/proc` or `/`. The Largest folders Widget (FR-14a) also lists directories under each real filesystem and `lstat`s their entries, never opening a file, never entering `/home` or `/root`, never following a link, and within fixed limits (amended 25 November 2026, pen-test #107). Every read through the Host root is refused if, once links are followed, it would leave the Host root (#113).
- `network_mode: host`, so network interfaces and throughput are the Host's real ones, not the Container's virtual NIC

We do **not** use `privileged: true` or `pid: host`.

## Considered Options

- **Native Node process under systemd:** gives accurate metrics without extra mounts, but needs Node on the Host and a hand-rolled install/update process.
- **Bridge networking and reading `/host/proc/1/net/dev`:** keeps network isolation, but is fiddly, and Lookout still needs to bind to a LAN/VPN address anyway.

## Consequences

- Access to the Docker socket is **root-equivalent on the Host**. This is why [ADR-0008](./0008-single-password-private-network.md) restricts access, and why the host root mount is read-only.
- Metric code must always resolve paths through `LOOKOUT_HOST_ROOT`. Reading `/proc` directly happens to work for some files (such as `meminfo`) and silently gives wrong answers for others (network, mounts). This is the easiest bug to reintroduce.
- With host networking, Compose `ports:` mappings do nothing, so Lookout must bind to `LOOKOUT_BIND_ADDRESS` itself.
- The read-only `/` mount gives Lookout every Host file its user may read. Lookout therefore runs as **UID and GID 65532**, a user no Host account uses, so it reads only what any user may (pen-test #106; it ran as the node image's UID 1000, the first account on most Hosts, whose home it could read). Its own filesystem is read-only, it drops every capability and may not gain privileges (#123).
- **Accepted:** whoever signs in to Lookout, or compromises it, holds Docker and so the Host. This **stops being true** if Lookout gains users other than its owner, or is recommended for a network its owner does not control, and is revisited by the next pen-test round, on 25 February 2027 at the latest.
