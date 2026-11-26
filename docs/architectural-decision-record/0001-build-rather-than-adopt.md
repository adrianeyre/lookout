---
status: accepted
---

# Build Lookout rather than adopt Portainer, Netdata or similar

Existing tools already cover this ground. Netdata and Glances cover Host Metrics; Portainer and Dozzle cover Containers. Using them would mean running and securing two or more separate UIs, each much bigger than we need: Portainer brings stacks, registries, users and Kubernetes, and Netdata brings hundreds of collectors and a cloud tie-in. We are building [Lookout](https://github.com/adrianeyre/lookout) ourselves to get **one lightweight UI** that covers both the Host and its Containers, with only the features in the PRD.

## Considered Options

- **Portainer CE + Netdata:** feature-rich, but two tools, a heavy footprint, and far more power (and attack surface) than one operator needs.
- **Dozzle + Glances:** lighter, but still two UIs, and Dozzle is read-only (no Container Actions).
- **Build our own (chosen):** one UI, a small footprint, and a scope we control.

## Consequences

We own maintenance, including keeping up with Docker Engine API changes. Every new feature request should be weighed against "would adopting an existing tool now be cheaper?"
