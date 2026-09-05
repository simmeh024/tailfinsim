import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { bookCheck, lockDispatchAvailability } from '../aircraft/maintenance';
import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  airframe,
  airport,
  crewDutyPeriod,
  flight,
  operationsTask,
  worldEvent,
} from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { departFlight } from './depart';

import type { DispatchDecision } from '../crew/dispatch';

/**
 * A queued flight cannot leave in an aeroplane that is in a hangar (IMPROVE-03).
 *
 * `schedule/store.ts` checks availability when a rotation is **authored**, which
 * is the only moment it could — and a departure happens later. Between the two,
 * the maintenance sweep can ground the aircraft or the player can book it into a
 * check, and until this gate nothing enforced the change: the queued
 * `FLIGHT_DEPART` released the flight, committed a crew duty period and
 * scheduled an arrival, in an aircraft that could not fly.
 *
 * The aircraft here are acquired through `acquireAircraft` and taken out of
 * service through `bookCheck` — the same two functions the API calls — because
 * the bug is about two real code paths disagreeing, and a hand-written status
 * column would not prove they now agree.
 *
 * The crew decision is injected. `dispatch.test.ts` owns fatigue arithmetic;
 * what matters here is that dispatch is never **reached**, which an injected
 * spy can say precisely.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/depart-availability.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/**
 * Game time, just after the flagship world's epoch of 2024-10-20.
 *
 * Close to the epoch on purpose. A check booked at the world's launch completes
 * a game day or so later, and a retry lands at that instant — so a flight
 * scheduled a fortnight out would be asked to arrive *before* its own scheduled
 * departure, which `flight_arrives_after_departure` correctly refuses. Keeping
 * the flight and the checks on the same few days keeps the fixture coherent.
 */
const DEPART_AT = new Date(Date.UTC(2024, 9, 20, 1, 0, 0));
const ARRIVE_AT = new Date(Date.UTC(2024, 9, 20, 3, 0, 0));

describeDb('the departure availability gate', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const identities = createAirportIdentities('flight/depart-availability');
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(): Promise<{ ident: string; icao: string }> {
    const identity = identities();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Departure gate test ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return { ident: identity.ident, icao: identity.icaoCode };
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /**
   * A world, an airline, an aeroplane it actually owns, and a flight for it.
   *
   * The top-up is what makes a lease affordable — the founding balance buys one
   * ATR deposit and this suite books checks on top of it. Its exact size is not
   * under test.
   */
  async function readyToDepart(): Promise<{
    fixture: FoundedAirlineFixture;
    airframeId: string;
    flightId: string;
  }> {
    const from = await makeAirport();
    const to = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 1_000_000_000,
        cause: 'admin_adjustment',
        reference: `depart-gate-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );

    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: from.icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`acquisition refused: ${acquired.ok ? 'no airframe' : acquired.kind}`);
    }

    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: acquired.airframe.id,
        originIcao: from.icao,
        destinationIcao: to.icao,
        scheduledDeparture: DEPART_AT,
        estimatedArrival: ARRIVE_AT,
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');

    return { fixture, airframeId: acquired.airframe.id, flightId: created.id };
  }

  /** A dispatch that would say yes, and records whether it was ever asked. */
  function spyDispatch() {
    let calls = 0;
    const dispatch = (): Promise<DispatchDecision> => {
      calls += 1;
      return Promise.resolve({
        status: 'go',
        dutyPeriodId: randomUUID(),
        marginMinutes: 120,
        usedReserve: false,
      });
    };
    return {
      dispatch: dispatch as never,
      get calls() {
        return calls;
      },
    };
  }

  /** Nothing rolls: the gate, not the weather, is what this suite is about. */
  const noDisruption = (() => Promise.resolve(null)) as never;

  async function flightRow(flightId: string) {
    const [row] = await db.db
      .select({
        phase: flight.phase,
        disruption: flight.disruption,
        disruptionCause: flight.disruptionCause,
        actualDeparture: flight.actualDeparture,
        crewDutyPeriodId: flight.crewDutyPeriodId,
      })
      .from(flight)
      .where(eq(flight.id, flightId));
    if (!row) throw new Error('flight is gone');
    return row;
  }

  async function queued(worldId: string, type: 'FLIGHT_ARRIVE' | 'FLIGHT_DEPART') {
    return db.db
      .select({ key: worldEvent.idempotencyKey, fireAt: worldEvent.fireAt })
      .from(worldEvent)
      .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.type, type)));
  }

  /**
   * Book a check and say when it ends, in game time.
   *
   * The instant matters and cannot be guessed: `bookCheck` computes
   * `check_completes_at` from the tier's downtime on the **world's** clock, so a
   * fixed date in the test lands before or after it depending on how long an `a`
   * check happens to take. Reading it back lets the attempt below be placed
   * deliberately on either side of it.
   */
  async function bookCheckEnding(
    fixture: FoundedAirlineFixture,
    airframeId: string,
  ): Promise<Date> {
    const booked = await bookCheck(db.db, own(fixture), airframeId, 'a', fixture.world.launchDate);
    expect(booked.ok, 'the check was not booked').toBe(true);

    const [row] = await db.db
      .select({ status: airframe.status, completesAt: airframe.checkCompletesAt })
      .from(airframe)
      .where(eq(airframe.id, airframeId));
    expect(row?.status).toBe('in_check');
    if (!row?.completesAt) throw new Error('the booked check has no completion instant');
    return row.completesAt;
  }

  async function ground(airframeId: string): Promise<void> {
    // What `sweepMaintenance` does to an unairworthy airframe, done directly:
    // reaching it through the sweep needs an aeroplane flown past its check
    // interval, which is `maintenance.test.ts`'s subject rather than this one.
    await db.db
      .update(airframe)
      .set({ status: 'grounded', checkCompletesAt: null })
      .where(eq(airframe.id, airframeId));
  }

  it('lets an in-service aircraft depart, which is the case that must not break', async () => {
    const { fixture, flightId } = await readyToDepart();
    const spy = spyDispatch();

    const outcome = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: spy.dispatch,
      disruption: noDisruption,
    });

    expect(outcome.status).toBe('departed');
    expect(spy.calls).toBe(1);
    expect((await flightRow(flightId)).phase).toBe('cruise');
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(1);
  });

  it('will not release a flight whose aircraft has been grounded since it was scheduled', async () => {
    /*
     * The reproduction from the issue, in three lines: a valid flight, a
     * grounding after it was queued, and a departure attempt with crew that
     * would have said yes.
     */
    const { fixture, flightId, airframeId } = await readyToDepart();
    await ground(airframeId);
    const spy = spyDispatch();

    const outcome = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: spy.dispatch,
      disruption: noDisruption,
    });

    expect(outcome.status).toBe('cancelled');
    if (outcome.status === 'cancelled') expect(outcome.reason).toMatch(/grounded/i);

    // Dispatch was never reached, so no duty period was opened and no crew were
    // committed — the criterion that a blocked departure commits nothing.
    expect(spy.calls).toBe(0);
    const duties = await db.db
      .select({ id: crewDutyPeriod.id })
      .from(crewDutyPeriod)
      .where(eq(crewDutyPeriod.airlineId, fixture.airline.id));
    expect(duties).toHaveLength(0);

    // And no arrival was scheduled: a cancelled flight must not land.
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);

    const row = await flightRow(flightId);
    expect(row.phase).toBe('idle');
    expect(row.disruption).toBe('cancelled');
    expect(row.disruptionCause).toBe('technical');
    expect(row.actualDeparture).toBeNull();
    expect(row.crewDutyPeriodId).toBeNull();
  });

  it('tells the player why, through the operations task they already read', async () => {
    // "The reason is recorded and visible through the existing operational
    // response" — the same task list the automation ladder writes to.
    const { fixture, flightId, airframeId } = await readyToDepart();
    await ground(airframeId);

    await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });

    const tasks = await db.db
      .select({ kind: operationsTask.kind, detail: operationsTask.detail })
      .from(operationsTask)
      .where(eq(operationsTask.airlineId, fixture.airline.id));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.detail).toMatch(/grounded/i);
    // The vocabulary the disruption system already uses, not a third spelling.
    expect(tasks[0]?.kind).toBe('disruption_review');
  });

  it('holds a flight whose aircraft is in a check, and retries when it is released', async () => {
    /*
     * A check ends at a known instant, so it is worth waiting for — unlike a
     * grounding, which has no end date. The flight is delayed to
     * `check_completes_at` and a second `FLIGHT_DEPART` is queued for then,
     * which is the same retry the crew and weather delays use.
     *
     * That is the "retry/resumption behaviour is deliberate" criterion: the
     * flight is not stranded, and it is not cancelled for a forty-minute check
     * either.
     */
    const { fixture, flightId, airframeId } = await readyToDepart();
    const completesAt = await bookCheckEnding(fixture, airframeId);
    // An hour before the check ends: the aeroplane is unavailable *and* there is
    // something to wait for, which is the case this outcome is about.
    const attemptAt = new Date(completesAt.getTime() - 3_600_000);

    const spy = spyDispatch();
    const outcome = await departFlight(db.db, flightId, attemptAt, {
      dispatch: spy.dispatch,
      disruption: noDisruption,
    });

    expect(outcome.status).toBe('delayed');
    expect(spy.calls).toBe(0);

    const row = await flightRow(flightId);
    expect(row.disruption).toBe('delayed');
    expect(row.disruptionCause).toBe('technical');
    expect(row.actualDeparture).toBeNull();

    // Something is queued to look at it again, and at the moment the aircraft
    // comes back rather than at an arbitrary interval.
    const retries = await queued(fixture.world.id, 'FLIGHT_DEPART');
    expect(retries).toHaveLength(1);
    if (outcome.status === 'delayed') {
      expect(retries[0]?.fireAt.getTime()).toBe(outcome.untilAt.getTime());
    }
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
  });

  it('departs on the retry once the check has finished', async () => {
    // Recovery after maintenance. The delay is only worth anything if the
    // second attempt actually goes.
    const { fixture, flightId, airframeId } = await readyToDepart();
    const completesAt = await bookCheckEnding(fixture, airframeId);

    const held = await departFlight(db.db, flightId, new Date(completesAt.getTime() - 3_600_000), {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });
    expect(held.status).toBe('delayed');

    // The worker's sweep releases it at `check_completes_at`; this is that
    // release, without waiting for a tick.
    await db.db
      .update(airframe)
      .set({ status: 'in_service', checkTier: null, checkCompletesAt: null })
      .where(eq(airframe.id, airframeId));

    const spy = spyDispatch();
    const retry = await departFlight(db.db, flightId, completesAt, {
      dispatch: spy.dispatch,
      disruption: noDisruption,
    });

    expect(retry.status).toBe('departed');
    expect(spy.calls).toBe(1);
    expect((await flightRow(flightId)).phase).toBe('cruise');
    // Still delayed, because it left late — the flag records what happened
    // rather than being cleared by the eventual departure.
    expect((await flightRow(flightId)).disruption).toBe('delayed');
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(1);
  });

  it('cancels rather than delaying twice, so a flight cannot be stranded', async () => {
    /*
     * The failure mode the second delay would create. `scheduleEvent` is
     * idempotent by key, and the retry key is the instant — so delaying again to
     * the same `check_completes_at` would queue nothing, leaving the flight
     * `delayed` for ever with nothing due to look at it.
     *
     * Production has no worker at all (OPS-12), so a check there never
     * completes: one delay, then a decision, is the only bounded shape.
     */
    const { fixture, flightId, airframeId } = await readyToDepart();
    const completesAt = await bookCheckEnding(fixture, airframeId);

    const first = await departFlight(db.db, flightId, new Date(completesAt.getTime() - 3_600_000), {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });
    expect(first.status).toBe('delayed');

    // It comes round again and the check has *not* finished, because nothing
    // ran the sweep — which on production is not hypothetical (OPS-12).
    const second = await departFlight(db.db, flightId, new Date(completesAt.getTime() - 60_000), {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });

    expect(second.status).toBe('cancelled');
    const row = await flightRow(flightId);
    expect(row.phase).toBe('idle');
    expect(row.disruption).toBe('cancelled');
    // Exactly one retry was ever queued — the second attempt added none.
    expect(await queued(fixture.world.id, 'FLIGHT_DEPART')).toHaveLength(1);
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
  });

  it('holds the airframe row, so a booking racing a dispatch cannot slip past', async () => {
    /*
     * The concurrency criterion.
     *
     * `bookCheck` takes `FOR UPDATE` on the airframe before it writes the
     * status, and the gate takes the same lock before it reads it. So the two
     * cannot interleave: whichever arrives second waits.
     *
     * Proved by holding the lock from a transaction of our own and showing the
     * booking blocks on it — which is what serialises them, and what a
     * non-locking read would not do. A plain `select` here would let the booking
     * through immediately, and this assertion is the difference.
     */
    const { fixture, airframeId } = await readyToDepart();

    let bookingSettled = false;
    let releaseGate: (() => void) | undefined;
    const gateHeld = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const holding = db.db.transaction(async (tx) => {
      const availability = await lockDispatchAvailability(tx, fixture.world.id, airframeId);
      expect(availability.available).toBe(true);
      // The lock is held for as long as this transaction is open.
      await gateHeld;
    });

    // Give the lock a moment to be taken, then start the booking.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const booking = bookCheck(db.db, own(fixture), airframeId, 'a', fixture.world.launchDate).then(
      (result) => {
        bookingSettled = true;
        return result;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    // Still waiting on the row lock rather than having committed a status the
    // gate had already read as available.
    expect(bookingSettled).toBe(false);

    releaseGate?.();
    await holding;
    expect((await booking).ok).toBe(true);
    expect(bookingSettled).toBe(true);
  });

  it('treats an aircraft in another world as absent rather than as available', async () => {
    // The gate is scoped by world, like the settlement's resolver. An airframe
    // id from a world that has been reset must not answer for a flight in a
    // different one.
    const owner = await readyToDepart();
    const other = await fixtures.create();

    expect(
      await lockDispatchAvailability(db.db, owner.fixture.world.id, owner.airframeId),
    ).toMatchObject({ available: true });

    await ground(owner.airframeId);
    expect(
      await lockDispatchAvailability(db.db, owner.fixture.world.id, owner.airframeId),
    ).toMatchObject({ available: false, status: 'grounded' });

    // Grounded in its own world, unknown in another — and unknown is available,
    // which is what keeps every flight scheduled against a placeholder id flying.
    expect(await lockDispatchAvailability(db.db, other.world.id, owner.airframeId)).toMatchObject({
      available: true,
    });
  });

  it('leaves a blocked flight alone when the event is replayed', async () => {
    // The queue delivers twice after a restart. A cancelled flight is
    // `already-handled` on the second delivery, so nothing is written again and
    // no second task is raised.
    const { fixture, flightId, airframeId } = await readyToDepart();
    await ground(airframeId);

    await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });
    const again = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: spyDispatch().dispatch,
      disruption: noDisruption,
    });

    expect(again.status).toBe('already-handled');

    const tasks = await db.db
      .select({ id: operationsTask.id })
      .from(operationsTask)
      .where(eq(operationsTask.airlineId, fixture.airline.id));
    expect(tasks).toHaveLength(1);
    expect(await queued(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
  });
});
