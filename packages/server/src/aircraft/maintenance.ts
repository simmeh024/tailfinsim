import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';

import {
  type MaintenanceProfile,
  type MaintenanceResponse,
  type MaintenanceAirframeView,
} from '@tailfin/shared';
import {
  accrueFlight,
  type CheckTier,
  CHECK_TIERS,
  checkTerms,
  completeCheck,
  gameTime,
  maintenanceStatus,
  type MaintenanceState,
  NEW_AIRFRAME_STATE,
  type WorldClock,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { type Database } from '../db/client';
import { airframe, world, type AirframeRow } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import { loadCatalogueVersion } from './catalogue';

/**
 * Maintenance (M4-06, §7.3).
 *
 * `packages/sim` owns what is due and what deferring it costs in reliability;
 * this file owns the rows. Three jobs:
 *
 *   1. **accrue** hours and cycles when a flight settles;
 *   2. **book** a check, taking the money and putting the aeroplane out of
 *      service for the tier's downtime;
 *   3. **finish** a check when the world clock reaches its completion, which is
 *      the worker's sweep.
 *
 * ## Reading a null history
 *
 * `airframe.maintenance_state` is nullable, and how a null is read is the most
 * consequential decision in this file. It means *"every tier was last completed
 * at the hours this airframe has now"*, not *"last completed at hour zero"*.
 *
 * The alternative is not merely wrong, it is destructive: every airframe
 * delivered before this migration would read as tens of thousands of hours
 * overdue, and the first worker tick after the deploy would ground a live fleet
 * for maintenance nobody had deferred. A fleet is not punished for a schema
 * change.
 */

const HOURS_PER_DAY = 24;

function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/**
 * The stored history, or a fresh one anchored at the airframe's current totals.
 *
 * See the module note: a null is *"nothing is overdue"*, deliberately.
 */
export function stateOf(
  row: Pick<AirframeRow, 'hours' | 'cycles' | 'maintenanceState'>,
): MaintenanceState {
  if (row.maintenanceState === null) {
    return {
      ...NEW_AIRFRAME_STATE,
      totalHours: row.hours,
      totalCycles: row.cycles,
      hoursAtLastCheck: { a: row.hours, c: row.hours, d: row.hours },
      cyclesAtLastCheck: { a: row.cycles, c: row.cycles, d: row.cycles },
    };
  }

  const parsed = JSON.parse(row.maintenanceState) as MaintenanceState;
  // The totals live in their own columns and those are authoritative — the blob
  // carries them too so it round-trips as one value, but a disagreement means the
  // columns won. Accrual writes both, so they only diverge if something else
  // updated the columns, and then the columns are the newer fact.
  return { ...parsed, totalHours: row.hours, totalCycles: row.cycles };
}

function isCheckTier(value: string | null): value is CheckTier {
  return value !== null && (CHECK_TIERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/**
 * Add one settled flight to its airframe's totals.
 *
 * Called inside the settlement transaction, so an arrival either prices *and*
 * accrues or does neither. A flight whose money moved but whose hours did not
 * would make a fleet permanently younger than its own history, and the drift
 * would be invisible and unrecoverable.
 *
 * `blockHours` comes from the settlement's own block time rather than being
 * recomputed here — one number for one fact (invariant 4).
 */
export async function accrueFlightHours(
  tx: Database,
  airframeId: string,
  blockHours: number,
): Promise<void> {
  const rows = await tx
    .select({
      hours: airframe.hours,
      cycles: airframe.cycles,
      maintenanceState: airframe.maintenanceState,
    })
    .from(airframe)
    .where(eq(airframe.id, airframeId))
    .limit(1);

  const row = rows[0];
  // No row is not an error here. `flight.airframe_id` has no foreign key until
  // the M4/HIST boundary (#508), and M2's own tests fly placeholder ids — so a
  // missing airframe means "nothing to accrue against", not "the arrival failed".
  if (!row) return;

  const next = accrueFlight(stateOf(row), blockHours);
  await tx
    .update(airframe)
    .set({
      hours: next.totalHours,
      cycles: next.totalCycles,
      maintenanceState: JSON.stringify(next),
    })
    .where(eq(airframe.id, airframeId));
}

// ---------------------------------------------------------------------------
// Booking a check
// ---------------------------------------------------------------------------

export type CheckBookingRefusal =
  | { kind: 'airframe-not-found' }
  | { kind: 'not-owned' }
  | { kind: 'already-in-check'; completesAt: Date }
  | { kind: 'insufficient-funds'; requiredMinor: number; availableMinor: number };

export type CheckBookingResult =
  | { ok: true; tier: CheckTier; costMinor: number; completesAt: Date }
  | ({ ok: false } & CheckBookingRefusal);

/** Thrown to roll the booking transaction back; never escapes `bookCheck`. */
class NotEnoughCash extends Error {
  constructor(
    readonly requiredMinor: number,
    readonly availableMinor: number,
  ) {
    super('The airline does not have enough cash for this maintenance check');
  }
}

/**
 * Put an aeroplane into a check.
 *
 * Money and downtime in one transaction, like every other commitment: the cash
 * movement, the status change and the completion time commit together, so a check
 * that was paid for is always a check that is running.
 *
 * **A grounded airframe may be booked in.** That is the point of grounding — it is
 * a state you clear by doing the work, not a dead end. Refusing the booking would
 * leave the player with an aeroplane they could neither fly nor fix.
 */
export async function bookCheck(
  db: Database,
  own: { id: string; worldId: string },
  airframeId: string,
  tier: CheckTier,
  now: Date = new Date(),
): Promise<CheckBookingResult> {
  try {
    return await bookCheckInTransaction(db, own, airframeId, tier, now);
  } catch (error) {
    if (error instanceof NotEnoughCash) {
      return {
        ok: false,
        kind: 'insufficient-funds',
        requiredMinor: error.requiredMinor,
        availableMinor: error.availableMinor,
      };
    }
    throw error;
  }
}

async function bookCheckInTransaction(
  db: Database,
  own: { id: string; worldId: string },
  airframeId: string,
  tier: CheckTier,
  now: Date,
): Promise<CheckBookingResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(airframe)
      .where(eq(airframe.id, airframeId))
      .limit(1)
      .for('update');

    const row = rows[0];
    if (!row) return { ok: false, kind: 'airframe-not-found' } as const;
    // Ownership is resolved from the session's airline, never accepted from the
    // client — the same boundary the rest of the fleet API uses (ADR-0010).
    if (row.airlineId !== own.id || row.worldId !== own.worldId) {
      return { ok: false, kind: 'not-owned' } as const;
    }
    if (row.status === 'in_check' && row.checkCompletesAt !== null) {
      return { ok: false, kind: 'already-in-check', completesAt: row.checkCompletesAt } as const;
    }

    const worlds = await tx
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
        catalogueVersion: world.aircraftCatalogueVersion,
        economyConfigVersion: world.economyConfigVersion,
      })
      .from(world)
      .where(eq(world.id, own.worldId))
      .limit(1);
    const worldRow = worlds[0];
    if (!worldRow) return { ok: false, kind: 'airframe-not-found' } as const;

    const [economy, catalogue] = await Promise.all([
      loadEconomyConfig(tx, worldRow.economyConfigVersion),
      loadCatalogueVersion(tx, row.catalogueVersion),
    ]);
    const type = catalogue.types.get(row.typeDesignation);
    if (!type) return { ok: false, kind: 'airframe-not-found' } as const;

    const terms = checkTerms(tier, type.maintenanceProfile, economy.maintenance);
    const gameNow = gameTime(clockOf(worldRow), now);
    // Downtime is game days, not real days. A check is an operational span in the
    // world's own calendar, unlike factory lead time, which §7.2 fixes in real
    // weeks. Two time domains, deliberately, exactly as M4-04 documents.
    const completesAt = new Date(
      gameNow.getTime() + terms.downtimeDays * HOURS_PER_DAY * 3_600_000,
    );

    const movement = await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: -terms.costMinor,
      cause: 'maintenance_check',
      // `cause + reference` is a movement's identity, so the reference has to be
      // unique per booking. The airframe, tier and game instant together are:
      // the same aeroplane cannot start the same tier twice at the same moment,
      // and a retry within the same instant is the replay this makes safe.
      reference: `maintenance:${airframeId}:${tier}:${String(gameNow.getTime())}`,
      occurredAt: gameNow,
    });
    // The same overdraft shape `acquireAircraft` uses: the movement is made and
    // then rolled back by throwing, rather than the balance being read first.
    // Reading first would be a check against a number another transaction can
    // change between the read and the write.
    if (movement.movement.balanceAfterMinor < 0) {
      throw new NotEnoughCash(
        terms.costMinor,
        movement.movement.balanceAfterMinor + terms.costMinor,
      );
    }

    await tx
      .update(airframe)
      .set({ status: 'in_check', checkTier: tier, checkCompletesAt: completesAt })
      .where(eq(airframe.id, airframeId));

    return { ok: true, tier, costMinor: terms.costMinor, completesAt } as const;
  });
}

// ---------------------------------------------------------------------------
// The sweeps the worker runs
// ---------------------------------------------------------------------------

export interface MaintenanceSweepResult {
  worldId: string;
  /** Checks that finished on this tick. */
  completed: number;
  /** Airframes grounded for flying too far past a check. */
  grounded: number;
  /** Airframes released from grounding because their check finished. */
  released: number;
}

/**
 * Finish due checks and ground the neglected, once per world per tick.
 *
 * Both halves are idempotent by their `where` clause rather than by a lock: a
 * check is completed only from `in_check` with a past completion time, and the
 * update clears both, so a second call finds nothing. Grounding sets a status
 * that is already `grounded` on a second pass.
 */
export async function sweepMaintenance(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<MaintenanceSweepResult> {
  const empty: MaintenanceSweepResult = { worldId, completed: 0, grounded: 0, released: 0 };

  const worlds = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
      economyConfigVersion: world.economyConfigVersion,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const worldRow = worlds[0];
  if (!worldRow) return empty;

  const gameNow = gameTime(clockOf(worldRow), now);
  const economy = await loadEconomyConfig(db, worldRow.economyConfigVersion);

  // --- finish what is due -------------------------------------------------
  const due = await db
    .select()
    .from(airframe)
    .where(
      and(
        eq(airframe.worldId, worldId),
        eq(airframe.status, 'in_check'),
        isNotNull(airframe.checkCompletesAt),
        lte(airframe.checkCompletesAt, gameNow),
      ),
    )
    .orderBy(asc(airframe.checkCompletesAt));

  let completed = 0;
  let released = 0;
  for (const row of due) {
    if (!isCheckTier(row.checkTier)) continue;
    const next = completeCheck(stateOf(row), row.checkTier);
    const updated = await db
      .update(airframe)
      .set({
        status: 'in_service',
        checkTier: null,
        checkCompletesAt: null,
        maintenanceState: JSON.stringify(next),
      })
      // Re-asserted in the WHERE rather than trusted from the SELECT, so two
      // workers racing cannot both complete the same check.
      .where(and(eq(airframe.id, row.id), eq(airframe.status, 'in_check')))
      .returning({ id: airframe.id });
    if (updated.length > 0) {
      completed += 1;
      released += 1;
    }
  }

  // --- ground what has been flown too far ---------------------------------
  const flying = await db
    .select()
    .from(airframe)
    .where(and(eq(airframe.worldId, worldId), eq(airframe.status, 'in_service')));

  let grounded = 0;
  if (flying.length > 0) {
    const catalogues = new Map<string, Awaited<ReturnType<typeof loadCatalogueVersion>>>();
    for (const row of flying) {
      let catalogue = catalogues.get(row.catalogueVersion);
      if (catalogue === undefined) {
        catalogue = await loadCatalogueVersion(db, row.catalogueVersion);
        catalogues.set(row.catalogueVersion, catalogue);
      }
      const type = catalogue.types.get(row.typeDesignation);
      if (!type) continue;

      const status = maintenanceStatus(stateOf(row), type.maintenanceProfile, economy.maintenance);
      if (status.airworthiness.airworthy) continue;

      const updated = await db
        .update(airframe)
        .set({ status: 'grounded' })
        .where(and(eq(airframe.id, row.id), eq(airframe.status, 'in_service')))
        .returning({ id: airframe.id });
      grounded += updated.length;
    }
  }

  return { worldId, completed, grounded, released };
}

// ---------------------------------------------------------------------------
// What the player plans around
// ---------------------------------------------------------------------------

/**
 * The fleet's maintenance position, soonest due first.
 *
 * M4-06's second acceptance criterion is that *"scheduled checks appear on a
 * due-timeline the player can plan around"*, and "plan around" is why this sorts
 * by what is closest rather than by registration: the aeroplane about to need a
 * C-check is the decision, and the rest is inventory.
 */
export async function fleetMaintenance(
  db: Database,
  own: { id: string; worldId: string },
): Promise<MaintenanceResponse> {
  const worlds = await db
    .select({ economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, own.worldId))
    .limit(1);
  const worldRow = worlds[0];
  if (!worldRow) throw new Error(`No world ${own.worldId}`);

  const economy = await loadEconomyConfig(db, worldRow.economyConfigVersion);
  const rows = await db
    .select()
    .from(airframe)
    .where(and(eq(airframe.worldId, own.worldId), eq(airframe.airlineId, own.id)));

  const catalogues = new Map<string, Awaited<ReturnType<typeof loadCatalogueVersion>>>();
  const airframes: MaintenanceAirframeView[] = [];

  for (const row of rows) {
    let catalogue = catalogues.get(row.catalogueVersion);
    if (catalogue === undefined) {
      catalogue = await loadCatalogueVersion(db, row.catalogueVersion);
      catalogues.set(row.catalogueVersion, catalogue);
    }
    const type = catalogue.types.get(row.typeDesignation);
    if (!type) continue;

    const profile: MaintenanceProfile = type.maintenanceProfile;
    const status = maintenanceStatus(stateOf(row), profile, economy.maintenance);

    airframes.push({
      airframeId: row.id,
      registration: row.registration,
      typeDesignation: row.typeDesignation,
      maintenanceProfile: profile,
      status: row.status,
      checkTier: isCheckTier(row.checkTier) ? row.checkTier : null,
      checkCompletesAt: row.checkCompletesAt?.toISOString() ?? null,
      totalHours: row.hours,
      totalCycles: row.cycles,
      technicalRisk: status.technicalRisk,
      airworthy: status.airworthiness.airworthy,
      dueTiers: [...status.dueTiers],
      tiers: CHECK_TIERS.map((tier) => {
        const t = status.tiers[tier];
        const terms = checkTerms(tier, profile, economy.maintenance);
        return {
          tier,
          hoursRemaining: t.hoursRemaining,
          cyclesRemaining: t.cyclesRemaining,
          binding: t.binding,
          usedFraction: t.usedFraction,
          due: t.due,
          costMinor: terms.costMinor,
          downtimeDays: terms.downtimeDays,
        };
      }),
    });
  }

  // Soonest first, by whichever limit is binding. An airframe already due sorts
  // to the very top; one in a check sorts by nothing urgent, because the decision
  // has already been taken.
  airframes.sort((a, b) => urgency(b) - urgency(a));

  return { airframes };
}

/**
 * One airframe's technical-fault probability, for the disruption roll (M5-05).
 *
 * The same reliability the fleet page shows, reduced to the single number
 * `DisruptionRisk.technical` reserved for it — a new airframe near 0, one overdue
 * for a check approaching 1. Returns 0 for an unknown airframe or a type absent
 * from its pinned catalogue: a missing reliability model is honestly "no extra
 * risk", and a departure must never fail because a type row could not be found.
 */
export async function airframeTechnicalRisk(db: Database, airframeId: string): Promise<number> {
  const [row] = await db.select().from(airframe).where(eq(airframe.id, airframeId)).limit(1);
  if (!row) return 0;

  const [worldRow] = await db
    .select({ economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, row.worldId))
    .limit(1);
  if (!worldRow) return 0;

  const economy = await loadEconomyConfig(db, worldRow.economyConfigVersion);
  const catalogue = await loadCatalogueVersion(db, row.catalogueVersion);
  const type = catalogue.types.get(row.typeDesignation);
  if (!type) return 0;

  return maintenanceStatus(stateOf(row), type.maintenanceProfile, economy.maintenance)
    .technicalRisk;
}

/**
 * Higher is more urgent. Grounded first, then unairworthy, then closest to due.
 *
 * Keyed on the status column rather than only on recomputed airworthiness, and
 * kept identical to `fleet.ts`'s ordering — the fleet table and the maintenance
 * page must not disagree about which aeroplane needs attention first.
 */
function urgency(view: MaintenanceAirframeView): number {
  if (view.status === 'grounded') return 3_000;
  if (!view.airworthy) return 2_000;
  if (view.status === 'in_check') return -1;
  return view.tiers.reduce((max, t) => Math.max(max, t.usedFraction), 0);
}

/**
 * Whether this airframe may push back, decided under a row lock (IMPROVE-03).
 *
 * The same question {@link airframeUnavailability} answers for the *scheduler*,
 * asked at the moment of departure and for a different reason. A schedule is
 * authored once; a departure happens later, and an aeroplane that was in service
 * when the rotation was saved may have been booked into a check or grounded by
 * the maintenance sweep since.
 *
 * ## Why it locks
 *
 * `bookCheck` takes `FOR UPDATE` on this row before it changes the status, so
 * taking it here too is what makes the gate authoritative rather than advisory.
 * Without the lock the two interleave: the departure reads `in_service`, the
 * booking commits `in_check`, and the flight leaves in an aeroplane that is in
 * a hangar. With it, whichever transaction arrives second waits and then sees
 * the first one's decision.
 *
 * The lock is on the airframe rather than the flight because the airframe is
 * what both sides contend for — the flight row is only ever touched by the
 * departure.
 *
 * ## Why an unknown id is available
 *
 * `null` from a missing row, exactly as `airframeUnavailability` documents:
 * `flight.airframe_id` has no foreign key until the M4/HIST boundary (#508),
 * and M2's own tests materialise flights against placeholder ids. An unknown id
 * means *"nothing here says it cannot fly"* rather than *"refuse"* — inventing
 * a refusal would enforce an integrity rule the column does not have, and would
 * strand every flight in those suites.
 *
 * `checkCompletesAt` comes back with the status because the departure gate
 * treats a check that ends at a known instant differently from an indefinite
 * grounding: one is worth waiting for and the other is not.
 */
export type DispatchAvailability =
  | { available: true }
  | {
      available: false;
      status: 'in_check' | 'grounded';
      /** Game time the running check ends. Null when nothing is scheduled to end. */
      checkCompletesAt: Date | null;
    };

export async function lockDispatchAvailability(
  db: Database,
  worldId: string,
  airframeId: string,
): Promise<DispatchAvailability> {
  const rows = await db
    .select({ status: airframe.status, checkCompletesAt: airframe.checkCompletesAt })
    .from(airframe)
    .where(and(eq(airframe.worldId, worldId), eq(airframe.id, airframeId)))
    .limit(1)
    .for('update');

  const row = rows[0];
  if (!row) return { available: true };
  if (row.status === 'in_check' || row.status === 'grounded') {
    return { available: false, status: row.status, checkCompletesAt: row.checkCompletesAt };
  }
  return { available: true };
}

/**
 * Why this airframe cannot be scheduled, or `null` if it can.
 *
 * `null` for an airframe with no row at all, deliberately. `schedule.airframe_id`
 * has no foreign key until the M4/HIST boundary (#508) and M2's own tests
 * schedule placeholder ids, so an unknown id means *"nothing here says it cannot
 * fly"* rather than *"refuse"*. Turning that into a refusal would break every
 * existing schedule test and would be enforcing an integrity rule that the
 * column does not yet have.
 */
export async function airframeUnavailability(
  db: Database,
  worldId: string,
  airframeId: string,
): Promise<'in_check' | 'grounded' | null> {
  const rows = await db
    .select({ status: airframe.status })
    .from(airframe)
    .where(and(eq(airframe.worldId, worldId), eq(airframe.id, airframeId)))
    .limit(1);

  const status = rows[0]?.status;
  if (status === 'in_check' || status === 'grounded') return status;
  return null;
}
