import { and, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';

import type { CrewDutyBalance } from '@tailfin/shared';
import { restRequiredMinutes, type DutyHistoryEntry } from '@tailfin/sim';

import { airport, crewBase, crewDutyPeriod, crewPool } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { chargePositioning } from './payroll';

import type { Database } from '../db/client';

/**
 * Duty periods as rows: opening, extending, resting, closing (M5-02, §9.2).
 *
 * The pure rules live in `@tailfin/sim`'s `crew/duty.ts` and know nothing about
 * a database. This is the other half — the bookkeeping that makes a duty period
 * a thing the world remembers between two departures, and the thing that keeps
 * `crew_pool.on_duty` honest.
 *
 * ## The one invariant worth stating
 *
 * **Heads taken from a pool are returned to the same pool.** A duty period
 * records the base, the family and the head count it drew, and rest returns
 * exactly that. Anything that debits `on_duty` without a duty period to explain
 * it, or credits it back to a different pool, produces crew that exist in the
 * arithmetic and nowhere else — and the check constraint will eventually catch
 * it, in a transaction that has nothing to do with the bug.
 *
 * ## Why the pool is charged by rank in proportion, not exactly
 *
 * A complement is *"two captains, one purser, three cabin crew"*; a pool is
 * heads at one rank. Committing the complement exactly would mean resolving
 * which rank filled which slot — the greedy fill `checkComplement` already does,
 * repeated and persisted. It is done that way: {@link commitComplement} walks
 * the same juniormost-first order, so the pool that was *counted* as covering a
 * slot is the pool that is *charged* for it. Two different answers to that
 * question would let an airline dispatch a flight its pools cannot actually
 * staff.
 */

/** One rank and how many heads of it a duty period holds. */
export interface CommittedSlot {
  rank: string;
  count: number;
}

export interface OpenDutyPeriod {
  id: string;
  worldId: string;
  airlineId: string;
  airframeId: string;
  crewBaseId: string;
  family: string;
  heads: number;
  complement: readonly CommittedSlot[];
  fromReserve: boolean;
  reportAt: Date;
  sectors: number;
  blockMinutes: number;
  locationIcao: string;
}

/**
 * Read a stored complement back.
 *
 * Total: a row written before this column existed holds `[]`, and an empty
 * complement releases nothing — which is the right answer for a period that
 * never took anything. Anything unparseable is treated the same way rather than
 * throwing, because a malformed row must not be able to wedge the tick that
 * would otherwise return every *other* crew set from rest.
 */
export function parseComplement(json: string): CommittedSlot[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { rank, count } = entry as { rank?: unknown; count?: unknown };
      if (typeof rank !== 'string' || typeof count !== 'number') return [];
      return [{ rank, count }];
    });
  } catch {
    return [];
  }
}

/** The open duty period for this airframe, if a crew set is still working it. */
export async function openPeriodFor(
  db: Database,
  airframeId: string,
): Promise<OpenDutyPeriod | null> {
  const rows = await db
    .select({
      id: crewDutyPeriod.id,
      worldId: crewDutyPeriod.worldId,
      airlineId: crewDutyPeriod.airlineId,
      airframeId: crewDutyPeriod.airframeId,
      crewBaseId: crewDutyPeriod.crewBaseId,
      family: crewDutyPeriod.family,
      heads: crewDutyPeriod.heads,
      complement: crewDutyPeriod.complement,
      fromReserve: crewDutyPeriod.fromReserve,
      reportAt: crewDutyPeriod.reportAt,
      sectors: crewDutyPeriod.sectors,
      blockMinutes: crewDutyPeriod.blockMinutes,
      locationIcao: crewDutyPeriod.locationIcao,
    })
    .from(crewDutyPeriod)
    .where(and(eq(crewDutyPeriod.airframeId, airframeId), eq(crewDutyPeriod.status, 'open')))
    .limit(1);

  const row = rows[0];
  return row ? { ...row, complement: parseComplement(row.complement) } : null;
}

export interface CrewBaseLocation {
  id: string;
  airportIcao: string;
  /** Standard-time offset in minutes, or `null` where the airport data has none. */
  utcOffsetMinutes: number | null;
}

/** The airline's open crew bases, with enough of the airport to evaluate the WOCL. */
export async function readBaseLocations(
  db: Database,
  airlineId: string,
): Promise<CrewBaseLocation[]> {
  return db
    .select({
      id: crewBase.id,
      airportIcao: crewBase.airportIcao,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(crewBase)
    .innerJoin(airport, eq(airport.icaoCode, crewBase.airportIcao))
    .where(and(eq(crewBase.airlineId, airlineId), eq(crewBase.status, 'open')));
}

/**
 * Completed duty periods inside the rolling windows, for one crew base.
 *
 * Scoped to the base rather than the airline because the cumulative limits
 * belong to *crew*, and crew belong to a base. An airline-wide sum would let a
 * second base's quiet fortnight pay for this one's heavy one, which is the
 * opposite of what ORO.FTL.210 is for.
 *
 * Twenty-eight days is the longest window there is, so nothing older is read.
 */
export async function dutyHistoryFor(
  db: Database,
  crewBaseId: string,
  family: string,
  at: Date,
): Promise<DutyHistoryEntry[]> {
  const since = new Date(at.getTime() - 28 * 86_400_000);
  const rows = await db
    .select({
      offDutyAt: crewDutyPeriod.offDutyAt,
      dutyMinutes: sql<number>`extract(epoch from (${crewDutyPeriod.offDutyAt} - ${crewDutyPeriod.reportAt})) / 60`,
      blockMinutes: crewDutyPeriod.blockMinutes,
    })
    .from(crewDutyPeriod)
    .where(
      and(
        eq(crewDutyPeriod.crewBaseId, crewBaseId),
        eq(crewDutyPeriod.family, family),
        isNotNull(crewDutyPeriod.offDutyAt),
        gte(crewDutyPeriod.offDutyAt, since),
        lte(crewDutyPeriod.offDutyAt, at),
      ),
    );

  return rows.flatMap((row) =>
    row.offDutyAt === null
      ? []
      : [
          {
            offDutyAt: row.offDutyAt,
            // `sql<number>` is an assertion, not a conversion: raw arithmetic
            // comes back as a string from the driver however it is typed.
            dutyMinutes: Number(row.dutyMinutes),
            blockMinutes: row.blockMinutes,
          },
        ],
  );
}

export interface CommitInput {
  crewBaseId: string;
  family: string;
  /** Rank and count, already resolved by the greedy fill. */
  slots: readonly CommittedSlot[];
  /** Take the heads from the standby designation rather than the line pool. */
  fromReserve: boolean;
}

/**
 * Move heads from available to on duty, rank by rank.
 *
 * Returns `false` without writing anything if any rank cannot supply what the
 * complement asked for. The caller has usually already checked with
 * `checkComplement`; this is the check that holds under concurrency, because it
 * is the one inside the transaction that also writes the duty period.
 */
export async function commitComplement(db: Database, input: CommitInput): Promise<boolean> {
  for (const slot of input.slots) {
    const available = input.fromReserve
      ? sql`least(${crewPool.reserve}, ${crewPool.headcount} - ${crewPool.unavailable} - ${crewPool.onDuty})`
      : sql`${crewPool.headcount} - ${crewPool.unavailable} - ${crewPool.onDuty}`;

    const updated = await db
      .update(crewPool)
      .set({ onDuty: sql`${crewPool.onDuty} + ${slot.count}`, updatedAt: new Date() })
      .where(
        and(
          eq(crewPool.crewBaseId, input.crewBaseId),
          eq(crewPool.family, input.family),
          eq(crewPool.rank, slot.rank as never),
          sql`${available} >= ${slot.count}`,
        ),
      )
      .returning({ id: crewPool.id });

    /*
     * Throwing rather than returning would be tidier to read and wrong to use:
     * the caller is inside a transaction it may want to finish differently — a
     * dispatch that cannot staff a flight delays it rather than failing the
     * tick. Returning false leaves that decision where it belongs.
     */
    if (updated.length === 0) return false;
  }
  return true;
}

/** Give the heads back. The exact inverse of {@link commitComplement}. */
export async function releaseComplement(
  db: Database,
  input: { crewBaseId: string; family: string; slots: readonly CommittedSlot[] },
): Promise<void> {
  for (const slot of input.slots) {
    await db
      .update(crewPool)
      .set({
        // `greatest(0, …)` so a double release cannot drive the column negative
        // and trip a check constraint in a transaction doing something else.
        onDuty: sql`greatest(0, ${crewPool.onDuty} - ${slot.count})`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(crewPool.crewBaseId, input.crewBaseId),
          eq(crewPool.family, input.family),
          eq(crewPool.rank, slot.rank as never),
        ),
      );
  }
}

export interface StartDutyInput {
  worldId: string;
  airlineId: string;
  airframeId: string;
  crewBaseId: string;
  family: string;
  complement: readonly CommittedSlot[];
  fromReserve: boolean;
  reportAt: Date;
  locationIcao: string;
}

/** Open a duty period. The complement must already be committed. */
export async function startDutyPeriod(db: Database, input: StartDutyInput): Promise<string> {
  const heads = input.complement.reduce((total, slot) => total + slot.count, 0);
  const [created] = await db
    .insert(crewDutyPeriod)
    .values({
      worldId: input.worldId,
      airlineId: input.airlineId,
      airframeId: input.airframeId,
      crewBaseId: input.crewBaseId,
      family: input.family,
      heads,
      complement: JSON.stringify(input.complement),
      fromReserve: input.fromReserve,
      reportAt: input.reportAt,
      locationIcao: input.locationIcao,
    })
    .returning({ id: crewDutyPeriod.id });
  if (!created) throw new Error('Duty period was not created');
  return created.id;
}

/** Record a sector flown: one more sector, more block time, a new location. */
export async function recordSector(
  db: Database,
  periodId: string,
  sector: { blockMinutes: number; arrivedAtIcao: string; arrivesAt: Date; deadhead?: boolean },
): Promise<void> {
  await db
    .update(crewDutyPeriod)
    .set({
      sectors:
        sector.deadhead === true
          ? sql`${crewDutyPeriod.sectors}`
          : sql`${crewDutyPeriod.sectors} + 1`,
      blockMinutes:
        sector.deadhead === true
          ? sql`${crewDutyPeriod.blockMinutes}`
          : sql`${crewDutyPeriod.blockMinutes} + ${Math.round(sector.blockMinutes)}`,
      locationIcao: sector.arrivedAtIcao,
      lastArrivalAt: sector.arrivesAt,
      updatedAt: new Date(),
    })
    .where(eq(crewDutyPeriod.id, periodId));
}

/**
 * Send a crew set off duty, and work out when they are available again.
 *
 * The heads stay in `on_duty` through the rest — they are not rosterable, and
 * the whole reason `on_duty` is separate from `unavailable` is so the Crew page
 * can say *"resting until 06:00"* rather than *"unavailable"*. They come back
 * in {@link returnRestedCrew}, which the worker runs.
 */
export async function endDutyPeriod(
  db: Database,
  periodId: string,
  offDutyAt: Date,
  atBase: boolean,
  duty: CrewDutyBalance,
): Promise<{ restUntil: Date }> {
  const rows = await db
    .select({ reportAt: crewDutyPeriod.reportAt })
    .from(crewDutyPeriod)
    .where(eq(crewDutyPeriod.id, periodId))
    .limit(1);
  const reportAt = rows[0]?.reportAt;
  if (!reportAt) throw new Error(`No duty period ${periodId}`);

  const dutyMinutes = (offDutyAt.getTime() - reportAt.getTime()) / 60_000;
  const restUntil = new Date(
    offDutyAt.getTime() + restRequiredMinutes(dutyMinutes, atBase, duty) * 60_000,
  );

  await db
    .update(crewDutyPeriod)
    .set({ status: 'resting', offDutyAt, restUntil, updatedAt: new Date() })
    .where(eq(crewDutyPeriod.id, periodId));

  return { restUntil };
}

/**
 * Send home the crew sets that have finished for the day (M5-02).
 *
 * A duty period stays open between sectors, because a 45-minute turnaround is
 * not a rest and the crew are still on duty through it. So something has to
 * decide when the day is over, and the honest signal is that **nothing was
 * dispatched before the crew could have gone home**: once more than an off-duty
 * tail plus a fresh report has passed since the last landing, no further sector
 * could have used this set anyway.
 *
 * Without this the pools would leak. Heads move to `on_duty` at the first
 * departure and only come back through rest, so a crew set that simply stopped
 * flying would hold its heads for ever and the airline would slowly run out of
 * people it demonstrably still employs.
 *
 * Scoped to one world, and called once per world per tick. Game time is a
 * per-world quantity - a world at 4x and one at 2x disagree about what "an hour
 * ago" means - so a sweep that read every world's rows against one clock would
 * be wrong in both of them.
 *
 * The worker's job, and it carries the standard warning: **production has no
 * worker**, so there a fleet would fly one duty period and stop.
 */
export async function standDownIdleCrew(
  db: Database,
  worldId: string,
  now: Date,
): Promise<{ stoodDown: number; hotelledMinor: number }> {
  const economy = await loadWorldEconomyConfig(db, worldId);
  const duty = economy.crew.duty;
  const idleAfterMs =
    (duty.offDutyAfterArrivalMinutes + duty.reportBeforeDepartureMinutes) * 60_000;

  const candidates = await db
    .select({
      id: crewDutyPeriod.id,
      airlineId: crewDutyPeriod.airlineId,
      heads: crewDutyPeriod.heads,
      locationIcao: crewDutyPeriod.locationIcao,
      lastArrivalAt: crewDutyPeriod.lastArrivalAt,
      baseIcao: crewBase.airportIcao,
      hotelTier: crewBase.hotelTier,
    })
    .from(crewDutyPeriod)
    .innerJoin(crewBase, eq(crewBase.id, crewDutyPeriod.crewBaseId))
    .where(
      and(
        eq(crewDutyPeriod.worldId, worldId),
        eq(crewDutyPeriod.status, 'open'),
        isNotNull(crewDutyPeriod.lastArrivalAt),
        lte(crewDutyPeriod.lastArrivalAt, new Date(now.getTime() - idleAfterMs)),
      ),
    )
    .limit(200);

  let stoodDown = 0;
  let hotelledMinor = 0;
  for (const period of candidates) {
    const offDutyAt = new Date(
      (period.lastArrivalAt ?? now).getTime() + duty.offDutyAfterArrivalMinutes * 60_000,
    );
    const atBase = period.locationIcao === period.baseIcao;

    /*
     * One transaction per period. `airline_cash_reconciles` is a DEFERRABLE
     * constraint trigger, so the hotel movement and the balance it implies have
     * to commit together -- outside a transaction the insert lands first and the
     * trigger fires on a state that exists only between two statements. CI found
     * this; the first version charged with the bare handle.
     *
     * Per period rather than per batch, so one airline's problem cannot roll
     * back everybody else's stand-down.
     */
    await db.transaction(async (tx) => {
      const ended = await endDutyPeriod(tx, period.id, offDutyAt, atBase, duty);

      /*
       * The bill section 9.2 names: *"an aircraft night-stopping away from base
       * needs crew hotelling"*. Charged when the set stops, not when it flies,
       * because until it stops nobody knows whether it is going home.
       *
       * Nights are counted from the rest the duty earned, which is the span the
       * crew are actually somewhere - a ten-hour minimum rest is one night, and a
       * set left away over a slow weekend is more.
       */
      if (!atBase) {
        hotelledMinor += await chargePositioning(tx, {
          airlineId: period.airlineId,
          dutyPeriodId: period.id,
          heads: period.heads,
          nights: Math.max(
            1,
            Math.ceil((ended.restUntil.getTime() - offDutyAt.getTime()) / 86_400_000),
          ),
          occurredAt: offDutyAt,
          duty,
          // The tier the player chose for this base, not a flat rate.
          hotelCostMultiplier: economy.crew.morale.hotelTiers[period.hotelTier].costMultiplier,
        });
      }
    });
    stoodDown += 1;
  }
  return { stoodDown, hotelledMinor };
}

/**
 * Return crew whose rest has finished (M5-02) — the worker's job.
 *
 * The same story as conversions, deliveries, checks and the used market, and it
 * carries the same warning: **production has no worker**, so on a production
 * world a crew set that went off duty would rest for ever. Every aeroplane would
 * fly exactly one duty period and then stop, and the Crew page would show a
 * fleet's worth of crew permanently resting. `crewRested` is the counter that
 * tells that apart from an airline that simply is not flying.
 *
 * One transaction per period rather than one for the batch: a set whose pools
 * have since been deleted must not take the rest of the world's crew down with
 * it. Returns the number closed.
 *
 * Scoped to one world, for the reason {@link standDownIdleCrew} is.
 */
export async function returnRestedCrew(
  db: Database,
  worldId: string,
  now: Date,
  limit = 200,
): Promise<{ returned: number }> {
  const due = await db
    .select({
      id: crewDutyPeriod.id,
      crewBaseId: crewDutyPeriod.crewBaseId,
      family: crewDutyPeriod.family,
      complement: crewDutyPeriod.complement,
    })
    .from(crewDutyPeriod)
    .where(
      and(
        eq(crewDutyPeriod.worldId, worldId),
        eq(crewDutyPeriod.status, 'resting'),
        isNotNull(crewDutyPeriod.restUntil),
        lte(crewDutyPeriod.restUntil, now),
      ),
    )
    .limit(limit);

  let returned = 0;
  for (const period of due) {
    await db.transaction(async (tx) => {
      /*
       * Claim first. `status = 'resting'` in the WHERE is the whole concurrency
       * story: two workers racing produce one winner and one no-op, and the
       * loser credits nothing back. Without it a handover would return the same
       * heads twice and quietly inflate the pool.
       */
      const claimed = await tx
        .update(crewDutyPeriod)
        .set({ status: 'closed', updatedAt: now })
        .where(and(eq(crewDutyPeriod.id, period.id), eq(crewDutyPeriod.status, 'resting')))
        .returning({ id: crewDutyPeriod.id });
      if (claimed.length === 0) return;

      await releaseComplement(tx, {
        crewBaseId: period.crewBaseId,
        family: period.family,
        slots: parseComplement(period.complement),
      });
      returned += 1;
    });
  }

  return { returned };
}
