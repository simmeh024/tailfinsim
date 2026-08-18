import { readFile } from 'node:fs/promises';

import { sql } from 'drizzle-orm';

import {
  type AdminAlert,
  type AdminBackupStatus,
  type AdminOverviewResponse,
} from '@tailfin/shared';

import { type Database } from '../db/client';

/**
 * The console's front page: counts, and anything that wants attention (M1A-07).
 *
 * ## Alerts are computed here, not in the browser
 *
 * Whether a backup is overdue is a judgement about the state of the system, and
 * §21's rule is that the server owns those. A client deciding for itself when to
 * worry would drift from what the box actually knows — and the box is the only
 * thing that can see the backup status file at all.
 *
 * ## Counts, not lists
 *
 * The question this page answers is "is anything wrong?". A list of 85,915
 * airports does not answer it; the number does. The airport count in particular
 * earns its place: dev silently lost its entire airport dataset to a misdirected
 * test run in August 2026 and it went unnoticed for hours. A tile reading zero
 * would have caught it in seconds.
 */

/**
 * Where the backup script leaves its result.
 *
 * A file rather than a database table on purpose. The backup runs as `postgres`
 * on a timer that knows nothing about the application, and it has to be able to
 * report **that the database was unreachable** — which a row in that database
 * cannot do.
 *
 * Overridable so local development, where the path does not exist, simply reports
 * nothing rather than pretending.
 */
const BACKUP_STATUS_FILE = process.env.BACKUP_STATUS_FILE ?? '/var/lib/tailfin/backup-status.json';

/**
 * How long after a backup before its absence is a problem.
 *
 * The timer runs nightly with up to five minutes of jitter, so 26 hours is one
 * missed run plus room for the jitter and a slow dump. Tighter than that and a
 * long backup raises a false alarm; much looser and two missed nights pass
 * unnoticed.
 */
const BACKUP_STALE_AFTER_HOURS = 26;

function isBackupStatus(value: unknown): value is AdminBackupStatus {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.finishedAt === 'string' &&
    (body.result === 'ok' || body.result === 'failed') &&
    typeof body.uploaded === 'number' &&
    typeof body.databases === 'string'
  );
}

/**
 * Reads the last backup result, or null.
 *
 * Never throws. A missing file is the ordinary local case, and an unreadable or
 * malformed one is itself reported as an alert rather than as a 500 — a console
 * that will not load because the backup file is odd is a console you cannot use
 * to find out why.
 */
export async function readBackupStatus(
  path = BACKUP_STATUS_FILE,
): Promise<AdminBackupStatus | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isBackupStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface OverviewCounts {
  players: number;
  worlds: number;
  admins: number;
  airports: number;
  auditEntries: number;
}

/** Every count in one round trip. Five separate queries for five numbers is five times the latency. */
export async function countEverything(db: Database): Promise<OverviewCounts> {
  const rows = await db.execute<{
    players: number;
    worlds: number;
    admins: number;
    airports: number;
    audit_entries: number;
  }>(sql`
    select
      (select count(*)::int from player)       as players,
      (select count(*)::int from world)        as worlds,
      (select count(*)::int from admin_grant)  as admins,
      (select count(*)::int from airport)      as airports,
      (select count(*)::int from admin_audit)  as audit_entries
  `);

  const row = rows.rows[0];
  return {
    players: row?.players ?? 0,
    worlds: row?.worlds ?? 0,
    admins: row?.admins ?? 0,
    airports: row?.airports ?? 0,
    auditEntries: row?.audit_entries ?? 0,
  };
}

/**
 * Everything worth interrupting someone about.
 *
 * Deliberately few. An alerts panel that is never empty is an alerts panel nobody
 * reads, so each of these is something a person would actually want to act on,
 * and silence means silence.
 */
export function alertsFor(
  counts: OverviewCounts,
  backup: AdminBackupStatus | null,
  now: Date,
): AdminAlert[] {
  const alerts: AdminAlert[] = [];

  // --- backups -------------------------------------------------------------
  if (backup === null) {
    alerts.push({
      code: 'backup.unknown',
      severity: 'warning',
      message: 'No backup result has been recorded.',
      detail:
        'Either backups have never run on this box, or the status file is missing. ' +
        'Nothing here can tell the difference, which is itself worth knowing.',
    });
  } else {
    const ageHours = (now.getTime() - Date.parse(backup.finishedAt)) / 3_600_000;

    if (backup.result === 'failed') {
      alerts.push({
        code: 'backup.failed',
        severity: 'error',
        message: 'The last backup failed.',
        detail:
          `Finished ${backup.finishedAt}. Databases: ${backup.databases}. ` +
          'A dump that did not leave the box is not a backup — check journalctl -u tailfin-backup.',
      });
    }

    if (Number.isFinite(ageHours) && ageHours > BACKUP_STALE_AFTER_HOURS) {
      alerts.push({
        code: 'backup.stale',
        severity: 'error',
        message: `No backup in ${Math.floor(ageHours)} hours.`,
        detail:
          `The timer runs nightly, so anything past ${String(BACKUP_STALE_AFTER_HOURS)} hours means a run was ` +
          'missed rather than merely late.',
      });
    }
  }

  // --- the console's own recoverability ------------------------------------
  if (counts.admins === 1) {
    alerts.push({
      code: 'admin.single',
      severity: 'info',
      message: 'There is only one administrator.',
      detail:
        'Revoking the last admin is refused, but losing access to that one account still means ' +
        'recovery needs a shell on the server. A second admin removes that.',
    });
  }

  // --- reference data ------------------------------------------------------
  // The specific failure this exists for: dev lost 85,915 airports to a
  // misdirected test run and nobody noticed for hours.
  if (counts.airports === 0) {
    alerts.push({
      code: 'airports.empty',
      severity: 'error',
      message: 'There are no airports.',
      detail:
        'The OurAirports import (M1-01) has either never run here or its data has been deleted. ' +
        'Nothing that needs a route can work until it is back.',
    });
  }

  if (counts.worlds === 0) {
    alerts.push({
      code: 'world.none',
      severity: 'info',
      message: 'No world has been created yet.',
      detail: 'Create one below, or run pnpm world:seed.',
    });
  }

  return alerts;
}

export async function buildOverview(
  db: Database,
  now: Date = new Date(),
): Promise<AdminOverviewResponse> {
  const [counts, backup] = await Promise.all([countEverything(db), readBackupStatus()]);
  return { counts, backup, alerts: alertsFor(counts, backup, now) };
}
