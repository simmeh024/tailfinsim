import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';

import { DefaultStage, isRestricted, type CreditTier, type DefaultStanding } from '@tailfin/shared';
import { reviewDefaultLadder, type DefaultState } from '@tailfin/sim';

import {
  aircraftOrder,
  airframe,
  creditStanding,
  flight,
  flightResult,
  loan,
  route,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { airlineArrearsMinor } from './interest';

import type { Database } from '../db/client';

/**
 * §13.5's default ladder, and what each rung actually does (M8-07).
 *
 * ```
 * missed payment → warning → restriction → forced disposal
 *                → repossession → administration
 * ```
 *
 * > **Recoverable, not run-ending.** Losing your airline outright to a bad loan
 * > would push players away from the entire system.
 *
 * That sentence is the design, and three things here exist because of it.
 *
 * **Clearing the arrears clears the stage, from anywhere.** The state machine in
 * `@tailfin/sim` checks a zero balance before anything else, so an airline that
 * pays what it owes while in administration is out of administration on the next
 * sweep. A ladder you can only descend is a run-ending one with extra steps.
 *
 * **Nothing here deletes, cancels or ceases an airline.** The harshest rung
 * strips the network back to the routes that make money and wrecks the rating.
 * Control is returned, in the sense that matters: the player keeps playing, with
 * a smaller airline and the worst credit in the world.
 *
 * **Seizure takes the aeroplane and not the livery.** §13.5 says so explicitly,
 * and `airframe.repossessed_at` is a marker rather than a delete so that
 * `livery_id` — and every flight that ever referenced the airframe — survives it.
 *
 * ## Why the rungs are spaced, and where the mechanics are
 *
 * | Rung | What changes |
 * | --- | --- |
 * | `warning` | Nothing but the clock. §13.5 gives the airline its window. |
 * | `restriction` | No new routes, no new aircraft. |
 * | `forced_disposal` | Still only the restriction — the airline is being *told* to sell, and selling is the player's move. Automating it here would take the decision §13.5 hands them. |
 * | `repossession` | Secured airframes seized, their value credited against the loan. |
 * | `administration` | Loss-making routes closed, rating wrecked to the floor. |
 */

/**
 * What a wrecked rating falls to.
 *
 * `D` and never `startup`: the founder facility is exempt from §13.1's profit
 * test, so dropping an airline in administration to `startup` would hand it
 * $250K of profit-exempt credit *as a consequence of defaulting*. A database
 * test caught the same mistake in M8-06's rating review.
 */
const ADMINISTRATION_TIER: CreditTier = 'D';

/** Trailing window the "profitable core" is judged over, in game days. */
const CORE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** What one sweep of one world's ladders did. */
export interface DefaultReviewResult {
  /** Airlines that dropped a rung this sweep. */
  escalated: number;
  /** Airlines that cleared their arrears and left the ladder. */
  cured: number;
  /** Airframes seized at §13.5's fourth rung. */
  repossessed: number;
  /** Routes closed by an administration this sweep. */
  routesClosed: number;
}

const EMPTY: DefaultReviewResult = { escalated: 0, cured: 0, repossessed: 0, routesClosed: 0 };

/** The stored ladder state, defaulted for an airline that has never had a standing row. */
function stateFrom(row: typeof creditStanding.$inferSelect | undefined): DefaultState {
  return {
    stage: DefaultStage.safeParse(row?.defaultStage).data ?? 'none',
    stageEnteredAt: row?.stageEnteredAt ?? null,
    cureByAt: row?.cureByAt ?? null,
  };
}

/**
 * Review every airline in this world that is either in arrears or on the ladder.
 *
 * The second half of that condition is what lets an airline get *off*: an
 * airline whose arrears are now zero still has a stage to clear, and a sweep
 * that only looked at debtors would never look at it again.
 */
export async function reviewWorldDefaults(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<DefaultReviewResult> {
  const [inArrears, onLadder] = await Promise.all([
    db
      .selectDistinct({ airlineId: loan.airlineId })
      .from(loan)
      .where(
        and(
          eq(loan.worldId, worldId),
          inArray(loan.status, ['active', 'defaulted']),
          sql`${loan.arrearsMinor} > 0`,
        ),
      ),
    db
      .select({ airlineId: creditStanding.airlineId })
      .from(creditStanding)
      .where(and(eq(creditStanding.worldId, worldId), ne(creditStanding.defaultStage, 'none'))),
  ]);

  const airlineIds = [...new Set([...inArrears, ...onLadder].map((r) => r.airlineId))];
  if (airlineIds.length === 0) return EMPTY;

  const economy = await loadWorldEconomyConfig(db, worldId);
  const result: DefaultReviewResult = { ...EMPTY };

  for (const airlineId of airlineIds) {
    const arrearsMinor = await airlineArrearsMinor(db, airlineId);
    const [stored] = await db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, airlineId))
      .limit(1);

    const review = reviewDefaultLadder(
      stateFrom(stored),
      { arrearsMinor, gameNow },
      economy.credit,
    );
    if (!review.escalated && !review.cured) continue;

    await db
      .insert(creditStanding)
      .values({
        airlineId,
        worldId,
        defaultStage: review.next.stage,
        stageEnteredAt: review.next.stageEnteredAt,
        cureByAt: review.next.cureByAt,
      })
      .onConflictDoUpdate({
        target: creditStanding.airlineId,
        set: {
          defaultStage: review.next.stage,
          stageEnteredAt: review.next.stageEnteredAt,
          cureByAt: review.next.cureByAt,
          updatedAt: new Date(),
        },
      });

    if (review.cured) {
      result.cured += 1;
      continue;
    }
    result.escalated += 1;

    // The rung's own consequence, applied once — on the sweep that enters it.
    if (review.next.stage === 'repossession') {
      result.repossessed += await repossessSecuredAirframes(db, airlineId, gameNow);
    } else if (review.next.stage === 'administration') {
      result.routesClosed += await enterAdministration(db, worldId, airlineId, gameNow);
    }
  }

  return result;
}

/**
 * §13.5 rung 4 — take the aeroplanes the loans are written against.
 *
 * The seized airframe's acquisition cost is credited against the loan it
 * secured: arrears first, then the outstanding principal. Crediting rather than
 * simply closing the loan is deliberate. §13.1's asset advance is `0.60 ×` the
 * airline's **whole** tangible fleet, so a loan can legitimately be several times
 * the value of the one airframe named as security — and a seizure that wrote the
 * whole balance off would turn "pledge your cheapest aeroplane, then stop
 * paying" into the best price of credit in the game.
 *
 * A loan the security fully covers is `defaulted` and closed. One it does not
 * stays active, unsecured, and keeps accruing: the ladder continues to
 * administration, which is exactly where an airline that cannot cover its
 * security belongs.
 */
async function repossessSecuredAirframes(
  db: Database,
  airlineId: string,
  gameNow: Date,
): Promise<number> {
  const rows = await db
    .select({
      loanId: loan.id,
      outstandingMinor: loan.outstandingMinor,
      arrearsMinor: loan.arrearsMinor,
      airframeId: airframe.id,
      valueMinor: aircraftOrder.chargedMinor,
    })
    .from(loan)
    .innerJoin(airframe, eq(airframe.id, loan.securedAirframeId))
    .innerJoin(aircraftOrder, eq(aircraftOrder.id, airframe.sourceOrderId))
    .where(
      and(
        eq(loan.airlineId, airlineId),
        eq(loan.status, 'active'),
        eq(airframe.airlineId, airlineId),
        isNull(airframe.repossessedAt),
      ),
    );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    const value = Math.max(0, Number(row.valueMinor));
    const clearedArrears = Math.min(row.arrearsMinor, value);
    const clearedPrincipal = Math.min(row.outstandingMinor, value - clearedArrears);
    const arrears = row.arrearsMinor - clearedArrears;
    const outstanding = row.outstandingMinor - clearedPrincipal;
    const settled = arrears === 0 && outstanding === 0;

    await db.transaction(async (tx) => {
      await tx
        .update(airframe)
        .set({
          repossessedAt: gameNow,
          // Belt and braces: the dispatch gate refuses a grounded aeroplane, so a
          // query that forgets the seizure filter still cannot fly one.
          status: 'grounded',
          checkTier: null,
          checkCompletesAt: null,
        })
        .where(eq(airframe.id, row.airframeId));
      await tx
        .update(loan)
        .set({
          outstandingMinor: outstanding,
          arrearsMinor: arrears,
          status: settled ? 'defaulted' : 'active',
          // The security is gone either way; a loan cannot be seized twice.
          securedAirframeId: null,
          updatedAt: new Date(),
        })
        .where(eq(loan.id, row.loanId));
    });
  }

  return rows.length;
}

/**
 * §13.5 rung 5 — *"network stripped to profitable core, control returned with a
 * wrecked rating"*.
 *
 * Three deliberate readings of that sentence.
 *
 * **Stripped, not seized.** Routes that lost money over the trailing window are
 * deactivated. Everything that made money is left alone, which is what makes it
 * a *core* rather than a liquidation, and a route the airline wants back is one
 * it can reopen once it is out of restriction.
 *
 * **A route with no settled flights is kept.** It has not been shown to lose
 * money; closing it would punish an airline for a route it has not flown yet.
 *
 * **Wrecked means `D`, not `startup`.** The founder facility is exempt from the
 * profit test, so dropping an airline in administration into `startup` would hand
 * it $250K of profit-exempt credit as a *consequence of defaulting*. `D` is the
 * floor for any airline that has traded, and its capacity is subject to the
 * profit test like every earned tier — which for an airline in administration
 * means no capacity at all.
 */
async function enterAdministration(
  db: Database,
  worldId: string,
  airlineId: string,
  gameNow: Date,
): Promise<number> {
  const since = new Date(gameNow.getTime() - CORE_WINDOW_DAYS * DAY_MS);

  // One grouped read rather than a correlated subquery — the shape CLAUDE.md
  // records as the one that actually comes back with data.
  const settled = await db
    .select({
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      netMinor: sql<string>`sum(${flightResult.netMinor})::text`,
    })
    .from(flightResult)
    .innerJoin(flight, eq(flight.id, flightResult.flightId))
    .where(and(eq(flightResult.airlineId, airlineId), gte(flightResult.settledAt, since)))
    .groupBy(flight.originIcao, flight.destinationIcao);

  const lossMaking = new Set(
    settled
      .filter((row) => Number(row.netMinor) < 0)
      .map((row) => `${row.originIcao}-${row.destinationIcao}`),
  );

  const routes = await db
    .select({ id: route.id, originIcao: route.originIcao, destinationIcao: route.destinationIcao })
    .from(route)
    .where(and(eq(route.airlineId, airlineId), eq(route.worldId, worldId), eq(route.active, true)));

  const closing = routes
    .filter((r) => lossMaking.has(`${r.originIcao}-${r.destinationIcao}`))
    .map((r) => r.id);

  if (closing.length > 0) {
    await db.update(route).set({ active: false }).where(inArray(route.id, closing));
  }

  await db
    .update(creditStanding)
    .set({ tier: ADMINISTRATION_TIER, goodReviews: 0, updatedAt: new Date() })
    .where(and(eq(creditStanding.airlineId, airlineId), ne(creditStanding.tier, 'startup')));

  return closing.length;
}

/** Plain words for a rung — what is happening, and the one thing that ends it. */
function messageFor(stage: DefaultStage, cureByAt: Date | null): string | null {
  const by = cureByAt === null ? '' : ` You have until ${cureByAt.toISOString().slice(0, 10)}.`;
  switch (stage) {
    case 'none':
      return null;
    case 'warning':
      return `You have missed an interest payment. Clear the arrears to return to good standing.${by}`;
    case 'restriction':
      return `Your lender has restricted the airline: no new routes and no new aircraft until the arrears are cleared.${by}`;
    case 'forced_disposal':
      return `Your lender is requiring disposals. Sell aircraft or gates and clear the arrears.${by}`;
    case 'repossession':
      return 'Your lender has seized the aircraft securing your loans. Clear the arrears to stop this going further.';
    case 'administration':
      return 'The airline is in administration: loss-making routes have been closed and your rating is at its floor. Clear the arrears and you have your airline back.';
  }
}

/** The ladder as the client sees it, for one airline. */
export function projectStanding(
  row: typeof creditStanding.$inferSelect | undefined,
  arrearsMinor: number,
  dailyInterestMinor: number,
): DefaultStanding {
  const state = stateFrom(row);
  return {
    stage: state.stage,
    stageEnteredAt: state.stageEnteredAt?.toISOString() ?? null,
    cureByAt: state.cureByAt?.toISOString() ?? null,
    arrearsMinor,
    restricted: isRestricted(state.stage),
    message: messageFor(state.stage, state.cureByAt),
    dailyInterestMinor,
  };
}

/**
 * Whether §13.5 forbids this airline a new route or a new aeroplane right now.
 *
 * Read straight from `credit_standing` rather than recomputed: the sweep owns
 * the stage, and a second place deciding *"is this airline in default?"* is the
 * mistake §13.1's no-trouble-check rule exists to prevent, one subsection along.
 */
export async function isAirlineRestricted(db: Database, airlineId: string): Promise<boolean> {
  const [row] = await db
    .select({ defaultStage: creditStanding.defaultStage })
    .from(creditStanding)
    .where(eq(creditStanding.airlineId, airlineId))
    .limit(1);
  return isRestricted(DefaultStage.safeParse(row?.defaultStage).data ?? 'none');
}

/** The refusal a restricted airline receives, named once so both call sites agree. */
export const RESTRICTED_MESSAGE =
  'Your lender has restricted the airline while it is in default. Clear your arrears to lift it.';
