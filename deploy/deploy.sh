#!/usr/bin/env bash
#
# Deploy Tailfin. Run on the server, as the `tailfin` user.
#
#   ./deploy.sh                 deploy origin/main
#   ./deploy.sh <sha|tag>       deploy (or roll back to) a specific commit
#
# There is no CI involvement by design: running this command *is* the approval
# step. See ADR-0003 for why, and what it costs.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/srv/tailfin}"
SERVICE="${SERVICE:-tailfin}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cd "${REPO_DIR}"

log "Fetching"
git fetch --prune origin

TARGET="${1:-origin/main}"
PREVIOUS="$(git rev-parse HEAD)"
NEXT="$(git rev-parse "${TARGET}")"

echo "current: ${PREVIOUS}"
echo "target:  ${NEXT}  (${TARGET})"

if [ "${PREVIOUS}" = "${NEXT}" ]; then
  log "Already at target — nothing to do"
  exit 0
fi

# Detached checkout: the box tracks an explicit commit, never a moving branch,
# so `git log -1` on the server always answers "what is actually running".
log "Checking out ${NEXT}"
git checkout --quiet --detach "${NEXT}"

log "Installing dependencies"
pnpm install --frozen-lockfile

log "Building"
# Build before touching the database. A build failure here leaves the running
# service completely untouched.
pnpm --filter @tailfin/server build

log "Applying migrations"
# From packages/server so drizzle finds ./drizzle. If this fails the old
# service is still serving, and the checkout is the only thing that moved.
( cd packages/server && node dist/migrate.js ) || die "migration failed — service NOT restarted, still running ${PREVIOUS}"

log "Restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

log "Waiting for health"
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "healthy after ${i}s"
    log "Deployed ${NEXT}"
    exit 0
  fi
  sleep 1
done

printf '\n\033[31mUnhealthy after 20s.\033[0m\n' >&2
echo "  journalctl -u ${SERVICE} -n 50 --no-pager" >&2
echo "  ./deploy.sh ${PREVIOUS}   # roll back" >&2
exit 1
