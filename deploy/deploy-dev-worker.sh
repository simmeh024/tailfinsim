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
# ## Its health check is the engine's, and it is the only check it gets
#
# Port 3100 on loopback, and `worker.js` answers 503 there while its process is
# alive if the engine is not ticking. That is deliberate: it makes this script's
# health poll fail for a worker that started and did not run, which is exactly
# the failure `systemctl is-active` cannot see.
#
# That poll is also the *whole* of this node's post-deploy evidence, because
# `SERVES_PUBLIC_SURFACE=0` turns the browser smoke off. This node has no public
# HTTP surface at all — loopback port, no Caddy vhost, permanently — so there is
# no origin for the smoke to ask "are you serving the commit I just deployed?"
# about. See deploy.sh for why aiming it at another node is worse than skipping.
#
# ## It is gated on handler coverage
#
# `CHECKS_EVENT_HANDLERS=1` — the other half of the same instinct as
# `RUNS_MIGRATIONS=0`. A worker deployed ahead of a schema change is told to
# deploy the web node first; a worker that cannot handle the event types already
# queued is now told the same kind of thing, before anything restarts. This is
# the only role for which the question means anything, because it is the only
# role that drains the queue. See SCALE-06.

set -euo pipefail

export REPO_DIR="${REPO_DIR:-/srv/tailfin-dev-worker}"
export SERVICE="${SERVICE:-tailfin-dev-worker}"
export HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/healthz}"
export MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin_dev}"
export RUNS_MIGRATIONS=0
export CHECKS_EVENT_HANDLERS=1
export SERVES_PUBLIC_SURFACE=0

# POST_DEPLOY_BASE_URL and POST_DEPLOY_EXPECTED_ENVIRONMENT are deliberately not
# set here, and copying dev web's two lines across is not the fix it looks like.
#
# Until this comment existed they were simply missing, so the smoke fell through
# to deploy.sh's defaults and a *dev worker* deploy asserted that the production
# front door was serving the worker's ref — pointed at the public site, and false
# by construction. Setting them to the dev origin instead only moves the bug: the
# two dev nodes deploy separately and are routinely at different commits, and
# POST_DEPLOY_EXPECTED_COMMIT is always this node's, so the smoke would fail
# whenever dev web had not been deployed to the same ref yet.
#
# The step does not run here, so neither variable is read. A worker that one day
# does serve something would need both, plus SERVES_PUBLIC_SURFACE=1.

# ALLOW_HANDLER_GAP is deliberately **not** set here, and must never be.
#
# The override is the pressure valve that stops the gate being deleted the first
# time it blocks something legitimate — but only while it stays a decision. A
# default in this file would make every worker deploy carry it silently, which is
# indistinguishable from not having the gate. It is passed through from the
# environment, so it has to be typed on the command that wants it:
#
#     ALLOW_HANDLER_GAP=1 ./deploy/deploy-dev-worker.sh my-branch

# Same exemption as dev web: this node exists to run branches before they merge.
export ALLOW_UNMERGED_REF=1

exec "$(dirname "$(readlink -f "$0")")/deploy.sh" "$@"
