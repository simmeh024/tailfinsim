import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { reconcileAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, cashMovement, flight, flightResult } from '../db/schema';
import { fixtureAirframe } from '../test-fixtures/airframe';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { arrivalKey, createFlightArriveHandler, settleArrivedFlight } from './settle';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('flight/settle');

/**
 * Settling an arrived flight, against a real Postgres (M2-06).
 *
 * The settlement arithmetic is proven in `@tailfin/sim` and is not retested here.
 * What is here is the half only a database can settle, and it is the half where
 * being wrong costs money:
 *
 *   - **Replaying a settled flight is a no-op**, because a unique constraint
 *     refuses the second row — not because this code checked first. The
 *     acceptance criterion, and the one that would otherwise pay an airline twice.
 *   - **The cash movement and the result are one commit.** Neither can exist
 *     without the other, whatever fails in between.
 *   - **The breakdown cannot disagree with the totals**, because a check
 *     constraint refuses a row where the net is not the difference.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/settle.test] DATABASE_URL not set — skipping settle tests.\n');
const describeDb = url ? describe : describe.skip;

const DEPARTS = new Date('2026-08-17T06:00:00.000Z');
const ARRIVES = new Date('2026-08-17T07:15:00.000Z');

/** A 70-seat cabin at 47 passengers — §13.4's airline, near enough. */
const LOAD = JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } });

/**
 * Assert that Postgres refused a write, and refused it for the *stated* reason.
 *
 * Drizzle wraps driver errors, so the outer message is always `Failed query: …`
 * and asserting on that passes for **any** failure — a typo in a column name
 * would satisfy it just as well as the constraint under test. CLAUDE.md records
 * this as a trap already met; this walks `error.cause` for the constraint name
 * Postgres actually reported.
 */
async function expectConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught, 'expected the write to be refused, but it succeeded').toBeDefined();

  const reported: string[] = [];
  let current: unknown = caught;
  while (current instanceof Error) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === 'string') reported.push(name);
    current = current.cause;
  }

  expect(reported, `Postgres reported ${reported.join(', ') || 'no constraint'}`).toContain(
    constraint,
  );
}

/**
 * Settle against a fixed aeroplane.
 *
 * This suite's subject is the settlement, not the fleet: production resolves the
 * flight's real airframe from `airframe.effective_spec` (IMPROVE-02), and
 * `flight/settle-aircraft.test.ts` is where that path is proved. Substituting it
 * on the line rather than relying on a default is what keeps the difference
 * visible.
 */
function settle(
  tx: Parameters<typeof settleArrivedFlight>[0],
  flightId: string,
  arrivedAt: Date,
  deps: Parameters<typeof settleArrivedFlight>[3] = {},
): ReturnType<typeof settleArrivedFlight> {
  return settleArrivedFlight(tx, flightId, arrivedAt, {
    resolveAirframe: fixtureAirframe,
    ...deps,
  });
}

describeDb('settling an arrived flight', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  /** Amsterdam and London, near enough — a real 200 nm sector. */
  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude,
      longitude,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeFlight(
    overrides: { load?: string; cargoKg?: number; diversionIcao?: string | null } = {},
  ): Promise<{
    flightId: string;
    airlineId: string;
    worldId: string;
    openingCashMinor: number;
    origin: string;
    dest: string;
  }> {
    const created = await fixtures.create();

    const origin = await makeAirport(52.3086, 4.76389);
    const dest = await makeAirport(51.4706, -0.461941);

    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: created.world.id,
        airlineId: created.airline.id,
        airframeId: crypto.randomUUID(),
        originIcao: origin,
        destinationIcao: dest,
        diversionIcao: overrides.diversionIcao ?? null,
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: overrides.load ?? LOAD,
        cargoKg: overrides.cargoKg ?? 0,
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');

    return {
      flightId: f.id,
      airlineId: created.airline.id,
      worldId: created.world.id,
      openingCashMinor: created.airline.cash,
      origin,
      dest,
    };
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cash: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    return row?.cash ?? 0;
  }

  it('writes a result traceable to its inputs, and moves cash by exactly the net', async () => {
    const { flightId, airlineId, openingCashMinor } = await makeFlight();

    const outcome = await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));
    expect(outcome.status).toBe('settled');
    if (outcome.status !== 'settled') return;

    const [row] = await db.db
      .select()
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    expect(row).toBeDefined();
    if (!row) return;

    // Invariant 4: the row explains itself. Totals reconcile, the breakdown is
    // there, and the rates it ran under are recorded.
    expect(row.netMinor).toBe(row.revenueMinor - row.costMinor);
    expect(row.revenueMinor).toBe(47 * 7_500);
    expect(row.seats).toBe(70);
    expect(row.passengers).toBe(47);
    expect(row.settlementVersion).toBe('v1');
    expect(row.blockSeconds).toBeGreaterThan(0);

    const breakdown = JSON.parse(row.breakdown) as {
      revenue: { source: string; amountMinor: number }[];
      costs: { source: string; amountMinor: number }[];
      distanceNm: number;
    };
    expect(breakdown.costs.map((c) => c.source)).toEqual([
      'fuel',
      'crew',
      'maintenance',
      'airport',
      'handling',
    ]);
    expect(breakdown.costs.reduce((s, c) => s + c.amountMinor, 0)).toBe(row.costMinor);
    // Distance came from the airports' own coordinates, not from a constant.
    expect(breakdown.distanceNm).toBeGreaterThan(195);
    expect(breakdown.distanceNm).toBeLessThan(205);

    expect(await cashOf(airlineId)).toBe(openingCashMinor + row.netMinor);

    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    expect(movements).toHaveLength(2);
    const settlementMovement = movements.find((movement) => movement.cause === 'flight_settlement');
    expect(settlementMovement).toMatchObject({
      amountMinor: row.netMinor,
      cause: 'flight_settlement',
      reference: flightId,
      balanceAfterMinor: openingCashMinor + row.netMinor,
      occurredAt: ARRIVES,
    });
    expect(await reconcileAirlineCash(db.db, airlineId)).toMatchObject({
      balanceMinor: openingCashMinor + row.netMinor,
      movementTotalMinor: openingCashMinor + row.netMinor,
      reconciles: true,
    });
  });

  it('marks the flight arrived, in the same commit', async () => {
    const { flightId } = await makeFlight();

    await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

    const [row] = await db.db.select().from(flight).where(eq(flight.id, flightId));
    expect(row?.phase).toBe('turnaround');
    expect(row?.actualArrival?.toISOString()).toBe(ARRIVES.toISOString());
  });

  it('records the arrival delay as a reputation input, without acting on it', async () => {
    const { flightId, airlineId } = await makeFlight();
    const late = new Date(ARRIVES.getTime() + 23 * 60_000);

    await db.db.transaction((tx) => settle(tx, flightId, late));

    const [row] = await db.db
      .select()
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    expect(row?.arrivalDelayMinutes).toBe(23);

    // §15 owns what punctuality does to standing. Nothing here touches it.
    const [air] = await db.db
      .select({ reputation: airline.reputation })
      .from(airline)
      .where(eq(airline.id, airlineId));
    expect(air?.reputation).toBe('0.35');
  });

  describe('replaying a settled flight', () => {
    it('is a no-op: one result row, and the cash moves once', async () => {
      const { flightId, airlineId } = await makeFlight();

      const first = await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));
      const cashAfterFirst = await cashOf(airlineId);

      const second = await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

      expect(first.status).toBe('settled');
      expect(second.status).toBe('already-settled');
      expect(await cashOf(airlineId)).toBe(cashAfterFirst);

      const rows = await db.db
        .select()
        .from(flightResult)
        .where(eq(flightResult.flightId, flightId));
      expect(rows).toHaveLength(1);
      const movements = await db.db
        .select()
        .from(cashMovement)
        .where(eq(cashMovement.reference, flightId));
      expect(movements).toHaveLength(1);
    });

    it('is refused by the database even if the guard is bypassed', async () => {
      // The guard is a select; the guarantee is the constraint. Proven by
      // inserting a second result directly, the way a bug or a race would.
      const { flightId, worldId, airlineId } = await makeFlight();
      await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

      await expectConstraint(
        db.db.insert(flightResult).values({
          worldId,
          flightId,
          airlineId,
          revenueMinor: 1,
          costMinor: 1,
          netMinor: 0,
          seats: 1,
          passengers: 0,
          blockSeconds: 60,
          breakdown: '{}',
          settlementVersion: 'v1',
          settledAt: ARRIVES,
        }),
        'flight_result_flight_id_unique',
      );
    });
  });

  it('refuses a result whose net does not reconcile', async () => {
    // The check constraint, proven directly. An application bug that computed the
    // net wrongly must not be able to persist it.
    const { flightId, worldId, airlineId } = await makeFlight();

    await expectConstraint(
      db.db.insert(flightResult).values({
        worldId,
        flightId,
        airlineId,
        revenueMinor: 1_000,
        costMinor: 400,
        netMinor: 999, // should be 600
        seats: 10,
        passengers: 5,
        blockSeconds: 60,
        breakdown: '{}',
        settlementVersion: 'v1',
        settledAt: ARRIVES,
      }),
      'flight_result_net_reconciles',
    );
  });

  it('settles a diversion to where the aircraft actually went', async () => {
    // §8.4: a diversion costs what it cost, not what was planned. The alternate
    // is far enough away that the distance, and so the fuel, must differ.
    const straight = await makeFlight();
    await db.db.transaction((tx) => settle(tx, straight.flightId, ARRIVES));

    const diverted = await makeFlight();
    const alternate = await makeAirport(48.8566, 2.3522);
    await db.db
      .update(flight)
      .set({ diversionIcao: alternate, disruption: 'diverted' })
      .where(eq(flight.id, diverted.flightId));
    await db.db.transaction((tx) => settle(tx, diverted.flightId, ARRIVES));

    const distanceOf = async (flightId: string): Promise<number> => {
      const [row] = await db.db
        .select()
        .from(flightResult)
        .where(eq(flightResult.flightId, flightId));
      return (JSON.parse(row?.breakdown ?? '{}') as { distanceNm: number }).distanceNm;
    };

    expect(await distanceOf(diverted.flightId)).toBeGreaterThan(
      await distanceOf(straight.flightId),
    );
  });

  it('bills a badly delayed arrival on its own ledger line (M5-05)', async () => {
    const { flightId, airlineId } = await makeFlight();
    // Four hours late at pushback — past the EU261 and duty-of-care thresholds.
    const late = new Date(DEPARTS.getTime() + 4 * 60 * 60_000);
    await db.db
      .update(flight)
      .set({ disruption: 'delayed', actualDeparture: late })
      .where(eq(flight.id, flightId));

    await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

    const movements = await db.db
      .select({
        cause: cashMovement.cause,
        amountMinor: cashMovement.amountMinor,
        reference: cashMovement.reference,
      })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    const disruption = movements.filter((m) => m.cause === 'disruption_cost');
    // A separate line from the flight's own settlement, and it costs money.
    expect(disruption).toHaveLength(1);
    expect(Number(disruption[0]?.amountMinor)).toBeLessThan(0);
    expect(disruption[0]?.reference).toBe(`${flightId}:disruption`);
    expect(movements.some((m) => m.cause === 'flight_settlement')).toBe(true);
  });

  it('bills no disruption cost for an on-time arrival', async () => {
    const { flightId, airlineId } = await makeFlight();
    await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

    const movements = await db.db
      .select({ cause: cashMovement.cause })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    expect(movements.some((m) => m.cause === 'disruption_cost')).toBe(false);
  });

  it('reports a flight that does not exist rather than inventing one', async () => {
    const outcome = await db.db.transaction((tx) => settle(tx, crypto.randomUUID(), ARRIVES));

    expect(outcome.status).toBe('not-found');
  });

  it('refuses a malformed load rather than settling a plausible wrong number', async () => {
    const { flightId } = await makeFlight({ load: '{"economy":{"seats":"lots"}}' });

    await expect(db.db.transaction((tx) => settle(tx, flightId, ARRIVES))).rejects.toThrow();

    const rows = await db.db.select().from(flightResult).where(eq(flightResult.flightId, flightId));
    expect(rows).toHaveLength(0);
  });

  describe('spill (A.5, M3-05)', () => {
    it('records the passengers a full flight turned away', async () => {
      // A.5 wants the game to be able to say "you turned away 40 passengers a
      // day". It has to survive settlement to be sayable, and it cannot be
      // recovered afterwards — a full aircraft looks the same either way.
      const { flightId } = await makeFlight({
        load: JSON.stringify({
          economy: { seats: 70, passengers: 70, revenue: 70 * 7_500, spilled: 40 },
        }),
      });

      await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

      const [row] = await db.db
        .select({
          seats: flightResult.seats,
          passengers: flightResult.passengers,
          spilled: flightResult.spilledPassengers,
        })
        .from(flightResult)
        .where(eq(flightResult.flightId, flightId));

      expect(row?.spilled).toBe(40);
      expect(row?.passengers).toBe(70);
      expect(row?.seats).toBe(70);
    });

    it('records zero for a load that predates the field', async () => {
      // `LOAD` has no `spilled`, which is every load written before M3-05.
      const { flightId } = await makeFlight({});

      await db.db.transaction((tx) => settle(tx, flightId, ARRIVES));

      const [row] = await db.db
        .select({ spilled: flightResult.spilledPassengers })
        .from(flightResult)
        .where(eq(flightResult.flightId, flightId));

      expect(row?.spilled).toBe(0);
    });

    it('is refused by the database when seats were going empty', async () => {
      // The constraint exists because the model's own guard is one new write
      // path away from being bypassed. Inserting directly is how that would
      // look, so that is what this asserts against.
      const { flightId, worldId, airlineId } = await makeFlight({});

      await expectConstraint(
        db.db.insert(flightResult).values({
          worldId,
          flightId,
          airlineId,
          revenueMinor: 0,
          costMinor: 0,
          netMinor: 0,
          kind: 'scheduled',
          seats: 70,
          passengers: 40,
          spilledPassengers: 12,
          blockSeconds: 3_600,
          breakdown: '{}',
          settlementVersion: 'test',
          settledAt: ARRIVES,
        }),
        'flight_result_spill_needs_a_full_aircraft',
      );
    });
  });

  it('pays for belly freight when the flight carried some', async () => {
    const empty = await makeFlight({ cargoKg: 0 });
    const laden = await makeFlight({ cargoKg: 2_000 });

    await db.db.transaction((tx) => settle(tx, empty.flightId, ARRIVES));
    await db.db.transaction((tx) => settle(tx, laden.flightId, ARRIVES));

    const revenueOf = async (flightId: string): Promise<number> => {
      const [row] = await db.db
        .select({ revenue: flightResult.revenueMinor })
        .from(flightResult)
        .where(eq(flightResult.flightId, flightId));
      return row?.revenue ?? 0;
    };

    expect(await revenueOf(laden.flightId)).toBeGreaterThan(await revenueOf(empty.flightId));
  });

  describe('the FLIGHT_ARRIVE handler', () => {
    // The wiring, not the fleet: `settle-aircraft.test.ts` runs this handler
    // with no deps at all against an aircraft acquired through the catalogue,
    // which is what proves the production resolver.
    const handler = createFlightArriveHandler({ resolveAirframe: fixtureAirframe });

    function event(fireAt: Date) {
      return { id: 'evt', fireAt } as Parameters<typeof handler>[0];
    }

    it('settles the flight its payload names', async () => {
      const { flightId, airlineId, openingCashMinor } = await makeFlight();

      await db.db.transaction((tx) => handler(event(ARRIVES), { payload: { flightId }, tx }));

      expect(await cashOf(airlineId)).not.toBe(openingCashMinor);
    });

    it('is safe to replay, which is what the queue does after a restart', async () => {
      const { flightId, airlineId } = await makeFlight();

      await db.db.transaction((tx) => handler(event(ARRIVES), { payload: { flightId }, tx }));
      const once = await cashOf(airlineId);
      await db.db.transaction((tx) => handler(event(ARRIVES), { payload: { flightId }, tx }));

      expect(await cashOf(airlineId)).toBe(once);
    });

    it('fails loudly on a payload with no flight', async () => {
      await expect(
        db.db.transaction((tx) => handler(event(ARRIVES), { payload: {}, tx })),
      ).rejects.toThrow(/flightId/);
    });

    it('fails loudly when the flight is gone — the queue and the table disagree', async () => {
      await expect(
        db.db.transaction((tx) =>
          handler(event(ARRIVES), { payload: { flightId: crypto.randomUUID() }, tx }),
        ),
      ).rejects.toThrow(/unknown flight/);
    });
  });

  it('names its arrival event the way the departure event is named', () => {
    // `departureKey` is `flight:<id>:depart`; these have to be a matched pair or
    // a rescheduling path will cancel one and leave the other.
    expect(arrivalKey('abc')).toBe('flight:abc:arrive');
  });
});
