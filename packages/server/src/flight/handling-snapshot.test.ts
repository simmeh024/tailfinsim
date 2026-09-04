import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airlineHub, airport, flight, flightResult } from '../db/schema';
import { openSelfHandling, signContract } from '../ground/contracts';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { departFlight } from './depart';
import { settleArrivedFlight } from './settle';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * A flight is billed for the handler that worked its turn (BUG-02, M5-06).
 *
 * The settlement used to resolve the arrangement at **arrival**, from live
 * `ground_contract` and `ground_self_handling` rows. Those are mutable and the
 * flight is not, so two things were wrong at once:
 *
 *   - a player who switched handlers between a flight's departure and its
 *     arrival moved that flight's bill, in either direction;
 *   - settling the same flight from the same stored state produced a different
 *     figure once anything had changed — which is exactly what
 *     `settleArrivedFlight`'s own doc comment promises will not happen
 *     (invariant 2, and M13-01's replay harness).
 *
 * `flight.handling_price_factor` is the snapshot, taken where the turn happens.
 * The fuel half of the same settlement already worked this way, reading the
 * world curve at the stored departure instant.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/handling-snapshot.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

/** A dispatch that always goes, so the test does not need a staffed crew base. */
const ALWAYS_GO = () =>
  Promise.resolve({
    status: 'go' as const,
    dutyPeriodId: randomUUID(),
    marginMinutes: 120,
    usedReserve: false,
  });

/** No ground disruption, so the roll cannot turn a departure into a delay. */
const NEVER_DISRUPTED = () => Promise.resolve(null);

describeDb('the handling a flight is billed for', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let seq = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  async function makeAirport(icao: string): Promise<string> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_950_000 + n),
        ident: `SNAP-${icao}`,
        icaoCode: icao,
        name: `Snapshot Test ${icao}`,
        isoCountry: 'NL',
        continent: 'EU',
        kind: 'large_airport',
        latitude: 52.3 + n * 0.01,
        longitude: 4.76 + n * 0.01,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'large',
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    return icao;
  }

  async function giveHub(fixture: FoundedAirlineFixture, icao: string): Promise<void> {
    const [row] = await db.db
      .select({ id: airport.id })
      .from(airport)
      .where(eq(airport.icaoCode, icao))
      .limit(1);
    if (!row) throw new Error(`no airport ${icao}`);
    await db.db
      .insert(airlineHub)
      .values({ airlineId: fixture.airline.id, airportId: row.id })
      .onConflictDoNothing();
  }

  const DEPARTS = new Date('2026-08-17T06:00:00.000Z');
  const ARRIVES = new Date('2026-08-17T07:15:00.000Z');

  /** A scheduled flight, not yet departed. */
  async function makeFlight(
    fixture: FoundedAirlineFixture,
    origin: string,
    destination: string,
  ): Promise<string> {
    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: randomUUID(),
        originIcao: origin,
        destinationIcao: destination,
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } }),
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');
    return f.id;
  }

  async function depart(flightId: string): Promise<void> {
    const outcome = await departFlight(db.db, flightId, DEPARTS, {
      dispatch: ALWAYS_GO,
      disruption: NEVER_DISRUPTED,
    });
    expect(outcome.status).toBe('departed');
  }

  async function handlingOf(flightId: string): Promise<number> {
    const [row] = await db.db
      .select({ breakdown: flightResult.breakdown })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    if (!row) throw new Error('no result');
    const breakdown = JSON.parse(row.breakdown) as {
      costs: { source: string; amountMinor: number }[];
    };
    const line = breakdown.costs.find((c) => c.source === 'handling');
    if (!line) throw new Error('no handling line');
    return line.amountMinor;
  }

  async function snapshotOf(flightId: string): Promise<number | null> {
    const [row] = await db.db
      .select({ factor: flight.handlingPriceFactor })
      .from(flight)
      .where(eq(flight.id, flightId));
    return row?.factor ?? null;
  }

  it('records what the turn cost at the moment the aeroplane left', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('SNA1');
    const destination = await makeAirport('SNA2');
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'premium' });

    const id = await makeFlight(a, origin, destination);
    expect(await snapshotOf(id)).toBeNull();
    await depart(id);
    // Premium is the dearest grade a vendor sells.
    expect(await snapshotOf(id)).toBeCloseTo(1.5, 10);
  });

  it('does not move when the handler changes mid-flight', async () => {
    // The defect, exactly: a premium handler worked the turn, the player switched
    // to budget while the aeroplane was airborne, and the flight was billed
    // budget for work premium did.
    const a = await fixtures.create();
    const origin = await makeAirport('SNB1');
    const destination = await makeAirport('SNB2');
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'premium' });

    const id = await makeFlight(a, origin, destination);
    await depart(id);

    // Airborne. Now change everything about how the station is handled.
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });
    await giveHub(a, origin);
    await openSelfHandling(db.db, own(a), origin, { serviceLine: 'ramp_baggage', headcount: 28 });

    await db.db.transaction((tx) => settleArrivedFlight(tx, id, ARRIVES));

    // The bill is the premium turn the aeroplane actually had.
    const premiumOnly = await fixtures.create();
    const cleanOrigin = await makeAirport('SNB3');
    await signContract(db.db, own(premiumOnly), cleanOrigin, {
      serviceLine: 'ramp_baggage',
      grade: 'premium',
    });
    const reference = await makeFlight(premiumOnly, cleanOrigin, destination);
    await depart(reference);
    await db.db.transaction((tx) => settleArrivedFlight(tx, reference, ARRIVES));

    expect(await handlingOf(id)).toBe(await handlingOf(reference));
  });

  it('bills a walk-up departure as walk-up even if a contract is signed mid-flight', async () => {
    // The same defect in the other direction, and the cheaper-looking one: sign a
    // handler while the aeroplane is airborne and its turn was retrospectively
    // discounted for a contract that did not exist when it left.
    const a = await fixtures.create();
    const origin = await makeAirport('SNC1');
    const destination = await makeAirport('SNC2');

    const id = await makeFlight(a, origin, destination);
    await depart(id);
    const atDeparture = await snapshotOf(id);
    expect(atDeparture).toBeGreaterThan(1);

    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });
    await db.db.transaction((tx) => settleArrivedFlight(tx, id, ARRIVES));

    expect(await snapshotOf(id)).toBe(atDeparture);
  });

  it('settles a flight that departed before the snapshot existed', async () => {
    // `handling_price_factor` is null for anything already airborne when this
    // deployed. Null means "not recorded", not "standard rate", so those resolve
    // live — the way every flight did before the column.
    const a = await fixtures.create();
    const origin = await makeAirport('SND1');
    const destination = await makeAirport('SND2');
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });

    const id = await makeFlight(a, origin, destination);
    // Airborne without ever passing the dispatch gate, as a pre-deploy flight is.
    await db.db
      .update(flight)
      .set({ phase: 'cruise', actualDeparture: DEPARTS })
      .where(eq(flight.id, id));
    expect(await snapshotOf(id)).toBeNull();

    const outcome = await db.db.transaction((tx) => settleArrivedFlight(tx, id, ARRIVES));
    expect(outcome.status).toBe('settled');
    expect(await handlingOf(id)).toBeGreaterThan(0);
  });

  it('snapshots a ferry too, which never passes the dispatch gate', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('SNE1');
    const destination = await makeAirport('SNE2');
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });

    const { createFerryFlight } = await import('./ferry');
    const created = await createFerryFlight(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: randomUUID(),
      fromIcao: origin,
      toIcao: destination,
      departAt: DEPARTS,
      cruiseSpeedKt: 447,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    // A positioning leg is still a turn somebody works, and it is billed for one.
    expect(await snapshotOf(created.flightId)).toBeCloseTo(0.7, 10);
  });
});
