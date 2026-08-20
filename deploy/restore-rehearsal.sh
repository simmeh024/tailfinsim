#!/usr/bin/env bash
#
# Repeatable off-box database restore rehearsal (OPS-04).
#
# Downloads the newest verified DreamObjects nightly, restores it into a fresh
# `_test` database, applies current migrations, boots an isolated Tailfin server,
# and checks domain data plus the flagship clock. The scratch database and
# download are removed on every exit path.
#
# This script must run as root because it deliberately crosses three local
# identities: postgres creates/drops the database and reads the backup key,
# tailfin owns the restored objects and boots the app, and root coordinates the
# two without copying either account's credentials.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo tailfin-restore-rehearsal

Environment overrides:
  RESTORE_DATABASE         scratch target; must end in _test
                           (default: tailfin_restore_test)
  RESTORE_SOURCE_DATABASE  DreamObjects backup prefix (default: tailfin)
  RESTORE_PORT             isolated loopback port (default: 3099)
  TAILFIN_CHECKOUT         built checkout (default: /srv/tailfin)
  S3_CONFIG                s3cmd config (default: /etc/tailfin/dreamobjects.s3cfg)
  S3_BUCKET                bucket root (default: s3://backupstailfin)

The command never connects to a live Tailfin database. It refuses an existing
target instead of dropping it, and it will create or drop only a name ending in
`_test`.
EOF
}

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  usage
  exit 0
fi
if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

TARGET_DB="${RESTORE_DATABASE:-tailfin_restore_test}"
SOURCE_DB="${RESTORE_SOURCE_DATABASE:-tailfin}"
RESTORE_PORT="${RESTORE_PORT:-3099}"
CHECKOUT="${TAILFIN_CHECKOUT:-/srv/tailfin}"
S3_CONFIG="${S3_CONFIG:-/etc/tailfin/dreamobjects.s3cfg}"
S3_BUCKET="${S3_BUCKET:-s3://backupstailfin}"

# This check precedes root/tool checks on purpose: even a dry invocation proves
# that a live database name cannot reach a destructive command below.
if [[ ! "${TARGET_DB}" =~ ^[A-Za-z0-9_]+_test$ ]]; then
  printf 'REFUSED: RESTORE_DATABASE must end in _test; got %q\n' "${TARGET_DB}" >&2
  exit 2
fi
if [[ ! "${SOURCE_DB}" =~ ^[A-Za-z0-9_]+$ ]]; then
  printf 'REFUSED: RESTORE_SOURCE_DATABASE is not a safe backup prefix: %q\n' "${SOURCE_DB}" >&2
  exit 2
fi
if [[ ! "${RESTORE_PORT}" =~ ^[0-9]+$ ]] || [ "${RESTORE_PORT}" -lt 1024 ] || [ "${RESTORE_PORT}" -gt 65535 ]; then
  printf 'REFUSED: RESTORE_PORT must be an unprivileged TCP port (1024-65535).\n' >&2
  exit 2
fi
if [ "${EUID}" -ne 0 ]; then
  printf 'REFUSED: run this rehearsal with sudo; it must switch between postgres and tailfin.\n' >&2
  exit 2
fi

required=(
  awk createdb curl date dropdb grep id mktemp node pg_restore pnpm psql runuser
  s3cmd sed seq sha256sum sleep sort tail test
)
for command_name in "${required[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'REFUSED: required command is missing: %s\n' "${command_name}" >&2
    exit 2
  fi
done

if [ ! -r "${S3_CONFIG}" ] || ! runuser -u postgres -- test -r "${S3_CONFIG}"; then
  printf 'REFUSED: off-box credentials are unreadable by postgres: %s\n' "${S3_CONFIG}" >&2
  exit 2
fi
for account in postgres tailfin; do
  if ! id "${account}" >/dev/null 2>&1; then
    printf 'REFUSED: required operating-system account is missing: %s\n' "${account}" >&2
    exit 2
  fi
done
if [ ! -s "${CHECKOUT}/packages/server/dist/main.js" ]; then
  printf 'REFUSED: no built server at %s; deploy/build the checkout first.\n' "${CHECKOUT}" >&2
  exit 2
fi
if [ ! -f "${CHECKOUT}/packages/server/drizzle.config.ts" ]; then
  printf 'REFUSED: %s is not a Tailfin checkout.\n' "${CHECKOUT}" >&2
  exit 2
fi

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }
now_ms() { date +%s%3N; }
seconds() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }

WORK_DIR=''
SERVER_PID=''
DATABASE_CREATED=0

drop_scratch_database() {
  # Repeat the suffix guard at the destructive boundary. Do not rely on the
  # earlier validation surviving a future refactor.
  if [[ ! "${TARGET_DB}" =~ ^[A-Za-z0-9_]+_test$ ]]; then
    log "FAIL cleanup refused unsafe database name ${TARGET_DB}"
    return 1
  fi
  runuser -u postgres -- dropdb --if-exists "${TARGET_DB}"
}

remove_work_dir() {
  # WORK_DIR is created from this literal template. Refuse any broader target.
  if [[ "${WORK_DIR}" != /var/tmp/tailfin-restore.* ]]; then
    log "FAIL cleanup refused unsafe work directory ${WORK_DIR}"
    return 1
  fi
  rm -rf -- "${WORK_DIR}"
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT INT TERM
  set +e

  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill -TERM "${SERVER_PID}" >/dev/null 2>&1
    wait "${SERVER_PID}" >/dev/null 2>&1
  fi

  if [ "${DATABASE_CREATED}" -eq 1 ]; then
    if drop_scratch_database >/dev/null 2>&1; then
      log "cleanup: dropped disposable database ${TARGET_DB}"
    else
      log "FAIL cleanup could not drop disposable database ${TARGET_DB}"
      cleanup_failed=1
    fi
  fi

  if [[ "${WORK_DIR}" == /var/tmp/tailfin-restore.* ]] && [ -d "${WORK_DIR}" ]; then
    if remove_work_dir; then
      log 'cleanup: removed downloaded rehearsal files'
    else
      log "FAIL cleanup could not remove ${WORK_DIR}"
      cleanup_failed=1
    fi
  fi

  if [ "${status}" -eq 0 ] && [ "${cleanup_failed}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if runuser -u postgres -- psql -XAtqc \
  "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'" | grep -qx 1; then
  printf 'REFUSED: scratch database already exists; inspect and remove it yourself: %s\n' \
    "${TARGET_DB}" >&2
  exit 2
fi

WORK_DIR="$(mktemp -d /var/tmp/tailfin-restore.XXXXXX)"
chown postgres:tailfin "${WORK_DIR}"
chmod 2750 "${WORK_DIR}"

TOTAL_STARTED="$(now_ms)"
log "safety: target=${TARGET_DB} (_test); source=DreamObjects only; live databases unopened"

latest_line="$(
  runuser -u postgres -- s3cmd --config="${S3_CONFIG}" ls \
    "${S3_BUCKET}/nightly/${SOURCE_DB}/" \
    | awk '$4 ~ /\.dump$/ { print }' \
    | sort -k4 \
    | tail -n 1
)"
if [ -z "${latest_line}" ]; then
  printf 'FAIL: no off-box nightly dump found for %s.\n' "${SOURCE_DB}" >&2
  exit 1
fi

read -r BACKUP_DATE BACKUP_TIME BACKUP_BYTES BACKUP_OBJECT <<<"${latest_line}"
if [[ "${BACKUP_OBJECT}" != "${S3_BUCKET}/nightly/${SOURCE_DB}/"*.dump ]]; then
  printf 'FAIL: DreamObjects returned an unexpected key: %q\n' "${BACKUP_OBJECT}" >&2
  exit 1
fi
BACKUP_EPOCH="$(date -u -d "${BACKUP_DATE} ${BACKUP_TIME}" +%s)"
BACKUP_AGE_SECONDS="$(($(date -u +%s) - BACKUP_EPOCH))"
if [ "${BACKUP_AGE_SECONDS}" -lt 0 ] || [ "${BACKUP_AGE_SECONDS}" -gt $((26 * 60 * 60)) ]; then
  printf 'FAIL: newest off-box nightly is stale or future-dated (%s %s UTC).\n' \
    "${BACKUP_DATE}" "${BACKUP_TIME}" >&2
  exit 1
fi
BACKUP_AGE_HOURS="$(awk -v seconds="${BACKUP_AGE_SECONDS}" 'BEGIN { printf "%.1f", seconds / 3600 }')"

DUMP_FILE="${WORK_DIR}/restore.dump"
SHA_FILE="${DUMP_FILE}.sha256"

DOWNLOAD_STARTED="$(now_ms)"
log "download: ${BACKUP_OBJECT} (${BACKUP_BYTES} bytes; uploaded ${BACKUP_DATE} ${BACKUP_TIME} UTC)"
runuser -u postgres -- s3cmd --config="${S3_CONFIG}" get "${BACKUP_OBJECT}" "${DUMP_FILE}"
runuser -u postgres -- s3cmd --config="${S3_CONFIG}" get "${BACKUP_OBJECT}.sha256" "${SHA_FILE}"
chgrp tailfin "${DUMP_FILE}" "${SHA_FILE}"
chmod 0640 "${DUMP_FILE}" "${SHA_FILE}"
DOWNLOAD_FINISHED="$(now_ms)"

EXPECTED_SHA="$(awk 'NR == 1 { print $1 }' "${SHA_FILE}")"
ACTUAL_SHA="$(sha256sum "${DUMP_FILE}" | awk '{ print $1 }')"
if [[ ! "${EXPECTED_SHA}" =~ ^[0-9a-f]{64}$ ]] || [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then
  printf 'FAIL: downloaded dump does not match its off-box SHA-256 sidecar.\n' >&2
  exit 1
fi
pg_restore --list "${DUMP_FILE}" >/dev/null
log "integrity: SHA-256 matched and pg_restore listed the archive"

runuser -u postgres -- createdb "${TARGET_DB}" --owner=tailfin --locale=C --template=template0
DATABASE_CREATED=1

RESTORE_STARTED="$(now_ms)"
runuser -u tailfin -- pg_restore \
  --dbname="${TARGET_DB}" \
  --no-owner \
  --no-privileges \
  --single-transaction \
  "${DUMP_FILE}"
RESTORE_FINISHED="$(now_ms)"
log "restore: archive loaded into ${TARGET_DB} as role tailfin"

# node-postgres receives a URL because DATABASE_URL is required, but the encoded
# host selects the local Unix socket. No production password is read or copied.
RESTORE_URL="postgresql://tailfin@localhost/${TARGET_DB}?host=%2Fvar%2Frun%2Fpostgresql"
MIGRATE_STARTED="$(now_ms)"
runuser -u tailfin -- env DATABASE_URL="${RESTORE_URL}" \
  node "${CHECKOUT}/packages/server/dist/migrate.js" --apply
MIGRATE_FINISHED="$(now_ms)"
log 'schema: current migrations apply cleanly to the restored archive'

APP_STARTED="$(now_ms)"
runuser -u tailfin -- env \
  NODE_ENV=production \
  DATABASE_URL="${RESTORE_URL}" \
  DATABASE_POOL_MAX=2 \
  LOG_LEVEL=warn \
  WEB_SURFACE=holding \
  ENVIRONMENT_LABEL=local \
  PUBLIC_ORIGIN="http://127.0.0.1:${RESTORE_PORT}" \
  GOOGLE_CLIENT_ID= \
  GOOGLE_CLIENT_SECRET= \
  SESSION_SECRET= \
  HOST=127.0.0.1 \
  PORT="${RESTORE_PORT}" \
  node "${CHECKOUT}/packages/server/dist/main.js" \
  >"${WORK_DIR}/server.log" 2>&1 &
SERVER_PID=$!

HEALTH_FILE="${WORK_DIR}/health.json"
healthy=0
for _attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${RESTORE_PORT}/healthz" >"${HEALTH_FILE}"; then
    if grep -q '"status":"ok"' "${HEALTH_FILE}" && grep -q '"db":"up"' "${HEALTH_FILE}"; then
      healthy=1
      break
    fi
  fi
  if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if [ "${healthy}" -ne 1 ]; then
  printf 'FAIL: isolated server did not become healthy. Log follows:\n' >&2
  sed -n '1,120p' "${WORK_DIR}/server.log" >&2
  exit 1
fi
APP_HEALTHY="$(now_ms)"
log "application: isolated server healthy on 127.0.0.1:${RESTORE_PORT}"

VERIFY_STARTED="$(now_ms)"
counts="$(
  runuser -u tailfin -- psql -XAt -F '|' -d "${TARGET_DB}" -c '
    SELECT
      (SELECT count(*) FROM airport),
      (SELECT count(*) FROM runway),
      (SELECT count(*) FROM airport WHERE scheduled_service),
      (SELECT count(*) FROM airport WHERE scheduled_service AND tier IS NOT NULL),
      (SELECT count(*) FROM world);
  '
)"
IFS='|' read -r AIRPORTS RUNWAYS SCHEDULED_AIRPORTS TIERED_AIRPORTS WORLDS <<<"${counts}"
if [ "${AIRPORTS}" -le 0 ] || [ "${RUNWAYS}" -le 0 ] || [ "${SCHEDULED_AIRPORTS}" -le 0 ] || [ "${WORLDS}" -le 0 ]; then
  printf 'FAIL: restored domain data is incomplete (airports=%s runways=%s scheduled=%s worlds=%s).\n' \
    "${AIRPORTS}" "${RUNWAYS}" "${SCHEDULED_AIRPORTS}" "${WORLDS}" >&2
  exit 1
fi
if [ "${SCHEDULED_AIRPORTS}" -ne "${TIERED_AIRPORTS}" ]; then
  printf 'FAIL: only %s of %s scheduled-service airports are tiered.\n' \
    "${TIERED_AIRPORTS}" "${SCHEDULED_AIRPORTS}" >&2
  exit 1
fi

world_clock="$(
  runuser -u tailfin -- psql -XAt -F '|' -d "${TARGET_DB}" -c "
    SELECT
      name,
      to_char(epoch AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
      to_char(
        (epoch + ((clock_timestamp() - launch_date) * speed_multiplier::double precision))
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'
      ),
      (epoch + ((clock_timestamp() - launch_date) * speed_multiplier::double precision)) >= epoch
    FROM world
    WHERE name = 'Flagship'
    LIMIT 1;
  "
)"
if [ -z "${world_clock}" ]; then
  printf 'FAIL: restored archive has no Flagship world.\n' >&2
  exit 1
fi
IFS='|' read -r WORLD_NAME WORLD_EPOCH WORLD_GAME_DATE WORLD_DATE_SENSIBLE <<<"${world_clock}"
if [ "${WORLD_DATE_SENSIBLE}" != 't' ]; then
  printf 'FAIL: Flagship in-game date %s is before its epoch %s.\n' \
    "${WORLD_GAME_DATE}" "${WORLD_EPOCH}" >&2
  exit 1
fi

# Prove that schema behaviour survived, not merely its tables. The expected
# trigger failure aborts and rolls back the temporary insert with it.
set +e
AUDIT_PROBE="$(
  runuser -u tailfin -- psql -X -v ON_ERROR_STOP=1 -d "${TARGET_DB}" -c "
    BEGIN;
    INSERT INTO admin_audit (actor_label, action, subject_type)
      VALUES ('restore rehearsal', 'sessions.revoked', 'player');
    DELETE FROM admin_audit WHERE actor_label = 'restore rehearsal';
    ROLLBACK;
  " 2>&1
)"
AUDIT_STATUS=$?
set -e
if [ "${AUDIT_STATUS}" -eq 0 ] || ! grep -q 'admin_audit is append-only' <<<"${AUDIT_PROBE}"; then
  printf 'FAIL: restored admin_audit did not prove its append-only trigger.\n' >&2
  exit 1
fi
VERIFY_FINISHED="$(now_ms)"

TOTAL_FINISHED="$(now_ms)"

# A pass includes cleanup. Do it before printing the success banner so a stuck
# process, undroppable database or undeletable archive cannot leave a transcript
# that says PASSED above a later cleanup failure.
if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
  kill -TERM "${SERVER_PID}"
  wait "${SERVER_PID}" >/dev/null 2>&1 || true
fi
SERVER_PID=''
drop_scratch_database
DATABASE_CREATED=0
log "cleanup: dropped disposable database ${TARGET_DB}"
remove_work_dir
WORK_DIR=''
log 'cleanup: removed downloaded rehearsal files'

printf '\nRESTORE REHEARSAL PASSED\n'
printf '  source object       %s\n' "${BACKUP_OBJECT}"
printf '  backup uploaded     %s %s UTC\n' "${BACKUP_DATE}" "${BACKUP_TIME}"
printf '  recovery point age  %s h at rehearsal start\n' "${BACKUP_AGE_HOURS}"
printf '  target              %s (disposable; dropped after verification)\n' "${TARGET_DB}"
printf '  SHA-256             %s\n' "${ACTUAL_SHA}"
printf '  domain data         %s airports; %s runways; %s/%s scheduled airports tiered\n' \
  "${AIRPORTS}" "${RUNWAYS}" "${TIERED_AIRPORTS}" "${SCHEDULED_AIRPORTS}"
printf '  world clock         %s: %s (epoch %s)\n' \
  "${WORLD_NAME}" "${WORLD_GAME_DATE}" "${WORLD_EPOCH}"
printf '  schema behaviour    migrations current; admin_audit still append-only\n'
printf '  download            %s s\n' "$(seconds "$((DOWNLOAD_FINISHED - DOWNLOAD_STARTED))")"
printf '  restore             %s s\n' "$(seconds "$((RESTORE_FINISHED - RESTORE_STARTED))")"
printf '  migrations          %s s\n' "$(seconds "$((MIGRATE_FINISHED - MIGRATE_STARTED))")"
printf '  application boot    %s s\n' "$(seconds "$((APP_HEALTHY - APP_STARTED))")"
printf '  domain verification %s s\n' "$(seconds "$((VERIFY_FINISHED - VERIFY_STARTED))")"
printf '  total RTO observed  %s s\n' "$(seconds "$((TOTAL_FINISHED - TOTAL_STARTED))")"
printf '  worst-case RPO      up to 24 hours (nightly schedule)\n'
