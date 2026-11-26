# The pen-test fixtures' one Image (E2, docs/pen-test/fixtures.md): Hosted Sites, the victim,
# the Hostile Container's logs and the egress check, all from fixture.mjs. Built locally by
# `pnpm pen-test:up` and loaded into the throwaway daemon, which cannot pull. Same pinned
# base as Lookout's own Image.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN apk add --no-cache openssl
WORKDIR /fixture
COPY fixture.mjs ./
USER node
ENTRYPOINT ["node", "/fixture/fixture.mjs"]
CMD ["idle"]
