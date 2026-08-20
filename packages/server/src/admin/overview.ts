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
  /** Accounts created in the last seven days — see the trend note on the wire schema. */
  newPlayers7d: number;
  /** Audited admin actions in the last twenty-four hours. */
  auditEntries24h: number;
}

/** Every count in one round trip. Seven separate queries for seven numbers is seven times the latency. */
export async function countEverything(db: Database): Promise<OverviewCounts> {
  const rows = await db.execute<{
    players: number;
    worlds: number;
    admins: number;
    airports: number;
    audit_entries: number;
    new_players_7d: number;
    audit_entries_24h: number;
  }>(sql`
    select
      (select count(*)::int from player)       as players,
      (select count(*)::int from world)        as worlds,
      (select count(*)::int from admin_grant)  as admins,
      (select count(*)::int from airport)      as airports,
      (select count(*)::int from admin_audit)  as audit_entries,
      (select count(*)::int from player
        where created_at > now() - interval '7 days')   as new_players_7d,
      (select count(*)::int from admin_audit
        where at > now() - interval '24 hours')         as audit_entries_24h
  `);

  const row = rows.rows[0];
  return {
    players: row?.players ?? 0,
    worlds: row?.worlds ?? 0,
    admins: row?.admins ?? 0,
    airports: row?.airports ?? 0,
    auditEntries: row?.audit_entries ?? 0,
    newPlayers7d: row?.new_players_7d ?? 0,
    auditEntries24h: row?.audit_entries_24h ?? 0,
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

/**
 * Whether anything is actually running, read from the queue.
 *
 * The same inference `buildWorldHealth` makes per world, collapsed to one row
 * for the front page. Liveness comes from the queue rather than from the loop
 * because a loop that reports its own health cannot report that it is not
 * running — and today nothing runs it at all, which is precisely the state this
 * has to be able to show.
 *
 * `min`/`max` over a timestamp come back as strings from the driver. Column
 * type parsers do not apply to raw aggregates, and `sql<Date>` would be an
 * assertion rather than a conversion, so this normalises at the boundary — the
 * trap CLAUDE.md records.
 */
export async function engineStatus(db: Database): Promise<AdminOverviewResponse['engine']> {
  const rows = await db.execute<{
    pending: number;
    oldest_pending: string | null;
    last_processed: string | null;
  }>(sql`
    select
      (select count(*)::int from world_event where status = 'pending')  as pending,
      (select min(fire_at) from world_event where status = 'pending')   as oldest_pending,
      (select max(processed_at) from world_event)                       as last_processed
  `);

  const row = rows.rows[0];
  const iso = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : new Date(value).toISOString();

  return {
    pendingEvents: row?.pending ?? 0,
    oldestPendingAt: iso(row?.oldest_pending),
    lastProcessedAt: iso(row?.last_processed),
  };
}

export async function buildOverview(
  db: Database,
  now: Date = new Date(),
): Promise<AdminOverviewResponse> {
  const [counts, engine, backup] = await Promise.all([
    countEverything(db),
    engineStatus(db),
    readBackupStatus(),
  ]);

  return {
    counts,
    trend: { newPlayers7d: counts.newPlayers7d, auditEntries24h: counts.auditEntries24h },
    engine,
    backup,
    alerts: alertsFor(counts, backup, now),
  };
}
