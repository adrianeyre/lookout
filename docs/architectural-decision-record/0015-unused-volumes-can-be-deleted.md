---
status: accepted
---

# The Containers page shows volumes, and unused ones can be deleted

Operators asked to see which volumes each Container uses, and to clean up the ones nothing uses: leftovers from removed stacks, test runs and anonymous volumes. Until now that meant `docker volume ls` and `docker volume rm` on the Host.

The Containers page (its header link now reads **Docker**) lists each Container's named volumes under its row: the volume, where it is mounted, whether read-only, and its size. An **Unused volumes** Widget lists the volumes no Container mounts, each with **Delete**.

- **What counts as unused:** no Container, **running or stopped**, mounts it. A stopped Container's volume is still that Container's. Lookout's own data volume is always in use.
- **The server checks, not just the page.** `POST /api/volumes/:name/delete` takes the volume's name and the same name typed again. It needs a session and passes the `Origin` check like every action. It answers 404 for anything that is not a volume name, 400 unless the typed name matches, and 409 if any Container mounts the volume, naming them. The check is made on a fresh list of every Container, just before deleting. One delete runs at a time.
- **Never forced.** Lookout sends `DELETE /volumes/{name}?force=false`. Docker refuses a volume a Container uses, so one that came into use in between is not deleted either.
- **Sizes** come from `GET /system/df?type=volume`, which walks every volume, so they are reused for 10 minutes and measured in the background, never awaited by a page.

This widens [ADR-0005](./0005-container-actions-without-shell.md). Container Actions are still start, stop, restart and remove; deleting an **unused volume** is the only other change Lookout can make. It is the one that destroys data, so it carries remove's guard-rails (name typed, server-side refusal) plus the in-use check. Pruning (`docker volume prune`), forced deletes and deleting a volume a Container uses stay impossible.

## Consequences

- A compromised Lookout, or anyone with a session, can delete any volume no Container mounts. A volume kept on purpose for a stack that is down (its Containers removed) is unused by this definition. The dialog says so, and the README advises stopping a stack (`docker compose stop`) rather than removing it (`down`) when its data matters.
- The socket proxy ([ADR-0011](./0011-optional-docker-socket-proxy.md)) allows `GET /volumes` and `DELETE /volumes/{name}`. Like `DELETE /containers/{id}`, it cannot see the query, so `force=true` would pass it; only Lookout's code sends `force=false`. Docker refuses to delete a volume in use even with force, so the accepted risk adds nothing beyond deleting unused volumes.
