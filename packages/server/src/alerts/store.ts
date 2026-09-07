import { and, asc, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import {
  AlertKind,
  AlertScreen,
  AlertSeverity,
  AlertSubjectType,
  type Alert,
  type AlertsResponse,
} from '@tailfin/shared';

import { alert, alertState } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { AlertRow } from '../db/schema';

/**
 * Reading alerts (M8-13).
 *
 * Nothing here evaluates a rule. The sweep owns that, for the reason
 * `evaluate.ts` gives at length: an alert dated at the moment a player looked at
 * it puts every alert inside every digest window, which destroys the only thing
 * the digest is for.
 */

/**
 * A stored row as the client sees it.
 *
 * `kind`, `severity`, `subject_type` and `screen` are `text` columns holding
 * `@tailfin/shared` enum members, so they are parsed on the way out and a row
 * whose values this build does not recognise is **dropped from the projection**
 * rather than crashing the endpoint. That is the M8-06 logo lesson applied to a
 * list: a single unreadable row must not take the page with it, and the database
 * source is left untouched so a later build can still show it.
 */
export function projectAlert(row: AlertRow): Alert | null {
  const kind = AlertKind.safeParse(row.kind);
  const severity = AlertSeverity.safeParse(row.severity);
  const subjectType = AlertSubjectType.safeParse(row.subjectType);
  const screen = AlertScreen.safeParse(row.screen);
  if (!kind.success || !severity.success || !subjectType.success || !screen.success) return null;

  return {
    id: row.id,
    kind: kind.data,
    severity: severity.data,
    subjectType: subjectType.data,
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    title: row.title,
    detail: row.detail,
    screen: screen.data,
    raisedAt: row.raisedAt.toISOString(),
  };
}

export function projectAlerts(rows: readonly AlertRow[]): Alert[] {
  return rows.flatMap((row) => {
    const projected = projectAlert(row);
    return projected ? [projected] : [];
  });
}

/**
 * Every open alert for the airline, worst first.
 *
 * Critical before warning, then **oldest first** inside a severity. Oldest
 * rather than newest deliberately: an alert that has been open for three game
 * weeks is a decision the player keeps not taking, and burying it under this
 * morning's is how it stays untaken.
 */
export async function readOpenAlerts(
  db: Database,
  own: ResolvedPlayerAirline,
  /**
   * The world's game time, when the caller already has it (PERF-01).
   *
   * The digest reads the clock to work out its own window and then called this,
   * which read it again — two `world` lookups per request for a value that
   * cannot differ between them by anything a player could observe. Optional
   * rather than required so `GET /api/alerts`, which has no other reason to know
   * the clock, still reads it here.
   */
  knownGameNow?: Date,
): Promise<AlertsResponse> {
  const [gameNow, rows, state] = await Promise.all([
    knownGameNow ?? worldGameNow(db, own.worldId),
    db
      .select()
      .from(alert)
      .where(and(eq(alert.airlineId, own.id), isNull(alert.resolvedAt)))
      // `critical` sorts before `warning` alphabetically, which is the order
      // wanted — spelled out rather than relied on, because a third severity
      // would silently land in the wrong place.
      .orderBy(sql`case ${alert.severity} when 'critical' then 0 else 1 end`, asc(alert.raisedAt)),
    db
      .select({ sweptAt: alertState.sweptAt })
      .from(alertState)
      .where(eq(alertState.airlineId, own.id))
      .limit(1),
  ]);

  return {
    alerts: projectAlerts(rows),
    gameNow: gameNow.toISOString(),
    /*
     * Null means the rules have never run for this airline, which is a different
     * statement from "nothing is wrong" and the one a node with no worker is
     * making. The page says so in words rather than presenting a clean bill of
     * health.
     */
    evaluatedAt: state[0]?.sweptAt?.toISOString() ?? null,
  };
}

/** Alerts raised inside a game-time window, oldest first — the digest's bad news. */
export async function readAlertsRaisedBetween(
  db: Database,
  airlineId: string,
  fromAt: Date,
  toAt: Date,
): Promise<Alert[]> {
  const rows = await db
    .select()
    .from(alert)
    .where(
      and(eq(alert.airlineId, airlineId), gt(alert.raisedAt, fromAt), lte(alert.raisedAt, toAt)),
    )
    .orderBy(asc(alert.raisedAt));
  return projectAlerts(rows);
}

/**
 * Alerts that cleared inside the window — the digest's good news.
 *
 * Load-bearing rather than decorative: a feed that only ever reported problems
 * would show a player who fixed three routes exactly what it showed a player who
 * fixed none.
 */
export async function readAlertsResolvedBetween(
  db: Database,
  airlineId: string,
  fromAt: Date,
  toAt: Date,
): Promise<Alert[]> {
  const rows = await db
    .select()
    .from(alert)
    .where(
      and(
        eq(alert.airlineId, airlineId),
        gt(alert.resolvedAt, fromAt),
        lte(alert.resolvedAt, toAt),
      ),
    )
    .orderBy(desc(alert.resolvedAt));
  return projectAlerts(rows);
}
