import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import { xpForLevel } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, crewMember, crewPool } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { allocateSkillPoint, nameEligibleCrew, readRoster } from './roster';
import { hireCrew, openCrewBase } from './store';

/**
 * Named crew and their skill trees, against a real database (M9-03, §10.2).
 *
 * The arithmetic has its own tests in `packages/sim`. What is worth proving here
 * is the half only Postgres can answer:
 *
 *   - a pool that has earned it produces a **named individual**, and the sweep
 *     is idempotent without a watermark;
 *   - the name is stable, because it is drawn from the world seed rather than
 *     at insert time;
 *   - a point spent is a point that cannot be spent twice;
 *   - Type Mastery goes inert when the fleet goes, end to end through the
 *     roster read rather than in a unit test's fixture.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/roster.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('crew/roster');
const SKILLS = ECONOMY_CONFIG_V1.crew.skills;
const GAME_NOW = new Date('2026-05-01T12:00:00.000Z');

describeDb('named crew', () => {
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

  async function makeHub(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Roster Test Hub ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude: 52.3086,
      longitude: 4.76389,
      scheduledService: true,
      hasRunwayData: false,
      tier: 'medium',
      slotLevel: 2,
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  /** An airline with a base, a pool, and whatever XP the test wants on it. */
  async function baseWithPool(options: {
    heads: number;
    xpPerHead: number;
    rank?: 'captain' | 'purser';
    family?: string;
  }): Promise<{ fixture: FoundedAirlineFixture; crewBaseId: string; icao: string }> {
    const icao = await makeHub();
    const fixture = await fixtures.create({ hubIdent: `TEST-${icao}` });
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);

    const hired = await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId: opened.value.crewBaseId,
      family: options.family ?? 'A320neo',
      rank: options.rank ?? 'captain',
      heads: options.heads,
    });
    if (!hired.ok) throw new Error(`could not hire: ${hired.refusal}`);

    /*
     * The pool's XP is set directly. It is not money — no trigger guards it —
     * and the alternative is settling dozens of flights to reach level 8, which
     * would be testing M9-02 rather than M9-03.
     */
    await db.db
      .update(crewPool)
      .set({ xp: options.xpPerHead * options.heads })
      .where(eq(crewPool.crewBaseId, opened.value.crewBaseId));

    return { fixture, crewBaseId: opened.value.crewBaseId, icao };
  }

  function own(fixture: FoundedAirlineFixture) {
    return { worldId: fixture.world.id, airlineId: fixture.airline.id };
  }

  async function members(crewBaseId: string) {
    return db.db
      .select({
        id: crewMember.id,
        name: crewMember.name,
        ordinal: crewMember.ordinal,
        level: crewMember.level,
        xp: crewMember.xp,
        rank: crewMember.rank,
      })
      .from(crewMember)
      .where(eq(crewMember.crewBaseId, crewBaseId))
      .orderBy(crewMember.ordinal);
  }

  // -------------------------------------------------------------------------

  describe('the naming sweep', () => {
    it('names nobody until a pool crosses the threshold', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS) - 1,
      });
      const result = await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      expect(result.named).toBe(0);
      expect(await members(crewBaseId)).toHaveLength(0);
    });

    it('names one when it does', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      expect((await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW)).named).toBe(1);

      const [member] = await members(crewBaseId);
      expect(member?.level).toBe(SKILLS.namedFromLevel);
      expect(member?.rank).toBe('captain');
      expect(member?.name.split(' ')).toHaveLength(2);
      // Their own XP starts at the per-head average that earned them the name.
      expect(member?.xp).toBe(xpForLevel(SKILLS.namedFromLevel, SKILLS));
    });

    it('names one more per level above the threshold', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 6,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel + 2, SKILLS),
      });
      expect((await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW)).named).toBe(3);
      expect(await members(crewBaseId)).toHaveLength(3);
    });

    it('never names more people than the pool has heads', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 2,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel + 6, SKILLS),
      });
      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      expect(await members(crewBaseId)).toHaveLength(2);
    });

    /** Idempotent without a watermark — the reason ADR-0005 has nothing to clear. */
    it('names nobody twice, however often the sweep runs', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      const first = await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      const second = await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      const third = await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      expect(first.named).toBe(1);
      expect(second.named).toBe(0);
      expect(third.named).toBe(0);
      expect(await members(crewBaseId)).toHaveLength(1);
    });

    it('gives a base a stable name for the same ordinal', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      const [before] = await members(crewBaseId);

      // Delete and re-sweep: the name is a function of (seed, base, ordinal),
      // so the same person comes back rather than a new one.
      await db.db.delete(crewMember).where(eq(crewMember.crewBaseId, crewBaseId));
      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      const [after] = await members(crewBaseId);
      expect(after?.name).toBe(before?.name);
      expect(after?.ordinal).toBe(0);
    });

    it('numbers a base’s roster sequentially across pools', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      // A second pool at the same base, also eligible.
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: 'A320neo',
        rank: 'first_officer',
        heads: 4,
      });
      if (!hired.ok) throw new Error('could not hire');
      await db.db
        .update(crewPool)
        .set({ xp: xpForLevel(SKILLS.namedFromLevel, SKILLS) * 4 })
        .where(and(eq(crewPool.crewBaseId, crewBaseId), eq(crewPool.rank, 'first_officer')));

      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
      const roster = await members(crewBaseId);
      expect(roster).toHaveLength(2);
      expect(roster.map((m) => m.ordinal)).toEqual([0, 1]);
      // Two people, not one name twice.
      expect(new Set(roster.map((m) => m.name)).size).toBe(2);
    });

    it('skips a closed base', async () => {
      const { fixture, crewBaseId } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await db.db.execute(
        sql`update crew_base set status = 'closed' where id = ${crewBaseId}::uuid`,
      );
      expect((await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW)).named).toBe(0);
    });
  });

  describe('the roster board', () => {
    it('reports a member’s level, points and career', async () => {
      const { fixture } = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);

      const roster = await readRoster(db.db, own(fixture));
      expect(roster.members).toHaveLength(1);
      const member = roster.members[0];
      expect(member?.level).toBe(SKILLS.namedFromLevel);
      expect(member?.unspentPoints).toBe((SKILLS.namedFromLevel - 1) * SKILLS.pointsPerLevel);
      expect(member?.spent).toEqual({});
      expect(member?.career.sectors).toBe(0);
      expect(roster.namedFromLevel).toBe(SKILLS.namedFromLevel);
    });

    it('reports an empty board for an airline with no veterans', async () => {
      const { fixture } = await baseWithPool({ heads: 4, xpPerHead: 10 });
      const roster = await readRoster(db.db, own(fixture));
      expect(roster.members).toEqual([]);
      // Every ceiling is still listed, at zero, so the page can show the ladder.
      expect(roster.boosts).toHaveLength(4);
      for (const boost of roster.boosts) {
        expect(boost.fraction).toBe(0);
        expect(boost.contributors).toBe(0);
        expect(boost.maxFraction).toBeGreaterThan(0);
      }
    });

    it('shows nobody else’s crew', async () => {
      const mine = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      const theirs = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await nameEligibleCrew(db.db, mine.fixture.world.id, GAME_NOW);
      await nameEligibleCrew(db.db, theirs.fixture.world.id, GAME_NOW);

      const roster = await readRoster(db.db, own(mine.fixture));
      expect(roster.members).toHaveLength(1);
      expect(roster.members[0]?.crewBaseId).toBe(mine.crewBaseId);
    });
  });

  describe('spending a point', () => {
    async function namedPilot() {
      const made = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await nameEligibleCrew(db.db, made.fixture.world.id, GAME_NOW);
      const [member] = await members(made.crewBaseId);
      if (!member) throw new Error('nobody was named');
      return { ...made, memberId: member.id };
    }

    it('commits the point and reduces what is left', async () => {
      const { fixture, memberId } = await namedPilot();
      const result = await allocateSkillPoint(db.db, own(fixture), memberId, 'performance_fuel');
      expect(result.ok).toBe(true);

      const roster = await readRoster(db.db, own(fixture));
      expect(roster.members[0]?.spent).toEqual({ performance_fuel: 1 });
      expect(roster.members[0]?.unspentPoints).toBe(
        (SKILLS.namedFromLevel - 1) * SKILLS.pointsPerLevel - 1,
      );
      // And the airline's fuel boost moved, through the capped stack.
      const fuel = roster.boosts.find((b) => b.ceiling === 'fuelBurn');
      expect(fuel?.fraction).toBeGreaterThan(0);
      expect(fuel?.contributors).toBe(1);
    });

    it('refuses a branch on the other ladder', async () => {
      const { fixture, memberId } = await namedPilot();
      expect(await allocateSkillPoint(db.db, own(fixture), memberId, 'service')).toEqual({
        ok: false,
        refusal: 'branch_wrong_ladder',
      });
    });

    it('refuses once the branch is full', async () => {
      const { fixture, memberId } = await namedPilot();
      for (let n = 0; n < SKILLS.maxPointsPerBranch; n += 1) {
        const step = await allocateSkillPoint(db.db, own(fixture), memberId, 'handling_safety');
        expect(step.ok, `spend ${String(n)}`).toBe(true);
      }
      expect(await allocateSkillPoint(db.db, own(fixture), memberId, 'handling_safety')).toEqual({
        ok: false,
        refusal: 'branch_full',
      });
    });

    it('refuses once the points run out', async () => {
      const { fixture, memberId } = await namedPilot();
      const granted = (SKILLS.namedFromLevel - 1) * SKILLS.pointsPerLevel;
      const branches = ['performance_fuel', 'handling_safety', 'command_leadership'] as const;
      let spentTotal = 0;
      for (const branch of branches) {
        for (let n = 0; n < SKILLS.maxPointsPerBranch && spentTotal < granted; n += 1) {
          const step = await allocateSkillPoint(db.db, own(fixture), memberId, branch);
          if (!step.ok) break;
          spentTotal += 1;
        }
      }
      expect(spentTotal).toBe(granted);
      expect(await allocateSkillPoint(db.db, own(fixture), memberId, 'type_mastery')).toEqual({
        ok: false,
        refusal: 'no_unspent_points',
      });
    });

    it('conceals another airline’s member as absent, and changes nothing', async () => {
      const mine = await namedPilot();
      const theirs = await namedPilot();

      expect(
        await allocateSkillPoint(db.db, own(mine.fixture), theirs.memberId, 'performance_fuel'),
      ).toEqual({ ok: false, refusal: 'member_absent' });

      const theirRoster = await readRoster(db.db, own(theirs.fixture));
      expect(theirRoster.members[0]?.spent).toEqual({});
    });

    it('treats an absent id exactly as a foreign one', async () => {
      const { fixture } = await namedPilot();
      expect(
        await allocateSkillPoint(
          db.db,
          own(fixture),
          '00000000-0000-4000-8000-000000000000',
          'performance_fuel',
        ),
      ).toEqual({ ok: false, refusal: 'member_absent' });
    });
  });

  /** AC3, end to end through the roster read. */
  describe('Type Mastery and the fleet', () => {
    it('is inert for an airline that operates no aircraft of the family', async () => {
      const made = await baseWithPool({
        heads: 4,
        xpPerHead: xpForLevel(SKILLS.namedFromLevel, SKILLS),
      });
      await nameEligibleCrew(db.db, made.fixture.world.id, GAME_NOW);
      const [member] = await members(made.crewBaseId);
      if (!member) throw new Error('nobody was named');

      await allocateSkillPoint(db.db, own(made.fixture), member.id, 'type_mastery');

      const roster = await readRoster(db.db, own(made.fixture));
      // The fixture airline owns no airframes, so it operates no families at all.
      expect(roster.operatedFamilies).toEqual([]);
      expect(roster.members[0]?.typeMasteryActive).toBe(false);
      // The point is kept, not refunded.
      expect(roster.members[0]?.spent).toEqual({ type_mastery: 1 });
      // And it buys nothing.
      const maintenance = roster.boosts.find((b) => b.ceiling === 'maintenanceCost');
      expect(maintenance?.fraction).toBe(0);
      expect(maintenance?.contributors).toBe(0);
    });
  });
});
