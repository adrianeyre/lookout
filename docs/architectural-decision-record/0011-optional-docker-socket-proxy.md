---
status: accepted
---

# An optional filtering proxy narrows Lookout's Docker access

[Lookout](https://github.com/adrianeyre/lookout) talks to the Docker Engine API through `/var/run/docker.sock`, which is root-equivalent on the Host ([ADR-0003](./0003-deploy-as-container-with-host-access.md)). Lookout itself uses only a dozen read endpoints plus start, stop, restart and remove ([ADR-0005](./0005-container-actions-without-shell.md)), but anyone who compromised the Lookout process would get the whole Engine API, including `exec`, `create` with Host mounts, and `pull`. The v1 security review recorded this as an accepted risk.

We ship an **optional** Compose override, `compose.socket-proxy.yaml`, that runs [wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy) in front of the socket. It allows requests by method and path, and only these: `GET /_ping`, `/events`, `/containers/json`, `/containers/{id}/json`, `/containers/{id}/logs`, `/containers/{id}/stats`, `/images/{id}/json` and `/system/df`; `POST /containers/{id}/start|stop|restart`; and `DELETE /containers/{id}`. Lookout then has neither the socket nor the Docker group, and reaches the proxy through `DOCKER_HOST=unix:///run/lookout-docker/docker.sock`, which it already supports. The proxy listens on that **Unix socket only**, never on a TCP port: the socket lives in a `tmpfs` volume that only the proxy and Lookout mount, which only root and group 65532 may enter, and the socket itself is mode `0660`, owned by the proxy's user (65533) and Lookout's group (65532). The proxy has no network (`network_mode: none`), runs read-only as that unprivileged user with no capabilities, and carries `lookout.self=true` so Lookout won't stop it.

_Amended 25 November 2026 (pen-test #101):_ the proxy first listened on `127.0.0.1:2375` on the Host's network. Every process on the Host's loopback, and every host-network Container, could then read every Container's environment and restart or remove Containers with no password and no docker group: more than the docker group allows, not less. The Unix socket ends that.

It is opt-in rather than the default because it is a second Container to run, pin and update, and it needs Docker Compose 2.24 or later for `!reset`/`!override`. The default install stays one Container. Its footprint (about 10 MB of memory and no measurable idle CPU) is outside Lookout's own NFR-1 budget, which applies to the Lookout process.

## Consequences

- With the proxy, a compromised Lookout can still read Container details, including environment values, and start, stop, restart or remove Containers. That is what Lookout is for. It can no longer exec, create Containers, pull Images, or touch Images, volumes, networks, secrets or swarm.
- Only Lookout's user and group reach the proxy. Root on the Host, and members of the docker group, already hold Docker itself, so the proxy gives no one access they lacked.
- **Accepted: the proxy matches the method and the path, never the query** (pen-test #102). `DELETE /containers/{id}?force=true&v=true` passes it, so whoever holds the socket can force-remove a running Container with its volumes, which [ADR-0005](./0005-container-actions-without-shell.md)'s remove never does; only Lookout's code sends `force=false&v=false`. Since #101 that is a compromised Lookout and nothing else, which can already stop and then remove the Container. **This stops being true on 25 February 2027** (the next pen-test round), or sooner if anything other than Lookout is given the socket; then the proxy is replaced or fronted by one that checks the query.
- A new Engine endpoint in Lookout must be added to the allowlist in `compose.socket-proxy.yaml` and to this ADR.
- _Amended 26 November 2026:_ `GET /system/df` was added for Site Stats ([ADR-0013](./0013-daily-stats-history-on-disk.md)). It reports the sizes of Images, Containers, volumes and the build cache. It changes nothing, and lists nothing Lookout could not already learn from the Containers it inspects, apart from sizes and the names of volumes and Images no Container uses.
