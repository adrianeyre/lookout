---
status: accepted
---

# Live metrics only: no persisted history

[Lookout](https://github.com/adrianeyre/lookout) keeps Host Metrics only in an in-memory **Live Window** (default 15 minutes at a 2 s sample interval) for sparklines. Nothing is written to disk, and the window starts empty after a restart. The goal is "how is the Host right now?", and storing history would bring a database, retention, downsampling, migrations and a writable volume. All of that cuts against the lightweight goal in [ADR-0001](./0001-build-rather-than-adopt.md).

## Consequences

Lookout cannot answer "what happened overnight?". If history is needed later, prefer exporting to an existing time-series stack (Prometheus/Grafana) before adding storage to Lookout. That decision would supersede this ADR.
