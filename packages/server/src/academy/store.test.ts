import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import { gameTime, realTimeAtGameTime, type WorldClock } from '@tailfin/sim';

import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { moveAirlineCash } from '../airline/cash';
import { openCrewBase, startCrewConversion } from '../crew/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { academy, airline, airport, cashMovement, crewConversion } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  buildAcademyModule,
  completeDueAcademyBuilds,
  foundAcademy,
  readAcademies,
  runAcademyUpkeep,
  upgradeAcademy,
} from './store';

/**
 * The training academy against a real database (M9-01, §10.1).
 *
 * The pure ladder has its own tests in `packages/sim`. What is worth proving
 * here is the part only Postgres can answer: that the capital moves through
 * AIR-06 with the row, that a build finishes on the **world's** clock and not
 * before, that the slot limit survives being read and written concurrently, and
 * that upkeep bills once a month however often the sweep runs.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [academy/store.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const BALANCE = ECONOMY_CONFIG_V1.academy;
const MARKET_CONVERSION = ECONOMY_CONFIG_V1.crew.conversion.costPerHeadMinor;

describeDb('the training academy', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  const nextAirport = createAirportIdentities('academy/store');

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    // The full-flight sim is per aircraft family, so the picker needs a
    // catalogue to draw families from. Insert-if-absent, like every seed.
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    // Fixtures first: `crew_base` cascades from the airline and `academy` from
    // the base, and the airport cannot go while a base still references it.
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  /** A hub with a real ICAO code — `crew_base.airport_icao` needs one. */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Academy Test Hub ${identity.ident}`,
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
    if (!created) throw new Error('Could not create an academy test hub');
    madeAirports.push(created.id);
    return { ident: identity.ident, icao: identity.icaoCode };
  }

  /** Founded, never inserted — CLAUDE.md's rule. */
  async function foundedAirline(): Promise<FoundedAirlineFixture> {
    const hub = await makeIcaoHub();
    return fixtures.create({ hubIdent: hub.ident });
  }

  function ownerOf(fixture: FoundedAirlineFixture) {
    return { worldId: fixture.world.id, airlineId: fixture.airline.id };
  }

  function clockOf(fixture: FoundedAirlineFixture): WorldClock {
    return {
      epoch: fixture.world.epoch,
      launchDate: fixture.world.launchDate,
      speedMultiplier: Number(fixture.world.speedMultiplier),
    };
  }

  function gameNowOf(fixture: FoundedAirlineFixture): Date {
    return gameTime(clockOf(fixture), new Date());
  }

  async function baseFor(fixture: FoundedAirlineFixture): Promise<string> {
    const icao = fixture.hubAirport.icaoCode;
    if (icao === null) throw new Error('The founded fixture hub has no ICAO code');
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: icao,
    });
    if (!opened.ok) throw new Error(`Could not open a base: ${opened.refusal}`);
    return opened.value.crewBaseId;
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return row?.cashMinor ?? 0;
  }

  /**
   * Put money in, through a movement.
   *
   * A founding airline holds 50,000,000 and level 4 alone costs 40,000,000 —
   * which is §10.1's *"a level 5 academy at a base with 12 aircraft is a money
   * pit"* working exactly as intended, and means a test that wants a large
   * academy has to buy one. Never `update airline set cash_minor`: the AIR-06
   * reconciliation trigger refuses a balance that no movement explains.
   */
  async function fund(airlineId: string, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor,
        cause: 'admin_adjustment',
        reference: `academy-test-funding:${randomUUID()}`,
        occurredAt: new Date(),
      }),
    );
  }

  /**
   * Found an academy and carry it all the way to a commissioned level.
   *
   * The whole point of the feature is that this takes time, so the test has to
   * move the world's clock rather than the row: each level is commissioned by
   * sweeping at the game instant the build was promised for.
   */
  async function commissionTo(
    fixture: FoundedAirlineFixture,
    level: 1 | 2 | 3 | 4 | 5,
  ): Promise<string> {
    // Enough for every level and every module, so the ladder rather than the
    // purse is what these tests exercise.
    await fund(fixture.airline.id, 500_000_000);
    const crewBaseId = await baseFor(fixture);
    const founded = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
    if (!founded.ok) throw new Error(`Could not found an academy: ${founded.refusal}`);

    let readyAt = founded.value.readyAt;
    for (let target = 1; target <= level; target += 1) {
      await completeDueAcademyBuilds(db.db, fixture.world.id, readyAt);
      if (target === level) break;
      const upgraded = await upgradeAcademy(db.db, ownerOf(fixture), founded.value.academyId);
      if (!upgraded.ok) throw new Error(`Could not upgrade: ${upgraded.refusal}`);
      readyAt = upgraded.value.readyAt;
    }
    return founded.value.academyId;
  }

  // -------------------------------------------------------------------------

  describe('founding', () => {
    it('charges level 1 through AIR-06 and leaves a building site', async () => {
      const fixture = await foundedAirline();
      const before = await cashOf(fixture.airline.id);
      const crewBaseId = await baseFor(fixture);
      const afterBase = await cashOf(fixture.airline.id);

      const result = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(await cashOf(fixture.airline.id)).toBe(
        afterBase - BALANCE.levels['1'].capitalCostMinor,
      );
      expect(before).toBeGreaterThan(afterBase);

      const [movement] = await db.db
        .select({ cause: cashMovement.cause, amountMinor: cashMovement.amountMinor })
        .from(cashMovement)
        .where(eq(cashMovement.reference, `${result.value.academyId}:level:1`));
      expect(movement?.cause).toBe('academy_construction');
      expect(movement?.amountMinor).toBe(-BALANCE.levels['1'].capitalCostMinor);

      // Level 0: the money is spent and nothing has arrived.
      const state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies).toHaveLength(1);
      expect(state.academies[0]?.level).toBe(0);
      expect(state.academies[0]?.pendingLevel).toBe(1);
      expect(state.academies[0]?.ceiling).toBeNull();
      expect(state.sites).toHaveLength(0);
    });

    it('refuses a second academy at the same base', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      expect((await foundAcademy(db.db, ownerOf(fixture), crewBaseId)).ok).toBe(true);
      const second = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
      expect(second).toEqual({ ok: false, refusal: 'academy_exists' });
    });

    it('conceals another airline’s crew base as absent, and moves no money', async () => {
      const mine = await foundedAirline();
      const theirs = await foundedAirline();
      const theirBase = await baseFor(theirs);

      const before = await cashOf(mine.airline.id);
      const result = await foundAcademy(db.db, ownerOf(mine), theirBase);
      expect(result).toEqual({ ok: false, refusal: 'base_absent' });
      // SEC-07: a refused write leaves the money and the rows untouched.
      expect(await cashOf(mine.airline.id)).toBe(before);
      expect(
        await db.db
          .select({ id: academy.id })
          .from(academy)
          .where(eq(academy.crewBaseId, theirBase)),
      ).toHaveLength(0);
    });

    it('lists an open base with no academy as a site, priced', async () => {
      const fixture = await foundedAirline();
      await baseFor(fixture);
      const state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies).toHaveLength(0);
      expect(state.sites).toHaveLength(1);
      expect(state.sites[0]?.quote.capitalCostMinor).toBe(BALANCE.levels['1'].capitalCostMinor);
      expect(state.outsourcedConversionPerHeadMinor).toBe(MARKET_CONVERSION);
    });
  });

  /** AC3: build time cannot be shortened — by money or by anything else. */
  describe('construction', () => {
    it('does not commission before the world clock reaches the promised instant', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      const founded = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
      if (!founded.ok) throw new Error('found failed');

      const oneSecondEarly = new Date(founded.value.readyAt.getTime() - 1000);
      const early = await completeDueAcademyBuilds(db.db, fixture.world.id, oneSecondEarly);
      expect(early.levelsCommissioned).toBe(0);
      expect((await readAcademies(db.db, ownerOf(fixture))).academies[0]?.level).toBe(0);

      const swept = await completeDueAcademyBuilds(db.db, fixture.world.id, founded.value.readyAt);
      expect(swept.levelsCommissioned).toBe(1);

      const state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies[0]?.level).toBe(1);
      expect(state.academies[0]?.pendingLevel).toBeNull();
      expect(state.academies[0]?.levelName).toBe('Training Room');
      expect(state.academies[0]?.ceiling?.researchTier).toBe(1);
      expect(state.academies[0]?.ceiling?.trainingSlots).toBe(BALANCE.levels['1'].trainingSlots);
    });

    it('promises the build in the world’s weeks, not the wall clock’s (ADR-0026)', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      const before = gameNowOf(fixture);
      const founded = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
      if (!founded.ok) throw new Error('found failed');

      const weeks = BALANCE.levels['1'].buildWeeks;
      const gameSpanMs = founded.value.readyAt.getTime() - before.getTime();
      expect(gameSpanMs).toBeGreaterThanOrEqual(weeks * 7 * 86_400_000 - 5_000);
      expect(gameSpanMs).toBeLessThanOrEqual(weeks * 7 * 86_400_000 + 5_000);

      /*
       * And it is a *game* span: at the world's speed the real wait is shorter,
       * which is the whole of ADR-0026 in one assertion. A wall-clock
       * `construction_ready_at` would make these two equal.
       */
      const realReady = realTimeAtGameTime(clockOf(fixture), founded.value.readyAt);
      const realSpanMs = realReady.getTime() - Date.now();
      const speed = Number(fixture.world.speedMultiplier);
      if (speed > 1) expect(realSpanMs).toBeLessThan(gameSpanMs);
    });

    it('commissions nothing twice, however often the sweep runs', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      const founded = await foundAcademy(db.db, ownerOf(fixture), crewBaseId);
      if (!founded.ok) throw new Error('found failed');

      const first = await completeDueAcademyBuilds(db.db, fixture.world.id, founded.value.readyAt);
      const second = await completeDueAcademyBuilds(db.db, fixture.world.id, founded.value.readyAt);
      expect(first.levelsCommissioned).toBe(1);
      expect(second.levelsCommissioned).toBe(0);
      expect((await readAcademies(db.db, ownerOf(fixture))).academies[0]?.level).toBe(1);
    });

    it('climbs one level at a time and refuses a second build in flight', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 1);

      const first = await upgradeAcademy(db.db, ownerOf(fixture), academyId);
      expect(first.ok).toBe(true);
      const second = await upgradeAcademy(db.db, ownerOf(fixture), academyId);
      expect(second).toEqual({ ok: false, refusal: 'already_building' });

      const state = await readAcademies(db.db, ownerOf(fixture));
      // Nothing to quote while a build is running: §10.1 builds one at a time.
      expect(state.academies[0]?.nextLevel).toBeNull();
      expect(state.academies[0]?.pendingLevel).toBe(2);
    });

    it('stops at level 5', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 5);
      const state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies[0]?.level).toBe(5);
      expect(state.academies[0]?.levelName).toBe('Centre of Excellence');
      expect(state.academies[0]?.nextLevel).toBeNull();
      expect(await upgradeAcademy(db.db, ownerOf(fixture), academyId)).toEqual({
        ok: false,
        refusal: 'max_level',
      });
    });
  });

  describe('modules', () => {
    it('refuses one the level does not yet reach, and moves no money', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 1);
      const before = await cashOf(fixture.airline.id);

      // The fixed-base sim arrives at level 3.
      const result = await buildAcademyModule(db.db, ownerOf(fixture), academyId, {
        kind: 'fixed_base_sim',
      });
      expect(result).toEqual({ ok: false, refusal: 'module_level' });
      expect(await cashOf(fixture.airline.id)).toBe(before);
    });

    it('builds one, and installs it only when its own build is due', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 1);
      const before = await cashOf(fixture.airline.id);

      const result = await buildAcademyModule(db.db, ownerOf(fixture), academyId, {
        kind: 'cbt_suite',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(await cashOf(fixture.airline.id)).toBe(
        before - BALANCE.modules.cbt_suite.capitalCostMinor,
      );

      let state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies[0]?.modules[0]?.status).toBe('under_construction');
      // Upkeep does not start on a building site.
      expect(state.academies[0]?.monthlyUpkeepMinor).toBe(BALANCE.levels['1'].monthlyUpkeepMinor);

      await completeDueAcademyBuilds(db.db, fixture.world.id, result.value.readyAt);
      state = await readAcademies(db.db, ownerOf(fixture));
      expect(state.academies[0]?.modules[0]?.status).toBe('operational');
      expect(state.academies[0]?.monthlyUpkeepMinor).toBe(
        BALANCE.levels['1'].monthlyUpkeepMinor + BALANCE.modules.cbt_suite.monthlyUpkeepMinor,
      );
    });

    it('refuses a duplicate room but allows a second simulator for another family', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 4);
      const own = ownerOf(fixture);

      expect((await buildAcademyModule(db.db, own, academyId, { kind: 'cbt_suite' })).ok).toBe(
        true,
      );
      expect(await buildAcademyModule(db.db, own, academyId, { kind: 'cbt_suite' })).toEqual({
        ok: false,
        refusal: 'module_exists',
      });

      const families = (await readAcademies(db.db, own)).families;
      expect(families.length).toBeGreaterThan(1);
      const [first, second] = families;
      if (first === undefined || second === undefined) throw new Error('need two families');

      expect(
        (
          await buildAcademyModule(db.db, own, academyId, {
            kind: 'full_flight_sim',
            family: first,
          })
        ).ok,
      ).toBe(true);
      // A different family is a different simulator — the partial unique index
      // must not treat them as one.
      expect(
        (
          await buildAcademyModule(db.db, own, academyId, {
            kind: 'full_flight_sim',
            family: second,
          })
        ).ok,
      ).toBe(true);
      expect(
        await buildAcademyModule(db.db, own, academyId, {
          kind: 'full_flight_sim',
          family: first,
        }),
      ).toEqual({ ok: false, refusal: 'module_exists' });
    });

    it('refuses a simulator for a family the world does not fly', async () => {
      const fixture = await foundedAirline();
      const academyId = await commissionTo(fixture, 4);
      const before = await cashOf(fixture.airline.id);
      const result = await buildAcademyModule(db.db, ownerOf(fixture), academyId, {
        kind: 'full_flight_sim',
        family: 'Nonexistent',
      });
      expect(result).toEqual({ ok: false, refusal: 'unknown_family' });
      expect(await cashOf(fixture.airline.id)).toBe(before);
    });
  });

  /** AC2: training slots are finite and visibly consume crew availability. */
  describe('training slots', () => {
    it('shows a course occupying slots, and the crew leaving the roster', async () => {
      const fixture = await foundedAirline();
      const own = ownerOf(fixture);
      const academyId = await commissionTo(fixture, 4);

      const families = (await readAcademies(db.db, own)).families;
      const [from, to] = families;
      if (from === undefined || to === undefined) throw new Error('need two families');

      for (const kind of ['cbt_suite', 'fixed_base_sim'] as const) {
        const built = await buildAcademyModule(db.db, own, academyId, { kind });
        if (!built.ok) throw new Error(`could not build ${kind}: ${built.refusal}`);
        await completeDueAcademyBuilds(db.db, fixture.world.id, built.value.readyAt);
      }

      const [row] = await db.db
        .select({ crewBaseId: academy.crewBaseId })
        .from(academy)
        .where(eq(academy.id, academyId));
      const crewBaseId = row?.crewBaseId;
      if (crewBaseId === undefined) throw new Error('no academy');

      const { hireCrew } = await import('../crew/store');
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: from,
        rank: 'first_officer',
        heads: 3,
      });
      if (!hired.ok) throw new Error(`could not hire: ${hired.refusal}`);

      const started = await startCrewConversion(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        fromFamily: from,
        toFamily: to,
        rank: 'first_officer',
        heads: 3,
      });
      expect(started.ok).toBe(true);

      const state = await readAcademies(db.db, own);
      // Three heads, three slots — a count of crew, not of courses.
      expect(state.academies[0]?.ceiling?.slotsInUse).toBe(3);

      // And the course is recorded as this academy's, which is what makes the
      // slot ledger a query rather than a counter column.
      const [conversion] = await db.db
        .select({ academyId: crewConversion.academyId })
        .from(crewConversion)
        .where(eq(crewConversion.crewBaseId, crewBaseId));
      expect(conversion?.academyId).toBe(academyId);
    });

    it('buys a course in at the market rate when there is no academy', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      const state = await readAcademies(db.db, ownerOf(fixture));
      const families = state.families;
      const [from, to] = families;
      if (from === undefined || to === undefined) throw new Error('need two families');

      const { hireCrew } = await import('../crew/store');
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: from,
        rank: 'first_officer',
        heads: 2,
      });
      if (!hired.ok) throw new Error(`could not hire: ${hired.refusal}`);

      const before = await cashOf(fixture.airline.id);
      const started = await startCrewConversion(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        fromFamily: from,
        toFamily: to,
        rank: 'first_officer',
        heads: 2,
      });
      expect(started.ok).toBe(true);

      /*
       * The whole M5-01 behaviour, unchanged. This is the assertion that would
       * fail if somebody later turned the academy into a gate, which is the
       * change most likely to be made by accident.
       */
      expect(await cashOf(fixture.airline.id)).toBe(before - MARKET_CONVERSION * 2);
      const [conversion] = await db.db
        .select({ academyId: crewConversion.academyId })
        .from(crewConversion)
        .where(eq(crewConversion.crewBaseId, crewBaseId));
      expect(conversion?.academyId).toBeNull();
    });
  });

  describe('upkeep', () => {
    it('bills the month once, however many times the sweep runs', async () => {
      const fixture = await foundedAirline();
      await commissionTo(fixture, 2);

      // A game instant early in a month, so the *previous* month is billed.
      const gameNow = gameNowOf(fixture);
      const nextMonth = new Date(Date.UTC(gameNow.getUTCFullYear(), gameNow.getUTCMonth() + 1, 5));

      const before = await cashOf(fixture.airline.id);
      const first = await runAcademyUpkeep(db.db, fixture.world.id, nextMonth);
      expect(first.airlinesBilled).toBe(1);
      expect(first.totalMinor).toBe(BALANCE.levels['2'].monthlyUpkeepMinor);
      expect(await cashOf(fixture.airline.id)).toBe(
        before - BALANCE.levels['2'].monthlyUpkeepMinor,
      );

      // Attempted on every tick and billed once — AIR-06's replay identity,
      // not a "last billed" column ADR-0005 would have to reset.
      const second = await runAcademyUpkeep(db.db, fixture.world.id, nextMonth);
      expect(second.airlinesBilled).toBe(0);
      expect(await cashOf(fixture.airline.id)).toBe(
        before - BALANCE.levels['2'].monthlyUpkeepMinor,
      );
    });

    it('bills nothing for a world with no academies', async () => {
      const fixture = await foundedAirline();
      await baseFor(fixture);
      const gameNow = gameNowOf(fixture);
      const nextMonth = new Date(Date.UTC(gameNow.getUTCFullYear(), gameNow.getUTCMonth() + 1, 5));
      expect(await runAcademyUpkeep(db.db, fixture.world.id, nextMonth)).toEqual({
        airlinesBilled: 0,
        totalMinor: 0,
      });
    });

    it('charges nothing while the first level is still going up', async () => {
      const fixture = await foundedAirline();
      const crewBaseId = await baseFor(fixture);
      expect((await foundAcademy(db.db, ownerOf(fixture), crewBaseId)).ok).toBe(true);

      const gameNow = gameNowOf(fixture);
      const nextMonth = new Date(Date.UTC(gameNow.getUTCFullYear(), gameNow.getUTCMonth() + 1, 5));
      // The capital was taken at the start. Rent on a building site would be a
      // second bill for the same thing.
      expect((await runAcademyUpkeep(db.db, fixture.world.id, nextMonth)).totalMinor).toBe(0);
    });
  });

  describe('ownership', () => {
    it('conceals another airline’s academy as absent on every write', async () => {
      const mine = await foundedAirline();
      const theirs = await foundedAirline();
      const theirAcademy = await commissionTo(theirs, 1);

      expect(await upgradeAcademy(db.db, ownerOf(mine), theirAcademy)).toEqual({
        ok: false,
        refusal: 'academy_absent',
      });
      expect(
        await buildAcademyModule(db.db, ownerOf(mine), theirAcademy, { kind: 'cbt_suite' }),
      ).toEqual({ ok: false, refusal: 'academy_absent' });

      // And it is not in their neighbour's read at all.
      expect((await readAcademies(db.db, ownerOf(mine))).academies).toHaveLength(0);
      expect((await readAcademies(db.db, ownerOf(theirs))).academies).toHaveLength(1);
    });

    it('treats an absent id exactly as a foreign one', async () => {
      const mine = await foundedAirline();
      await commissionTo(mine, 1);
      expect(
        await upgradeAcademy(db.db, ownerOf(mine), '00000000-0000-4000-8000-000000000000'),
      ).toEqual({ ok: false, refusal: 'academy_absent' });
    });
  });
});
