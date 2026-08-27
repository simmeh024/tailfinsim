import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { DisruptionRoll } from '@tailfin/sim';

import { writeSetting } from '../automation/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, operationsTask, worldEvent } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { departFlight } from './depart';

import type { DispatchDecision } from '../crew/dispatch';

/**
 * `FLIGHT_DEPART`, the dispatch gate (M5-02).
 *
 * The crew decision itself is `dispatch.test.ts`'s; this is about what a
 * departure attempt does to the flight row and to the queue. So the decision is
 * injected — three canned answers, one per outcome — which keeps these tests
 * about the gate rather than about fatigue arithmetic, and lets the cancel and
 * delay paths be exercised without constructing a crew that has run out of
 * hours.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/depart.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('a departure attempt', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  /** `TP` as the prefix — every suite that makes airports needs its own. */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFP-${String(n)}`;
    const icao = `TP${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_400_000 + n),
        ident,
        icaoCode: icao,
        name: `Depart Test Hub ${ident}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
        utcOffsetMinutes: 60,
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Could not create a depart test hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  const DEPART_AT = new Date(Date.UTC(2024, 9, 21, 8, 0, 0));
  const ARRIVE_AT = new Date(Date.UTC(2024, 9, 21, 10, 0, 0));

  async function scheduledFlight(): Promise<{
    fixture: FoundedAirlineFixture;
    flightId: string;
    from: string;
    to: string;
  }> {
    const from = await makeIcaoHub();
    const to = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: from.ident });

    const rows = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: randomUUID(),
        originIcao: from.icao,
        destinationIcao: to.icao,
        scheduledDeparture: DEPART_AT,
        estimatedArrival: ARRIVE_AT,
      })
      .returning({ id: flight.id });
    const flightId = rows[0]?.id;
    if (flightId === undefined) throw new Error('Could not create a flight');
    return { fixture, flightId, from: from.icao, to: to.icao };
  }

  async function flightRow(flightId: string) {
    const rows = await db.db
      .select({
        phase: flight.phase,
        disruption: flight.disruption,
        disruptionCause: flight.disruptionCause,
        actualDeparture: flight.actualDeparture,
        estimatedArrival: flight.estimatedArrival,
        crewDutyPeriodId: flight.crewDutyPeriodId,
      })
      .from(flight)
      .where(eq(flight.id, flightId))
      .limit(1);
    return rows[0];
  }

  async function eventsOfType(worldId: string, type: 'FLIGHT_ARRIVE' | 'FLIGHT_DEPART') {
    return db.db
      .select({ fireAt: worldEvent.fireAt, key: worldEvent.idempotencyKey })
      .from(worldEvent)
      .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.type, type)));
  }

  const goes = (dutyPeriodId: string): DispatchDecision => ({
    status: 'go',
    dutyPeriodId,
    marginMinutes: 120,
    usedReserve: false,
  });

  it('releases the flight and queues its arrival', async () => {
    const { fixture, flightId } = await scheduledFlight();
    const dutyPeriodId = randomUUID();

    const outcome = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () => Promise.resolve(goes(dutyPeriodId)),
    });

    expect(outcome.status).toBe('departed');
    const row = await flightRow(flightId);
    expect(row?.phase).toBe('cruise');
    expect(row?.actualDeparture?.toISOString()).toBe(DEPART_AT.toISOString());
    expect(row?.crewDutyPeriodId).toBe(dutyPeriodId);
    // On time, so nothing to report.
    expect(row?.disruption).toBeNull();

    const arrivals = await eventsOfType(fixture.world.id, 'FLIGHT_ARRIVE');
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]?.fireAt.toISOString()).toBe(ARRIVE_AT.toISOString());
  });

  it('carries a late departure through to a late arrival', async () => {
    const { flightId } = await scheduledFlight();
    const late = new Date(DEPART_AT.getTime() + 90 * 60_000);

    await departFlight(db.db, flightId, late, {
      dispatch: () => Promise.resolve(goes(randomUUID())),
    });

    const row = await flightRow(flightId);
    /*
     * The aeroplane does not fly faster to make it up. That matters more than it
     * looks: erasing the delay here would erase the propagation that makes a
     * tight rotation fail two legs later, which is the whole of M5-02's first
     * acceptance criterion.
     */
    expect(row?.estimatedArrival.toISOString()).toBe(
      new Date(ARRIVE_AT.getTime() + 90 * 60_000).toISOString(),
    );
    expect(row?.disruption).toBe('delayed');
  });

  it('holds a timed-out flight and schedules a second attempt', async () => {
    const { fixture, flightId } = await scheduledFlight();
    const untilAt = new Date(DEPART_AT.getTime() + 100 * 60_000);

    const outcome = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () =>
        Promise.resolve({
          status: 'delay',
          untilAt,
          cause: 'crew_timeout',
          reason: 'The crew are out of hours.',
        }),
    });

    expect(outcome.status).toBe('delayed');
    const row = await flightRow(flightId);
    expect(row?.disruption).toBe('delayed');
    // M2-08's cause, finally persisted. "Delayed 100 minutes" is not information;
    // "delayed 100 minutes because the crew were out of hours" is.
    expect(row?.disruptionCause).toBe('crew_timeout');
    // It has not left.
    expect(row?.actualDeparture).toBeNull();
    expect(row?.phase).toBe('scheduled');

    const retries = await eventsOfType(fixture.world.id, 'FLIGHT_DEPART');
    expect(retries).toHaveLength(1);
    expect(retries[0]?.fireAt.toISOString()).toBe(untilAt.toISOString());
    // A distinct key. Reusing `departureKey` would make the retry a silent
    // no-op, and the flight would sit delayed for ever with nothing to look at
    // it again.
    expect(retries[0]?.key).not.toBe(`flight:${flightId}:depart`);
  });

  it('cancels when the crew cannot be replaced in time', async () => {
    const { fixture, flightId } = await scheduledFlight();

    const outcome = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () =>
        Promise.resolve({
          status: 'cancel',
          cause: 'crew_timeout',
          reason: 'The rest they are owed runs overnight.',
        }),
    });

    expect(outcome.status).toBe('cancelled');
    const row = await flightRow(flightId);
    // Where `machine.ts` puts a cancelled flight: it never left the stand.
    expect(row?.phase).toBe('idle');
    expect(row?.disruption).toBe('cancelled');
    expect(row?.disruptionCause).toBe('crew_timeout');
    expect(await eventsOfType(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
  });

  it('records no cause when the reason was not a crew timeout', async () => {
    const { flightId } = await scheduledFlight();

    await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () =>
        Promise.resolve({
          status: 'cancel',
          cause: 'no_crew',
          reason: 'The airline has no crew base.',
        }),
    });

    const row = await flightRow(flightId);
    expect(row?.disruption).toBe('cancelled');
    // `no_crew` is not one of M2-08's causes and must not be filed as fatigue:
    // an airline that never hired anybody has a different problem from one that
    // worked its crew too hard, and the ledger has to be able to tell them apart.
    expect(row?.disruptionCause).toBeNull();
  });

  it('does nothing to a flight that has already gone', async () => {
    const { flightId } = await scheduledFlight();
    let calls = 0;
    const dispatch = () => {
      calls += 1;
      return Promise.resolve(goes(randomUUID()));
    };

    await departFlight(db.db, flightId, DEPART_AT, { dispatch });
    const again = await departFlight(db.db, flightId, DEPART_AT, { dispatch });

    expect(again).toEqual({ status: 'already-handled' });
    // The queue can deliver an event twice. A second dispatch would open a
    // second duty period against the same aeroplane and take a second set of
    // heads out of the pool.
    expect(calls).toBe(1);
  });

  it('does nothing to a flight that has already been cancelled', async () => {
    const { flightId } = await scheduledFlight();
    await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () =>
        Promise.resolve({ status: 'cancel', cause: 'crew_timeout', reason: 'out of hours' }),
    });

    const again = await departFlight(db.db, flightId, DEPART_AT, {
      dispatch: () => Promise.resolve(goes(randomUUID())),
    });
    expect(again).toEqual({ status: 'already-handled' });
    expect((await flightRow(flightId))?.disruption).toBe('cancelled');
  });

  it('reports a flight that is not there rather than inventing one', async () => {
    const outcome = await departFlight(db.db, randomUUID(), DEPART_AT, {
      dispatch: () => Promise.resolve(goes(randomUUID())),
    });
    expect(outcome).toEqual({ status: 'not-found' });
  });

  /*
   * The ground disruption roll (M5-05). The roll itself is `disruption.test`'s
   * (soon) and the sim's; these prove the gate wires it in correctly — that it
   * runs before the crew are committed, and once.
   */
  describe('a ground disruption', () => {
    const delayRoll: DisruptionRoll = {
      cause: 'technical',
      outcome: 'delay',
      delayMinutes: 45,
      disruption: 'delayed',
      probability: 0.2,
    };
    const cancelRoll: DisruptionRoll = {
      cause: 'technical',
      outcome: 'cancel',
      delayMinutes: 0,
      disruption: 'cancelled',
      probability: 0.2,
    };

    it('delays the departure and does not commit the crew', async () => {
      const { fixture, flightId } = await scheduledFlight();
      let dispatched = false;

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => {
          dispatched = true;
          return Promise.resolve(goes(randomUUID()));
        },
        disruption: () => Promise.resolve(delayRoll),
      });

      // Rolled before dispatch: the crew were never asked, so no duty period opened.
      expect(dispatched).toBe(false);
      expect(outcome.status).toBe('delayed');
      const untilAt = new Date(DEPART_AT.getTime() + 45 * 60_000);
      if (outcome.status === 'delayed') {
        expect(outcome.untilAt.toISOString()).toBe(untilAt.toISOString());
      }

      const row = await flightRow(flightId);
      expect(row?.disruption).toBe('delayed');
      expect(row?.disruptionCause).toBe('technical');
      expect(row?.actualDeparture).toBeNull();
      expect(row?.crewDutyPeriodId).toBeNull();

      // A retry is queued at the new time, and no arrival yet.
      const departs = await eventsOfType(fixture.world.id, 'FLIGHT_DEPART');
      expect(departs.map((e) => e.fireAt.toISOString())).toContain(untilAt.toISOString());
      expect(await eventsOfType(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
    });

    it('cancels the flight and does not commit the crew', async () => {
      const { fixture, flightId } = await scheduledFlight();
      let dispatched = false;

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => {
          dispatched = true;
          return Promise.resolve(goes(randomUUID()));
        },
        disruption: () => Promise.resolve(cancelRoll),
      });

      expect(dispatched).toBe(false);
      expect(outcome.status).toBe('cancelled');
      const row = await flightRow(flightId);
      expect(row?.disruption).toBe('cancelled');
      expect(row?.disruptionCause).toBe('technical');
      expect(row?.phase).toBe('idle');
      expect(row?.crewDutyPeriodId).toBeNull();
      expect(await eventsOfType(fixture.world.id, 'FLIGHT_ARRIVE')).toHaveLength(0);
    });

    it('is not rolled again for a flight that already carries a disruption', async () => {
      const { flightId } = await scheduledFlight();
      // A prior attempt (or a crew delay) already marked it; the retry must not roll.
      await db.db.update(flight).set({ disruption: 'delayed' }).where(eq(flight.id, flightId));

      let rolled = false;
      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => Promise.resolve(goes(randomUUID())),
        disruption: () => {
          rolled = true;
          return Promise.resolve(cancelRoll);
        },
      });

      expect(rolled).toBe(false);
      expect(outcome.status).toBe('departed');
    });
  });

  /*
   * The automation ladder governing the disruption response (M5-05, ADR-0023).
   * The roll is injected so these are about what the *policy* does with a delay,
   * not about the odds of one.
   */
  describe('the disruption-response policy', () => {
    const delayRoll: DisruptionRoll = {
      cause: 'technical',
      outcome: 'delay',
      delayMinutes: 90,
      disruption: 'delayed',
      probability: 0.2,
    };

    async function tasksFor(airlineId: string) {
      return db.db
        .select({ kind: operationsTask.kind, subjectId: operationsTask.subjectId })
        .from(operationsTask)
        .where(eq(operationsTask.airlineId, airlineId));
    }

    it('under Manual, lets the delay stand and raises an operations task', async () => {
      const { fixture, flightId } = await scheduledFlight();

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => Promise.resolve(goes(randomUUID())),
        disruption: () => Promise.resolve(delayRoll),
      });

      expect(outcome.status).toBe('delayed');
      const tasks = await tasksFor(fixture.airline.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: 'disruption_review', subjectId: flightId });
    });

    it('cancels a delay past the policy ceiling, and raises no task', async () => {
      const { fixture, flightId } = await scheduledFlight();
      await writeSetting(
        db.db,
        { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' },
        'disruption',
        { mode: 'policy', policy: { disruptionResponse: { cancelDelaysOverMinutes: 60 } } },
      );

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => Promise.resolve(goes(randomUUID())),
        disruption: () => Promise.resolve(delayRoll),
      });

      // 90 > 60: the player's rule cancels it.
      expect(outcome.status).toBe('cancelled');
      expect((await flightRow(flightId))?.disruption).toBe('cancelled');
      expect(await tasksFor(fixture.airline.id)).toHaveLength(0);
    });

    it('accepts a delay within the ceiling, quietly', async () => {
      const { fixture, flightId } = await scheduledFlight();
      await writeSetting(
        db.db,
        { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' },
        'disruption',
        { mode: 'policy', policy: { disruptionResponse: { cancelDelaysOverMinutes: 120 } } },
      );

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        dispatch: () => Promise.resolve(goes(randomUUID())),
        disruption: () => Promise.resolve(delayRoll),
      });

      // 90 <= 120: covered and accepted — no task.
      expect(outcome.status).toBe('delayed');
      expect(await tasksFor(fixture.airline.id)).toHaveLength(0);
    });
  });
});
