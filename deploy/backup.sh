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
# The monthly copy is a server-side copy of that night's object rather than a
# second upload: same bytes, no second transfer, and it cannot exist unless the
# nightly upload it came from succeeded.
#
# Retention is enforced here rather than by bucket lifecycle rules, because a
# rule that silently stops applying looks exactly like one that is working.
# Deleting explicitly means the log says what went.
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

DATABASES=("$@")
if [ ${#DATABASES[@]} -eq 0 ]; then
  DATABASES=(tailfin tailfin_dev)
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MONTH="$(date -u +%Y-%m)"
TODAY="$(date -u +%d)"
STATUS_FILE="${BACKUP_DIR}/last-run.json"

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

failed=0
uploaded=0
declare -a SUMMARY=()

s3() { s3cmd --config="${S3_CONFIG}" --quiet "$@"; }

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
    # Server-side copy of the object just uploaded: same bytes, no second
    # transfer, and it cannot exist unless the nightly upload succeeded.
    if s3 cp "${nightly_key}" "${monthly_key}"; then
      s3 cp "${nightly_key}.sha256" "${monthly_key}.sha256" >/dev/null 2>&1 || true
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

# A machine-readable record of the last run, so something other than a human
# reading the journal can notice a backup that stopped happening (OPS-02).
printf '{"finishedAt":"%s","result":"%s","uploaded":%d,"databases":"%s"}\n' \
  "$(date -Is)" "$([ "${failed}" -eq 0 ] && echo ok || echo failed)" \
  "${uploaded}" "${SUMMARY[*]:-none}" >"${STATUS_FILE}"

if [ "${failed}" -ne 0 ]; then
  log "one or more backups FAILED"
  exit 1
fi
