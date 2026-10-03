import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, ResearchResponse, type ResearchNodeId } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { openCrewBase } from '../crew/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  academy,
  airline,
  airport,
  cashMovement,
  flight,
  flightResult,
  ledgerEntry,
  researchAccount,
  researchProject,
} from '../db/schema';
import { settleArrivedFlight } from '../flight/settle';
import { fixtureAirframe } from '../test-fixtures/airframe';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { accrueResearchPoints, debitResearchPoints } from './points';
import { readResearch, startResearch } from './store';

/**
 * §10.3's research tree against a real database (M9-05).
 *
 * The pure half — the formula, the state machine, lazy completion — has its own
 * tests in `packages/sim`. What is worth proving here is what only Postgres can
 * answer: that points ride the settlement's replay guard, that a large airline
 * with no academy really earns nothing end to end, that a start moves points
 * and cash together or not at all, that one project at a time holds against two
 * requests arriving together, and that the CHECKs refuse what no code path
 * should ever attempt.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [research/store.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('research/store');

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const LOAD = JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } });
const FORMULA = ECONOMY_CONFIG_V1.research.pointsFormula;
const NODES = ECONOMY_CONFIG_V1.research.nodes;

/** The Postgres error under drizzle's wrapper (CLAUDE.md: walk `cause`). */
async function pgErrorCode(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    while (current !== undefined && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^\d{5}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
  return undefined;
}

describeDb('research against a real database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  /** The wall-clock instant every game time in a test is derived from. */
  let now: Date;
  let baseSerial = 0;

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

  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Research Test Field ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude,
      longitude,
      scheduledService: true,
      hasRunwayData: false,
      continent: 'EU',
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  interface Airline {
    fixture: FoundedAirlineFixture;
    own: { worldId: string; airlineId: string };
    origin: string;
    dest: string;
  }

  async function makeAirline(): Promise<Airline> {
    now = new Date();
    const fixture = await fixtures.create();
    const origin = await makeAirport(52.3086, 4.76389);
    const dest = await makeAirport(51.4706, -0.461941);
    return {
      fixture,
      own: { worldId: fixture.world.id, airlineId: fixture.airline.id },
      origin,
      dest,
    };
  }

  /**
   * An academy at a crew base, already at `level`.
   *
   * Inserted at its level rather than built through the worker's sweep: the
   * build path is `academy/store.test.ts`'s to prove, and what matters here is
   * only the commissioned integer §10.3 sums.
   */
  async function academyAt(
    who: Airline,
    level: number,
    pending?: { pendingLevel: number },
  ): Promise<void> {
    baseSerial += 1;
    const icao = await makeAirport(52 + baseSerial / 100, 5 + baseSerial / 100);
    const opened = await openCrewBase(db.db, { ...who.own, airportIcao: icao });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    const gameNow = await worldGameNow(db.db, who.own.worldId, now);
    await db.db.insert(academy).values({
      worldId: who.own.worldId,
      airlineId: who.own.airlineId,
      crewBaseId: opened.value.crewBaseId,
      level,
      pendingLevel: pending?.pendingLevel ?? null,
      constructionStartedAt: pending ? gameNow : null,
      constructionReadyAt: pending ? new Date(gameNow.getTime() + 28 * DAY_MS) : null,
    });
  }

  /** Fly and settle one sector, arriving `daysAgo` game days before the world's now. */
  async function settleOne(who: Airline, daysAgo = 1): Promise<string> {
    const gameNow = await worldGameNow(db.db, who.own.worldId, now);
    const arrives = new Date(gameNow.getTime() - daysAgo * DAY_MS);
    const [row] = await db.db
      .insert(flight)
      .values({
        worldId: who.own.worldId,
        airlineId: who.own.airlineId,
        airframeId: randomUUID(),
        originIcao: who.origin,
        destinationIcao: who.dest,
        scheduledDeparture: new Date(arrives.getTime() - 2 * HOUR_MS),
        estimatedArrival: arrives,
        load: LOAD,
        cargoKg: 0,
      })
      .returning({ id: flight.id });
    if (!row) throw new Error('no flight');
    await settle(row.id, arrives);
    return row.id;
  }

  async function settle(flightId: string, arrives: Date): Promise<void> {
    await db.db.transaction(async (tx) => {
      const outcome = await settleArrivedFlight(tx, flightId, arrives, {
        resolveAirframe: () => fixtureAirframe(),
        resolveWeather: () => null,
      });
      if (outcome.status === 'not-found') throw new Error('flight vanished');
    });
  }

  /**
   * Bank points the only way there is — the settlement accrual — without
   * settling hundreds of sectors to do it. One long "flight" of block time.
   */
  async function bankPoints(who: Airline, levelSum: number, points: number): Promise<void> {
    const blockMinutes = (points * FORMULA.scalingFactorHours * 60) / levelSum;
    await db.db.transaction((tx) =>
      accrueResearchPoints(tx, { flightId: randomUUID(), ...who.own, blockMinutes }, FORMULA),
    );
  }

  async function account(airlineId: string) {
    const [row] = await db.db
      .select()
      .from(researchAccount)
      .where(eq(researchAccount.airlineId, airlineId));
    return row;
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    return row?.cashMinor ?? 0;
  }

  async function breakdownResearch(flightId: string) {
    const [row] = await db.db
      .select({ breakdown: flightResult.breakdown, blockSeconds: flightResult.blockSeconds })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    const parsed = JSON.parse(row?.breakdown ?? '{}') as {
      research?: {
        points: number;
        academyLevelSum: number;
        academyStaffQuality: number;
        scalingFactorHours: number;
        blockHours: number;
      };
    };
    return { research: parsed.research, blockSeconds: row?.blockSeconds ?? 0 };
  }

  function nodeOf(response: ResearchResponse, id: ResearchNodeId) {
    const node = response.branches.flatMap((branch) => branch.nodes).find((row) => row.id === id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  }

  // -------------------------------------------------------------------------
  // Earning
  // -------------------------------------------------------------------------

  it('gives a large airline with no academy nothing, however much it flies', async () => {
    // Issue #92's second criterion, end to end: twelve settled sectors, every
    // one of them earning zero and saying so.
    const who = await makeAirline();
    const flights: string[] = [];
    for (let i = 0; i < 12; i += 1) flights.push(await settleOne(who, 1 + i / 4));

    expect(await account(who.own.airlineId)).toBeUndefined();
    for (const id of flights) {
      const { research } = await breakdownResearch(id);
      // "Why did I earn nothing?" has an answer on every flight.
      expect(research?.points).toBe(0);
      expect(research?.academyLevelSum).toBe(0);
      expect(research?.blockHours).toBeGreaterThan(0);
    }

    const tree = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    expect(tree.points).toEqual({ balance: 0, earnedTotal: 0, recentPerDay: 0 });
    expect(tree.formula.academyLevelSum).toBe(0);
    // And the page can say why: the hours are there, the academies are not.
    expect(tree.formula.fleetFlightHoursPerDay).toBeGreaterThan(0);
    expect(tree.academy).toEqual({ highestLevel: 0, researchTier: null });
    for (const node of tree.branches.flatMap((branch) => branch.nodes)) {
      expect(node.status, node.id).toBe('locked');
      expect(node.startRefusal, node.id).toBe('academy_level');
    }
  });

  it('pays Σ(levels) × quality × block hours ÷ scaling factor, and records why', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await academyAt(who, 2);
    const flightId = await settleOne(who);

    const { research, blockSeconds } = await breakdownResearch(flightId);
    const blockHours = blockSeconds / 3_600;
    expect(research?.academyLevelSum).toBe(3);
    expect(research?.academyStaffQuality).toBe(FORMULA.academyStaffQuality);
    expect(research?.scalingFactorHours).toBe(FORMULA.scalingFactorHours);
    expect(research?.blockHours).toBeCloseTo(blockHours, 3);
    const expected = (3 * FORMULA.academyStaffQuality * blockHours) / FORMULA.scalingFactorHours;
    expect(research?.points).toBeCloseTo(expected, 2);

    const row = await account(who.own.airlineId);
    expect(row?.earnedMilli).toBe(Math.round((research?.points ?? 0) * 1_000));
    expect(row?.spentMilli).toBe(0);
  });

  it('counts a building site as nothing, and a level under construction as the level below', async () => {
    const who = await makeAirline();
    await academyAt(who, 0, { pendingLevel: 1 });
    await academyAt(who, 2, { pendingLevel: 3 });
    const flightId = await settleOne(who);
    expect((await breakdownResearch(flightId)).research?.academyLevelSum).toBe(2);
  });

  it('accrues a flight’s points exactly once, however often the arrival is replayed', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    const flightId = await settleOne(who);
    const once = (await account(who.own.airlineId))?.earnedMilli;
    expect(once).toBeGreaterThan(0);

    const [row] = await db.db
      .select({ settledAt: flightResult.settledAt })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    await settle(flightId, row!.settledAt);
    await settle(flightId, row!.settledAt);
    expect((await account(who.own.airlineId))?.earnedMilli).toBe(once);
  });

  it('reports the last game week’s points per day, from what flights recorded', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    const recent = [await settleOne(who, 1), await settleOne(who, 3)];
    // Outside the window: counted in the total, not in the rate.
    await settleOne(who, 9);

    let sum = 0;
    let seconds = 0;
    for (const id of recent) {
      const facts = await breakdownResearch(id);
      sum += facts.research?.points ?? 0;
      seconds += facts.blockSeconds;
    }

    const tree = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    expect(tree.points.recentPerDay).toBeCloseTo(sum / 7, 6);
    // The formula's third factor, over the same window and the same rows.
    expect(tree.formula.fleetFlightHoursPerDay).toBeCloseTo(seconds / 3_600 / 7, 6);
    expect(tree.points.earnedTotal).toBeGreaterThan(sum);
    expect(tree.formula.academyLevelSum).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Spending
  // -------------------------------------------------------------------------

  it('starts a project by spending its points and its cash together', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await bankPoints(who, 1, 150);
    const cashBefore = await cashOf(who.own.airlineId);
    const gameNow = await worldGameNow(db.db, who.own.worldId, now);

    const started = await startResearch(db.db, who.own, 'cost_index_sop', now);
    expect(started.ok).toBe(true);

    const row = await account(who.own.airlineId);
    expect(row?.spentMilli).toBe(NODES.cost_index_sop.researchPoints * 1_000);
    expect(await cashOf(who.own.airlineId)).toBe(cashBefore - NODES.cost_index_sop.cashCostMinor);

    const reference = `${who.own.airlineId}:research:cost_index_sop`;
    const [movement] = await db.db
      .select()
      .from(cashMovement)
      .where(and(eq(cashMovement.cause, 'research'), eq(cashMovement.reference, reference)));
    expect(movement?.amountMinor).toBe(-NODES.cost_index_sop.cashCostMinor);
    expect(movement?.occurredAt.getTime()).toBe(gameNow.getTime());
    const [line] = await db.db
      .select({ category: ledgerEntry.category })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.cashMovementId, movement!.id));
    expect(line?.category).toBe('crew');

    const [project] = await db.db
      .select()
      .from(researchProject)
      .where(eq(researchProject.airlineId, who.own.airlineId));
    expect(project?.nodeId).toBe('cost_index_sop');
    expect(project?.startedAt.getTime()).toBe(gameNow.getTime());
    // Game weeks, on the world's clock (ADR-0026).
    expect(project!.completesAt.getTime() - project!.startedAt.getTime()).toBe(
      NODES.cost_index_sop.buildWeeks * 7 * DAY_MS,
    );

    const tree = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    expect(tree.points.balance).toBeCloseTo(50, 6);
    expect(tree.active?.nodeId).toBe('cost_index_sop');
    expect(nodeOf(tree, 'cost_index_sop')).toMatchObject({
      status: 'in_progress',
      startRefusal: null,
    });
    expect(nodeOf(tree, 'boarding_sop').startRefusal).toBe('project_running');
  });

  it('completes lazily when the world’s clock reaches it, with nothing having run', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await bankPoints(who, 1, 250);
    expect((await startResearch(db.db, who.own, 'boarding_sop', now)).ok).toBe(true);

    // A second project is refused while the first runs.
    expect(await startResearch(db.db, who.own, 'line_efficiency', now)).toEqual({
      ok: false,
      refusal: 'project_running',
    });

    // Far enough on in real time for the world's clock to pass the build, at
    // this world's own speed — derived, never a literal date.
    const speed = Number(who.fixture.world.speedMultiplier);
    const buildMs = NODES.boarding_sop.buildWeeks * 7 * DAY_MS;
    const later = new Date(now.getTime() + buildMs / speed + DAY_MS);
    const tree = ResearchResponse.parse(await readResearch(db.db, who.own, later));
    expect(nodeOf(tree, 'boarding_sop').status).toBe('complete');
    expect(tree.active).toBeNull();
    // The next tier's academy gate is what stands in the way now, stated plainly.
    expect(nodeOf(tree, 'parallel_servicing')).toMatchObject({
      status: 'locked',
      startRefusal: 'academy_level',
      requiredAcademyLevel: 3,
      requiredAcademyName: 'Flight Academy',
    });

    expect((await startResearch(db.db, who.own, 'line_efficiency', later)).ok).toBe(true);
    expect(await startResearch(db.db, who.own, 'boarding_sop', later)).toEqual({
      ok: false,
      refusal: 'already_complete',
    });
  });

  it('runs one project at a time against two requests arriving together', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await bankPoints(who, 1, 500);

    const results = await Promise.all([
      startResearch(db.db, who.own, 'cost_index_sop', now),
      startResearch(db.db, who.own, 'boarding_sop', now),
      startResearch(db.db, who.own, 'reporting_culture', now),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok).map((result) => (result.ok ? null : result.refusal)),
    ).toEqual(['project_running', 'project_running']);

    const projects = await db.db
      .select()
      .from(researchProject)
      .where(eq(researchProject.airlineId, who.own.airlineId));
    expect(projects).toHaveLength(1);
    expect((await account(who.own.airlineId))?.spentMilli).toBe(100_000);
  });

  it('refuses a cash-rich airline with no points, and moves nothing', async () => {
    // "Research points cannot be purchased through any path": the purse is full
    // and it makes no difference.
    const who = await makeAirline();
    await academyAt(who, 1);
    const cashBefore = await cashOf(who.own.airlineId);
    expect(cashBefore).toBeGreaterThan(NODES.cost_index_sop.cashCostMinor * 10);

    expect(await startResearch(db.db, who.own, 'cost_index_sop', now)).toEqual({
      ok: false,
      refusal: 'insufficient_points',
    });
    expect(await cashOf(who.own.airlineId)).toBe(cashBefore);
    expect(await account(who.own.airlineId)).toBeUndefined();
    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(
        and(eq(cashMovement.airlineId, who.own.airlineId), eq(cashMovement.cause, 'research')),
      );
    expect(movements).toEqual([]);
  });

  it('refuses an airline with points and no money, and keeps its points', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await bankPoints(who, 1, 150);
    const gameNow = await worldGameNow(db.db, who.own.worldId, now);
    const cash = await cashOf(who.own.airlineId);
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: who.own.airlineId,
        amountMinor: -(cash - 1_000_000),
        cause: 'admin_adjustment',
        reference: `research-test-drain-${who.own.airlineId}`,
        occurredAt: gameNow,
      }),
    );

    expect(await startResearch(db.db, who.own, 'cost_index_sop', now)).toEqual({
      ok: false,
      refusal: 'insufficient_funds',
    });
    expect((await account(who.own.airlineId))?.spentMilli).toBe(0);
    expect(await cashOf(who.own.airlineId)).toBe(1_000_000);
  });

  it('shows tiers 3 and 4 priced and locked, naming the academy or the release', async () => {
    const who = await makeAirline();
    await academyAt(who, 3);
    let tree = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    expect(nodeOf(tree, 'tankering_doctrine')).toMatchObject({
      status: 'locked',
      startRefusal: 'academy_level',
      requiredAcademyLevel: 4,
      requiredAcademyName: 'Full-Flight Sim Centre',
      released: false,
      effects: [],
      cost: {
        researchPoints: NODES.tankering_doctrine.researchPoints,
        cashMinor: NODES.tankering_doctrine.cashCostMinor,
        buildWeeks: NODES.tankering_doctrine.buildWeeks,
      },
    });
    expect(nodeOf(tree, 'in_house_heavy_checks')).toMatchObject({
      requiredAcademyLevel: 5,
      requiredAcademyName: 'Centre of Excellence',
    });

    await academyAt(who, 5);
    tree = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    expect(tree.academy).toEqual({ highestLevel: 5, researchTier: 4 });
    expect(tree.formula.academyLevelSum).toBe(8);
    expect(nodeOf(tree, 'tankering_doctrine').startRefusal).toBe('not_released');
    expect(nodeOf(tree, 'in_house_heavy_checks').startRefusal).toBe('not_released');
    expect(await startResearch(db.db, who.own, 'tankering_doctrine', now)).toEqual({
      ok: false,
      refusal: 'not_released',
    });
  });

  // -------------------------------------------------------------------------
  // The database's own refusals
  // -------------------------------------------------------------------------

  it('refuses an account that has spent more than it earned, or earned less than nothing', async () => {
    const who = await makeAirline();
    expect(
      await pgErrorCode(
        db.db.insert(researchAccount).values({ ...who.own, earnedMilli: 1_000, spentMilli: 1_001 }),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        db.db.insert(researchAccount).values({ ...who.own, earnedMilli: -1, spentMilli: 0 }),
      ),
    ).toBe('23514');
  });

  it('refuses an overdraft through the debit itself, and a debit that would be a credit', async () => {
    const who = await makeAirline();
    await academyAt(who, 1);
    await bankPoints(who, 1, 10);
    expect(
      await pgErrorCode(
        db.db.transaction((tx) => debitResearchPoints(tx, who.own.airlineId, 10_001)),
      ),
    ).toBe('23514');
    await expect(
      db.db.transaction((tx) => debitResearchPoints(tx, who.own.airlineId, -5_000)),
    ).rejects.toThrow(/positive/);
    await expect(
      db.db.transaction((tx) => debitResearchPoints(tx, who.own.airlineId, 0)),
    ).rejects.toThrow(/positive/);
    expect((await account(who.own.airlineId))?.spentMilli).toBe(0);
  });

  it('refuses a project that ends before it starts, costs nothing, or repeats a node', async () => {
    const who = await makeAirline();
    const gameNow = await worldGameNow(db.db, who.own.worldId, now);
    const base = {
      ...who.own,
      nodeId: 'cost_index_sop',
      startedAt: gameNow,
      completesAt: new Date(gameNow.getTime() + 21 * DAY_MS),
      researchPoints: 100,
      cashCostMinor: 3_000_000,
    };
    expect(
      await pgErrorCode(db.db.insert(researchProject).values({ ...base, completesAt: gameNow })),
    ).toBe('23514');
    expect(
      await pgErrorCode(db.db.insert(researchProject).values({ ...base, researchPoints: 0 })),
    ).toBe('23514');
    expect(
      await pgErrorCode(db.db.insert(researchProject).values({ ...base, cashCostMinor: 0 })),
    ).toBe('23514');

    await db.db.insert(researchProject).values(base);
    expect(await pgErrorCode(db.db.insert(researchProject).values(base))).toBe('23505');
  });
});
