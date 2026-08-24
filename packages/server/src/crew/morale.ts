import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';

import type { CrewMoraleBalance, HotelTier, PayBand } from '@tailfin/shared';
import {
  attritionRate,
  driftMorale,
  moraleTarget,
  restRatioFrom,
  rosterStability,
  sicknessRate,
  type MoraleContribution,
} from '@tailfin/sim';

import { airport, crewBase, crewDutyPeriod, crewPool } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * The weekly morale review (M5-03, §9.2).
 *
 * ## Why it is a review and not a computation
 *
 * The pure model gives a **target**; a base's morale eases toward it. That means
 * morale cannot be derived on read — it has to be stored and moved, and
 * something has to move it. This is that something, and it runs on the worker
 * against the world's game clock, like every other crew process.
 *
 * **Production has no worker**, so there morale would sit at its starting value
 * for ever: no drift, no sickness, no attrition, and §9.2's delayed bill would
 * never arrive at all. `moraleReviews`, `crewResignations` and `crewSickened`
 * are the counters that tell that apart from an airline whose crew are simply
 * content.
 *
 * ## Weekly, and it catches up rather than skipping
 *
 * A review covers however many game weeks have passed since the last one, and
 * `driftMorale` compounds, so a worker that was down for a month applies a
 * month's drift in one go rather than losing it. Two half-weeks equal one week
 * by construction — a tick that ran twice as often must not sour a base twice as
 * fast.
 *
 * ## Attrition is the only thing here that destroys something
 *
 * Sickness is a number that goes back down. A resignation removes heads from a
 * pool permanently, and the money to replace them is real. So it is deliberately
 * the slower of the two, and the reviews that produce it are recorded — a bill
 * nobody can trace back to a decision is indistinguishable from a bug.
 */

/** How much of a game week has passed, for the drift. */
const MS_PER_WEEK = 7 * 86_400_000;

/** Duty periods older than this tell you nothing about how a base feels now. */
const LOOKBACK_DAYS = 28;

export interface MoraleReviewResult {
  basesReviewed: number;
  resignations: number;
  sickened: number;
}

export interface BaseMoraleReading {
  crewBaseId: string;
  airportIcao: string;
  payBand: PayBand;
  hotelTier: HotelTier;
  /** Where morale is now, 0–1. Never null to a caller — see `crew_base.morale`. */
  morale: number;
  /** Where it is heading. */
  target: number;
  contributions: readonly MoraleContribution[];
  /** Game time of the last review, or null if it has never run. */
  reviewedAt: Date | null;
}

/**
 * Read morale and its itemised factors for one airline's bases.
 *
 * The read side of M5-03's second acceptance criterion. Deliberately recomputes
 * the *target* and its breakdown rather than storing them: only the eased score
 * is state, and a stored breakdown would go stale the moment a pay band changed
 * without a review having run — showing the player a reason that no longer
 * applies for a number that has not moved yet.
 */
export async function readBaseMorale(
  db: Database,
  worldId: string,
  airlineId: string,
  now: Date,
): Promise<readonly BaseMoraleReading[]> {
  const economy = await loadWorldEconomyConfig(db, worldId);
  const balance = economy.crew.morale;

  const bases = await db
    .select({
      id: crewBase.id,
      airportIcao: crewBase.airportIcao,
      payBand: crewBase.payBand,
      hotelTier: crewBase.hotelTier,
      morale: crewBase.morale,
      moraleReviewedAt: crewBase.moraleReviewedAt,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(crewBase)
    .innerJoin(airport, eq(airport.icaoCode, crewBase.airportIcao))
    .where(and(eq(crewBase.airlineId, airlineId), eq(crewBase.status, 'open')));

  const readings: BaseMoraleReading[] = [];
  for (const base of bases) {
    const inputs = await moraleInputsFor(db, base, now, balance);
    const target = moraleTarget(inputs, balance);
    readings.push({
      crewBaseId: base.id,
      airportIcao: base.airportIcao,
      payBand: base.payBand,
      hotelTier: base.hotelTier,
      // Null means never reviewed, which reads as the balance's starting value.
      morale: base.morale ?? balance.startingMorale,
      target: target.score,
      contributions: target.contributions,
      reviewedAt: base.moraleReviewedAt,
    });
  }
  return readings;
}

/**
 * Move every base in this world toward its target, and collect the bill.
 *
 * Scoped to one world and called once per world per tick, for the reason the
 * duty sweeps are: game time is a per-world quantity, and a review that read
 * every world's rows against one clock would be wrong in all of them.
 */
export async function reviewCrewMorale(
  db: Database,
  worldId: string,
  now: Date,
): Promise<MoraleReviewResult> {
  const economy = await loadWorldEconomyConfig(db, worldId);
  const balance = economy.crew.morale;

  const bases = await db
    .select({
      id: crewBase.id,
      airportIcao: crewBase.airportIcao,
      payBand: crewBase.payBand,
      hotelTier: crewBase.hotelTier,
      morale: crewBase.morale,
      moraleReviewedAt: crewBase.moraleReviewedAt,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(crewBase)
    .innerJoin(airport, eq(airport.icaoCode, crewBase.airportIcao))
    .where(and(eq(crewBase.worldId, worldId), eq(crewBase.status, 'open')));

  let basesReviewed = 0;
  let resignations = 0;
  let sickened = 0;

  for (const base of bases) {
    const weeks =
      base.moraleReviewedAt === null
        ? 0
        : (now.getTime() - base.moraleReviewedAt.getTime()) / MS_PER_WEEK;

    /*
     * A base reviewed within the week is left alone. The review both applies
     * drift and rolls the bill, so running it every tick would apply a week's
     * sickness sixty times a minute — the counters exist to make that visible
     * and this is what stops it happening.
     */
    if (base.moraleReviewedAt !== null && weeks < 1) continue;

    const inputs = await moraleInputsFor(db, base, now, balance);
    const target = moraleTarget(inputs, balance);
    const current = base.morale ?? balance.startingMorale;
    const next = driftMorale(current, target.score, Math.max(weeks, 1), balance);

    const outcome = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(crewBase)
        .set({ morale: next, moraleReviewedAt: now })
        .where(
          and(
            eq(crewBase.id, base.id),
            /*
             * The claim. Two workers racing would otherwise each apply a week of
             * drift and a week of attrition, and the loser's resignations would
             * be real people gone for a review that already happened.
             */
            base.moraleReviewedAt === null
              ? sql`${crewBase.moraleReviewedAt} IS NULL`
              : eq(crewBase.moraleReviewedAt, base.moraleReviewedAt),
          ),
        )
        .returning({ id: crewBase.id });
      if (claimed.length === 0) return { resigned: 0, sick: 0 };

      return applyMoraleEffects(tx, base.id, next, weeks, now, balance);
    });

    basesReviewed += 1;
    resignations += outcome.resigned;
    sickened += outcome.sick;
  }

  return { basesReviewed, resignations, sickened };
}

/**
 * Resignations and sick leave, at this base's morale.
 *
 * Deterministic rather than rolled. §14.1 forbids a figure a player cannot
 * interrogate, and *"you lost two captains"* is a great deal easier to argue
 * with when the answer to *"why two"* is a die. The rate times the headcount,
 * floored, so a small pool at moderate morale loses nobody and a large one at
 * bad morale loses several — which is also the right shape: attrition is a
 * proportion, not an event.
 */
async function applyMoraleEffects(
  tx: Database,
  crewBaseId: string,
  morale: number,
  weeks: number,
  now: Date,
  balance: CrewMoraleBalance,
): Promise<{ resigned: number; sick: number }> {
  const pools = await tx
    .select({
      id: crewPool.id,
      headcount: crewPool.headcount,
      unavailable: crewPool.unavailable,
      onDuty: crewPool.onDuty,
      reserve: crewPool.reserve,
    })
    .from(crewPool)
    .where(eq(crewPool.crewBaseId, crewBaseId));

  const spanWeeks = Math.max(1, Math.min(weeks, 8));
  const leaving = attritionRate(morale, balance) * spanWeeks;
  const ill = sicknessRate(morale, balance);

  let resigned = 0;
  let sick = 0;

  for (const pool of pools) {
    const quitting = Math.floor(pool.headcount * leaving);
    const remaining = pool.headcount - quitting;

    /*
     * Sick heads have to fit alongside the classroom and the aeroplane, or the
     * check constraint refuses the whole review — and one over-committed pool
     * would take every other base's drift down with it.
     */
    const committed = Math.min(pool.unavailable + pool.onDuty, remaining);
    const offSick = Math.min(Math.floor(remaining * ill), Math.max(0, remaining - committed));

    if (quitting === 0 && offSick === 0) continue;

    await tx
      .update(crewPool)
      .set({
        headcount: remaining,
        // A reserve who resigns is no longer standby either.
        reserve: Math.min(pool.reserve, remaining),
        sick: offSick,
        sickUntil: offSick > 0 ? new Date(now.getTime() + balance.sicknessDays * 86_400_000) : null,
        updatedAt: now,
      })
      .where(eq(crewPool.id, pool.id));

    resigned += quitting;
    sick += offSick;
  }

  return { resigned, sick };
}

/**
 * Return crew whose sick leave has run out.
 *
 * Cheap and world-scoped, run beside the review. Separate from it because sick
 * leave is three game days and reviews are weekly — folding the two together
 * would keep a base's crew off for the rest of the week whatever the balance
 * said.
 */
export async function returnSickCrew(
  db: Database,
  worldId: string,
  now: Date,
): Promise<{ returned: number }> {
  const recovered = await db
    .update(crewPool)
    .set({ sick: 0, sickUntil: null, updatedAt: now })
    .where(
      and(
        isNotNull(crewPool.sickUntil),
        lte(crewPool.sickUntil, now),
        sql`${crewPool.crewBaseId} IN (SELECT id FROM crew_base WHERE world_id = ${worldId})`,
      ),
    )
    .returning({ id: crewPool.id });

  return { returned: recovered.length };
}

/* ---------------------------------------------------------------------- */

interface BaseRow {
  id: string;
  airportIcao: string;
  payBand: PayBand;
  hotelTier: HotelTier;
  utcOffsetMinutes: number | null;
}

/**
 * The four inputs, two chosen and two measured.
 *
 * Both measurements come from the duty periods M5-02 writes, over the last
 * 28 days of game time — the same window the cumulative duty limits use, and for
 * the same reason: further back says nothing about how a base feels now.
 */
async function moraleInputsFor(
  db: Database,
  base: BaseRow,
  now: Date,
  balance: CrewMoraleBalance,
): Promise<{
  payBand: PayBand;
  hotelTier: HotelTier;
  rosterStability: number;
  restRatio: number;
}> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const periods = await db
    .select({
      reportAt: crewDutyPeriod.reportAt,
      offDutyAt: crewDutyPeriod.offDutyAt,
      restUntil: crewDutyPeriod.restUntil,
    })
    .from(crewDutyPeriod)
    .where(
      and(
        eq(crewDutyPeriod.crewBaseId, base.id),
        gte(crewDutyPeriod.reportAt, since),
        lte(crewDutyPeriod.reportAt, now),
      ),
    )
    .limit(500);

  // Local minutes past midnight: what the crew's own clock says, which is what
  // a wandering sign-on time actually feels like.
  const offset = base.utcOffsetMinutes ?? 0;
  const reportMinutes = periods.map(
    (period) =>
      (((period.reportAt.getUTCHours() * 60 + period.reportAt.getUTCMinutes() + offset) % 1440) +
        1440) %
      1440,
  );

  let dutyHours = 0;
  let restHours = 0;
  for (const period of periods) {
    if (period.offDutyAt === null) continue;
    dutyHours += (period.offDutyAt.getTime() - period.reportAt.getTime()) / 3_600_000;
    if (period.restUntil !== null) {
      restHours += (period.restUntil.getTime() - period.offDutyAt.getTime()) / 3_600_000;
    }
  }

  return {
    payBand: base.payBand,
    hotelTier: base.hotelTier,
    rosterStability: rosterStability(reportMinutes),
    restRatio: restRatioFrom(restHours, dutyHours, balance),
  };
}
