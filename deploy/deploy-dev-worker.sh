#!/usr/bin/env bash
#
# Deploy the dev worker. Run on `tailfin-dev-worker-01`, as the `tailfin` user.
#
#   ./deploy-dev-worker.sh                deploy origin/main
#   ./deploy-dev-worker.sh <sha|branch>   deploy any ref — same as dev web
#   ./deploy-dev-worker.sh --force        rebuild in place
#
# Thin wrapper over deploy.sh, like deploy-dev.sh. Three things differ, and each
# is a consequence of this being a different machine with a different job.
#
# ## It does not migrate
#
# The dev web node owns the schema of `tailfin_dev`. Two nodes deploying against
# one database means two deploys can reach the migrator at once, and the second
# one's pre-migration backup would describe a database the first had already
# started changing. So `RUNS_MIGRATIONS=0` — and the preflight still runs, so a
# worker pointed at the wrong database is refused before anything starts, and a
# worker deployed ahead of a schema change is told to deploy the web node first.
#
# ## It is a separate checkout
#
# `/srv/tailfin-dev-worker`, not the web node's directory — which is on another
# host anyway. #193 wants the nodes independently deployable; the cost is that
# moving a version means deploying both, in that order.
#
# ## Its health check is the engine's
#
# Port 3100 on loopback, and `worker.js` answers 503 there while its process is
# alive if the engine is not ticking. That is deliberate: it makes this script's
# health poll fail for a worker that started and did not run, which is exactly
# the failure `systemctl is-active` cannot see.

set -euo pipefail

export REPO_DIR="${REPO_DIR:-/srv/tailfin-dev-worker}"
export SERVICE="${SERVICE:-tailfin-dev-worker}"
export HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/healthz}"
export MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin_dev}"
export RUNS_MIGRATIONS=0

# Same exemption as dev web: this node exists to run branches before they merge.
export ALLOW_UNMERGED_REF=1

exec "$(dirname "$(readlink -f "$0")")/deploy.sh" "$@"
