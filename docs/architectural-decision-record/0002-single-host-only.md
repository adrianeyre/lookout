---
status: accepted
---

# Monitor a single Host only: no agents, no hub

[Lookout](https://github.com/adrianeyre/lookout) monitors only the Host it is deployed on. It reads Host Metrics and the Docker socket locally, and has no agent protocol, central hub or Host selector. This keeps the design to one process with no network protocol between components. Monitoring several servers means running one Lookout per server.

## Consequences

Adding multi-Host support later is a significant redesign: an agent/hub split, an authenticated transport between them, and a Host dimension in every API and UI view. It is not an incremental feature. Code should not add half-built "host ID" abstractions in anticipation.
