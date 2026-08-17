# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build — full workspace, dev dependencies, esbuild bundle
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a source-only change reuses the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/sim/package.json    ./packages/sim/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json    ./packages/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

# esbuild bundles the server and everything it imports into one file, so the
# runtime stage needs no node_modules at all.
RUN pnpm --filter @tailfin/server build

# ---------------------------------------------------------------------------
# Runtime — just Node and one bundled file
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# Signal handling: without an init, PID 1 ignores SIGTERM by default and every
# deploy would wait for the 10s kill timeout instead of draining.
RUN apk add --no-cache tini

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Never run as root. The node image ships an unprivileged `node` user.
COPY --from=build --chown=node:node /app/packages/server/dist/ ./
# Migration SQL travels with the image, so the artefact that gets approved is
# the same artefact that knows how to migrate the database it runs against.
COPY --from=build --chown=node:node /app/packages/server/drizzle/ ./drizzle/

USER node
EXPOSE 3000

# Migrations are applied by the deploy script before the new container starts,
# not by the app on boot — a container that migrates on startup races itself
# whenever more than one replica exists.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
