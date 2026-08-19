#!/usr/bin/env bash
#
# Deploy Tailfin. Run on the server, as the `tailfin` user.
#
#   ./deploy.sh                 deploy origin/main
#   ./deploy.sh <sha|tag>       deploy (or roll back to) a specific commit
#   ./deploy.sh --force         rebuild and restart even if already at target
#
# There is no CI involvement by design: running this command *is* the approval
# step. See ADR-0003 for why, and what it costs.

set -euo pipefail

# ---------------------------------------------------------------------------
# Re-exec from a copy of ourselves.
#
# This script runs `git checkout`, which rewrites this very file on disk. Bash
# reads scripts incrementally rather than all at once, so a script that changes
# under itself mid-run can execute garbage — the longer the file gets, the more
# likely that becomes. Copying to a temp file and exec'ing that makes the
# running code immutable for the duration.
# ---------------------------------------------------------------------------
if [ "${TAILFIN_DEPLOY_REEXEC:-}" != '1' ]; then
  _self="$(mktemp -t tailfin-deploy.XXXXXX)"
  cat "$0" >"${_self}"
  chmod +x "${_self}"
  export TAILFIN_DEPLOY_REEXEC=1
  exec "${_self}" "$@"
fi
# Running from the copy now; clean it up on the way out.
trap 'rm -f "$0"' EXIT

REPO_DIR="${REPO_DIR:-/srv/tailfin}"
SERVICE="${SERVICE:-tailfin}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"

FORCE=0
TARGET=""
for arg in "$@"; do
  case "${arg}" in
    --force | -f) FORCE=1 ;;
    -*) echo "unknown option: ${arg}" >&2; exit 2 ;;
    *) TARGET="${arg}" ;;
  esac
done
TARGET="${TARGET:-origin/main}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cd "${REPO_DIR}"

log "Fetching"
git fetch --prune origin

PREVIOUS="$(git rev-parse HEAD)"
NEXT="$(git rev-parse "${TARGET}")"

echo "current: ${PREVIOUS}"
echo "target:  ${NEXT}  (${TARGET})"

# ---------------------------------------------------------------------------
# Production runs code that is on main. Nothing else. (OPS-01)
#
# `origin/main` being the default was never a restriction — `git rev-parse`
# resolves a feature branch, a tag, or a dangling SHA just as happily, so
# `./deploy.sh origin/feat/anything` would have put it on the front door. The
# documentation claimed this was already prevented. It was not.
#
# `--is-ancestor` and not `= origin/main`, because **rollback has to keep
# working**: an older commit that is on main is still on main, and rolling back
# is exactly when you least want the tooling to argue. A commit is its own
# ancestor, so deploying the tip passes too.
#
# Dev sets ALLOW_UNMERGED_REF=1, which is the whole point of dev — see
# deploy-dev.sh. Setting it by hand for production defeats this deliberately,
# and if you are doing that you should know you are doing it.
# ---------------------------------------------------------------------------
if [ "${ALLOW_UNMERGED_REF:-0}" != '1' ]; then
  if ! git merge-base --is-ancestor "${NEXT}" origin/main; then
    printf '\n\033[31mREFUSED: %s\033[0m\n' "${NEXT} (${TARGET}) is not on main" >&2
    echo "  Production only runs commits that have been merged to main." >&2
    echo "  Rolling back? An older commit on main is fine — this refuses only what is not on it." >&2
    echo "  Looking at a branch? That is what dev is for: ./deploy/deploy-dev.sh ${TARGET}" >&2
    exit 1
  fi
fi

# Skip only when there is genuinely nothing to do: same commit AND the service
# is actually up. Without the service check this exits early on a first-ever
# deploy (checkout already at origin/main, nothing built, nothing running) and
# on recovery after a crash — both cases where a rebuild is exactly what you
# want. Found the hard way while bootstrapping the production box.
if [ "${PREVIOUS}" = "${NEXT}" ] && [ "${FORCE}" -eq 0 ]; then
  if systemctl is-active --quiet "${SERVICE}"; then
    log "Already at target and ${SERVICE} is running — nothing to do"
    echo "(use --force to rebuild anyway)"
    exit 0
  fi
  log "Already at target, but ${SERVICE} is not running — continuing"
fi

if [ "${PREVIOUS}" != "${NEXT}" ]; then
  # Detached checkout: the box tracks an explicit commit, never a moving
  # branch, so `git log -1` on the server always answers "what is running".
  log "Checking out ${NEXT}"
  git checkout --quiet --detach "${NEXT}"
fi

log "Installing dependencies"
pnpm install --frozen-lockfile

log "Building"
# Build before touching the database. A build failure here leaves the running
# service completely untouched. Builds both the server bundle and the client,
# since WEB_SURFACE=app serves the client from packages/web/dist/client.
pnpm build:apps

log "Applying migrations"
# From packages/server so drizzle finds ./drizzle. If this fails the old
# service is still serving, and the checkout is the only thing that moved.
(cd packages/server && node dist/migrate.js) ||
  die "migration failed — service NOT restarted, still running ${PREVIOUS}"

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
echo "  ./deploy/deploy.sh ${PREVIOUS}   # roll back" >&2
exit 1
