#!/usr/bin/env bash
#
# Roll production forward to whatever image is currently tagged :production.
#
# Pull-based by design. Nothing in CI can reach this machine: GitHub's only
# power is to move the :production tag, and this script decides when to act on
# it. That means no SSH private key sitting in repository secrets.
#
# Idempotent and safe to run on a timer — it exits immediately when the digest
# has not moved.

set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/tailfin}"
COMPOSE="docker compose --project-directory ${STACK_DIR} -f ${STACK_DIR}/docker-compose.yml"
IMAGE="${TAILFIN_IMAGE:-ghcr.io/simmeh024/tailfinsim/server:production}"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }

cd "${STACK_DIR}"

before="$(docker image inspect --format '{{.Id}}' "${IMAGE}" 2>/dev/null || echo none)"

# Cheap when nothing changed: a manifest check, not a layer download.
if ! ${COMPOSE} pull --quiet server 2>/dev/null; then
  log "pull failed; leaving the running version in place"
  exit 0
fi

after="$(docker image inspect --format '{{.Id}}' "${IMAGE}")"

if [ "${before}" = "${after}" ]; then
  exit 0
fi

log "new image: ${before} -> ${after}"

# Postgres must be up before migrating. Starting it separately also means a
# first-ever deploy works without special-casing.
log "ensuring database is up"
${COMPOSE} up -d --wait postgres

# Migrate as a one-off container from the *new* image, before any new server
# starts. If this fails, the currently running version keeps serving.
log "applying migrations"
if ! ${COMPOSE} run --rm --no-deps --entrypoint /sbin/tini server -- node migrate.js; then
  log "MIGRATION FAILED — not restarting the server; previous version still serving"
  exit 1
fi

log "restarting server"
${COMPOSE} up -d --wait server caddy

log "pruning old images"
docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true

log "deploy complete: ${after}"
