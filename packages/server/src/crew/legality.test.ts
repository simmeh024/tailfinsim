import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft } from '../aircraft/acquisition';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport } from '../db/schema';
import { createSchedule } from '../schedule/store';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { hireCrew, openCrewBase } from './store';

/**
 * The crew rule reaching the scheduler (M5-01, §9.2).
 *
 * The acceptance criterion is *"every flight validates a legal complement before
 * departure"*. Nothing departs yet — `FLIGHT_DEPART` has no handler — so the
 * moment a flight comes into existence is `createSchedule`, and that is where
 * this proves the rule bites.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/legality.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('crew legality when a schedule is written', () => {
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

  /** A hub with an ICAO code, which `crew_base.airport_icao` needs. */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFL-${String(n)}`;
    // Four letters: `AircraftAcquisitionInput` requires a real ICAO shape, and a
    // digit in a test code fails validation rather than the thing under test.
    const icao = `T${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}X`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_200_000 + n),
        ident,
        icaoCode: icao,
        name: `Crew Legality Hub ${ident}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Could not create a hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  /**
   * A leased ATR, so there is a real airframe with a family and a seat count.
   *
   * Through `acquireAircraft` rather than an insert, because an airframe is
   * materialised from an order -- `source_order_id` is not nullable -- and
   * fabricating one here would be inventing a state M4-04 does not produce.
   *
   * The ATR 72-600 seats 70 in two classes, so a legal complement is a Captain,
   * a First Officer and two cabin crew: under the hundred-seat threshold, so no
   * Purser.
   */
  async function leaseAtr(fixture: FoundedAirlineFixture, icao: string): Promise<string> {
    // Leases take a deposit, and a founding balance is not sized for this test's
    // convenience. `flight_settlement` is the cause the maintenance suite uses
    // for the same top-up.
    // In a transaction, as the maintenance suite does. `airline_cash_reconciles`
    // checks the movement against the airline's balance, and outside one the
    // movement commits before the balance is updated -- so the trigger fires on a
    // state that only exists between two statements.
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 100_000_000,
        cause: 'flight_settlement',
        reference: `crew-legality-top-up-${randomUUID()}`,
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
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) throw new Error('Lease did not deliver');
    return acquired.airframe.id;
  }

  function rotation(fixture: FoundedAirlineFixture, airframeId: string, icao: string) {
    return {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airframeId,
      legs: [
        {
          originIcao: icao,
          destinationIcao: icao,
          departureMinute: 480,
          blockMinutes: 90,
          turnaroundMinutes: 40,
        },
      ],
      repeat: { kind: 'daily' as const },
    };
  }

  it('refuses a rotation from an airline with no crew, and says what is short', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });
    const airframeId = await leaseAtr(fixture, hub.icao);

    const saved = await createSchedule(db.db, rotation(fixture, airframeId, hub.icao));
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.problem).toBe('crew_illegal');
    // Actionable in one reading: the ranks and the numbers, not "no crew".
    expect(saved.detail).toContain('captain');
    expect(saved.detail).toContain('first officer');
  });

  it('lets a caller assert legality, for tests that are not about crew', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });
    const airframeId = await leaseAtr(fixture, hub.icao);

    // The escape hatch the fleet and maintenance suites use. It must skip the
    // read rather than pass it, or those suites would need crew pools to test
    // something else entirely.
    const saved = await createSchedule(db.db, rotation(fixture, airframeId, hub.icao), {
      crewLegal: true,
    });
    expect(saved.ok).toBe(true);
  });

  it('accepts the rotation once the airline holds a legal complement', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });
    const airframeId = await leaseAtr(fixture, hub.icao);

    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hub.icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);

    for (const [rank, heads] of [
      ['captain', 1],
      ['first_officer', 1],
      ['cabin_crew', 2],
    ] as const) {
      await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId: opened.value.crewBaseId,
        family: 'ATR 72',
        rank,
        heads,
      });
    }

    const saved = await createSchedule(db.db, rotation(fixture, airframeId, hub.icao));
    expect(saved.ok).toBe(true);
  });

  it('still refuses when the crew are rated on another family', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });
    const airframeId = await leaseAtr(fixture, hub.icao);

    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hub.icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);

    for (const [rank, heads] of [
      ['captain', 2],
      ['first_officer', 2],
      ['cabin_crew', 4],
    ] as const) {
      await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId: opened.value.crewBaseId,
        family: 'A320neo',
        rank,
        heads,
      });
    }

    // Plenty of crew, every one rated on the wrong aeroplane. This is §9.2's
    // commonality mechanic arriving at the scheduler rather than staying a
    // number on a page.
    const saved = await createSchedule(db.db, rotation(fixture, airframeId, hub.icao));
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.problem).toBe('crew_illegal');
  });
});
