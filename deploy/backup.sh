#!/usr/bin/env bash
#
# Nightly Postgres backup. Runs as the `postgres` user via
# tailfin-backup.timer, which is why it needs no password: peer auth on the
# local socket.
#
#   ./backup.sh              back up every tailfin database
#   ./backup.sh tailfin      back up one
#
# Every dump is verified by reading its table of contents back. An unreadable
# archive is worse than no archive, because you will believe you are covered.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/tailfin}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
DATABASES=("$@")
if [ ${#DATABASES[@]} -eq 0 ]; then
  DATABASES=(tailfin tailfin_dev)
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
log() { printf '%s  %s\n' "$(date -Is)" "$*"; }

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

failed=0

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
  log "OK   ${db} -> $(basename "${out}") ($(du -h "${out}" | cut -f1), $(pg_restore --list "${out}" | grep -c '^[0-9]') objects)"
done

# Prune old dumps and their sidecars.
deleted=$(find "${BACKUP_DIR}" -maxdepth 1 -name '*.dump' -mtime "+${RETAIN_DAYS}" -print -delete | wc -l)
find "${BACKUP_DIR}" -maxdepth 1 -name '*.sha256' -mtime "+${RETAIN_DAYS}" -delete
[ "${deleted}" -gt 0 ] && log "pruned ${deleted} dump(s) older than ${RETAIN_DAYS} days"

log "backup dir now $(du -sh "${BACKUP_DIR}" | cut -f1) across $(find "${BACKUP_DIR}" -name '*.dump' | wc -l) dump(s)"

if [ "${failed}" -ne 0 ]; then
  log "one or more backups FAILED"
  exit 1
fi
