---
status: accepted
---

# Server-Sent Events, not WebSockets, for live data

[Lookout](https://github.com/adrianeyre/lookout) pushes Host Metric samples, Container list changes (driven by Docker events) and log tails to the browser over Server-Sent Events. Container Actions are ordinary JSON `POST` requests. All the live data flows from server to browser, so two-way WebSockets add nothing. SSE runs over plain HTTP, uses the existing session cookie, reconnects automatically through `EventSource`, and passes through reverse proxies without special configuration.

## Consequences

- Each open log tail is its own SSE stream, closed when the detail view closes. That keeps within the browser's limit of 6 connections per origin over HTTP/1.1 for one user. If the limit becomes a problem, put Lookout behind HTTP/2 rather than merging streams.
- If a browser shell is ever added (see [ADR-0005](./0005-container-actions-without-shell.md)), that one feature may bring in WebSockets. Existing streams stay on SSE.
