#!/usr/bin/env bash
#
# Take the local, point-in-time backup that gates a schema migration (OPS-05).
# Installed as /usr/local/sbin/tailfin-migration-backup and invoked only by the
# root-owned systemd template. The ordinary deploy user never receives direct
# access to postgres or the backup directory.

set -euo pipefail

usage() {
  cat <<'EOF'
usage: tailfin-migration-backup <tailfin|tailfin_dev>

Creates and verifies a local custom-format dump before a migration batch.
The database name is deliberately restricted to Tailfin's two deployed databases.
EOF
}

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
  usage
  exit 0
fi

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi

database="$1"
case "${database}" in
  tailfin | tailfin_dev) ;;
  *)
    echo "REFUSED: migration backup database must be tailfin or tailfin_dev" >&2
    exit 2
    ;;
esac

backup_command="${BACKUP_COMMAND:-/usr/local/sbin/tailfin-backup}"
if [ ! -x "${backup_command}" ]; then
  echo "FAILED: ${backup_command} is not installed or executable" >&2
  exit 1
fi

export BACKUP_DIR="${BACKUP_DIR:-/var/backups/tailfin/pre-migration}"
export PUBLIC_STATUS_FILE="${PUBLIC_STATUS_FILE:-/var/lib/tailfin/migration-backup-${database}.json}"
export SKIP_UPLOAD=1
export REQUIRE_DATABASES=1
export KEEP_LOCAL="${KEEP_LOCAL:-8}"
export RETAIN_DAYS="${RETAIN_DAYS:-14}"

exec "${backup_command}" "${database}"
