# syntax=docker/dockerfile:1

# Lookout: one small Node runtime Image serving the SPA, the API and the live streams.
# Node and pnpm versions match the pins in package.json. The base image is pinned by tag
# and digest in both FROM lines, and Dependabot keeps them up to date.

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS pnpm
RUN npm install --global pnpm@12.23.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
# Built into the dashboard's footer as its Changelog.
COPY CHANGELOG.md ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
# The server is compiled to plain JavaScript: running .ts directly would load Node's
# TypeScript stripper, about 20 MB more memory (NFR-1).
RUN pnpm --filter @lookout/server build
# The release version (for example 1.0.0), shown in the footer. CI passes it; a local
# build says "development build".
ARG LOOKOUT_VERSION=""
RUN if [ -n "$LOOKOUT_VERSION" ]; then export VITE_LOOKOUT_VERSION="$LOOKOUT_VERSION"; fi \
  && pnpm --filter @lookout/web build

FROM pnpm AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @lookout/server...

FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
ARG LOOKOUT_VERSION=""
LABEL org.opencontainers.image.title="Lookout" \
  org.opencontainers.image.description="A lightweight, self-hosted dashboard for a Linux Host and its Docker Containers." \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.source="https://github.com/adrianeyre/lookout" \
  org.opencontainers.image.url="https://lookout.adrianeyre.co.uk" \
  org.opencontainers.image.version="${LOOKOUT_VERSION}"
ENV NODE_ENV=production \
  LOOKOUT_VERSION=${LOOKOUT_VERSION}
# Take Alpine's security fixes, and drop npm, npx and corepack: Lookout never runs them,
# and the npm bundled with Node carries its own vulnerable dependencies.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/apps/server/node_modules apps/server/node_modules
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Run as "lookout" (UID and GID 65532), a user no Host account uses (#106). The Host's `/`
# is mounted at /host, so the node image's UID 1000, the first account on most Hosts,
# could read that account's home (its ~/.ssh and ~/.docker) through the mount. Reaching the
# Docker socket needs its group: compose.yaml adds it with group_add (DOCKER_GID). See
# "Running as non-root" in the README for why that is still root-equivalent.
RUN printf '#!/bin/sh\nexec node /app/apps/server/dist/hash-password.js "$@"\n' \
    > /usr/local/bin/hash-password \
  && chmod 755 /usr/local/bin/hash-password \
  && addgroup -S -g 65532 lookout \
  && adduser -S -D -H -u 65532 -G lookout -h /nonexistent -s /sbin/nologin lookout \
  && mkdir -m 700 /data && chown 65532:65532 /data
USER 65532:65532

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "apps/server/dist/healthcheck.js"]
CMD ["node", "apps/server/dist/main.js"]
