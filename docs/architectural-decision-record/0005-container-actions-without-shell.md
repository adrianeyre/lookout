---
status: accepted
---

# Container Actions are limited to start, stop, restart and remove: no shell, no image pulls

"Full access" to Containers in [Lookout](https://github.com/adrianeyre/lookout) means reading everything (state, configuration, live logs) and performing four **Container Actions**: start, stop, restart, and remove (stopped Containers only, with typed-name confirmation). A browser shell (`docker exec`) and pulling or updating Images are deliberately excluded. A web shell turns any session compromise into an interactive root shell, and it would bring in two-way WebSockets and terminal emulation. Image pulls overlap with Compose-based deployment workflows.

## Consequences

- Lookout's own Container (label `lookout.self=true`) can never be stopped, restarted or removed through Lookout. This is enforced on the server, not only hidden in the UI.
- Remove never deletes volumes and never force-removes a running Container.
- Adding exec later would supersede this ADR and [ADR-0006](./0006-server-sent-events-for-live-data.md).
