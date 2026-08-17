#!/usr/bin/env bash
#
# Deploy the dev environment. Run on the server, as the `tailfin` user.
#
#   ./deploy-dev.sh                deploy origin/main to dev
#   ./deploy-dev.sh <sha|branch>   deploy any ref — this is the point of dev
#   ./deploy-dev.sh --force        rebuild in place
#
# Thin wrapper over deploy.sh, which already takes its paths from the
# environment. Dev exists so a branch can be looked at on a real server without
# touching the public site.

set -euo pipefail

export REPO_DIR="${REPO_DIR:-/srv/tailfin-dev}"
export SERVICE="${SERVICE:-tailfin-dev}"
export HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/healthz}"

exec "$(dirname "$(readlink -f "$0")")/deploy.sh" "$@"
