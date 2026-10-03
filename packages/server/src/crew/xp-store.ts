import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import type { CrewSkillBalance, CrewXpBalance, TrainingCaptainBalance } from '@tailfin/shared';
import {
  flightXp,
  isFlightDeckRank,
  trainedXpPerHead,
  trainingXpMultiplier,
  type FlightXp,
  type Weather,
  type XpDisruption,
} from '@tailfin/sim';

import { crewDutyPeriod, crewMember, crewPool, crewRank, type CrewRankValue } from '../db/schema';

import { parseComplement } from './duty-store';
import { creditNamedCrew } from './roster';

import type { Database } from '../db/client';

/**
 * Awarding §10.2's XP when a flight arrives (M9-02).
 *
 * ## "Every crew member aboard", with no crew member rows
 *
 * §10.2 says XP goes to *"every crew member aboard"*, and M5-01's rule is that
 * *"the player interacts with pool sizes and never with individuals"* — there is
 * deliberately no crew member table. Those are reconcilable, and the
 * reconciliation is the whole design of this file: the flight names the duty
 * period that operated it, the duty period holds the **rank breakdown actually
 * taken from the pools**, and each of those pools receives `xpPerHead × heads`.
 *
 * So every head aboard really does earn the same XP, and the total lands where
 * `crew_pool` already said it should: *"Individual hours and proficiency are M9;
 * if one arrives it should hang off this rather than replace it."*
 *
 * ## The complement is read, never recomputed
 *
 * `crew_duty_period.complement` is the JSON the dispatcher wrote when it took
 * the heads. Recomputing which ranks flew from today's pools would credit XP to
 * a rank that has since been hired into and miss one that has shrunk — and on a
 * multi-sector day the complement belongs to the sector that *opened* the
 * period, which is the same reason `releaseComplement` reads it rather than
 * deriving it.
 *
 * ## Awarded once, because it rides the settlement
 *
 * Called from inside `settleArrivedFlight`, **after** the `flight_result` insert
 * has proved the arrival is not a replay — the same position and the same
 * reason as `accrueFlightHours`. A flight whose money moved but whose XP did not
 * would leave a base permanently less experienced than its own history, and the
 * drift would be silent and unrecoverable.
 *
 * ## No worker, no XP
 *
 * Settlement is the `FLIGHT_ARRIVE` handler, so this is a worker story like
 * everything around it. On a production world nothing flies, so no XP is ever
 * awarded and every pool reads 0 — which looks like a brand-new airline rather
 * than a missing process, the same trap `docs/crew.md` records for the rest of
 * §9 and §10.
 */

/** The `crew_rank` enum's own values, for narrowing a rank read out of JSON. */
const CREW_RANKS = new Set<string>(crewRank.enumValues);

/** The flight-deck half of that enum — the ranks a Training Captain trains (M9-04). */
const FLIGHT_DECK_RANKS: CrewRankValue[] = crewRank.enumValues.filter((rank) =>
  isFlightDeckRank(rank),
);

export interface FlightXpFacts {
  /** The duty period that operated the flight. Null on a flight with no crew. */
  crewDutyPeriodId: string | null;
  /** Block minutes flown, for a named member's career history (M9-03). */
  blockMinutes: number;
  distanceNm: number;
  maxTakeoffWeightT: number;
  arrivalDifficulty: number | null;
  originDifficulty: number | null;
  arrivalWeather: Weather | null;
  arrivalLocalHour: number | null;
  disruption: XpDisruption;
  crossesContinents: boolean;
  /**
   * The flight's on-blocks instant, **game time** (M9-04). A Training Captain
   * counts towards this flight's multiplier only if their designation took
   * effect at or before it — so a flight that landed before a conversion and
   * was settled after it is not retroactively trained, and a replay of an old
   * arrival re-derives the same multiplier.
   */
  arrivedAt: Date;
}

/**
 * The Training Captain multiplier a flight's flight deck earned under, as
 * recorded on `flight_result.breakdown.crewXp.training` (M9-04).
 */
export interface TrainingXpAward {
  /** Designated Training Captains at the duty period's base, on its family. */
  trainingCaptains: number;
  /** Flight-deck heads there — what their coverage is measured against. */
  flightDeckHeads: number;
  coverage: number;
  multiplier: number;
  capped: boolean;
  /** What each flight-deck head aboard earned, after the multiplier. */
  flightDeckXpPerHead: number;
}

export interface XpAward {
  /** What each head aboard earned, and why. */
  xp: FlightXp;
  /** Heads that earned it — the duty period's complement. */
  heads: number;
  /** `xpPerHead × heads`, the figure the pools moved by in total. */
  totalXp: number;
  /** Per pool, for the audit trail on `flight_result.breakdown`. */
  pools: { rank: string; heads: number; xp: number }[];
  /**
   * The Training Captain multiplier the flight deck earned under (M9-04). Null
   * when the caller passed no Training Captain balance, or no flight-deck rank
   * flew — a training captain trains pilots, and cabin XP is unchanged.
   */
  training: TrainingXpAward | null;
}

/**
 * Compute and record the XP a flight earned its crew.
 *
 * Returns null when there is no crew to award it to — a ferry positioned before
 * the crew model existed, or a flight in a world with no crew base. That is a
 * real state rather than an error: `flight.crew_duty_period_id` is nullable and
 * stays nullable.
 */
export async function awardFlightXp(
  tx: Database,
  facts: FlightXpFacts,
  balance: CrewXpBalance,
  skills?: CrewSkillBalance,
  training?: TrainingCaptainBalance,
): Promise<XpAward | null> {
  if (facts.crewDutyPeriodId === null) return null;

  const [period] = await tx
    .select({
      crewBaseId: crewDutyPeriod.crewBaseId,
      family: crewDutyPeriod.family,
      heads: crewDutyPeriod.heads,
      complement: crewDutyPeriod.complement,
    })
    .from(crewDutyPeriod)
    .where(eq(crewDutyPeriod.id, facts.crewDutyPeriodId))
    .limit(1);
  // The column carries no foreign key, so a period deleted with its base leaves
  // the flight pointing at nothing. Nobody to pay rather than a failure.
  if (!period) return null;

  const slots = parseComplement(period.complement).filter((slot) => slot.count > 0);
  if (slots.length === 0) return null;

  const xp = flightXp(
    {
      distanceNm: facts.distanceNm,
      maxTakeoffWeightT: facts.maxTakeoffWeightT,
      arrivalDifficulty: facts.arrivalDifficulty,
      originDifficulty: facts.originDifficulty,
      arrivalWeather: facts.arrivalWeather,
      arrivalLocalHour: facts.arrivalLocalHour,
      disruption: facts.disruption,
      crossesContinents: facts.crossesContinents,
    },
    balance,
  );
  if (xp.xpPerHead <= 0) return null;

  /*
   * One statement for the whole complement. A day's flying at a large base is
   * several pools per sector, and a round trip per rank would make the arrival
   * handler's cost scale with the size of the crew rather than with the flight.
   *
   * Matched on `(base, family, rank)` — the pool's own unique key — so a rank
   * whose pool has since been emptied and removed simply matches nothing and its
   * share is dropped rather than resurrecting a row.
   */
  /*
   * `crew_duty_period.complement` is JSON, so its ranks arrive as plain strings
   * while `crew_pool.rank` is the `crew_rank` enum. Narrowed against the enum's
   * own values rather than asserted: a rank the schema does not know is a
   * corrupt complement, and dropping it here is better than handing Postgres a
   * value the column cannot hold.
   */
  const ranks = slots
    .map((slot) => slot.rank)
    .filter((rank): rank is CrewRankValue => CREW_RANKS.has(rank));
  if (ranks.length === 0) return null;
  const byRank = new Map(slots.map((slot) => [slot.rank, slot.count] as const));

  /*
   * §10.2's Training Captains: *"multiply XP gain for everyone they fly with"*
   * (M9-04). Read for the duty period's base and family — the pilots a Training
   * Captain is rostered among, which is the finest grain the pool model knows —
   * and applied to the **flight deck only**. A Training Captain trains pilots;
   * the cabin's XP is the formula's, unchanged.
   *
   * Pools and named members alike get the multiplied figure, because a named
   * member is one of the pool's heads and the two must move together.
   */
  const deckRanks = ranks.filter((rank) => isFlightDeckRank(rank));
  const trainingAward =
    training === undefined || deckRanks.length === 0
      ? null
      : await trainingFor(tx, period, facts.arrivedAt, xp.xpPerHead, training);
  // A complement's rank is a JSON string; one the ladder does not know is not
  // the flight deck's, so the cast cannot mistake it for one.
  const xpPerHeadFor = (rank: string): number =>
    trainingAward !== null && isFlightDeckRank(rank as CrewRankValue)
      ? trainingAward.flightDeckXpPerHead
      : xp.xpPerHead;

  const cases = sql.join(
    slots.map(
      (slot) =>
        sql`when ${crewPool.rank} = ${slot.rank} then ${xpPerHeadFor(slot.rank) * slot.count}`,
    ),
    sql` `,
  );

  const updated = await tx
    .update(crewPool)
    .set({ xp: sql`${crewPool.xp} + (case ${cases} else 0 end)`, updatedAt: sql`now()` })
    .where(
      and(
        eq(crewPool.crewBaseId, period.crewBaseId),
        eq(crewPool.family, period.family),
        inArray(crewPool.rank, ranks),
      ),
    )
    .returning({ rank: crewPool.rank });

  const pools = updated.map((row) => ({
    rank: row.rank,
    heads: byRank.get(row.rank) ?? 0,
    xp: xpPerHeadFor(row.rank) * (byRank.get(row.rank) ?? 0),
  }));

  /*
   * And the named individuals drawn from those pools (M9-03, §10.2).
   *
   * After the pools, and in the same transaction: a named member is one of the
   * pool's heads, so their XP and the pool's must move together or a replay
   * would credit one and not the other. `creditNamedCrew` records the
   * approximation the pool model forces — the game does not know *which*
   * individual flew, so every named member of a pool that flew is credited.
   *
   * `skills` is optional only so a caller that has already loaded the economy
   * need not load it twice; omitting it skips the individual credit rather than
   * guessing at a curve.
   *
   * Two calls when a Training Captain multiplier applies — the flight deck at
   * the trained rate, the cabin at the formula's — and each member is credited
   * by exactly one of them, because a member holds exactly one rank.
   */
  if (skills !== undefined) {
    const cabinRanks = ranks.filter((rank) => !isFlightDeckRank(rank));
    const groups =
      trainingAward === null
        ? [{ ranks, xpPerHead: xp.xpPerHead }]
        : [
            { ranks: deckRanks, xpPerHead: trainingAward.flightDeckXpPerHead },
            { ranks: cabinRanks, xpPerHead: xp.xpPerHead },
          ];
    for (const group of groups) {
      await creditNamedCrew(
        tx,
        {
          crewBaseId: period.crewBaseId,
          family: period.family,
          ranks: group.ranks,
          xpPerHead: group.xpPerHead,
          blockMinutes: facts.blockMinutes,
          handledDisruption: facts.disruption !== 'none',
        },
        skills,
      );
    }
  }

  return {
    xp,
    heads: period.heads,
    totalXp: pools.reduce((total, pool) => total + pool.xp, 0),
    pools,
    training: trainingAward,
  };
}

/**
 * The Training Captain multiplier at one base and family, for one arrival
 * (M9-04, §10.2).
 *
 * Two counts and `trainingXpMultiplier`, nothing else — the same function the
 * roster readout applies, so the page and the award cannot disagree:
 *
 *   - **Training Captains**: named members at the base on the family whose
 *     designation took effect at or before `arrivedAt`. Game time on both sides
 *     (ADR-0026), so the award is deterministic for the flight rather than
 *     depending on when the worker got round to settling it.
 *   - **Flight-deck heads**: `crew_pool.headcount` summed over the flight-deck
 *     ranks there. A named member is one of those heads, so a Training Captain
 *     counts once, as one of the pilots they cover.
 *
 * Doctrine is zero here until M9-06 wires research in; `trainingXpMultiplier`
 * already caps the two together.
 */
async function trainingFor(
  tx: Database,
  period: { crewBaseId: string; family: string },
  arrivedAt: Date,
  xpPerHead: number,
  balance: TrainingCaptainBalance,
): Promise<TrainingXpAward> {
  const [captains] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(crewMember)
    .where(
      and(
        eq(crewMember.crewBaseId, period.crewBaseId),
        eq(crewMember.family, period.family),
        isNotNull(crewMember.trainingCaptainSince),
        lte(crewMember.trainingCaptainSince, arrivedAt),
      ),
    );
  const [deck] = await tx
    .select({ heads: sql<number>`coalesce(sum(${crewPool.headcount}), 0)::int` })
    .from(crewPool)
    .where(
      and(
        eq(crewPool.crewBaseId, period.crewBaseId),
        eq(crewPool.family, period.family),
        inArray(crewPool.rank, FLIGHT_DECK_RANKS),
      ),
    );

  // Aggregates come back through the driver's own parser; `Number` normalises
  // at the boundary rather than trusting the `sql<number>` assertion.
  const multiplier = trainingXpMultiplier(
    { trainingCaptains: Number(captains?.count ?? 0), flightDeckHeads: Number(deck?.heads ?? 0) },
    balance,
  );
  return {
    trainingCaptains: Number(captains?.count ?? 0),
    flightDeckHeads: Number(deck?.heads ?? 0),
    coverage: multiplier.coverage,
    multiplier: multiplier.multiplier,
    capped: multiplier.capped,
    flightDeckXpPerHead: trainedXpPerHead(xpPerHead, multiplier),
  };
}

/**
 * Take XP away with the heads that carried it (M9-02).
 *
 * Called when crew **leave** — a resignation, and nothing else so far. Without
 * this a base's XP-per-head would rise every time somebody quit, so an airline
 * treating its crew badly would watch its remaining crew get better as they left,
 * which inverts §9.2's whole delayed bill.
 *
 * Pro rata by headcount, rounded down, because the pool total is all there is:
 * with no individuals there is no way to know whether the leavers were the
 * experienced ones. Rounded **down** so the arithmetic can only ever leave a
 * little XP behind rather than remove more than the pool holds — the check
 * constraint `crew_pool_xp_nonneg` is the backstop, not the plan.
 */
export function xpAfterDeparture(
  currentXp: number,
  headcountBefore: number,
  headsLeaving: number,
): number {
  if (headcountBefore <= 0 || headsLeaving <= 0) return currentXp;
  if (headsLeaving >= headcountBefore) return 0;
  const remaining = headcountBefore - headsLeaving;
  return Math.floor((currentXp * remaining) / headcountBefore);
}
