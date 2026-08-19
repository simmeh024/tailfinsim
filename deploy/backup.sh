#!/usr/bin/env bash
#
# Nightly Postgres backup, kept locally and copied off the box (OPS-03).
#
#   ./backup.sh              back up every tailfin database
#   ./backup.sh tailfin      back up one
#
# Every dump is verified by reading its table of contents back. An unreadable
# archive is worse than no archive, because you will believe you are covered.
#
# ---------------------------------------------------------------------------
# Off-box copies
# ---------------------------------------------------------------------------
# A backup written beside the database it protects only survives the failures
# that leave the disk intact — which is not the failure backups are for. Every
# verified dump is therefore uploaded to DreamObjects, and **an upload failure
# is a backup failure**: a dump that did not leave the box is not a backup.
#
#   nightly/<db>/<db>-<stamp>.dump        the last KEEP_NIGHTLY runs
#   monthly/<db>/<db>-<YYYY-MM>.dump      one per month, kept KEEP_MONTHLY months
#
# The monthly copy is a second upload of the same dump rather than a server-side
# copy — `s3cmd cp` against DreamObjects creates the object and then fails. It
# still cannot exist unless the nightly upload succeeded; the control flow is what
# guarantees that.
#
# Retention is enforced here rather than by bucket lifecycle rules, because a
# rule that silently stops applying looks exactly like one that is working.
# Deleting explicitly means the log says what went.
#
# ---------------------------------------------------------------------------
# Telling somebody when it goes wrong
# ---------------------------------------------------------------------------
# A backup job that fails silently is worse than none, because it manufactures
# confidence. Three layers, because each covers something the others cannot:
#
#   1. **This script pings a dead-man's-switch** — success on success, failure on
#      a handled failure. Immediate, and says which databases were involved.
#   2. **`OnFailure=` on the unit** catches the run that died before it could
#      report at all: a crash, the OOM killer, the 30-minute timeout.
#   3. **The switch's own grace period** catches the case neither of the above
#      can see — the run that never happened, because the timer was disabled or
#      the box was off. Nothing on a dead machine can report that it is dead.
#
# `HEARTBEAT_URL` is a healthchecks.io-style endpoint: a POST to the URL means
# success, and a POST to `<url>/fail` means failure. No mail infrastructure,
# which matters because M14 is not built.
#
# **A ping can never fail a backup.** A network blip while the dump is safely on
# disk and in the bucket is not a backup failure, and treating it as one would
# make the alerting itself a source of false alarms. Failures to ping are logged
# and otherwise ignored.
#
# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
# `S3_CONFIG` is an s3cmd config file owned by root and readable by the postgres
# group. It is not in this repository and must never be — see deploy/README.md
# for how to create it. If it is absent the script still takes local dumps and
# then fails, loudly: silently degrading to local-only backups would rebuild the
# exact false confidence this exists to remove.

set -euo pipefail

# Somewhere the postgres user can certainly reach. `find` restores its starting
# directory when it finishes and fails the run if it cannot — so invoking this
# from a directory postgres cannot read (a home directory, say) broke the prune
# step and skipped the status file. systemd would have started it in `/` anyway;
# this makes that true however it is invoked.
cd /

BACKUP_DIR="${BACKUP_DIR:-/var/backups/tailfin}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

S3_CONFIG="${S3_CONFIG:-/etc/tailfin/dreamobjects.s3cfg}"
S3_BUCKET="${S3_BUCKET:-s3://backupstailfin}"
KEEP_NIGHTLY="${KEEP_NIGHTLY:-7}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
# Which day of the month earns a monthly copy. Zero-padded.
MONTHLY_ON_DAY="${MONTHLY_ON_DAY:-01}"
# Set to 1 to take local dumps only. For rehearsals and debugging, never for a
# scheduled run — the timer must never be pointed at a local-only backup.
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"

# Dead-man's-switch endpoint. Empty means no alerting is configured, which is
# reported rather than assumed to be deliberate — see deploy/README.md.
HEARTBEAT_URL="${HEARTBEAT_URL:-}"

DATABASES=("$@")
if [ ${#DATABASES[@]} -eq 0 ]; then
  DATABASES=(tailfin tailfin_dev)
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MONTH="$(date -u +%Y-%m)"
TODAY="$(date -u +%d)"
STATUS_FILE="${BACKUP_DIR}/last-run.json"
# Readable by the application, so the admin console can surface a failed or
# overdue backup (M1A-07). Contains nothing secret.
PUBLIC_STATUS_FILE="${PUBLIC_STATUS_FILE:-/var/lib/tailfin/backup-status.json}"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

failed=0
uploaded=0
declare -a SUMMARY=()

s3() { s3cmd --config="${S3_CONFIG}" --quiet "$@"; }

# Ping the dead-man's-switch. Never fails the run — see the header.
#
# `--max-time` rather than trusting the default: this runs at 03:15 with nothing
# watching, and a hung connection to a monitoring service must not hold a
# systemd unit open until its timeout kills a backup that had already succeeded.
heartbeat() {
  local outcome="$1" body="$2" url
  [ -n "${HEARTBEAT_URL}" ] || return 0

  # An `if` rather than `[ … ] && url=…`, because this function's exit status is
  # the script's: the success ping is the last statement in the file, and an
  # AND-list evaluating to false there would make systemd treat a backup that
  # worked as a failed unit — and fire OnFailure on it.
  if [ "${outcome}" = 'fail' ]; then
    url="${HEARTBEAT_URL%/}/fail"
  else
    url="${HEARTBEAT_URL}"
  fi

  if curl -fsS --max-time 20 --retry 3 --retry-delay 5       --data-raw "${body}" "${url}" >/dev/null 2>&1; then
    log "heartbeat ${outcome} sent"
  else
    # Logged, not fatal. The backup itself is fine; what has failed is the
    # telling — and the switch's own grace period will notice the missing ping
    # regardless, which is the whole point of using one.
    log "warning: could not reach the heartbeat endpoint (${outcome})"
  fi

  return 0
}

# Objects under a prefix, oldest first. The stamp sorts lexically in the same
# order it sorts chronologically, which is the whole reason it is shaped that way.
list_dumps() {
  s3cmd --config="${S3_CONFIG}" ls "$1" 2>/dev/null | awk '{print $4}' | grep '\.dump$' | sort || true
}

# Keep the newest N under a prefix, delete the rest with their sidecars.
prune_prefix() {
  local prefix="$1" keep="$2" keys total excess
  mapfile -t keys < <(list_dumps "${prefix}")
  total=${#keys[@]}
  [ "${total}" -le "${keep}" ] && return 0

  excess=$((total - keep))
  for key in "${keys[@]:0:excess}"; do
    if s3 del "${key}"; then
      s3 del "${key}.sha256" >/dev/null 2>&1 || true
      log "     pruned $(basename "${key}")"
    else
      log "WARN could not delete ${key}"
    fi
  done
}

if [ "${SKIP_UPLOAD}" != '1' ] && [ ! -r "${S3_CONFIG}" ]; then
  log "FAIL ${S3_CONFIG} is missing or unreadable — cannot copy backups off the box"
  log "     see deploy/README.md; refusing to pretend a local-only backup is a backup"
  failed=1
fi

for db in "${DATABASES[@]}"; do
  if ! psql -qtAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
    log "SKIP ${db} — no such database"
    continue
  fi

  out="${BACKUP_DIR}/${db}-${STAMP}.dump"

  # Custom format: compressed, and pg_restore can list/filter it. --no-owner
  # and --no-privileges so a restore works into a differently-named role, which
  # is what you want when restoring production into a scratch database to test.
  if ! pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="${db}" --file="${out}"; then
    log "FAIL ${db} — pg_dump errored"
    rm -f "${out}"
    failed=1
    continue
  fi

  # Prove the archive is readable, not merely present.
  if ! pg_restore --list "${out}" >/dev/null 2>&1; then
    log "FAIL ${db} — dump written but its table of contents is unreadable"
    mv "${out}" "${out}.corrupt"
    failed=1
    continue
  fi

  sha256sum "${out}" | awk '{print $1}' >"${out}.sha256"
  size="$(du -h "${out}" | cut -f1)"
  objects="$(pg_restore --list "${out}" | grep -c '^[0-9]')"
  log "OK   ${db} -> $(basename "${out}") (${size}, ${objects} objects)"

  [ "${SKIP_UPLOAD}" = '1' ] && { SUMMARY+=("${db}:local-only"); continue; }
  [ -r "${S3_CONFIG}" ] || { SUMMARY+=("${db}:no-credentials"); continue; }

  nightly_key="${S3_BUCKET}/nightly/${db}/${db}-${STAMP}.dump"

  if ! s3 put "${out}" "${nightly_key}"; then
    # Not a warning. The dump exists only on the disk it is protecting.
    log "FAIL ${db} — dump written but the upload failed; this is not a backup"
    failed=1
    SUMMARY+=("${db}:upload-failed")
    continue
  fi
  s3 put "${out}.sha256" "${nightly_key}.sha256" >/dev/null 2>&1 || true
  log "     uploaded -> nightly/${db}/"
  uploaded=$((uploaded + 1))

  if [ "${TODAY}" = "${MONTHLY_ON_DAY}" ]; then
    monthly_key="${S3_BUCKET}/monthly/${db}/${db}-${MONTH}.dump"
    # A second upload, deliberately, rather than a server-side copy.
    #
    # `s3cmd cp` looked like the elegant choice — same bytes, no second transfer.
    # Against DreamObjects it **creates the object and then fails**: it signs a
    # follow-up request with a V2 signature, the endpoint rejects it with
    # `400 InvalidRequest`, and the command exits 1 having actually succeeded.
    # Verified on the box: the copy was there, readable, and pg_restore listed it
    # happily, while the run was reported as failed.
    #
    # An operation that reports failure while working is worse than one that
    # plainly does not work, because it teaches you to ignore the error. The
    # dumps are small, so a second transfer is a cheap price for an exit code
    # that means what it says.
    #
    # This still cannot run unless the nightly upload above succeeded — the
    # control flow, not the copy source, is what guarantees that.
    if s3 put "${out}" "${monthly_key}"; then
      s3 put "${out}.sha256" "${monthly_key}.sha256" >/dev/null 2>&1 || true
      log "     kept as monthly/${db}/${db}-${MONTH}.dump"
    else
      log "FAIL ${db} — monthly copy failed"
      failed=1
    fi
  fi

  prune_prefix "${S3_BUCKET}/nightly/${db}/" "${KEEP_NIGHTLY}"
  prune_prefix "${S3_BUCKET}/monthly/${db}/" "${KEEP_MONTHLY}"

  SUMMARY+=("${db}:ok")
done

# Prune old local dumps and their sidecars. The local copy is for convenience —
# a fast restore without a download — so it is kept on time rather than on count.
deleted=$(find "${BACKUP_DIR}" -maxdepth 1 -name '*.dump' -mtime "+${RETAIN_DAYS}" -print -delete | wc -l)
find "${BACKUP_DIR}" -maxdepth 1 -name '*.sha256' -mtime "+${RETAIN_DAYS}" -delete
[ "${deleted}" -gt 0 ] && log "pruned ${deleted} local dump(s) older than ${RETAIN_DAYS} days"

log "backup dir now $(du -sh "${BACKUP_DIR}" | cut -f1) across $(find "${BACKUP_DIR}" -name '*.dump' | wc -l) dump(s); ${uploaded} uploaded"

# A machine-readable record of the last run, written twice on purpose.
#
# `${BACKUP_DIR}` is postgres-only (mode 700), which is right for the dumps and
# useless for anything else that wants to know. The second copy goes somewhere
# the application can read, so the admin console can show a failed or overdue
# backup instead of it living only in the journal (M1A-07).
#
# A file rather than a row in the database, because the thing it most needs to be
# able to report is that the **database was unreachable** — which a row in that
# database cannot do.
status_json="$(
  printf '{"finishedAt":"%s","result":"%s","uploaded":%d,"databases":"%s"}' \
    "$(date -Is)" "$([ "${failed}" -eq 0 ] && echo ok || echo failed)" \
    "${uploaded}" "${SUMMARY[*]:-none}"
)"
printf '%s\n' "${status_json}" >"${STATUS_FILE}"

if [ -d "$(dirname "${PUBLIC_STATUS_FILE}")" ]; then
  # World-readable, and it says nothing secret: a timestamp, ok or failed, a
  # count, and which databases were involved.
  printf '%s\n' "${status_json}" >"${PUBLIC_STATUS_FILE}"
  chmod 0644 "${PUBLIC_STATUS_FILE}" 2>/dev/null || true
else
  log "note: $(dirname "${PUBLIC_STATUS_FILE}") does not exist — the console cannot see this result"
fi

if [ -z "${HEARTBEAT_URL}" ]; then
  # Said out loud every run. A box with no alerting configured looks exactly
  # like a box whose alerting is working, which is the failure this whole
  # section exists to prevent.
  log "warning: HEARTBEAT_URL is not set — nothing will notice if this stops running"
fi

if [ "${failed}" -ne 0 ]; then
  log "one or more backups FAILED"
  heartbeat fail "backup FAILED: ${SUMMARY[*]:-none}"
  exit 1
fi

heartbeat ok "backup ok: ${uploaded} uploaded; ${SUMMARY[*]:-none}"
