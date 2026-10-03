import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import { xpForLevel } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  academy,
  airline,
  airport,
  cashMovement,
  crewMember,
  crewPool,
  flight,
  flightResult,
  ledgerEntry,
} from '../db/schema';
import { settleArrivedFlight } from '../flight/settle';
import { fixtureAirframe } from '../test-fixtures/airframe';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  allocateSkillPoint,
  convertToTrainingCaptain,
  nameEligibleCrew,
  readRoster,
  revertTrainingCaptain,
  trainingCaptainReference,
} from './roster';
import { hireCrew, openCrewBase } from './store';

/**
 * Training Captains against a real database (M9-04, §10.2).
 *
 * The rules — who may convert, the multiplier, the cap — have their own tests
 * in `packages/sim`, including the convergence property. What is worth proving
 * here is the half only Postgres can answer:
 *
 *   - the designation and its fee are **one transaction**: a refusal, a
 *     shortfall or a race leaves the member, the cash and the ledger exactly as
 *     they were;
 *   - *"reversible at a cost"* — each change in a round trip is its own priced,
 *     referenced movement, and the way back refunds nothing;
 *   - §10.1's level-5 gate is read from the academy actually standing at the
 *     member's base;
 *   - the roster and the settlement both see a Training Captain's points at
 *     their reduced line value.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/training-captain.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('crew/training-captain');
const SKILLS = ECONOMY_CONFIG_V1.crew.skills;
const TRAINING = ECONOMY_CONFIG_V1.crew.trainingCaptain;
const GAME_NOW = new Date('2026-05-01T12:00:00.000Z');

describeDb('Training Captains', () => {
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

  async function makeAirport(latitude = 52.3086, longitude = 4.76389): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Training Captain Test Field ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude,
      longitude,
      scheduledService: true,
      hasRunwayData: false,
      tier: 'medium',
      slotLevel: 2,
      continent: 'EU',
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  interface Veteran {
    fixture: FoundedAirlineFixture;
    crewBaseId: string;
    memberId: string;
    icao: string;
  }

  /**
   * An airline with a base, a named member of the given rank and level, and —
   * when asked — an academy at that base.
   *
   * The pool's XP and the academy's level are written directly. Neither is
   * money, so no trigger guards them, and the alternatives — settling years of
   * flights to reach level 20, or building five levels over forty game weeks —
   * would be testing M9-02 and M9-01 rather than this.
   */
  async function veteran(
    options: {
      rank?: 'captain' | 'first_officer' | 'purser';
      level?: number;
      academyLevel?: number | null;
    } = {},
  ): Promise<Veteran> {
    const icao = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: `TEST-${icao}` });
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    const crewBaseId = opened.value.crewBaseId;

    const heads = 2;
    const hired = await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: options.rank ?? 'captain',
      heads,
    });
    if (!hired.ok) throw new Error(`could not hire: ${hired.refusal}`);
    await db.db
      .update(crewPool)
      .set({ xp: xpForLevel(options.level ?? SKILLS.maxLevel, SKILLS) * heads })
      .where(eq(crewPool.crewBaseId, crewBaseId));
    await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);

    const [member] = await db.db
      .select({ id: crewMember.id })
      .from(crewMember)
      .where(eq(crewMember.crewBaseId, crewBaseId))
      .orderBy(crewMember.ordinal)
      .limit(1);
    if (!member) throw new Error('nobody was named');

    const academyLevel = options.academyLevel === undefined ? 5 : options.academyLevel;
    if (academyLevel !== null) {
      await db.db.insert(academy).values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        level: academyLevel,
      });
    }

    return { fixture, crewBaseId, memberId: member.id, icao };
  }

  function own(fixture: FoundedAirlineFixture) {
    return { worldId: fixture.world.id, airlineId: fixture.airline.id };
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    return row?.cashMinor ?? Number.NaN;
  }

  async function designation(memberId: string) {
    const [row] = await db.db
      .select({
        since: crewMember.trainingCaptainSince,
        changes: crewMember.trainingCaptainChanges,
      })
      .from(crewMember)
      .where(eq(crewMember.id, memberId));
    return row;
  }

  async function fees(airlineId: string) {
    return db.db
      .select({
        id: cashMovement.id,
        amountMinor: cashMovement.amountMinor,
        reference: cashMovement.reference,
        occurredAt: cashMovement.occurredAt,
      })
      .from(cashMovement)
      .where(and(eq(cashMovement.airlineId, airlineId), eq(cashMovement.cause, 'training_captain')))
      .orderBy(cashMovement.reference);
  }

  // -------------------------------------------------------------------------

  describe('converting', () => {
    it('makes a max-level captain a Training Captain and charges the course, as crew', async () => {
      const { fixture, memberId } = await veteran();
      const before = await cashOf(fixture.airline.id);

      const result = await convertToTrainingCaptain(db.db, own(fixture), memberId);
      expect(result.ok).toBe(true);

      const row = await designation(memberId);
      expect(row?.since).not.toBeNull();
      expect(row?.changes).toBe(1);
      expect(await cashOf(fixture.airline.id)).toBe(before - TRAINING.conversionCostMinor);

      const [fee] = await fees(fixture.airline.id);
      expect(fee?.amountMinor).toBe(-TRAINING.conversionCostMinor);
      expect(fee?.reference).toBe(trainingCaptainReference(memberId, 1));
      // Game time on both: the designation and its movement are one instant.
      expect(fee?.occurredAt.getTime()).toBe(row?.since?.getTime());

      // §14.1: a crew training cost, under the crew line of the P&L.
      const lines = await db.db
        .select({ category: ledgerEntry.category })
        .from(ledgerEntry)
        .where(eq(ledgerEntry.cashMovementId, fee?.id ?? randomUUID()));
      expect(lines.map((line) => line.category)).toEqual(['crew']);
    });

    it('accepts the designation for a pilot already hired at Training Captain rank', async () => {
      const icao = await makeAirport();
      const fixture = await fixtures.create({ hubIdent: `TEST-${icao}` });
      const opened = await openCrewBase(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airportIcao: icao,
      });
      if (!opened.ok) throw new Error('no base');
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId: opened.value.crewBaseId,
        family: 'A320neo',
        rank: 'training_captain',
        heads: 1,
      });
      if (!hired.ok) throw new Error('no hire');
      await db.db
        .update(crewPool)
        .set({ xp: xpForLevel(SKILLS.maxLevel, SKILLS) })
        .where(eq(crewPool.crewBaseId, opened.value.crewBaseId));
      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      await db.db.insert(academy).values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId: opened.value.crewBaseId,
        level: 5,
      });
      const [member] = await db.db
        .select({ id: crewMember.id })
        .from(crewMember)
        .where(eq(crewMember.crewBaseId, opened.value.crewBaseId));

      expect((await convertToTrainingCaptain(db.db, own(fixture), member?.id ?? '')).ok).toBe(true);
    });

    it('says on the roster, before anybody clicks, whether the action is open', async () => {
      const open = await veteran();
      const shut = await veteran({ academyLevel: 4 });

      const openRoster = await readRoster(db.db, own(open.fixture));
      expect(openRoster.maxLevel).toBe(SKILLS.maxLevel);
      expect(openRoster.members[0]?.trainingCaptain).toEqual({
        since: null,
        convertRefusal: null,
        conversionCostMinor: TRAINING.conversionCostMinor,
        reversionCostMinor: TRAINING.reversionCostMinor,
      });

      const shutRoster = await readRoster(db.db, own(shut.fixture));
      expect(shutRoster.members[0]?.trainingCaptain.convertRefusal).toBe('academy_level');
    });

    it.each([
      ['below the top level', { level: SKILLS.namedFromLevel }, 'below_max_level'],
      ['with no academy at the base', { academyLevel: null }, 'no_academy'],
      ['at a building site', { academyLevel: 0 }, 'no_academy'],
      ['below a Centre of Excellence', { academyLevel: 4 }, 'academy_level'],
      ['for cabin crew', { rank: 'purser' as const }, 'not_flight_deck'],
      ['below command rank', { rank: 'first_officer' as const }, 'not_command_rank'],
    ] as const)('refuses %s and charges nothing', async (_label, options, refusal) => {
      const { fixture, memberId } = await veteran(options);
      const before = await cashOf(fixture.airline.id);

      expect(await convertToTrainingCaptain(db.db, own(fixture), memberId)).toEqual({
        ok: false,
        refusal,
      });
      expect(await designation(memberId)).toEqual({ since: null, changes: 0 });
      expect(await cashOf(fixture.airline.id)).toBe(before);
      expect(await fees(fixture.airline.id)).toEqual([]);
    });

    it('refuses a second conversion, and the course is charged once', async () => {
      const { fixture, memberId } = await veteran();
      await convertToTrainingCaptain(db.db, own(fixture), memberId);
      const after = await cashOf(fixture.airline.id);

      expect(await convertToTrainingCaptain(db.db, own(fixture), memberId)).toEqual({
        ok: false,
        refusal: 'already_training_captain',
      });
      expect(await cashOf(fixture.airline.id)).toBe(after);
      expect(await fees(fixture.airline.id)).toHaveLength(1);
    });

    it('charges once when two conversions race', async () => {
      // The member row is re-read under a lock: two clicks together would each
      // pass a check made against the same stale row without it.
      const { fixture, memberId } = await veteran();
      const before = await cashOf(fixture.airline.id);

      const results = await Promise.all([
        convertToTrainingCaptain(db.db, own(fixture), memberId),
        convertToTrainingCaptain(db.db, own(fixture), memberId),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, refusal: 'already_training_captain' },
      ]);
      expect(await cashOf(fixture.airline.id)).toBe(before - TRAINING.conversionCostMinor);
      expect((await designation(memberId))?.changes).toBe(1);
    });

    it('refuses a course the airline cannot pay for, and changes nothing', async () => {
      const { fixture, memberId } = await veteran();
      // Leave the airline one unit short of the fee, through AIR-06 like any
      // other movement — never by writing the balance.
      const cash = await cashOf(fixture.airline.id);
      await db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId: fixture.airline.id,
          amountMinor: -(cash - (TRAINING.conversionCostMinor - 1)),
          cause: 'admin_adjustment',
          reference: randomUUID(),
          occurredAt: GAME_NOW,
        }),
      );
      const before = await cashOf(fixture.airline.id);

      expect(await convertToTrainingCaptain(db.db, own(fixture), memberId)).toEqual({
        ok: false,
        refusal: 'insufficient_funds',
      });
      expect(await designation(memberId)).toEqual({ since: null, changes: 0 });
      expect(await cashOf(fixture.airline.id)).toBe(before);
      expect(await fees(fixture.airline.id)).toEqual([]);
    });

    it('conceals another airline’s member as absent, and changes nothing of theirs', async () => {
      const mine = await veteran();
      const theirs = await veteran();
      const before = await cashOf(theirs.fixture.airline.id);

      expect(await convertToTrainingCaptain(db.db, own(mine.fixture), theirs.memberId)).toEqual({
        ok: false,
        refusal: 'member_absent',
      });
      expect(await revertTrainingCaptain(db.db, own(mine.fixture), theirs.memberId)).toEqual({
        ok: false,
        refusal: 'member_absent',
      });
      expect(await designation(theirs.memberId)).toEqual({ since: null, changes: 0 });
      expect(await cashOf(theirs.fixture.airline.id)).toBe(before);
    });
  });

  /** The acceptance criterion: "Conversion is reversible at a cost." */
  describe('returning to the line', () => {
    it('reverts at the reversion price and refunds nothing', async () => {
      const { fixture, memberId } = await veteran();
      const start = await cashOf(fixture.airline.id);
      await convertToTrainingCaptain(db.db, own(fixture), memberId);

      expect((await revertTrainingCaptain(db.db, own(fixture), memberId)).ok).toBe(true);
      expect(await designation(memberId)).toEqual({ since: null, changes: 2 });
      expect(await cashOf(fixture.airline.id)).toBe(
        start - TRAINING.conversionCostMinor - TRAINING.reversionCostMinor,
      );
    });

    it('refuses to revert a line pilot, and charges nothing', async () => {
      const { fixture, memberId } = await veteran();
      const before = await cashOf(fixture.airline.id);
      expect(await revertTrainingCaptain(db.db, own(fixture), memberId)).toEqual({
        ok: false,
        refusal: 'not_training_captain',
      });
      expect(await cashOf(fixture.airline.id)).toBe(before);
    });

    it('prices each change of a round trip as its own movement', async () => {
      const { fixture, memberId } = await veteran();
      await convertToTrainingCaptain(db.db, own(fixture), memberId);
      await revertTrainingCaptain(db.db, own(fixture), memberId);
      await convertToTrainingCaptain(db.db, own(fixture), memberId);

      const charged = await fees(fixture.airline.id);
      expect(charged.map((fee) => fee.reference)).toEqual(
        [1, 2, 3].map((n) => `${memberId}:training_captain:${String(n)}`),
      );
      expect(charged.map((fee) => fee.amountMinor)).toEqual([
        -TRAINING.conversionCostMinor,
        -TRAINING.reversionCostMinor,
        -TRAINING.conversionCostMinor,
      ]);
      expect((await designation(memberId))?.changes).toBe(3);
    });

    it('refuses a reversion the airline cannot pay for, and leaves them a Training Captain', async () => {
      const { fixture, memberId } = await veteran();
      await convertToTrainingCaptain(db.db, own(fixture), memberId);
      const cash = await cashOf(fixture.airline.id);
      await db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId: fixture.airline.id,
          amountMinor: -(cash - (TRAINING.reversionCostMinor - 1)),
          cause: 'admin_adjustment',
          reference: randomUUID(),
          occurredAt: GAME_NOW,
        }),
      );

      expect(await revertTrainingCaptain(db.db, own(fixture), memberId)).toEqual({
        ok: false,
        refusal: 'insufficient_funds',
      });
      const row = await designation(memberId);
      expect(row?.since).not.toBeNull();
      expect(row?.changes).toBe(1);
    });
  });

  describe('what the designation is worth', () => {
    it('reports the base’s XP multiplier on the roster', async () => {
      const { fixture, memberId, crewBaseId, icao } = await veteran();
      const before = await readRoster(db.db, own(fixture));
      expect(before.trainingCoverage).toEqual([
        {
          crewBaseId,
          airportIcao: icao,
          family: 'A320neo',
          trainingCaptains: 0,
          flightDeckHeads: 2,
          coverage: 0,
          multiplier: 1,
          capped: false,
        },
      ]);

      await convertToTrainingCaptain(db.db, own(fixture), memberId);
      const after = await readRoster(db.db, own(fixture));
      // One Training Captain covers twelve; two heads are fully covered.
      expect(after.trainingCoverage[0]).toMatchObject({
        trainingCaptains: 1,
        flightDeckHeads: 2,
        coverage: 1,
        multiplier: 1 + TRAINING.xpBonusAtFullCoverage,
        capped: false,
      });
      expect(after.members.find((m) => m.id === memberId)?.trainingCaptain.convertRefusal).toBe(
        'already_training_captain',
      );
    });

    it('counts a Training Captain’s own points at the reduced line value', async () => {
      const { fixture, memberId } = await veteran();
      for (let n = 0; n < SKILLS.maxPointsPerBranch; n += 1) {
        const spent = await allocateSkillPoint(db.db, own(fixture), memberId, 'performance_fuel');
        expect(spent.ok).toBe(true);
      }
      const line = (await readRoster(db.db, own(fixture))).boosts.find(
        (b) => b.ceiling === 'fuelBurn',
      );

      await convertToTrainingCaptain(db.db, own(fixture), memberId);
      const trainer = (await readRoster(db.db, own(fixture))).boosts.find(
        (b) => b.ceiling === 'fuelBurn',
      );

      // §10.2's "stop generating full revenue value", end to end.
      expect(line?.fraction).toBeCloseTo(
        SKILLS.maxPointsPerBranch * SKILLS.fractionPerPoint.performance_fuel,
        12,
      );
      expect(trainer?.fraction).toBeCloseTo(
        (line?.fraction ?? 0) * TRAINING.lineContributionFactor,
        12,
      );
      expect(trainer?.contributors).toBe(1);

      // And returning them to the line restores the face value: the points
      // were never touched.
      await revertTrainingCaptain(db.db, own(fixture), memberId);
      const back = (await readRoster(db.db, own(fixture))).boosts.find(
        (b) => b.ceiling === 'fuelBurn',
      );
      expect(back?.fraction).toBeCloseTo(line?.fraction ?? -1, 12);
    });

    it('settles a flight with a Training Captain’s fuel discipline at the reduced value', async () => {
      const { fixture, memberId, icao } = await veteran();
      for (let n = 0; n < SKILLS.maxPointsPerBranch; n += 1) {
        await allocateSkillPoint(db.db, own(fixture), memberId, 'performance_fuel');
      }
      await convertToTrainingCaptain(db.db, own(fixture), memberId);

      const dest = await makeAirport(51.4706, -0.461941);
      const departs = new Date('2026-01-15T06:00:00.000Z');
      const arrives = new Date('2026-01-15T07:15:00.000Z');
      const [f] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId: randomUUID(),
          originIcao: icao,
          destinationIcao: dest,
          scheduledDeparture: departs,
          estimatedArrival: arrives,
          load: JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } }),
          cargoKg: 0,
        })
        .returning({ id: flight.id });
      if (!f) throw new Error('no flight');
      await db.db.transaction(async (tx) => {
        await settleArrivedFlight(tx, f.id, arrives, {
          resolveAirframe: () => fixtureAirframe(),
          resolveWeather: () => null,
        });
      });

      const [result] = await db.db
        .select({ breakdown: flightResult.breakdown })
        .from(flightResult)
        .where(eq(flightResult.flightId, f.id));
      const boost = (
        JSON.parse(result?.breakdown ?? '{}') as {
          crewFuelBoost?: {
            fraction: number;
            capped: boolean;
            contributors: number;
            bySource: { skills: number; trainingCaptains: number };
          };
        }
      ).crewFuelBoost;
      const expected =
        SKILLS.maxPointsPerBranch *
        SKILLS.fractionPerPoint.performance_fuel *
        TRAINING.lineContributionFactor;
      expect(boost?.fraction).toBeCloseTo(expected, 12);
      expect(boost?.bySource.trainingCaptains).toBeCloseTo(expected, 12);
      expect(boost?.bySource.skills).toBe(0);
      expect(boost?.contributors).toBe(1);
      expect(boost?.capped).toBe(false);
    });
  });

  describe('the schema holds the designation and its counter together', () => {
    it('refuses a designation without an odd count of changes', async () => {
      const { memberId } = await veteran();
      const error = await db.db
        .update(crewMember)
        .set({ trainingCaptainSince: GAME_NOW })
        .where(eq(crewMember.id, memberId))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      // Drizzle wraps the driver error; what Postgres said is on the cause.
      expect((error as { cause?: { constraint?: string } } | null)?.cause?.constraint).toBe(
        'crew_member_training_captain_parity',
      );
    });

    it('refuses the designation on a rank that may not hold it', async () => {
      const { memberId } = await veteran({ rank: 'first_officer' });
      const error = await db.db
        .update(crewMember)
        .set({ trainingCaptainSince: GAME_NOW, trainingCaptainChanges: 1 })
        .where(eq(crewMember.id, memberId))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect((error as { cause?: { constraint?: string } } | null)?.cause?.constraint).toBe(
        'crew_member_training_captain_rank',
      );
    });
  });
});
