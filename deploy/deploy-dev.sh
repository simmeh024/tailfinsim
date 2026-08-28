#!/usr/bin/env bash
#
# Deploy the dev environment. Run on the server, as the `tailfin` user.
#
#   ./deploy-dev.sh                deploy origin/main to dev
#   ./deploy-dev.sh <sha|branch>   deploy any ref — this is the point of dev
#   ./deploy-dev.sh --force        rebuild in place
#
# The branch name may be bare. This checkout is detached, so `feat/thing` used to
# die with git's `ambiguous argument` and only `origin/feat/thing` worked —
# deploy.sh now resolves a bare name against `origin`, which makes the line above
# true rather than aspirational. A bare name always means the remote's, never the
# stale local branch left behind by the original clone.
#
# Thin wrapper over deploy.sh, which already takes its paths from the
# environment. Dev exists so a branch can be looked at on a real server without
# touching the public site.

set -euo pipefail

export REPO_DIR="${REPO_DIR:-/srv/tailfin-dev}"
export SERVICE="${SERVICE:-tailfin-dev}"
export HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/healthz}"
export MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin_dev}"
# The public origin is intentional: the post-deploy browser smoke must exercise
# Caddy, TLS and the built client, rather than merely the loopback health port.
export POST_DEPLOY_BASE_URL="${POST_DEPLOY_BASE_URL:-https://dev.tailfinsim.com}"
export POST_DEPLOY_EXPECTED_ENVIRONMENT="${POST_DEPLOY_EXPECTED_ENVIRONMENT:-dev}"
export ROLLBACK_COMMAND="${ROLLBACK_COMMAND:-./deploy/deploy-dev.sh}"

# Dev exists to run code that is not on main yet — reviewing work before it is
# merged is the entire job. deploy.sh refuses a ref that is not on main
# (OPS-01); this is the exemption, and it is set here rather than defaulted in
# deploy.sh so that the permissive case is the one that has to be asked for.
export ALLOW_UNMERGED_REF=1

exec "$(dirname "$(readlink -f "$0")")/deploy.sh" "$@"
