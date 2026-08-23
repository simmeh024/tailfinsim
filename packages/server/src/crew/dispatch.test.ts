import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft } from '../aircraft/acquisition';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, crewDutyPeriod, crewPool } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { dispatchCrew, type DispatchRequest } from './dispatch';
import { returnRestedCrew, standDownIdleCrew } from './duty-store';
import { hireCrew, openCrewBase } from './store';

/**
 * The hard rule at departure (M5-02, §9.2), against a real database.
 *
 * The arithmetic is `packages/sim`'s and is tested there. What is worth proving
 * here is everything the pure model cannot see: that heads actually move between
 * `crew_pool` columns, that a duty period is opened once and extended rather
 * than duplicated, that a timed-out set is stood down and a reserve can take the
 * aeroplane, and that rest gives the heads back to the pool they came from.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/dispatch.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('dispatching crew', () => {
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

  /**
   * A hub with an ICAO code and a real UTC offset.
   *
   * `TD` as the prefix, for the reason the other two crew suites carry in their
   * own comments: each counts from zero, so a shared prefix makes the first
   * airport in each file collide on `airport_icao_code_key` and fail whichever
   * file vitest happened to run second.
   */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFD-${String(n)}`;
    const icao = `TD${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_300_000 + n),
        ident,
        icaoCode: icao,
        name: `Crew Dispatch Hub ${ident}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
        // Amsterdam's standard time. The WOCL is local, so a duty period with no
        // offset would be evaluated against UTC and the early-report tests would
        // be measuring the wrong hour.
        utcOffsetMinutes: 60,
        timezone: 'Europe/Amsterdam',
        timezoneBasis: 'test',
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Could not create a dispatch test hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  /**
   * An airline with a base, a crewed ATR and somewhere to fly it.
   *
   * The ATR 72-600 seats 70 in two classes, so a legal complement is a Captain,
   * a First Officer and two cabin crew — under the hundred-seat threshold, so no
   * Purser. Four heads, which makes the pool arithmetic easy to read.
   */
  async function crewedAirline(options: { captains?: number; reserve?: number } = {}) {
    const hub = await makeIcaoHub();
    const away = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });

    // A lease takes a deposit, and a founding balance is not sized for a test's
    // convenience. In a transaction: `airline_cash_reconciles` checks the
    // movement against the balance, and outside one the movement commits first.
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 100_000_000,
        cause: 'flight_settlement',
        reference: `crew-dispatch-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );

    const acquired = await acquireAircraft(
      db.db,
      { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' },
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: hub.icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) throw new Error('Lease did not deliver');

    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hub.icao,
    });
    if (!opened.ok) throw new Error(`Could not open a base: ${opened.refusal}`);
    const crewBaseId = opened.value.crewBaseId;

    for (const [rank, heads] of [
      ['captain', options.captains ?? 2],
      ['first_officer', 2],
      ['cabin_crew', 4],
    ] as const) {
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: 'ATR 72',
        rank,
        heads,
      });
      if (!hired.ok) throw new Error(`Could not hire ${rank}: ${hired.refusal}`);
    }

    if (options.reserve !== undefined) {
      await db.db
        .update(crewPool)
        .set({ reserve: options.reserve })
        .where(eq(crewPool.crewBaseId, crewBaseId));
    }

    return { fixture, hub, away, crewBaseId, airframeId: acquired.airframe.id };
  }

  /** A one-hour hop, departing at a civilised local hour. */
  function request(
    setup: Awaited<ReturnType<typeof crewedAirline>>,
    options: { departAt: Date; blockMinutes?: number; from?: string; to?: string },
  ): DispatchRequest {
    const block = (options.blockMinutes ?? 60) * 60_000;
    return {
      worldId: setup.fixture.world.id,
      airlineId: setup.fixture.airline.id,
      airframeId: setup.airframeId,
      flightId: randomUUID(),
      originIcao: options.from ?? setup.hub.icao,
      destinationIcao: options.to ?? setup.away.icao,
      departAt: options.departAt,
      arriveAt: new Date(options.departAt.getTime() + block),
    };
  }

  /** 08:00 UTC, which is 09:00 at the test hub: outside the WOCL. */
  function morning(dayOffset = 0, hour = 8): Date {
    return new Date(Date.UTC(2024, 9, 21 + dayOffset, hour, 0, 0));
  }

  async function poolOf(crewBaseId: string, rank: 'captain' | 'cabin_crew') {
    const rows = await db.db
      .select({
        headcount: crewPool.headcount,
        onDuty: crewPool.onDuty,
        unavailable: crewPool.unavailable,
        reserve: crewPool.reserve,
      })
      .from(crewPool)
      .where(and(eq(crewPool.crewBaseId, crewBaseId), eq(crewPool.rank, rank)))
      .limit(1);
    return rows[0];
  }

  async function periodsFor(airframeId: string) {
    return db.db
      .select({
        id: crewDutyPeriod.id,
        status: crewDutyPeriod.status,
        sectors: crewDutyPeriod.sectors,
        heads: crewDutyPeriod.heads,
        fromReserve: crewDutyPeriod.fromReserve,
        locationIcao: crewDutyPeriod.locationIcao,
        restUntil: crewDutyPeriod.restUntil,
      })
      .from(crewDutyPeriod)
      .where(eq(crewDutyPeriod.airframeId, airframeId));
  }

  it('opens a duty period and takes the heads out of the pool', async () => {
    const setup = await crewedAirline();

    const decision = await dispatchCrew(db.db, request(setup, { departAt: morning() }));
    expect(decision.status).toBe('go');

    const periods = await periodsFor(setup.airframeId);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.status).toBe('open');
    expect(periods[0]?.sectors).toBe(1);
    // Captain, First Officer, two cabin crew.
    expect(periods[0]?.heads).toBe(4);
    // The crew are where the aeroplane is going, not where it left.
    expect(periods[0]?.locationIcao).toBe(setup.away.icao);

    const captains = await poolOf(setup.crewBaseId, 'captain');
    expect(captains?.onDuty).toBe(1);
    expect(captains?.headcount).toBe(2);
  });

  it('extends the same period for the next sector rather than opening a second', async () => {
    const setup = await crewedAirline();
    await dispatchCrew(db.db, request(setup, { departAt: morning() }));

    // Back again, 45 minutes later: a turnaround, not a rest.
    const back = await dispatchCrew(
      db.db,
      request(setup, {
        departAt: new Date(morning().getTime() + 105 * 60_000),
        from: setup.away.icao,
        to: setup.hub.icao,
      }),
    );
    expect(back.status).toBe('go');

    const periods = await periodsFor(setup.airframeId);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.sectors).toBe(2);

    // And no second helping of heads: the same crew flew both.
    const captains = await poolOf(setup.crewBaseId, 'captain');
    expect(captains?.onDuty).toBe(1);
  });

  it('will not staff a second aeroplane from a pool that is already flying one', async () => {
    // One captain, one aeroplane's worth of crew. The second departure has
    // nobody left, which is the arithmetic §9.2's fragmentation argument rests
    // on — crew are not fungible with themselves either.
    const setup = await crewedAirline({ captains: 1 });
    await dispatchCrew(db.db, request(setup, { departAt: morning() }));

    const second = await dispatchCrew(db.db, {
      ...request(setup, { departAt: morning() }),
      // A different aeroplane, so it does not find the open period.
      airframeId: randomUUID(),
    });
    expect(second.status).toBe('cancel');
    if (second.status !== 'cancel') return;
    expect(second.cause).toBe('no_crew');
  });

  /**
   * A day that uses itself up, and a short leg the crew can no longer take.
   *
   * The shape matters, and the first version got it wrong in a way worth
   * recording: it staged a **single 13-hour sector**, which with an hour's
   * report is fourteen hours — longer than a completely fresh crew's thirteen.
   * So dispatch refused the standby set too, entirely correctly, and the reserve
   * test read that as the reserve mechanism being broken. A timeout scenario has
   * to be one the *incumbent* cannot fly and a fresh crew can, or it proves
   * nothing about who is asked second.
   *
   * Report 07:00Z, a long sector landing 19:00Z, then a one-hour hop:
   *
   *   - the incumbent would reach 13h45 of flight duty across two sectors,
   *     against a 13h00 ceiling — 45 minutes over;
   *   - a crew reporting at 18:45Z would fly one sector in two hours.
   *
   * The block times are longer than an ATR would really fly. Dispatch takes the
   * instants it is given and does not opine on them; plausibility is the
   * schedule's job.
   */
  const LONG_FIRST_SECTOR = 11 * 60;
  const SECOND_DEPARTURE_MS = (12 * 60 + 45) * 60_000;

  it('times the crew out rather than flying them past the limit', async () => {
    const setup = await crewedAirline();

    const first = await dispatchCrew(
      db.db,
      request(setup, { departAt: morning(), blockMinutes: LONG_FIRST_SECTOR }),
    );
    // The long sector itself is legal: one sector allows 13h00 and it uses 12h00.
    expect(first.status).toBe('go');

    const late = await dispatchCrew(
      db.db,
      request(setup, {
        departAt: new Date(morning().getTime() + SECOND_DEPARTURE_MS),
        blockMinutes: 60,
        from: setup.away.icao,
        to: setup.hub.icao,
      }),
    );

    expect(['delay', 'cancel']).toContain(late.status);
    if (late.status === 'go') return;
    expect(late.cause).toBe('crew_timeout');
    expect(late.reason).toContain('flight duty');

    // The set that could not take it is off duty, not left open for ever.
    const periods = await periodsFor(setup.airframeId);
    expect(periods).toHaveLength(1);
    expect(periods[0]?.status).toBe('resting');
    expect(periods[0]?.restUntil).not.toBeNull();
  });

  it('calls out a reserve set when one is designated, and records that it did', async () => {
    // Twice the crew, half of them on standby: enough for a second set.
    const setup = await crewedAirline({ captains: 4 });
    await db.db
      .update(crewPool)
      .set({ reserve: 2 })
      .where(eq(crewPool.crewBaseId, setup.crewBaseId));

    await dispatchCrew(
      db.db,
      request(setup, { departAt: morning(), blockMinutes: LONG_FIRST_SECTOR }),
    );
    const late = await dispatchCrew(
      db.db,
      request(setup, {
        departAt: new Date(morning().getTime() + SECOND_DEPARTURE_MS),
        blockMinutes: 60,
        from: setup.away.icao,
        to: setup.hub.icao,
      }),
    );

    expect(late.status).toBe('go');
    if (late.status !== 'go') return;
    // The whole point of section 9.2's *"deliberately a hard call"*: the standby
    // crew did nothing all day and then saved the evening.
    expect(late.usedReserve).toBe(true);

    const periods = await periodsFor(setup.airframeId);
    expect(periods).toHaveLength(2);
    expect(periods.filter((p) => p.fromReserve)).toHaveLength(1);
  });

  it('cannot conjure a legal crew for a sector longer than a legal day', async () => {
    // The mistake above, kept as a rule. Thirteen hours of block plus an hour of
    // report is past the maximum for a crew who have done nothing at all, and no
    // amount of standby fixes that - the schedule is wrong, not the roster.
    const setup = await crewedAirline({ captains: 4 });
    await db.db
      .update(crewPool)
      .set({ reserve: 2 })
      .where(eq(crewPool.crewBaseId, setup.crewBaseId));

    const impossible = await dispatchCrew(
      db.db,
      request(setup, { departAt: morning(), blockMinutes: 13 * 60 }),
    );
    expect(impossible.status).toBe('cancel');
    if (impossible.status !== 'cancel') return;
    expect(impossible.cause).toBe('no_crew');
  });

  it('refuses when the airline has no crew base at all', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });

    const decision = await dispatchCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airframeId: randomUUID(),
      flightId: randomUUID(),
      originIcao: hub.icao,
      destinationIcao: hub.icao,
      departAt: morning(),
      arriveAt: new Date(morning().getTime() + 3_600_000),
    });

    expect(decision.status).toBe('cancel');
    if (decision.status !== 'cancel') return;
    // Not `crew_timeout`. A world with no crew model must not report every
    // departure as a fatigue problem.
    expect(decision.cause).toBe('no_crew');
  });

  it('sends an idle set home, and rest gives the heads back', async () => {
    const setup = await crewedAirline();
    await dispatchCrew(db.db, request(setup, { departAt: morning() }));
    expect((await poolOf(setup.crewBaseId, 'cabin_crew'))?.onDuty).toBe(2);

    // Long after the aeroplane landed and nothing else was dispatched.
    const later = new Date(morning().getTime() + 6 * 3_600_000);
    const down = await standDownIdleCrew(db.db, setup.fixture.world.id, later);
    expect(down.stoodDown).toBe(1);
    // Still holding their heads: resting is not available.
    expect((await poolOf(setup.crewBaseId, 'cabin_crew'))?.onDuty).toBe(2);

    // And a day later the rest is served.
    const tomorrow = new Date(morning(1).getTime() + 12 * 3_600_000);
    const back = await returnRestedCrew(db.db, setup.fixture.world.id, tomorrow);
    expect(back.returned).toBe(1);

    const cabin = await poolOf(setup.crewBaseId, 'cabin_crew');
    expect(cabin?.onDuty).toBe(0);
    // Exactly what was borrowed, back in the pool it came from.
    expect(cabin?.headcount).toBe(4);
  });

  it('returns a rested set only once, however often the sweep runs', async () => {
    const setup = await crewedAirline();
    await dispatchCrew(db.db, request(setup, { departAt: morning() }));
    await standDownIdleCrew(
      db.db,
      setup.fixture.world.id,
      new Date(morning().getTime() + 6 * 3_600_000),
    );

    const tomorrow = new Date(morning(1).getTime() + 12 * 3_600_000);
    expect((await returnRestedCrew(db.db, setup.fixture.world.id, tomorrow)).returned).toBe(1);
    // The claim in the UPDATE is what makes a handover safe. Without it two
    // workers racing would credit the same heads back twice.
    expect((await returnRestedCrew(db.db, setup.fixture.world.id, tomorrow)).returned).toBe(0);
    expect((await poolOf(setup.crewBaseId, 'captain'))?.onDuty).toBe(0);
  });

  it('leaves another world’s crew alone', async () => {
    const setup = await crewedAirline();
    await dispatchCrew(db.db, request(setup, { departAt: morning() }));

    // Game time is per world. A sweep that read every world's rows against one
    // clock would be wrong in all of them.
    const other = await fixtures.create({ hubIdent: (await makeIcaoHub()).ident });
    const later = new Date(morning().getTime() + 6 * 3_600_000);
    expect((await standDownIdleCrew(db.db, other.world.id, later)).stoodDown).toBe(0);
    expect((await periodsFor(setup.airframeId))[0]?.status).toBe('open');
  });
});
