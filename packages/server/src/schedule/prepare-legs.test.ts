import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EXTENDED_AUTHORITY_ROLE } from '@tailfin/shared';
import type { AircraftCapability } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, officeHire, route, runway } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { prepareLegs } from './authoring';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Resolving and opening a rotation's legs (M2-03, §8.2, App. B.4).
 *
 * The heart of multi-stop authoring: each leg reuses a route the airline holds or
 * opens one, range/reachability-checked against the airframe's capability, and an
 * auto-return leg is appended nonstop. Turns on a capability rather than a whole
 * airframe, so it needs no acquisition fixture. Requires `DATABASE_URL`; CI has it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [schedule/prepare-legs.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

/** A capable narrowbody: enough range and short enough field for the test airports. */
const CAPABILITY: AircraftCapability = {
  rangeNm: 4_000,
  takeoffRunM: 1_500,
  wingspanCode: 'C',
  etopsMinutes: null,
};

describeDb('prepareLegs', () => {
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
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  function code(): string {
    return `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  }

  /** An airport near London with a long, open runway, so a leg is reachable. */
  async function makeAirport(lat = 51.5, lon = -0.1): Promise<string> {
    const icao = code();
    const n = seq++;
    const [row] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_600_000 + n),
        ident: `PREP-${icao}`,
        icaoCode: icao,
        name: `Prep Field ${icao}`,
        isoCountry: 'GB',
        kind: 'large_airport',
        latitude: lat,
        longitude: lon,
        scheduledService: true,
        hasRunwayData: true,
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!row) throw new Error('no airport');
    await db.db.insert(runway).values({
      sourceId: -(9_600_000 + n),
      airportId: row.id,
      identifier: '09/27',
      lengthFt: 12_000, // ~3,650 m — comfortably above the reference field length
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeRoute(
    a: FoundedAirlineFixture,
    from: string,
    to: string,
    greatCircleNm: number,
  ): Promise<string> {
    const [row] = await db.db
      .insert(route)
      .values({
        worldId: a.world.id,
        airlineId: a.airline.id,
        originIcao: from,
        destinationIcao: to,
        greatCircleNm,
      })
      .returning({ id: route.id });
    if (!row) throw new Error('no route');
    return row.id;
  }

  /**
   * Hire the Safety & Compliance seat, so opening a long-haul leg (≥2,200 nm) is
   * permitted (§9.1). Without it `openRoute` refuses a long-haul pair for
   * `authority_required`, which is its own tested path — see the refusal cases.
   */
  async function grantExtendedAuthority(a: FoundedAirlineFixture): Promise<void> {
    await db.db.insert(officeHire).values({
      worldId: a.world.id,
      airlineId: a.airline.id,
      role: EXTENDED_AUTHORITY_ROLE,
      candidateId: 'prep-authority',
      candidateName: 'Prep Compliance',
      monthlySalaryMinor: 0,
    });
  }

  it('reuses a route the airline already holds', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport(48.8, 2.3);
    const routeId = await makeRoute(a, hub, out, 200);

    const result = await prepareLegs(
      db.db,
      own(a),
      CAPABILITY,
      [{ originIcao: hub, destinationIcao: out, departureMinuteLocal: 480 }],
      false,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legs).toHaveLength(1);
      expect(result.legs[0]?.routeId).toBe(routeId);
      expect(result.legs[0]?.opened).toBe(false);
    }
  });

  it('refuses a leg beyond the aircraft’s range', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport(40, -74);
    await makeRoute(a, hub, out, 5_000); // beyond the 4,000 nm capability

    const result = await prepareLegs(
      db.db,
      own(a),
      CAPABILITY,
      [{ originIcao: hub, destinationIcao: out, departureMinuteLocal: 480 }],
      false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe('unreachable');
  });

  it('opens a route for a hop the airline does not yet serve', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport(51.5, -0.1);
    const stop = await makeAirport(51.6, -0.2); // a few nm away — reachable, in range

    const result = await prepareLegs(
      db.db,
      own(a),
      CAPABILITY,
      [{ originIcao: hub, destinationIcao: stop, departureMinuteLocal: 480 }],
      false,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legs[0]?.opened).toBe(true);
    }
    // The route now exists.
    const held = await db.db
      .select({ id: route.id })
      .from(route)
      .where(eq(route.airlineId, a.airline.id));
    expect(held.length).toBeGreaterThanOrEqual(1);
  });

  it('appends a nonstop auto-return from the last stop to the first', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    await grantExtendedAuthority(a); // KEF→JFK and JFK→AMS are long-haul (≥2,200 nm).
    const ams = await makeAirport(52.3, 4.8);
    const kef = await makeAirport(64.1, -21.9);
    const jfk = await makeAirport(40.6, -73.8);
    // Multi-stop outbound AMS→KEF→JFK, all within range and reachable.

    const result = await prepareLegs(
      db.db,
      own(a),
      CAPABILITY,
      [
        { originIcao: ams, destinationIcao: kef, departureMinuteLocal: 480 },
        { originIcao: kef, destinationIcao: jfk, departureMinuteLocal: 700 },
      ],
      true,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legs).toHaveLength(3);
      const ret = result.legs[2];
      // Nonstop straight home: JFK → AMS, placed ASAP (no chosen time).
      expect(ret?.originIcao).toBe(jfk);
      expect(ret?.destinationIcao).toBe(ams);
      expect(ret?.departureMinuteLocal).toBeNull();
    }
  });

  it('refuses a leg to an airport that does not exist', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();

    const result = await prepareLegs(
      db.db,
      own(a),
      CAPABILITY,
      [{ originIcao: hub, destinationIcao: 'ZZZZ', departureMinuteLocal: 480 }],
      false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe('unknown_airport');
  });
});
