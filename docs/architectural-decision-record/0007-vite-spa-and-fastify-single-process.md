---
status: accepted
---

# Vite React SPA and a Fastify server in one process, not Next.js

[Lookout](https://github.com/adrianeyre/lookout) is TypeScript end to end. It is a Vite-built React single-page app and a Fastify (Node.js) server, kept in a pnpm workspace (`apps/web`, `apps/server`, `packages/shared`). In production one Fastify process serves the built SPA as static files and the API/SSE endpoints, from one Container. We ruled out Next.js. It is a private, authenticated dashboard, so server-side rendering, SEO and file-based routing give nothing. Next's serverless-oriented request model is also awkward for long-lived SSE streams and for holding the in-memory Live Window and a persistent Docker connection.

## Considered Options

- **Next.js:** one framework, but its SSR and routing features go unused, and long-lived streams and in-process state fight its model.
- **Separate frontend and backend deployables:** more Images and CORS configuration for no benefit on a single Host.

## Consequences

`packages/shared` is the contract between server and SPA (Host Metric, Container and SSE event types). Change it first, then both ends. In development, Vite's dev server proxies `/api` to Fastify.
