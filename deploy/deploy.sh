#!/usr/bin/env bash
#
# Deploy Tailfin. Run on the server, as the `tailfin` user.
#
#   ./deploy.sh                 deploy origin/main
#   ./deploy.sh <sha|tag>       deploy (or roll back to) a specific commit
#   ./deploy.sh --force         rebuild and restart even if already at target
#
# A bare branch name is resolved against `origin`, so `main` and `origin/main`
# both work and both mean the remote. Production still refuses any commit that
# is not on main (OPS-01) — that check is on the resolved commit, so a branch
# name does not get round it.
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
MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin}"

# ---------------------------------------------------------------------------
# Does this node own migrations for its database? (OPS-09)
#
# Exactly one must, and it must be the web node. From the moment a database has
# two nodes deploying against it, two deploys can reach `migrate.js --apply` at
# the same time — and the second one's pre-migration backup would be taken after
# the first had already started changing the schema, which is the one moment the
# backup is supposed to describe.
#
# Defaults to 1, so every existing caller keeps the behaviour it had. The worker
# wrapper is the only thing that turns it off, and it still runs the preflight:
# proving a node is pointed at the database it thinks it is stays worth doing
# even when it will not write to it.
# ---------------------------------------------------------------------------
RUNS_MIGRATIONS="${RUNS_MIGRATIONS:-1}"

# ---------------------------------------------------------------------------
# Does this node run the simulation? (SCALE-06)
#
# A Worker is the only role that drains the event queue, so it is the only role
# for which "can this build handle what is queued?" is a question at all. The web
# node schedules events and never handles them; running the check there would ask
# a question whose answer cannot affect anything, and would put a database round
# trip in front of every front-door deploy for it.
#
# Defaults to 0 so the web deploy is byte-for-byte the deploy it was. The worker
# wrapper turns it on, exactly as it turns migrations off.
#
# This is a capability flag rather than a role name on purpose. #193 (OPS-14)
# owns "deploy to a named node and role", and inventing a competing NODE_ROLE
# here would leave two vocabularies for one idea. `RUNS_MIGRATIONS` is the
# pattern this repository already reaches for, and a capability collapses into
# whatever role mechanism OPS-14 settles on without a migration of its own.
# ---------------------------------------------------------------------------
CHECKS_EVENT_HANDLERS="${CHECKS_EVENT_HANDLERS:-0}"

case "${MIGRATION_DATABASE}" in
  tailfin | tailfin_dev) ;;
  *)
    echo "REFUSED: MIGRATION_DATABASE must be tailfin or tailfin_dev" >&2
    exit 2
    ;;
esac

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

# ---------------------------------------------------------------------------
# Resolve a ref, accepting a bare branch name.
#
# These checkouts are detached on purpose (see the checkout further down), and a
# fetch writes only remote-tracking refs — so there is no local `feat/thing`
# here for `rev-parse` to find. Asking for one died with git's own
# `ambiguous argument` while the usage text of both scripts, and the table in
# deploy/README.md, all promised that a branch name would work:
#
#     ./deploy-dev.sh <sha|branch>   deploy any ref — this is the point of dev
#
# `origin/<ref>` is tried **first**, which is not the obvious order and is the
# important part.
#
# The local branches in these checkouts are fossils of the original clone. The
# checkout went detached on the first deploy and nothing has updated them since:
# when this was written /srv/tailfin-dev still held a `main` **188 commits**
# behind `origin/main`, and /srv/tailfin likewise. Resolving the local one first
# would quietly deploy that, while reporting `main` — worse than the error this
# is fixing, because it succeeds.
#
# Nothing else collides. A SHA, a tag and `HEAD` have no `origin/` counterpart,
# so they fall through to the second branch untouched; only a name that is a
# branch on the remote can match the first, and for a deploy that is exactly the
# one you meant.
#
# `^{commit}` peels an annotated tag to the commit it points at, and refuses
# anything that is not a commit — which is what the checkout needs.
# ---------------------------------------------------------------------------
resolve_ref() {
  local ref="$1"
  # `HEAD` is this checkout's current commit and nothing else. It is excluded
  # because `origin/HEAD` exists on both boxes — a clone sets it to the remote's
  # default branch — so the rule above would silently turn "what is running
  # here" into "the tip of main", which is very much not the same question.
  if [ "${ref}" != 'HEAD' ] &&
    git rev-parse --verify --quiet "origin/${ref}^{commit}" >/dev/null; then
    printf '%s' "origin/${ref}"
  elif git rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    printf '%s' "${ref}"
  else
    return 1
  fi
}

cd "${REPO_DIR}"

log "Fetching"
git fetch --prune origin

# After the fetch, necessarily: a branch pushed moments ago has no
# remote-tracking ref here until it has been fetched.
RESOLVED="$(resolve_ref "${TARGET}")" ||
  die "no such commit, tag or branch: ${TARGET} (tried ${TARGET} and origin/${TARGET})"
if [ "${RESOLVED}" != "${TARGET}" ]; then
  echo "resolved ${TARGET} -> ${RESOLVED}"
  # Reassigned so the deploy stamp below records the ref that was actually
  # deployed. `ops:status` reads that field, and "my-branch" there would not say
  # which remote it came from.
  TARGET="${RESOLVED}"
fi

PREVIOUS="$(git rev-parse HEAD)"
# `^{commit}` because an **annotated** tag resolves to the tag object, not the
# commit it points at. Everything that acts on NEXT already peels — the
# ancestor check and the checkout both do — so nothing was unsafe, but the two
# places that only *report* it were wrong: `Deployed ${NEXT}` printed a sha that
# was not the commit now running, and `PREVIOUS = NEXT` could never match, so an
# already-deployed tag always rebuilt. No tags exist in the repo yet, so this
# had not bitten anyone.
NEXT="$(git rev-parse "${TARGET}^{commit}")"

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
pnpm build

# Stamp the deploy (OPS-02).
#
# `build.mjs` has just written dist/build-info.json — what this code *is*. This
# is the other half: how it got here. Only the deploy knows the ref that was
# asked for, because the checkout above is `--detach` and leaves no branch on
# disk to read back, and only the deploy knows when the code was put here as
# distinct from when the process last restarted.
#
# After the build because the build creates the directory, and before the
# restart because the server reads this once at boot.
#
# No JSON escaping: git refuses a ref containing a quote, a backslash or a
# space (git-check-ref-format), so TARGET cannot break out of the string.
log "Stamping the deploy"
cat > packages/server/dist/deploy-info.json <<JSON
{
  "ref": "${TARGET}",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

log "Checking migration state"
# The backup unit takes a database name rather than a connection string, so
# prove the application's actual connection resolves to the expected database.
# This prints no credentials.
ACTUAL_DATABASE="$(cd packages/server && node dist/migrate.js --database-name)" ||
  die "migration preflight failed — database NOT touched; service still running ${PREVIOUS}"
if [ "${ACTUAL_DATABASE}" != "${MIGRATION_DATABASE}" ]; then
  die "configured database is ${ACTUAL_DATABASE}, expected ${MIGRATION_DATABASE} — database NOT touched"
fi

PENDING_MIGRATIONS="$(cd packages/server && node dist/migrate.js --pending-count)" ||
  die "migration policy/preflight failed — database NOT touched; service still running ${PREVIOUS}"
if [[ ! "${PENDING_MIGRATIONS}" =~ ^[0-9]+$ ]]; then
  die "migration preflight returned an invalid pending count — database NOT touched"
fi

# ---------------------------------------------------------------------------
# Can this build do the work the database is already holding? (SCALE-06)
#
# Placed here, and the position is the design. The migration preflight above has
# just proved this node is pointed at ${MIGRATION_DATABASE}, so the queue this
# asks about is provably the right one — and nothing below has run yet, so a
# refusal here costs nothing at all. In particular it is **before the
# pre-migration backup**: a refusal that happens after a backup has been written
# is a refusal that already cost something.
#
# The worker's own /healthz reports the same gap and reports it too late. The
# engine starts before the deploy polls and drains on its first tick, so by then
# the queue has been processed against the build. This asks the question from a
# process that never starts the engine and never binds a port.
# ---------------------------------------------------------------------------
if [ "${CHECKS_EVENT_HANDLERS}" = '1' ]; then
  log "Checking handler coverage"
  set +e
  (cd packages/server && node dist/worker.js --handler-preflight)
  HANDLER_RESULT=$?
  set -e

  case "${HANDLER_RESULT}" in
    0) ;;
    30)
      # A real gap. Deliberately overridable — dev exists to run unmerged
      # branches, and a branch that adds a producer before its handler is a
      # legitimate thing to preview. A gate that blocks legitimate work is a gate
      # people disable, so the escape hatch is part of the design; it is an
      # environment variable typed on the command, never a default in a wrapper.
      if [ "${ALLOW_HANDLER_GAP:-0}" = '1' ]; then
        printf '\n\033[33mOVERRIDDEN: ALLOW_HANDLER_GAP=1 — deploying a build that cannot handle queued work.\033[0m\n'
        echo "  Those events will be parked as unsupported on the first tick, not lost."
        echo "  The first worker that ships the handler returns them to the queue (SCALE-05)."
        # Recorded where it outlives the terminal. This is the one decision in a
        # deploy that knowingly accepts a stalled queue, and scrollback on
        # somebody's laptop is not where that belongs.
        if command -v logger >/dev/null 2>&1; then
          logger -t tailfin-deploy \
            "ALLOW_HANDLER_GAP=1 override on ${SERVICE}: deployed ${NEXT} (${TARGET}) against ${MIGRATION_DATABASE} despite queued work it cannot handle"
        fi
      else
        die "this build has no handler for event types with queued work (see the list above) — database NOT touched, nothing restarted, service still running ${PREVIOUS}; deploy a build that registers the handler, or re-run with ALLOW_HANDLER_GAP=1 to accept the pause"
      fi
      ;;
    31)
      # Not the same thing as a gap, and deliberately not overridable. An
      # operator can say "I accept that work will pause"; nobody can say that
      # about a question that was never answered.
      die "handler preflight could not read the queue — database NOT touched, nothing restarted, service still running ${PREVIOUS}; ALLOW_HANDLER_GAP does not apply to an unknown answer"
      ;;
    *)
      die "handler preflight exited ${HANDLER_RESULT} — database NOT touched, nothing restarted, service still running ${PREVIOUS}"
      ;;
  esac
fi

if [ "${RUNS_MIGRATIONS}" != '1' ]; then
  # The preflight above has already proved this node is pointed at
  # ${MIGRATION_DATABASE}. Everything below belongs to whichever node owns the
  # schema, and a node that is not it must not take a backup either — the backup
  # unit is what the owner's failure message points at.
  if [ "${PENDING_MIGRATIONS}" -gt 0 ]; then
    die "${PENDING_MIGRATIONS} migration(s) pending on ${MIGRATION_DATABASE} and this node does not own them — deploy the web node first; database NOT touched, service still running ${PREVIOUS}"
  fi
  echo "schema is current, and this node does not own migrations — nothing applied"
else

MIGRATION_BACKUP_STATUS="/var/lib/tailfin/migration-backup-${MIGRATION_DATABASE}.json"
if [ "${PENDING_MIGRATIONS}" -gt 0 ]; then
  log "Taking pre-migration backup (${PENDING_MIGRATIONS} pending)"
  BACKUP_UNIT="tailfin-migration-backup@${MIGRATION_DATABASE}.service"
  if ! sudo systemctl start "${BACKUP_UNIT}"; then
    die "pre-migration backup failed — database NOT touched; inspect journalctl -u ${BACKUP_UNIT}"
  fi
  if [ ! -r "${MIGRATION_BACKUP_STATUS}" ]; then
    die "pre-migration backup produced no readable status — database NOT touched"
  fi
  echo "backup: $(cat "${MIGRATION_BACKUP_STATUS}")"
else
  echo "no pending migrations — backup not needed"
fi

log "Applying migrations"
# Drizzle's PostgreSQL migrator wraps the complete pending batch in one
# transaction. The CLI reads the journal after a failure and uses distinct exit
# codes so this message reports what the database actually says, including the
# rare client-failed-after-commit case.
set +e
(cd packages/server && node dist/migrate.js --apply)
MIGRATION_RESULT=$?
set -e

case "${MIGRATION_RESULT}" in
  0) ;;
  20)
    die "migration failed — DATABASE ROLLED BACK to its pre-deploy schema; service NOT restarted, still running ${PREVIOUS}; backup ${MIGRATION_BACKUP_STATUS}"
    ;;
  21)
    die "migration client failed — DATABASE REPORTS ALL PENDING MIGRATIONS APPLIED; service NOT restarted and remains compatible by policy; inspect before retrying"
    ;;
  22)
    die "migration failed — DATABASE STATE UNKNOWN/PARTIAL; service NOT restarted; do not retry or roll code back before following the migration recovery runbook"
    ;;
  23)
    die "migration was refused before SQL ran — DATABASE NOT TOUCHED; service NOT restarted, still running ${PREVIOUS}"
    ;;
  *)
    die "migration command exited ${MIGRATION_RESULT} — DATABASE STATE UNKNOWN; service NOT restarted; follow the migration recovery runbook"
    ;;
esac

fi

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
