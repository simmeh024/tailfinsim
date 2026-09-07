import { and, eq, gt, lte, sql } from 'drizzle-orm';

import type { DigestActivity, DigestResponse, DigestWindow } from '@tailfin/shared';

import { alertState, cashMovement, flight, flightResult } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import { readAlertsRaisedBetween, readAlertsResolvedBetween, readOpenAlerts } from './store';
import { DIGEST_MAX_WINDOW_DAYS } from './thresholds';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * §3.2's offline arrival digest (M8-13).
 *
 * > **Offline arrival digest** — you come back to a readable feed of what
 * > happened.
 *
 * ## What *"since last seen"* means, and why it is not `session.last_seen_at`
 *
 * `session.last_seen_at` is the obvious column and it cannot do the job.
 * `findSessionPlayer` touches it on **every authenticated request**, so by the
 * time this handler runs it already reads *now* and the window is empty. It is
 * also per **device** — a player with a phone and a laptop has two rows, each
 * telling a different story — and every row is deleted when a privilege change
 * rotates session authority (ADR-0015), which would silently erase the fact that
 * the player had ever been here at all.
 *
 * So *last seen* means **last digest the player acknowledged**, and it lives on
 * `alert_state`. That is a stronger reading of the criterion rather than a
 * weaker one: the window is the exact period whose events the player has not yet
 * been shown, which is what a digest is for, and it survives a new device, a
 * cleared cookie and an admin grant.
 *
 * ## The read does not advance it
 *
 * `GET /api/digest` is a safe `GET` under ADR-0025 and stays one. It also means
 * a page refresh shows the same feed rather than an empty one — the failure mode
 * where a player's week of news is destroyed by a stray reload.
 * `POST /api/digest/read` is what says *I have seen this*, and it carries the
 * `toAt` it was shown so it can never acknowledge past an event nobody saw.
 */

const DAY_MS = 86_400_000;

/** §14.3's D15 threshold, shared with `statistics/operations.ts`. */
const D15_MINUTES = 15;

/**
 * Work out the window, given the watermark and the world's clock.
 *
 * Three cases, and each one is a different sentence on screen:
 *
 * - **First visit** — no watermark. The window opens one capped span back, so a
 *   brand-new airline sees the week it has actually had rather than nothing at
 *   all, and `first` says which case this is.
 * - **A long absence** — the watermark is older than the cap. The window is
 *   truncated to the cap and `truncated` says so, rather than the digest quietly
 *   pretending the earlier part never happened.
 * - **A normal return** — the window is exactly the watermark to now.
 *
 * A watermark **ahead** of the world clock is possible and is not an error: a
 * world can be reset (ADR-0005), which winds the clock back to the epoch while
 * the acknowledgement stays where it was. The window collapses to zero days
 * rather than going negative, which would select every row ever written.
 */
export function digestWindowFor(coveredThroughAt: Date | null, gameNow: Date): DigestWindow {
  const cap = new Date(gameNow.getTime() - DIGEST_MAX_WINDOW_DAYS * DAY_MS);
  const first = coveredThroughAt === null;

  const wanted = coveredThroughAt ?? cap;
  const truncated = wanted < cap;
  const fromAt = new Date(Math.min(Math.max(wanted.getTime(), cap.getTime()), gameNow.getTime()));

  return {
    fromAt: fromAt.toISOString(),
    toAt: gameNow.toISOString(),
    days: (gameNow.getTime() - fromAt.getTime()) / DAY_MS,
    truncated,
    first,
  };
}

/** `GET /api/digest` — the feed, without moving the watermark. */
export async function readDigest(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<DigestResponse> {
  const gameNow = await worldGameNow(db, own.worldId);

  const stored = await db
    .select({ coveredThroughAt: alertState.digestCoveredThroughAt })
    .from(alertState)
    .where(eq(alertState.airlineId, own.id))
    .limit(1);

  const window = digestWindowFor(stored[0]?.coveredThroughAt ?? null, gameNow);
  const fromAt = new Date(window.fromAt);

  const [activity, raised, resolved, open] = await Promise.all([
    readActivity(db, own.id, fromAt, gameNow),
    readAlertsRaisedBetween(db, own.id, fromAt, gameNow),
    readAlertsResolvedBetween(db, own.id, fromAt, gameNow),
    readOpenAlerts(db, own, gameNow),
  ]);

  return { window, activity, raised, resolved, open: open.alerts };
}

/**
 * What the airline did inside the window.
 *
 * Two reads, because a cancelled flight has no `flight_result` at all — it never
 * settles — so counting only what settled would report a perfect week to an
 * airline that cancelled everything. The same decision M8-12 made for the
 * Operations dashboard, and it must match: two surfaces disagreeing about how
 * many flights were cancelled last week is worse than either being wrong alone.
 *
 * `cashChangeMinor` sums the AIR-06 ledger over the window rather than
 * differencing two balances. The ledger is the record and the balance is the
 * consequence — and `occurred_at` has been game time for every cause since
 * TIME-02, so a window in game time selects the movements it should.
 */
async function readActivity(
  db: Database,
  airlineId: string,
  fromAt: Date,
  toAt: Date,
): Promise<DigestActivity> {
  const [settled, cancelled, cash] = await Promise.all([
    db
      .select({
        flights: sql<string>`count(*)::text`,
        passengers: sql<string>`coalesce(sum(${flightResult.passengers}), 0)::text`,
        revenueMinor: sql<string>`coalesce(sum(${flightResult.revenueMinor}), 0)::text`,
        costMinor: sql<string>`coalesce(sum(${flightResult.costMinor}), 0)::text`,
        onTime: sql<string>`count(*) filter (where ${flightResult.arrivalDelayMinutes} <= ${D15_MINUTES})::text`,
      })
      .from(flightResult)
      .where(
        and(
          eq(flightResult.airlineId, airlineId),
          eq(flightResult.kind, 'scheduled'),
          gt(flightResult.settledAt, fromAt),
          lte(flightResult.settledAt, toAt),
        ),
      ),

    db
      .select({ n: sql<string>`count(*)::text` })
      .from(flight)
      .where(
        and(
          eq(flight.airlineId, airlineId),
          eq(flight.disruption, 'cancelled'),
          gt(flight.scheduledDeparture, fromAt),
          lte(flight.scheduledDeparture, toAt),
        ),
      ),

    db
      .select({ total: sql<string>`coalesce(sum(${cashMovement.amountMinor}), 0)::text` })
      .from(cashMovement)
      .where(
        and(
          eq(cashMovement.airlineId, airlineId),
          gt(cashMovement.occurredAt, fromAt),
          lte(cashMovement.occurredAt, toAt),
        ),
      ),
  ]);

  const row = settled[0];
  const flights = Number(row?.flights ?? 0);

  return {
    flightsFlown: flights,
    flightsCancelled: Number(cancelled[0]?.n ?? 0),
    passengers: Number(row?.passengers ?? 0),
    /*
     * Null over an empty window, never 0. Zero reads as "every flight was late",
     * a claim about a bad week rather than about an absent one — the same rule
     * M8-09 applies to every ratio it reports.
     */
    onTimeRate: flights === 0 ? null : Number(row?.onTime ?? 0) / flights,
    revenueMinor: Math.round(Number(row?.revenueMinor ?? 0)),
    costMinor: Math.round(Number(row?.costMinor ?? 0)),
    cashChangeMinor: Math.round(Number(cash[0]?.total ?? 0)),
  };
}

/**
 * `POST /api/digest/read` — move the watermark.
 *
 * Clamped at both ends, and both clamps matter. It never moves **backwards**, so
 * a stale acknowledgement arriving after a newer one cannot replay a period the
 * player has already dismissed. And it never moves **past the world's own game
 * time**, so a forged or wildly future `throughAt` cannot skip a period whose
 * events have not happened yet — which would silently swallow the next real
 * digest.
 */
export async function markDigestRead(
  db: Database,
  own: ResolvedPlayerAirline,
  throughAt: Date,
): Promise<{ coveredThroughAt: string }> {
  const gameNow = await worldGameNow(db, own.worldId);
  const bounded = new Date(Math.min(throughAt.getTime(), gameNow.getTime()));

  const [row] = await db
    .insert(alertState)
    .values({
      airlineId: own.id,
      worldId: own.worldId,
      digestCoveredThroughAt: bounded,
      digestReadAt: new Date(),
    })
    .onConflictDoUpdate({
      target: alertState.airlineId,
      set: {
        digestCoveredThroughAt: sql`greatest(coalesce(${alertState.digestCoveredThroughAt}, ${bounded}), ${bounded})`,
        digestReadAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({ coveredThroughAt: alertState.digestCoveredThroughAt });

  return { coveredThroughAt: (row?.coveredThroughAt ?? bounded).toISOString() };
}
