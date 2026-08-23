import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, cashMovement, crewPool } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  completeDueConversions,
  crewCanFly,
  hireCrew,
  openCrewBase,
  readCrewState,
  startCrewConversion,
} from './store';

/**
 * Crew rows, against a real database (M5-01, §9.2).
 *
 * The pure model has its own tests in `packages/sim`. What is worth proving here
 * is the part only Postgres can answer: that the money moves through AIR-06 with
 * the change, that a conversion takes crew off the roster and gives them back on
 * the world's clock, and that the mixed-fleet fragmentation the issue asks to be
 * *visible* is actually visible in the response.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/store.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('crew bases, pools and conversions', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    // Fixtures first: `crew_base` cascades from the airline, and the airport it
    // points at cannot go while a base still references it.
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * A hub that actually has an ICAO code.
   *
   * The default fixture airport deliberately has none — `found.test.ts` notes
   * that OurAirports' `ident` is the universal key and most records carry no
   * official ICAO. `crew_base.airport_icao` follows the eleven other operational
   * references in this schema and points at `airport.icao_code`, so a crew base
   * needs an airport that has one. CI found this; the first version of these
   * tests assumed the fixture hub would do.
   */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFC-${String(n)}`;
    // 'TC' is unassigned as a national prefix here, so this cannot collide with
    // an imported record.
    // Four letters: `AircraftAcquisitionInput` requires a real ICAO shape, and a
    // digit in a test code fails validation rather than the thing under test.
    /*
     * Prefixed per suite. Both crew suites generated `T??X` from a counter that
     * starts at zero in each file, so the very first airport in each produced the
     * identical ICAO — and `airport_icao_code_key` is unique, so whichever file
     * vitest ran second failed on a collision that looked like nothing to do with
     * crew.
     */
    const icao = `TC${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_100_000 + n),
        ident,
        icaoCode: icao,
        name: `Crew Test Hub ${ident}`,
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
    if (id === undefined) throw new Error('Could not create a crew test hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  /** Founded, never inserted — CLAUDE.md's rule, and AIR-11 removed the zero-cash state. */
  async function foundedAirline(): Promise<FoundedAirlineFixture> {
    const hub = await makeIcaoHub();
    return fixtures.create({ hubIdent: hub.ident });
  }

  /** The hub's ICAO code. `foundedAirline` guarantees there is one. */
  function hubIcao(fixture: FoundedAirlineFixture): string {
    const icao = fixture.hubAirport.icaoCode;
    if (icao === null) throw new Error('The founded fixture hub has no ICAO code');
    return icao;
  }

  async function baseFor(fixture: FoundedAirlineFixture): Promise<string> {
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hubIcao(fixture),
    });
    if (!opened.ok) throw new Error(`Could not open a base: ${opened.refusal}`);
    return opened.value.crewBaseId;
  }

  async function cashOf(airlineId: string): Promise<number> {
    const rows = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return rows[0]?.cashMinor ?? 0;
  }

  it('charges for a base through AIR-06, in the same transaction', async () => {
    const fixture = await foundedAirline();
    const before = await cashOf(fixture.airline.id);

    const crewBaseId = await baseFor(fixture);
    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);

    expect(state.bases.map((base) => base.id)).toEqual([crewBaseId]);
    expect(await cashOf(fixture.airline.id)).toBe(before - state.costs.baseOpeningMinor);

    // The ledger is the account of what happened, not a side effect of it.
    const movements = await db.db
      .select({ cause: cashMovement.cause, reference: cashMovement.reference })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, fixture.airline.id));
    expect(movements).toContainEqual({ cause: 'crew_base_opening', reference: crewBaseId });
  });

  it('refuses a second base at the same airport', async () => {
    const fixture = await foundedAirline();
    await baseFor(fixture);

    const again = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hubIcao(fixture),
    });
    expect(again).toEqual({ ok: false, refusal: 'base_exists' });
  });

  it('adds hires to one pool rather than making a second row', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);

    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 2,
    });
    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 3,
    });

    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);
    const pools = state.bases[0]?.pools ?? [];
    const captains = pools.filter((pool) => pool.rank === 'captain' && pool.family === 'A320neo');
    // One row, five heads: the unique constraint and the upsert together.
    expect(captains).toHaveLength(1);
    expect(captains[0]?.headcount).toBe(5);
  });

  it('refuses a hire larger than a week of capacity', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);

    const refused = await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: state.costs.weeklyHiringCapacity + 1,
    });
    // §9.2: you cannot buy a Captain instantly. Time is the only constraint money
    // cannot route around, so this has to be a refusal and not a price.
    expect(refused).toEqual({ ok: false, refusal: 'hiring_capacity' });
  });

  it('takes converting crew off the roster without hiding them', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 4,
    });

    const started = await startCrewConversion(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      fromFamily: 'A320neo',
      toFamily: '737 MAX',
      rank: 'captain',
      heads: 3,
    });
    expect(started.ok).toBe(true);

    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);
    const pool = state.bases[0]?.pools.find((p) => p.family === 'A320neo');
    // Still on strength, and visibly in a classroom. Removing them outright would
    // make the crew vanish for a fortnight with nothing to show for it.
    expect(pool?.headcount).toBe(4);
    expect(pool?.unavailable).toBe(3);
    expect(pool?.available).toBe(1);
    expect(state.bases[0]?.conversions).toHaveLength(1);
  });

  it('will not convert more heads than are available', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 2,
    });

    const refused = await startCrewConversion(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      fromFamily: 'A320neo',
      toFamily: '737 MAX',
      rank: 'captain',
      heads: 3,
    });
    expect(refused).toEqual({ ok: false, refusal: 'not_enough_heads' });
  });

  it('moves the heads across when the world clock reaches the completion', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 4,
    });
    const started = await startCrewConversion(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      fromFamily: 'A320neo',
      toFamily: '737 MAX',
      rank: 'captain',
      heads: 3,
    });
    if (!started.ok) throw new Error('expected the conversion to start');

    // A moment after the course ends, in game time.
    const after = new Date(started.value.completesAt.getTime() + 1000);
    expect(await completeDueConversions(db.db, fixture.world.id, after)).toEqual({ completed: 1 });

    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);
    const pools = state.bases[0]?.pools ?? [];
    expect(pools.find((p) => p.family === 'A320neo')?.headcount).toBe(1);
    expect(pools.find((p) => p.family === '737 MAX')?.headcount).toBe(3);
    // Nobody is left in a classroom that has finished.
    expect(pools.every((p) => p.unavailable === 0)).toBe(true);
    expect(state.bases[0]?.conversions).toHaveLength(0);
  });

  it('completes a conversion once, however many times the sweep runs', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 4,
    });
    const started = await startCrewConversion(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      fromFamily: 'A320neo',
      toFamily: '737 MAX',
      rank: 'captain',
      heads: 3,
    });
    if (!started.ok) throw new Error('expected the conversion to start');
    const after = new Date(started.value.completesAt.getTime() + 1000);

    await completeDueConversions(db.db, fixture.world.id, after);
    // The worker ticks every second and two of them may race a handover, so a
    // second pass must find nothing rather than move the heads twice.
    expect(await completeDueConversions(db.db, fixture.world.id, after)).toEqual({ completed: 0 });

    const rows = await db.db
      .select({ family: crewPool.family, headcount: crewPool.headcount })
      .from(crewPool)
      .where(eq(crewPool.crewBaseId, crewBaseId));
    expect(rows.find((r) => r.family === '737 MAX')?.headcount).toBe(3);
  });

  it('shows a mixed fleet fragmenting the pool', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    const hire = (family: string, rank: 'captain' | 'cabin_crew', heads: number) =>
      hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family,
        rank,
        heads,
      });

    await hire('A320neo', 'captain', 4);
    await hire('A320neo', 'cabin_crew', 5);
    await hire('737 MAX', 'captain', 2);

    const state = await readCrewState(db.db, fixture.world.id, fixture.airline.id);
    // The acceptance criterion, as a number the interface can print: eleven crew,
    // of whom only nine can fly the largest family's aeroplanes.
    expect(state.fragmentation.totalAvailable).toBe(11);
    expect(state.fragmentation.largestFamilyAvailable).toBe(9);
    expect(state.fragmentation.strandedHeads).toBe(2);
    expect(state.fragmentation.families).toEqual(['737 MAX', 'A320neo']);
  });

  it('answers the scheduling seam from the pools that actually exist', async () => {
    const fixture = await foundedAirline();
    const crewBaseId = await baseFor(fixture);
    const leg = { seats: 180, blockMinutes: 90 };

    // Nothing hired: an airline cannot fly before it has crew, which is the whole
    // point of wiring `RotationContext.crewLegal` to this.
    expect(await crewCanFly(db.db, fixture.airline.id, 'A320neo', leg)).toBe(false);

    for (const [rank, heads] of [
      ['captain', 1],
      ['first_officer', 1],
      ['purser', 1],
      ['cabin_crew', 3],
    ] as const) {
      await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: 'A320neo',
        rank,
        heads,
      });
    }

    expect(await crewCanFly(db.db, fixture.airline.id, 'A320neo', leg)).toBe(true);
    // The same crew, a different family: the commonality mechanic reaching the
    // scheduler rather than staying an interesting number on a page.
    expect(await crewCanFly(db.db, fixture.airline.id, '737 MAX', leg)).toBe(false);
  });
});
