import { randomUUID } from 'node:crypto';

import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import type { CrewBalance, CrewDemand, CrewResponse } from '@tailfin/shared';
import {
  availableHeads,
  checkComplement,
  fragmentation,
  gameTime,
  requiredComplement,
  type CrewPool,
  type WorldClock,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { aircraftType, airframe, crewBase, crewConversion, crewPool, world } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';
import type { CrewRankValue } from '../db/schema';

/**
 * Crew rows (M5-01, §9.2).
 *
 * `packages/sim` owns what a flight needs and whether a set of pools can field
 * it; this file owns the rows and the money. Four jobs: open a base, hire into a
 * pool, start a conversion, and finish the conversions the world clock has
 * reached.
 *
 * ## Everything here is a count
 *
 * There is no crew member row and nothing here should create one. A hire adds to
 * `headcount`; a conversion moves heads between two pools and parks them in
 * `unavailable` while they are in the classroom. The acceptance criterion is that
 * the player never touches an individual, and the surest way to hold that line is
 * to have no individual to touch.
 *
 * ## Game time, not real time
 *
 * A conversion completes on the **world's** clock, like a maintenance check and
 * unlike an aircraft delivery. Training happens inside the world, so a world at
 * 4× should train twice as fast in real time as one at 2×. §7.2 asks for real
 * weeks on factory deliveries and that is the deliberate exception, not the rule.
 */

export interface CrewClockRow {
  epoch: Date;
  launchDate: Date;
  speedMultiplier: string;
}

function clockOf(row: CrewClockRow): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

async function worldClock(db: Database, worldId: string): Promise<WorldClock> {
  const rows = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Cannot read the crew clock for unknown world ${worldId}`);
  return clockOf(row);
}

/**
 * The crew balance the world is pinned to.
 *
 * `loadWorldEconomyConfig`, not `loadEconomyConfig` — the latter takes a
 * *version* string, and handing it a world id makes it refuse with
 * `UnknownEconomyConfigError` naming the id as though it were a version. CI
 * found that; the shared working tree had another session's non-compiling work
 * in it, so this branch's first real run was on the runner.
 */
/** The catalogue version this world is pinned to (§22.5). */
async function catalogueVersionOf(db: Database, worldId: string): Promise<string> {
  const rows = await db
    .select({ version: world.aircraftCatalogueVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const version = rows[0]?.version;
  if (version === undefined) throw new Error(`No world ${worldId}`);
  return version;
}

async function crewBalance(db: Database, worldId: string): Promise<CrewBalance> {
  return (await loadWorldEconomyConfig(db, worldId)).crew;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CrewBaseView {
  id: string;
  airportIcao: string;
  status: 'open' | 'closed';
  openedAt: Date;
  pools: readonly (CrewPool & { id: string })[];
}

/** Every base an airline holds, with its pools. Empty is the normal new state. */
export async function readCrewBases(
  db: Database,
  airlineId: string,
): Promise<readonly CrewBaseView[]> {
  const bases = await db
    .select({
      id: crewBase.id,
      airportIcao: crewBase.airportIcao,
      status: crewBase.status,
      openedAt: crewBase.openedAt,
    })
    .from(crewBase)
    .where(eq(crewBase.airlineId, airlineId))
    .orderBy(crewBase.airportIcao);

  if (bases.length === 0) return [];

  /*
   * One grouped query and a lookup, rather than a correlated subquery in the
   * select list. CLAUDE.md records a correlated subquery coming back empty
   * against real Postgres for rows that demonstrably had data; this is the shape
   * `countWorldContents` and `listPlayers` use for the same reason.
   */
  const pools = await db
    .select({
      id: crewPool.id,
      crewBaseId: crewPool.crewBaseId,
      family: crewPool.family,
      rank: crewPool.rank,
      headcount: crewPool.headcount,
      unavailable: crewPool.unavailable,
    })
    .from(crewPool)
    .where(
      inArray(
        crewPool.crewBaseId,
        bases.map((base) => base.id),
      ),
    )
    .orderBy(crewPool.family, crewPool.rank);

  const byBase = new Map<string, (CrewPool & { id: string })[]>();
  for (const pool of pools) {
    const list = byBase.get(pool.crewBaseId) ?? [];
    list.push({
      id: pool.id,
      family: pool.family,
      rank: pool.rank,
      headcount: pool.headcount,
      unavailable: pool.unavailable,
    });
    byBase.set(pool.crewBaseId, list);
  }

  return bases.map((base) => ({ ...base, pools: byBase.get(base.id) ?? [] }));
}

/**
 * What the airline's fleet needs, by family and rank.
 *
 * **A floor, not a roster.** For every airframe the airline owns, the legal
 * complement for its seat count on a short sector, summed. One aeroplane flying
 * a day of rotations needs several crews; working out how many is duty and rest,
 * which §9.2 defers and M5-01 does not build. Everything that displays this says
 * so.
 *
 * A short sector deliberately: relief crew depend on block time, and using a
 * long one would inflate the floor with a requirement most flights do not have.
 * The number is "enough to launch what you own", and that is the smallest honest
 * thing it can be.
 */
async function crewDemand(
  db: Database,
  worldId: string,
  airlineId: string,
  pools: readonly CrewPool[],
  balance: CrewBalance,
): Promise<CrewDemand> {
  const frames = await db
    .select({ family: aircraftType.family, effectiveSpec: airframe.effectiveSpec })
    .from(airframe)
    .innerJoin(aircraftType, eq(aircraftType.designation, airframe.typeDesignation))
    .where(and(eq(airframe.worldId, worldId), eq(airframe.airlineId, airlineId)));

  const required = new Map<string, number>();
  const key = (family: string, rank: string) => `${family}\u0000${rank}`;

  for (const frame of frames) {
    const spec = JSON.parse(frame.effectiveSpec) as { seatsTwoClass?: number };
    // A short sector: no relief crew, which is the smallest honest requirement.
    const complement = requiredComplement(
      { seats: spec.seatsTwoClass ?? 0, blockMinutes: 0 },
      balance.regulation,
    );
    for (const slot of [...complement.flightDeck, ...complement.cabin]) {
      const at = key(frame.family, slot.rank);
      required.set(at, (required.get(at) ?? 0) + slot.count);
    }
  }

  const available = new Map<string, number>();
  for (const pool of pools) {
    const at = key(pool.family, pool.rank);
    available.set(at, (available.get(at) ?? 0) + availableHeads(pool));
  }

  const rows = [...new Set([...required.keys(), ...available.keys()])]
    .map((at) => {
      const [family = '', rank = ''] = at.split('\u0000');
      const need = required.get(at) ?? 0;
      const have = available.get(at) ?? 0;
      return { family, rank, required: need, available: have, delta: have - need };
    })
    // Only ranks the fleet actually asks for, or that the airline actually holds.
    .filter((row) => row.required > 0 || row.available > 0)
    .sort((a, b) => a.family.localeCompare(b.family) || a.rank.localeCompare(b.rank));

  const fleetFamilies = new Set(frames.map((frame) => frame.family));
  const crewedFamilies = new Set(
    pools.filter((pool) => availableHeads(pool) > 0).map((p) => p.family),
  );

  return {
    rows: rows as CrewDemand['rows'],
    totalRequired: [...required.values()].reduce((n, value) => n + value, 0),
    metRequired: rows.reduce((n, row) => n + Math.min(row.available, row.required), 0),
    covered: rows.every((row) => row.delta >= 0),
    uncoveredFamilies: [...fleetFamilies].filter((family) => !crewedFamilies.has(family)).sort(),
  };
}

/**
 * Everything the Crew page needs, in one read.
 *
 * The costs travel with the state rather than sitting in a second endpoint,
 * because they come from the world's pinned economy config and a client that
 * cached them would quote yesterday's prices after a retune. They are small, and
 * the page cannot draw a hire button without them.
 */
export async function readCrewState(
  db: Database,
  worldId: string,
  airlineId: string,
): Promise<CrewResponse> {
  const balance = await crewBalance(db, worldId);
  const bases = await readCrewBases(db, airlineId);

  const conversions =
    bases.length === 0
      ? []
      : await db
          .select({
            id: crewConversion.id,
            crewBaseId: crewConversion.crewBaseId,
            fromFamily: crewConversion.fromFamily,
            toFamily: crewConversion.toFamily,
            rank: crewConversion.rank,
            heads: crewConversion.heads,
            startedAt: crewConversion.startedAt,
            completesAt: crewConversion.completesAt,
          })
          .from(crewConversion)
          .where(
            and(
              inArray(
                crewConversion.crewBaseId,
                bases.map((base) => base.id),
              ),
              eq(crewConversion.status, 'in_training'),
            ),
          )
          .orderBy(crewConversion.completesAt);

  const openPools = bases.filter((base) => base.status === 'open').flatMap((base) => base.pools);
  const demand = await crewDemand(db, worldId, airlineId, openPools, balance);

  /*
   * The families this world flies, from its pinned catalogue.
   *
   * Sent so the page can offer a picker instead of a text box. The free-text
   * version let a pool be created rated on a family called `test`, which no
   * aeroplane will ever match and no amount of money can undo.
   */
  const catalogue = await db
    .selectDistinct({ family: aircraftType.family })
    .from(aircraftType)
    .where(eq(aircraftType.catalogueVersion, await catalogueVersionOf(db, worldId)))
    .orderBy(aircraftType.family);

  return {
    bases: bases.map((base) => ({
      id: base.id,
      airportIcao: base.airportIcao,
      status: base.status,
      openedAt: base.openedAt.toISOString(),
      pools: base.pools.map((pool) => ({
        id: pool.id,
        family: pool.family,
        rank: pool.rank,
        headcount: pool.headcount,
        unavailable: pool.unavailable,
        // Computed here rather than left as a subtraction the browser does: the
        // rule for "available" is the server's, and duty and rest will make it
        // more than this.
        available: availableHeads(pool),
      })),
      conversions: conversions
        .filter((conversion) => conversion.crewBaseId === base.id)
        .map((conversion) => ({
          id: conversion.id,
          fromFamily: conversion.fromFamily,
          toFamily: conversion.toFamily,
          rank: conversion.rank,
          heads: conversion.heads,
          startedAt: conversion.startedAt.toISOString(),
          completesAt: conversion.completesAt.toISOString(),
        })),
    })),
    demand,
    families: catalogue.map((row) => row.family),
    fragmentation: (() => {
      // `@tailfin/sim` returns readonly arrays; the wire type is a plain one.
      const report = fragmentation(openPools);
      return { ...report, families: [...report.families] };
    })(),
    costs: {
      baseOpeningMinor: balance.base.openingCostMinor,
      hireFlightDeckMinor: balance.hiringCostMinor.flightDeck,
      hireCabinMinor: balance.hiringCostMinor.cabin,
      conversionPerHeadMinor: balance.conversion.costPerHeadMinor,
      conversionDurationDays: balance.conversion.durationDays,
      weeklyHiringCapacity: balance.base.weeklyHiringCapacity,
    },
  };
}

/** Every pool an airline holds, flattened across bases. */
export async function readAirlinePools(
  db: Database,
  airlineId: string,
): Promise<readonly CrewPool[]> {
  const bases = await readCrewBases(db, airlineId);
  return bases.filter((base) => base.status === 'open').flatMap((base) => base.pools);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Thrown inside a transaction so the cash movement rolls back with it.
 *
 * `moveAirlineCash` does not refuse an overdraft — it records the movement and
 * reports the resulting balance, which is what makes the ledger the single
 * account of what happened. Affordability is therefore the caller's to enforce,
 * and the only way to enforce it *after* writing the movement is to abandon the
 * transaction. Same shape as `aircraft/acquisition.ts`.
 */
class InsufficientFunds extends Error {
  constructor() {
    super('The airline does not have enough cash for this crew operation');
  }
}

export type CrewRefusal =
  | 'base_exists'
  | 'base_absent'
  | 'base_closed'
  | 'insufficient_funds'
  | 'hiring_capacity'
  | 'not_enough_heads'
  | 'same_family';

export type CrewResult<T> = { ok: true; value: T } | { ok: false; refusal: CrewRefusal };

export interface OpenCrewBaseInput {
  worldId: string;
  airlineId: string;
  airportIcao: string;
}

/** Open a base, taking the opening cost in the same transaction (AIR-06). */
export async function openCrewBase(
  db: Database,
  input: OpenCrewBaseInput,
): Promise<CrewResult<{ crewBaseId: string }>> {
  const balance = await crewBalance(db, input.worldId);
  const clock = await worldClock(db, input.worldId);
  const now = gameTime(clock, new Date());

  try {
    return await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: crewBase.id })
        .from(crewBase)
        .where(
          and(eq(crewBase.airlineId, input.airlineId), eq(crewBase.airportIcao, input.airportIcao)),
        )
        .limit(1);
      if (existing[0]) return { ok: false, refusal: 'base_exists' as const };

      const crewBaseId = randomUUID();
      const movement = await moveAirlineCash(tx, {
        airlineId: input.airlineId,
        amountMinor: -balance.base.openingCostMinor,
        cause: 'crew_base_opening',
        reference: crewBaseId,
        occurredAt: now,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      await tx.insert(crewBase).values({
        id: crewBaseId,
        worldId: input.worldId,
        airlineId: input.airlineId,
        airportIcao: input.airportIcao,
        openedAt: now,
      });
      return { ok: true, value: { crewBaseId } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

export interface HireCrewInput {
  worldId: string;
  airlineId: string;
  crewBaseId: string;
  family: string;
  rank: CrewRankValue;
  heads: number;
}

const FLIGHT_DECK_RANKS = new Set<CrewRankValue>([
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
]);

/**
 * Hire heads into one pool.
 *
 * Capped per call by the base's weekly hiring capacity, which is §9.2's *"you
 * cannot buy a Captain instantly"* expressed as the only constraint that money
 * cannot route around. A cost curve would simply be a price a rich airline pays.
 */
export async function hireCrew(
  db: Database,
  input: HireCrewInput,
): Promise<CrewResult<{ headcount: number }>> {
  const balance = await crewBalance(db, input.worldId);
  if (input.heads > balance.base.weeklyHiringCapacity) {
    return { ok: false, refusal: 'hiring_capacity' };
  }

  const clock = await worldClock(db, input.worldId);
  const now = gameTime(clock, new Date());
  const perHead = FLIGHT_DECK_RANKS.has(input.rank)
    ? balance.hiringCostMinor.flightDeck
    : balance.hiringCostMinor.cabin;

  try {
    return await db.transaction(async (tx) => {
      const bases = await tx
        .select({ id: crewBase.id, status: crewBase.status })
        .from(crewBase)
        .where(and(eq(crewBase.id, input.crewBaseId), eq(crewBase.airlineId, input.airlineId)))
        .limit(1);
      const base = bases[0];
      if (!base) return { ok: false, refusal: 'base_absent' as const };
      if (base.status !== 'open') return { ok: false, refusal: 'base_closed' as const };

      const movement = await moveAirlineCash(tx, {
        airlineId: input.airlineId,
        amountMinor: -(perHead * input.heads),
        cause: 'crew_hiring',
        // Unique per hire, so two identical hires are two movements rather than
        // one silently deduplicated by the cause/reference key.
        reference: randomUUID(),
        occurredAt: now,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      const [pool] = await tx
        .insert(crewPool)
        .values({
          crewBaseId: input.crewBaseId,
          family: input.family,
          rank: input.rank,
          headcount: input.heads,
        })
        .onConflictDoUpdate({
          target: [crewPool.crewBaseId, crewPool.family, crewPool.rank],
          set: {
            headcount: sql`${crewPool.headcount} + ${input.heads}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ headcount: crewPool.headcount });

      return { ok: true, value: { headcount: pool?.headcount ?? input.heads } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

export interface StartConversionInput {
  worldId: string;
  airlineId: string;
  crewBaseId: string;
  fromFamily: string;
  toFamily: string;
  rank: CrewRankValue;
  heads: number;
}

/**
 * Convert heads from one family rating to another.
 *
 * The heads stay in their **old** pool and are marked `unavailable` until the
 * course finishes. Moving them immediately would make an airline's crew vanish
 * for a fortnight with nothing to show for it; leaving them visible but grounded
 * is what makes the cost of a mixed fleet legible while it is being paid.
 */
export async function startCrewConversion(
  db: Database,
  input: StartConversionInput,
): Promise<CrewResult<{ conversionId: string; completesAt: Date }>> {
  if (input.fromFamily === input.toFamily) return { ok: false, refusal: 'same_family' };

  const balance = await crewBalance(db, input.worldId);
  const clock = await worldClock(db, input.worldId);
  const now = gameTime(clock, new Date());
  const completesAt = new Date(now.getTime() + balance.conversion.durationDays * 86_400_000);

  try {
    return await db.transaction(async (tx) => {
      const bases = await tx
        .select({ id: crewBase.id, status: crewBase.status })
        .from(crewBase)
        .where(and(eq(crewBase.id, input.crewBaseId), eq(crewBase.airlineId, input.airlineId)))
        .limit(1);
      const base = bases[0];
      if (!base) return { ok: false, refusal: 'base_absent' as const };
      if (base.status !== 'open') return { ok: false, refusal: 'base_closed' as const };

      /*
       * `FOR UPDATE` and a re-read, rather than trusting the count the caller saw.
       * Two conversions started at once from one pool would each pass a check made
       * against the same stale headcount and together strand more crew than exist —
       * which the `unavailable <= headcount` constraint would then refuse at write
       * time with an error nobody can act on.
       */
      const pools = await tx
        .select({
          id: crewPool.id,
          headcount: crewPool.headcount,
          unavailable: crewPool.unavailable,
        })
        .from(crewPool)
        .where(
          and(
            eq(crewPool.crewBaseId, input.crewBaseId),
            eq(crewPool.family, input.fromFamily),
            eq(crewPool.rank, input.rank),
          ),
        )
        .limit(1)
        .for('update');
      const pool = pools[0];
      if (!pool || pool.headcount - pool.unavailable < input.heads) {
        return { ok: false, refusal: 'not_enough_heads' as const };
      }

      const conversionId = randomUUID();
      const movement = await moveAirlineCash(tx, {
        airlineId: input.airlineId,
        amountMinor: -(balance.conversion.costPerHeadMinor * input.heads),
        cause: 'crew_conversion',
        reference: conversionId,
        occurredAt: now,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      await tx
        .update(crewPool)
        .set({ unavailable: sql`${crewPool.unavailable} + ${input.heads}`, updatedAt: sql`now()` })
        .where(eq(crewPool.id, pool.id));

      await tx.insert(crewConversion).values({
        id: conversionId,
        crewBaseId: input.crewBaseId,
        fromFamily: input.fromFamily,
        toFamily: input.toFamily,
        rank: input.rank,
        heads: input.heads,
        startedAt: now,
        completesAt,
      });

      return { ok: true, value: { conversionId, completesAt } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

/**
 * Finish every conversion the world's clock has reached.
 *
 * The worker's sweep, on the same footing as a maintenance check completing. It
 * is idempotent by the `in_training` filter and the row-level update, so a
 * re-run or a second worker completes nothing twice.
 */
export async function completeDueConversions(
  db: Database,
  worldId: string,
  now: Date,
): Promise<{ completed: number }> {
  const due = await db
    .select({
      id: crewConversion.id,
      crewBaseId: crewConversion.crewBaseId,
      fromFamily: crewConversion.fromFamily,
      toFamily: crewConversion.toFamily,
      rank: crewConversion.rank,
      heads: crewConversion.heads,
    })
    .from(crewConversion)
    .innerJoin(crewBase, eq(crewBase.id, crewConversion.crewBaseId))
    .where(
      and(
        eq(crewBase.worldId, worldId),
        eq(crewConversion.status, 'in_training'),
        lte(crewConversion.completesAt, now),
      ),
    );

  let completed = 0;
  for (const conversion of due) {
    await db.transaction(async (tx) => {
      // Claim first. If another worker got here, this updates nothing and the
      // rest of the transaction is skipped rather than double-applied.
      const claimed = await tx
        .update(crewConversion)
        .set({ status: 'completed', completedAt: now })
        .where(and(eq(crewConversion.id, conversion.id), eq(crewConversion.status, 'in_training')))
        .returning({ id: crewConversion.id });
      if (!claimed[0]) return;

      // Out of the old pool entirely: they are no longer rated on it.
      await tx
        .update(crewPool)
        .set({
          headcount: sql`${crewPool.headcount} - ${conversion.heads}`,
          unavailable: sql`${crewPool.unavailable} - ${conversion.heads}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(crewPool.crewBaseId, conversion.crewBaseId),
            eq(crewPool.family, conversion.fromFamily),
            eq(crewPool.rank, conversion.rank),
          ),
        );

      await tx
        .insert(crewPool)
        .values({
          crewBaseId: conversion.crewBaseId,
          family: conversion.toFamily,
          rank: conversion.rank,
          headcount: conversion.heads,
        })
        .onConflictDoUpdate({
          target: [crewPool.crewBaseId, crewPool.family, crewPool.rank],
          set: {
            headcount: sql`${crewPool.headcount} + ${conversion.heads}`,
            updatedAt: sql`now()`,
          },
        });

      completed += 1;
    });
  }

  return { completed };
}

// ---------------------------------------------------------------------------
// The scheduling seam
// ---------------------------------------------------------------------------

/**
 * Whether an airline's crew can legally fly a leg on a given family.
 *
 * This is what fills `RotationContext.crewLegal`, the input `validateRotation`
 * has carried since M2-07 waiting for M5. It is deliberately a **whole-airline**
 * question rather than a per-base one: M5-01 has no positioning model, so asking
 * which base the crew are at would be inventing an answer §9.2 explicitly defers.
 */
export async function crewCanFly(
  db: Database,
  airlineId: string,
  family: string,
  leg: { seats: number; blockMinutes: number },
  regulation?: CrewBalance['regulation'],
): Promise<boolean> {
  const pools = await readAirlinePools(db, airlineId);
  return checkComplement(leg, pools, family, regulation).ok;
}
