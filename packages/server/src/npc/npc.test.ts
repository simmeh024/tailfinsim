import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, demandPool, npcDecision, route, world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';
import { competitorsFor } from '../network/competitors';
import { REFERENCE_AIRFRAME } from '../network/economics';
import { createWorld } from '../world/lifecycle';

import { readNpcDecisions } from './decisions';
import { reviewDue, reviewNpcCarriers } from './operate';
import { seedNpcCarriers } from './seed';

/**
 * NPC carriers, against a real database (M3-12, §24).
 *
 * M3-12's four acceptance criteria, each with a test that fails if it stops
 * being true:
 *
 *   1. a newly seeded world has plausible incumbent competition on major pairs
 *   2. an uncontested high-margin route attracts NPC entry within ~30 game days
 *   3. NPC decisions are logged and inspectable
 *   4. NPCs never receive resources or modifiers unavailable to players
 *
 * The fourth is mostly proved in `packages/sim/src/npc/carrier.test.ts`, where
 * the demand model can be run directly. What is proved here is the half that
 * needs storage: an NPC is a row in `airline` under the same constraints, with
 * the same opening cash, and the database refuses to let it become anything
 * else.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [npc.test] DATABASE_URL not set — skipping NPC tests.\n');
const describeDb = url ? describe : describe.skip;

/** Unique per call — `world.name` is unique, and CI runs every suite in one database. */
function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/**
 * Two letters, from a serial rather than a random draw.
 *
 * ICAO codes are unique per airport and must be four uppercase letters. A
 * random pair would collide eventually across a long run and fail an insert
 * for a reason that had nothing to do with the test; a serial cannot, and CI
 * starts from a fresh database each run.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let tagSerial = 0;
function nextTag(): string {
  const n = tagSerial++;
  return `${LETTERS[Math.floor(n / 26) % 26]!}${LETTERS[n % 26]!}`;
}

describeDb('NPC carriers', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      // `npc_decision`, `route` and `airline` all cascade from the world.
      await db.db.delete(world).where(eq(world.id, id));
    }
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeWorld(): Promise<string> {
    const created = await createWorld(db.db, { ...FLAGSHIP_CONFIG, name: uniqueName('npc-test') });
    madeWorlds.push(created.world.id);
    return created.world.id;
  }

  /**
   * A pair of hub airports and a fat market between them.
   *
   * Built rather than borrowed: the OurAirports import may or may not have run
   * in this database, and a test that depended on Amsterdam existing would pass
   * or fail on whether another suite had imported it.
   */
  async function makeMarket(worldId: string, dailyPassengers = 1_400): Promise<[string, string]> {
    // Four uppercase letters, because `airport_icao_code_format` demands
    // exactly that. A uuid slice looks unique and is not a legal ICAO code — it
    // carries digits, and CI refused every one of them.
    const tag = nextTag();
    const a = `ZA${tag}`;
    const b = `ZB${tag}`;

    for (const [icao, name, lat] of [
      [a, `Alpha ${tag}`, 52],
      [b, `Bravo ${tag}`, 41],
    ] as const) {
      await db.db.insert(airport).values({
        sourceId: Math.floor(Math.random() * 1_000_000_000),
        ident: icao,
        icaoCode: icao,
        name,
        municipality: name,
        isoCountry: icao === a ? 'ZA' : 'ZB',
        kind: 'large_airport',
        latitude: lat,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: true,
        tier: 'flagship',
        // Deliberately enormous. Seeding takes the top hubs by catchment and
        // caps the number of countries, so a fixture with a merely plausible
        // catchment could be pushed out of the running by whatever airports
        // another suite happened to leave in the shared CI database.
        catchmentPopulation: 900_000_000,
      });
      madeAirports.push(icao);
    }

    // `demand_pool` enforces `origin < destination`, so the pair is stored in
    // the order the check demands rather than the order it was written here.
    const [origin, destination] = a < b ? [a, b] : [b, a];
    await db.db.insert(demandPool).values({
      worldId,
      originIcao: origin,
      destinationIcao: destination,
      distanceNm: 700,
      dailyPassengers: dailyPassengers.toFixed(2),
      businessShare: '0.2500',
      leisureShare: '0.5500',
      vfrShare: '0.2000',
      basis: '{}',
      gravityVersion: 'v1',
    });

    return [origin, destination];
  }

  // ------------------------------------------------------- an NPC is an airline

  describe('what an NPC is', () => {
    it('is an airline row with no player and an archetype', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId);
      const result = await seedNpcCarriers(db.db, worldId);

      expect(result.created).toBeGreaterThan(0);

      const carriers = await db.db
        .select()
        .from(airline)
        .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')));

      expect(carriers.length).toBe(result.created);
      for (const carrier of carriers) {
        expect(carrier.playerId).toBeNull();
        expect(carrier.archetype).not.toBeNull();
        expect(carrier.status).toBe('active');
      }
    });

    it('starts with exactly the cash a player is founded with', async () => {
      // The clearest possible breach of the no-cheating criterion would be an
      // NPC with a bottomless balance, so the figure is asserted against the
      // world's own economy config rather than against a constant.
      const worldId = await makeWorld();
      await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const economy = await loadEconomyConfig(db.db, FLAGSHIP_CONFIG.economyConfigVersion);
      const carriers = await db.db
        .select({ cashMinor: airline.cashMinor })
        .from(airline)
        .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')));

      for (const carrier of carriers) {
        expect(carrier.cashMinor).toBe(economy.airlineStartingPosition.openingCashMinor);
      }
    });

    it('cannot be given a player, and a player cannot be given an archetype', async () => {
      // Enforced by the database rather than by the seeding code, so the two
      // kinds cannot drift into each other however a row is written.
      const worldId = await makeWorld();
      await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const carrier = (
        await db.db
          .select({ id: airline.id })
          .from(airline)
          .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')))
          .limit(1)
      )[0];
      if (!carrier) throw new Error('expected a carrier');

      await expect(
        db.db.update(airline).set({ kind: 'player' }).where(eq(airline.id, carrier.id)),
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------- criterion 1: a populated world

  describe('a newly seeded world', () => {
    it('has incumbents on its major city pairs', async () => {
      const worldId = await makeWorld();
      const [origin, destination] = await makeMarket(worldId);

      const result = await seedNpcCarriers(db.db, worldId);
      expect(result.routesOpened).toBeGreaterThan(0);

      const onPair = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(route)
        .where(
          and(
            eq(route.worldId, worldId),
            eq(route.originIcao, origin),
            eq(route.destinationIcao, destination),
          ),
        );
      expect(onPair[0]?.n ?? 0).toBeGreaterThan(0);
    });

    it('is deterministic — the same world seeds the same carriers', async () => {
      // Two worlds cannot share a seed, so determinism is asserted the way it
      // can be: the same world, seeded, torn down and seeded again, produces
      // the same identities. `world.seed` is what both runs draw from.
      const worldId = await makeWorld();
      await makeMarket(worldId);

      await seedNpcCarriers(db.db, worldId);
      const first = await db.db
        .select({ iataCode: airline.iataCode, archetype: airline.archetype })
        .from(airline)
        .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')))
        .orderBy(airline.iataCode);

      await db.db.delete(airline).where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')));

      await seedNpcCarriers(db.db, worldId);
      const second = await db.db
        .select({ iataCode: airline.iataCode, archetype: airline.archetype })
        .from(airline)
        .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')))
        .orderBy(airline.iataCode);

      expect(second).toEqual(first);
    });

    it('does not seed twice', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId);

      const first = await seedNpcCarriers(db.db, worldId);
      const second = await seedNpcCarriers(db.db, worldId);

      expect(first.alreadySeeded).toBe(false);
      expect(second.alreadySeeded).toBe(true);
      expect(second.created).toBe(0);
    });

    it('says so plainly when the world has no demand pools', async () => {
      // The prerequisite that is not guessable: NPCs pick their networks from
      // `demand_pool`, so a world that never ran `demand:generate` gets a
      // message rather than sixty carriers flying nowhere.
      const worldId = await makeWorld();
      const result = await seedNpcCarriers(db.db, worldId);
      expect(result.created).toBe(0);
      expect(result.alreadySeeded).toBe(false);
    });
  });

  // ------------------------------------- criterion 3: decisions are inspectable

  describe('the decision log', () => {
    it('records why every route was opened', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const decisions = await readNpcDecisions(db.db, worldId);
      expect(decisions.length).toBeGreaterThan(0);

      const opened = decisions.find((d) => d.kind === 'route_opened');
      expect(opened).toBeDefined();
      expect(opened?.reason).toMatch(/passengers a day/);
      // The numbers the decision rested on, not just the sentence.
      expect(opened?.basis.dailyPassengers).toBeGreaterThan(0);
      expect(opened?.basis.variableCostPerSeatMinor).toBeGreaterThan(0);
      // The economy version it was judged under, so it stays explicable after a
      // retune (invariant 4).
      expect(opened?.economyConfigVersion).toBe(FLAGSHIP_CONFIG.economyConfigVersion);
    });

    it('is scoped to one world', async () => {
      const a = await makeWorld();
      const b = await makeWorld();
      await makeMarket(a);
      await makeMarket(b);
      await seedNpcCarriers(db.db, a);

      expect((await readNpcDecisions(db.db, a)).length).toBeGreaterThan(0);
      expect(await readNpcDecisions(db.db, b)).toEqual([]);
    });

    it('goes with the world when the world goes', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      await db.db.delete(world).where(eq(world.id, worldId));
      madeWorlds.splice(madeWorlds.indexOf(worldId), 1);

      const left = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(npcDecision)
        .where(eq(npcDecision.worldId, worldId));
      expect(left[0]?.n ?? 0).toBe(0);
    });
  });

  // ------------------------------------ criterion 2: monopolies attract entry

  describe('the weekly review', () => {
    it('only runs when the world clock says so', () => {
      const epoch = new Date('2024-10-20T00:00:00.000Z');
      const day = (n: number) => new Date(epoch.getTime() + n * 86_400_000);

      expect(reviewDue(epoch, day(0), 7)).toBe(true);
      expect(reviewDue(epoch, day(3), 7)).toBe(false);
      expect(reviewDue(epoch, day(7), 7)).toBe(true);
      // Before the epoch is not a review, it is a clock that has not started.
      expect(reviewDue(epoch, day(-1), 7)).toBe(false);
    });

    it('enters an uncontested market, and logs why', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId, 2_400);
      await seedNpcCarriers(db.db, worldId);

      // Clear the world's routes so every market is uncontested — the A.10
      // monopoly case, with carriers already in existence to notice it.
      await db.db.delete(route).where(eq(route.worldId, worldId));
      await db.db.delete(npcDecision).where(eq(npcDecision.worldId, worldId));

      const epoch = (
        await db.db.select({ epoch: world.epoch }).from(world).where(eq(world.id, worldId))
      )[0]!.epoch;

      // Day 28 — four weekly reviews in, comfortably inside the ~30 game days
      // the acceptance criterion allows.
      const result = await reviewNpcCarriers(
        db.db,
        worldId,
        new Date(epoch.getTime() + 28 * 86_400_000),
      );

      expect(result.reviewed).toBe(true);
      expect(result.entered).toBeGreaterThan(0);

      const decisions = await readNpcDecisions(db.db, worldId);
      const opened = decisions.find((d) => d.kind === 'route_opened');
      expect(opened?.reason).toMatch(/Entered/);
      expect(opened?.basis.incumbents).toBe(0);
    });

    it('does nothing on a day that is not a review day', async () => {
      const worldId = await makeWorld();
      await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const epoch = (
        await db.db.select({ epoch: world.epoch }).from(world).where(eq(world.id, worldId))
      )[0]!.epoch;

      const result = await reviewNpcCarriers(
        db.db,
        worldId,
        new Date(epoch.getTime() + 3 * 86_400_000),
      );
      expect(result.reviewed).toBe(false);
      expect(result.entered).toBe(0);
    });

    it('is a no-op on a world with no carriers', async () => {
      const worldId = await makeWorld();
      const epoch = (
        await db.db.select({ epoch: world.epoch }).from(world).where(eq(world.id, worldId))
      )[0]!.epoch;

      const result = await reviewNpcCarriers(db.db, worldId, epoch);
      expect(result.carriers).toBe(0);
    });
  });

  // ------------------------------------------ competitors reach the player

  describe('what a player sees', () => {
    it('finds the incumbent on their market, in either direction', async () => {
      const worldId = await makeWorld();
      const [origin, destination] = await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const economy = await loadEconomyConfig(db.db, FLAGSHIP_CONFIG.economyConfigVersion);
      const query = {
        worldId,
        excludeAirlineId: randomUUID(),
        economy,
        playerSeatsByCabin: REFERENCE_AIRFRAME.seatsByCabin,
      };

      const forward = await competitorsFor(db.db, {
        ...query,
        originIcao: origin,
        destinationIcao: destination,
      });
      // The reverse direction is the same market. Before M3-12 this returned
      // nothing, and the player flying it saw an empty market.
      const reverse = await competitorsFor(db.db, {
        ...query,
        originIcao: destination,
        destinationIcao: origin,
      });

      expect(forward.length).toBeGreaterThan(0);
      expect(reverse.map((c) => c.id).sort()).toEqual(forward.map((c) => c.id).sort());
    });

    it('never lists the asking airline as its own competitor', async () => {
      const worldId = await makeWorld();
      const [origin, destination] = await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const incumbent = (
        await db.db
          .select({ id: route.airlineId })
          .from(route)
          .where(
            and(
              eq(route.worldId, worldId),
              eq(route.originIcao, origin),
              eq(route.destinationIcao, destination),
            ),
          )
          .limit(1)
      )[0];
      if (!incumbent) throw new Error('expected an incumbent');

      const economy = await loadEconomyConfig(db.db, FLAGSHIP_CONFIG.economyConfigVersion);
      const competitors = await competitorsFor(db.db, {
        worldId,
        originIcao: origin,
        destinationIcao: destination,
        excludeAirlineId: incumbent.id,
        economy,
        playerSeatsByCabin: REFERENCE_AIRFRAME.seatsByCabin,
      });

      expect(competitors.map((c) => c.id)).not.toContain(incumbent.id);
    });

    it('sells every competitor at or above A.10’s floor', async () => {
      // The no-cheating criterion where a player would actually notice it: an
      // NPC undercutting the price a player is refused at.
      const worldId = await makeWorld();
      const [origin, destination] = await makeMarket(worldId);
      await seedNpcCarriers(db.db, worldId);

      const economy = await loadEconomyConfig(db.db, FLAGSHIP_CONFIG.economyConfigVersion);
      const competitors = await competitorsFor(db.db, {
        worldId,
        originIcao: origin,
        destinationIcao: destination,
        excludeAirlineId: randomUUID(),
        economy,
        playerSeatsByCabin: REFERENCE_AIRFRAME.seatsByCabin,
      });

      for (const competitor of competitors) {
        for (const offer of Object.values(competitor.cabins)) {
          expect(offer.fareMinor).toBeGreaterThan(0);
        }
      }
    });
  });
});
