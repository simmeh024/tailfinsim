import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AircraftSpec,
  AirframeDetailResponse,
  FleetAirframesResponse,
  SpecAxis,
} from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, flight, type WorldRow } from '../db/schema';
import { createSchedule } from '../schedule/store';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { acquireAircraft, deliverDueAircraftOrders } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';
import { airframeDetail, listFleet } from './fleet';
import { fleetMaintenance } from './maintenance';

/**
 * The fleet list and aircraft detail against real Postgres (M4-07).
 *
 * The decomposition arithmetic is proved without a database in
 * `packages/sim/src/aircraft/spec-decomposition.test.ts`. What needs Postgres:
 *
 *   - **the decomposition agrees with the stored `effective_spec`.** The one
 *     place M4-07 could produce two numbers for one fact, because the detail view
 *     recomputes a spec the acquisition already wrote to a column. If these ever
 *     diverge the build screen is explaining a different aeroplane from the one
 *     that is flying, and nothing else would notice.
 *   - **concealment.** ADR-0020: another airline's airframe must be
 *     indistinguishable from one that does not exist.
 *   - **location is folded from flights**, including a diversion — the case a
 *     stored column would get wrong.
 *   - **utilisation** measured from real block times, over a window that respects
 *     how long the aeroplane has existed.
 *   - **the wire contract**, parsed rather than asserted field by field.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [fleet.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

describeDb('the fleet', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
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

  async function makeAirport(): Promise<string> {
    const tag = Array.from({ length: 3 }, () => String.fromCharCode(randomInt(65, 91))).join('');
    const icao = `W${tag}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: randomInt(-2_147_483_648, 0),
        ident: icao,
        icaoCode: icao,
        name: `Fleet test ${tag}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('Airport was not created');
    madeAirports.push(created.id);
    return icao;
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /** Real-time instant at which this world's game clock reads `epoch + days`. */
  function atGameDay(world: WorldRow, days: number): Date {
    return new Date(world.launchDate.getTime() + (days * DAY_MS) / Number(world.speedMultiplier));
  }

  /** Game-time instant `days` after the epoch. */
  function gameDay(world: WorldRow, days: number): Date {
    return new Date(world.epoch.getTime() + days * DAY_MS);
  }

  async function acquire(
    fixture: FoundedAirlineFixture,
    designation: string,
    options: { at?: Date; deliverTo?: string } = {},
  ): Promise<{ airframeId: string; icao: string }> {
    const icao = options.deliverTo ?? (await makeAirport());
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: designation,
        deliveryAirportIcao: icao,
      },
      options.at ?? fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`Lease did not deliver: ${JSON.stringify(acquired)}`);
    }
    return { airframeId: acquired.airframe.id, icao };
  }

  async function topUp(fixture: FoundedAirlineFixture, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'flight_settlement',
        reference: `fleet-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /**
   * A **configured** airframe, which only the new-build path produces.
   *
   * A lease stores `build_option_ids: []` — App. C.5's used market and the
   * lessor's shelf both deliver an aircraft as it is, and only a factory order is
   * configured (C.3). So a decomposition test that leased an aeroplane and passed
   * `optionIds` would be asserting over zero steps and proving nothing. Hence the
   * full path: order, wait past the real-time lead, and let the delivery sweep
   * materialise the airframe exactly as the Worker would.
   *
   * None of the options used here needs research: `acquireAircraft` calls
   * `resolveOptions` with no held topics, so ETOPS and Cat IIIb are refused at
   * order time and cannot be part of a v1 build.
   */
  async function acquireConfigured(
    fixture: FoundedAirlineFixture,
    designation: string,
    optionIds: readonly string[],
  ): Promise<{ airframeId: string; icao: string }> {
    const icao = await makeAirport();
    // Enough for any type in the catalogue plus every option on it.
    await topUp(fixture, 500_000_000_000);

    const ordered = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'new',
        typeDesignation: designation,
        optionIds: [...optionIds],
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!ordered.ok) throw new Error(`Order refused: ${JSON.stringify(ordered)}`);
    // A new order delivers in real weeks (§7.2), never in game time.
    expect(ordered.airframe).toBeNull();

    const oneYearOn = new Date(fixture.world.launchDate.getTime() + 365 * DAY_MS);
    const swept = await deliverDueAircraftOrders(db.db, fixture.world.id, oneYearOn);
    expect(swept.delivered).toBe(1);

    const [row] = await db.db
      .select({ id: airframe.id })
      .from(airframe)
      .where(eq(airframe.sourceOrderId, ordered.order.id));
    if (!row) throw new Error('Delivery sweep produced no airframe');
    return { airframeId: row.id, icao };
  }

  // -------------------------------------------------------------------------
  // The claim that matters most
  // -------------------------------------------------------------------------

  describe('the effective spec, taken apart', () => {
    it('decomposes to exactly the spec the acquisition stored', async () => {
      const fixture = await fixtures.create();
      // A build that moves several axes at once, including two multiplicative
      // burn factors — the case a naive per-option readout gets wrong.
      const { airframeId } = await acquireConfigured(fixture, 'A320neo', [
        'sharklets',
        'efficiency-package',
        'mtow-increase',
      ]);

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      if (detail === null) throw new Error('no detail');

      const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      const stored = AircraftSpec.parse(JSON.parse(row?.effectiveSpec ?? '{}'));

      // The column the simulation bills from, and the spec the build screen
      // explains, are the same aeroplane.
      expect(detail.spec.effective).toEqual(stored);

      // And the steps add up to it, on every axis.
      for (const axis of SpecAxis.options) {
        const summed = detail.spec.steps.reduce((total, step) => {
          const moved = step.movements.find((movement) => movement.axis === axis);
          return moved === undefined ? total : total + (moved.after - moved.before);
        }, detail.spec.base[axis]);
        expect(summed, axis).toBeCloseTo(stored[axis], 9);
      }
    });

    it('names each option and says which category the charge came from', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquireConfigured(fixture, 'A320neo', ['sharklets']);

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      const step = detail?.spec.steps[0];

      // Words, not ids: this is a readout a player reasons with.
      expect(step?.optionId).toBe('sharklets');
      expect(step?.label).toBe('Sharklets');
      expect(step?.category).toBe('aerodynamic');
      expect(step?.summary).toBeTruthy();
      // C.3 rule 3's whole point — a fuel-saving option that can strand you at
      // your own gate — is only visible if the code change is reported.
      expect(step?.wingspan).toEqual({ before: 'C', after: 'D' });
      expect(detail?.options.map((option) => option.id)).toEqual(['sharklets']);
    });

    it('has no steps for an aircraft ordered off the shelf', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquire(fixture, 'ATR 72-600');

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      expect(detail?.spec.steps).toEqual([]);
      expect(detail?.spec.effective).toEqual(detail?.spec.base);
      // Nothing writes a cabin yet (§6.1 is M6's), and that is reported rather
      // than omitted so "no cabin fitted" is a state a player can see.
      expect(detail?.cabinConfigId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Concealment
  // -------------------------------------------------------------------------

  describe('an airframe that is not yours', () => {
    it('is indistinguishable from one that does not exist', async () => {
      const mine = await fixtures.create();
      const theirs = await fixtures.create({ worldId: mine.world.id });
      const { airframeId } = await acquire(theirs, 'ATR 72-600');

      // Scoped by the session-resolved owner, so there is no state in which this
      // could answer "exists, but not yours" (ADR-0020).
      expect(await airframeDetail(db.db, own(mine), airframeId)).toBeNull();
      expect(await airframeDetail(db.db, own(mine), randomUUID())).toBeNull();
      // And it is not in the list either.
      const list = await listFleet(db.db, own(mine));
      expect(list.airframes).toEqual([]);
    });

    it('is still visible to its own airline', async () => {
      const mine = await fixtures.create();
      const theirs = await fixtures.create({ worldId: mine.world.id });
      const { airframeId } = await acquire(theirs, 'ATR 72-600');

      expect(await airframeDetail(db.db, own(theirs), airframeId)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Where it is
  // -------------------------------------------------------------------------

  describe('location', () => {
    it('starts at the delivery airport and follows the flights', async () => {
      const fixture = await fixtures.create();
      const home = await makeAirport();
      const away = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: home });

      let list = await listFleet(db.db, own(fixture));
      expect(list.airframes[0]?.locationIcao).toBe(home);

      await db.db.insert(flight).values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        originIcao: home,
        destinationIcao: away,
        phase: 'turnaround',
        scheduledDeparture: gameDay(fixture.world, 1),
        estimatedArrival: gameDay(fixture.world, 1),
        actualDeparture: gameDay(fixture.world, 1),
        actualArrival: new Date(gameDay(fixture.world, 1).getTime() + 2 * HOUR_MS),
        load: '{}',
      });

      list = await listFleet(db.db, own(fixture));
      expect(list.airframes[0]?.locationIcao).toBe(away);
    });

    it('leaves the aircraft where it diverted to, not where it was aimed', async () => {
      const fixture = await fixtures.create();
      const home = await makeAirport();
      const planned = await makeAirport();
      const actual = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: home });

      await db.db.insert(flight).values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        originIcao: home,
        destinationIcao: planned,
        diversionIcao: actual,
        phase: 'turnaround',
        scheduledDeparture: gameDay(fixture.world, 1),
        estimatedArrival: gameDay(fixture.world, 1),
        actualDeparture: gameDay(fixture.world, 1),
        actualArrival: new Date(gameDay(fixture.world, 1).getTime() + 2 * HOUR_MS),
        load: '{}',
      });

      // The case that makes derivation worth having rather than merely tidy: a
      // stored position updated on arrival would have to remember to handle it.
      const list = await listFleet(db.db, own(fixture));
      expect(list.airframes[0]?.locationIcao).toBe(actual);
    });

    it('ignores a flight that has not gone anywhere yet', async () => {
      const fixture = await fixtures.create();
      const home = await makeAirport();
      const away = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: home });

      await db.db.insert(flight).values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        originIcao: home,
        destinationIcao: away,
        phase: 'scheduled',
        scheduledDeparture: gameDay(fixture.world, 1),
        estimatedArrival: gameDay(fixture.world, 1),
        load: '{}',
      });

      const list = await listFleet(db.db, own(fixture));
      expect(list.airframes[0]?.locationIcao).toBe(home);
    });
  });

  // -------------------------------------------------------------------------
  // Utilisation
  // -------------------------------------------------------------------------

  describe('utilisation', () => {
    it('is block hours flown over the days the aeroplane has existed', async () => {
      const fixture = await fixtures.create();
      const home = await makeAirport();
      const away = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: home });

      // Two three-hour sectors on game day one.
      for (const hour of [8, 14]) {
        const off = new Date(gameDay(fixture.world, 1).getTime() + hour * HOUR_MS);
        await db.db.insert(flight).values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId,
          originIcao: home,
          destinationIcao: away,
          phase: 'turnaround',
          scheduledDeparture: off,
          estimatedArrival: new Date(off.getTime() + 3 * HOUR_MS),
          actualDeparture: off,
          actualArrival: new Date(off.getTime() + 3 * HOUR_MS),
          load: '{}',
        });
      }

      // Read at game day three: the aeroplane has existed for three days, so the
      // window is three rather than the full seven.
      const list = await listFleet(db.db, own(fixture), atGameDay(fixture.world, 3));
      const utilisation = list.airframes[0]?.utilisation;
      expect(utilisation?.blockHours).toBeCloseTo(6, 6);
      expect(utilisation?.windowDays).toBeCloseTo(3, 3);
      expect(utilisation?.blockHoursPerDay).toBeCloseTo(2, 3);
    });

    it('has no rate for an aeroplane that arrived less than a day ago', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquire(fixture, 'ATR 72-600');

      // Null rather than zero, and rather than a rate divided by an hour. A rate
      // over a fraction of a day swings for reasons a player cannot see, and §2488
      // fires an onboarding warning off exactly this number.
      const list = await listFleet(db.db, own(fixture), fixture.world.launchDate);
      expect(list.airframes[0]?.airframeId).toBe(airframeId);
      expect(list.airframes[0]?.utilisation).toBeNull();
    });

    it('counts only flights inside the window', async () => {
      const fixture = await fixtures.create();
      const home = await makeAirport();
      const away = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: home });

      // One sector on game day one, one on game day twenty. Read at day twenty-one,
      // only the second is inside the seven-day window.
      for (const day of [1, 20]) {
        const off = new Date(gameDay(fixture.world, day).getTime() + 8 * HOUR_MS);
        await db.db.insert(flight).values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId,
          originIcao: home,
          destinationIcao: away,
          phase: 'turnaround',
          scheduledDeparture: off,
          estimatedArrival: new Date(off.getTime() + 4 * HOUR_MS),
          actualDeparture: off,
          actualArrival: new Date(off.getTime() + 4 * HOUR_MS),
          load: '{}',
        });
      }

      const list = await listFleet(db.db, own(fixture), atGameDay(fixture.world, 21));
      const utilisation = list.airframes[0]?.utilisation;
      expect(utilisation?.blockHours).toBeCloseTo(4, 6);
      expect(utilisation?.windowDays).toBeCloseTo(7, 3);
    });
  });

  // -------------------------------------------------------------------------
  // The list as a list
  // -------------------------------------------------------------------------

  describe('the fleet table', () => {
    it('is empty rather than an error for an airline with no aircraft', async () => {
      const fixture = await fixtures.create();
      expect(await listFleet(db.db, own(fixture))).toEqual({ airframes: [] });
    });

    it('puts the aeroplane that cannot fly first', async () => {
      const fixture = await fixtures.create();
      const flyable = await acquire(fixture, 'ATR 72-600');
      const stuck = await acquire(fixture, 'Dash 8-400');

      await db.db
        .update(airframe)
        .set({ status: 'grounded' })
        .where(eq(airframe.id, stuck.airframeId));

      const list = await listFleet(db.db, own(fixture), atGameDay(fixture.world, 2));
      expect(list.airframes.map((row) => row.airframeId)).toEqual([
        stuck.airframeId,
        flyable.airframeId,
      ]);
      expect(list.airframes[0]?.status).toBe('grounded');
    });

    it('quotes the tier closest to due, with the limit that binds it', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquire(fixture, 'ATR 72-600');

      const list = await listFleet(db.db, own(fixture), atGameDay(fixture.world, 2));
      const next = list.airframes[0]?.nextCheck;
      // Both remaining figures and the binding one, because M4-06 established
      // that "210 cycles from an A-check" is a plan and "soonish" is not.
      expect(next?.tier).toBe('a');
      expect(next?.binding === 'hours' || next?.binding === 'cycles').toBe(true);
      expect(next?.hoursRemaining).toBeGreaterThan(0);
      expect(next?.costMinor).toBeGreaterThan(0);
      expect(list.airframes[0]?.airframeId).toBe(airframeId);
    });

    it('agrees with the maintenance endpoint about the same aeroplane', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquire(fixture, 'A320neo');

      const [list, maintenance] = await Promise.all([
        listFleet(db.db, own(fixture), atGameDay(fixture.world, 2)),
        fleetMaintenance(db.db, own(fixture)),
      ]);

      const row = list.airframes.find((entry) => entry.airframeId === airframeId);
      const view = maintenance.airframes.find((entry) => entry.airframeId === airframeId);
      // Two assemblers, one shape. Which function built it does not matter; that
      // they cannot disagree does — a fleet table saying an aeroplane is fine
      // while the maintenance page says it is grounded is the worst kind of bug.
      expect(row?.technicalRisk).toBe(view?.technicalRisk);
      expect(row?.airworthy).toBe(view?.airworthy);
      expect(row?.nextCheck?.tier).toBe(
        [...(view?.tiers ?? [])].sort((a, b) => b.usedFraction - a.usedFraction)[0]?.tier,
      );
    });

    it('reports provenance, so a used airframe does not read as new', async () => {
      const fixture = await fixtures.create();
      const { airframeId, icao } = await acquire(fixture, 'ATR 72-600');

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      expect(detail?.provenance.deliveredToIcao).toBe(icao);
      expect(detail?.provenance.acquisitionKind).toBe('lease');
      // A leased new-build has no build date, so age is honestly unknown rather
      // than silently the delivery date.
      expect(detail?.airframe.ageYears).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Assignment
  // -------------------------------------------------------------------------

  describe('assignment', () => {
    it('names the rotations an aeroplane flies, legs in order', async () => {
      const fixture = await fixtures.create();
      const a = await makeAirport();
      const b = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: a });

      const saved = await createSchedule(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        legs: [
          {
            originIcao: a,
            destinationIcao: b,
            departureMinute: 480,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
          {
            originIcao: b,
            destinationIcao: a,
            departureMinute: 660,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
        ],
        repeat: { kind: 'daily' },
      });
      if (!saved.ok) throw new Error(`schedule refused: ${saved.problem}`);

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      const assignment = detail?.assignments[0];
      expect(detail?.assignments).toHaveLength(1);
      expect(assignment?.repeat).toEqual({ kind: 'daily' });
      expect(assignment?.legs.map((leg) => leg.legIndex)).toEqual([0, 1]);
      expect(assignment?.legs.map((leg) => leg.originIcao)).toEqual([a, b]);
      // The plan's own block time, so it can be compared with what actually flew.
      expect(assignment?.dailyBlockMinutes).toBe(180);
      expect(detail?.airframe.activeScheduleCount).toBe(1);
    });

    it('reports a weekly pattern as its days rather than as an empty list', async () => {
      const fixture = await fixtures.create();
      const a = await makeAirport();
      const b = await makeAirport();
      const { airframeId } = await acquire(fixture, 'ATR 72-600', { deliverTo: a });

      const saved = await createSchedule(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        legs: [
          {
            originIcao: a,
            destinationIcao: b,
            departureMinute: 480,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
          {
            originIcao: b,
            destinationIcao: a,
            departureMinute: 660,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
        ],
        repeat: { kind: 'weekdays', days: [2, 5] },
      });
      if (!saved.ok) throw new Error(`schedule refused: ${saved.problem}`);

      const detail = await airframeDetail(db.db, own(fixture), airframeId);
      // `network.ts` refuses the "empty array means every day" convention, and the
      // round trip through two database columns has to preserve that.
      expect(detail?.assignments[0]?.repeat).toEqual({ kind: 'weekdays', days: [2, 5] });
    });
  });

  // -------------------------------------------------------------------------
  // The wire contract
  // -------------------------------------------------------------------------

  describe('the wire contract', () => {
    it('parses what the assembler produces, strictly', async () => {
      const fixture = await fixtures.create();
      const { airframeId } = await acquireConfigured(fixture, 'A321XLR', ['sharklets', 'act-3']);

      const list = await listFleet(db.db, own(fixture));
      const detail = await airframeDetail(db.db, own(fixture), airframeId);

      // Parsed, not asserted field by field. Every schema is `.strict()`, so a
      // field the assembler grew that the contract does not declare fails here
      // as well as being stripped by Fastify's serialiser.
      expect(() => FleetAirframesResponse.parse(list)).not.toThrow();
      expect(() => AirframeDetailResponse.parse(detail)).not.toThrow();
    });
  });
});
