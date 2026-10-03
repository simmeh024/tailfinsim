import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ECONOMY_CONFIG_V1,
  EFFICIENCY_QUANTITIES,
  RESEARCH_NODES,
  ResearchResponse,
  type ResearchNodeId,
} from '@tailfin/shared';

import { previousMonth } from '../crew/payroll';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, cashMovement, flight, flightResult, researchProject } from '../db/schema';
import { resolveAirlineEfficiency } from '../economy/efficiency';
import { settleArrivedFlight } from '../flight/settle';
import { fixtureAirframe } from '../test-fixtures/airframe';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { airlineDoctrine, runResearchUpkeep, setDoctrineFunding } from './doctrine';
import { readResearch } from './store';

/**
 * §10.4 applied, against a real database (M9-06).
 *
 * The two acceptance criteria this suite owns end to end:
 *
 *   - *"Ceasing upkeep visibly decays the advantage over game weeks"* — the
 *     strength falls week by week once funding stops, on the page **and** on
 *     what a flight is actually billed;
 *   - and the boosts reaching their consumers at all: a completed doctrine takes
 *     fuel, block time and the maintenance reserve off a settled flight, and
 *     resolves into all six quantities against their own ceilings.
 *
 * The pure halves — the lapse arithmetic, the resolver's cap — have their own
 * tests in `packages/sim`. What only Postgres answers is that the columns, the
 * month boundaries, the cash movement and the settlement agree.
 *
 * Every instant is derived from one wall-clock `now` read per test; a literal
 * date in a game-clock test has expired twice in this repository.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [research/doctrine.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('research/doctrine');

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const LOAD = JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } });
const BALANCE = ECONOMY_CONFIG_V1.research;
const NODES = BALANCE.nodes;
const UPKEEP = BALANCE.upkeep;
const CEILINGS = ECONOMY_CONFIG_V1.boosts.ceilings;

const effect = (node: ResearchNodeId, target: string): number =>
  (NODES[node].effects as Record<string, number | undefined>)[target] ?? 0;

describeDb('doctrine against a real database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let now: Date;

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
      name: `Doctrine Test Field ${identity.icaoCode}`,
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
    own: { worldId: string; airlineId: string };
    origin: string;
    dest: string;
    gameNow: Date;
  }

  async function makeAirline(): Promise<Airline> {
    now = new Date();
    const fixture = await fixtures.create();
    const own = { worldId: fixture.world.id, airlineId: fixture.airline.id };
    return {
      own,
      // The same sector for every airline, so two of them fly identical flights.
      origin: await makeAirport(52.3086, 4.76389),
      dest: await makeAirport(51.4706, -0.461941),
      gameNow: await worldGameNow(db.db, own.worldId, now),
    };
  }

  /** A research project, written directly: the start path is `store.test.ts`'s to prove. */
  async function researched(
    who: Airline,
    nodeId: ResearchNodeId,
    completesAt: Date,
    funding: { funded: boolean; changedAt: Date; permille?: number } | null = null,
  ): Promise<void> {
    await db.db.insert(researchProject).values({
      worldId: who.own.worldId,
      airlineId: who.own.airlineId,
      nodeId,
      startedAt: new Date(completesAt.getTime() - NODES[nodeId].buildWeeks * WEEK_MS),
      completesAt,
      researchPoints: NODES[nodeId].researchPoints,
      cashCostMinor: NODES[nodeId].cashCostMinor,
      ...(funding === null
        ? {}
        : {
            funded: funding.funded,
            fundingChangedAt: funding.changedAt,
            strengthAtChangePermille: funding.permille ?? 1000,
          }),
    });
  }

  async function settleAt(who: Airline, arrives: Date): Promise<string> {
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
    await db.db.transaction(async (tx) => {
      const outcome = await settleArrivedFlight(tx, row.id, arrives, {
        resolveAirframe: () => fixtureAirframe(),
        resolveWeather: () => null,
      });
      if (outcome.status !== 'settled') throw new Error(`not settled: ${outcome.status}`);
    });
    return row.id;
  }

  interface Settled {
    blockSeconds: number;
    fuelTonnes: number;
    maintenanceMinor: number;
    crewFuelBoost: { fraction: number; bySource: Record<string, number> };
    efficiency: Record<string, { fraction: number; bySource: Record<string, number> }>;
  }

  async function settled(flightId: string): Promise<Settled> {
    const [row] = await db.db
      .select({ breakdown: flightResult.breakdown, blockSeconds: flightResult.blockSeconds })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    const parsed = JSON.parse(row?.breakdown ?? '{}') as {
      fuelTonnes: number;
      costs: { source: string; amountMinor: number }[];
      crewFuelBoost: Settled['crewFuelBoost'];
      efficiency: Settled['efficiency'];
    };
    return {
      blockSeconds: row?.blockSeconds ?? 0,
      fuelTonnes: parsed.fuelTonnes,
      maintenanceMinor:
        parsed.costs.find((line) => line.source === 'maintenance')?.amountMinor ?? 0,
      crewFuelBoost: parsed.crewFuelBoost,
      efficiency: parsed.efficiency,
    };
  }

  async function upkeepMovements(airlineId: string) {
    return db.db
      .select({ amountMinor: cashMovement.amountMinor, reference: cashMovement.reference })
      .from(cashMovement)
      .where(and(eq(cashMovement.airlineId, airlineId), eq(cashMovement.cause, 'research_upkeep')));
  }

  const monthly = (node: ResearchNodeId) =>
    Math.round(NODES[node].cashCostMinor * UPKEEP.monthlyFractionOfCashCost);

  // -------------------------------------------------------------------------
  // Applied to flights
  // -------------------------------------------------------------------------

  it('takes completed doctrine off the flight it settles: fuel, block time and the reserve', async () => {
    const lean = await makeAirline();
    const plain = await makeAirline();
    const longAgo = new Date(lean.gameNow.getTime() - 20 * WEEK_MS);
    for (const node of ['cost_index_sop', 'continuous_descent', 'line_efficiency'] as const) {
      await researched(lean, node, longAgo);
    }

    const arrives = new Date(lean.gameNow.getTime() - DAY_MS);
    const withDoctrine = await settled(await settleAt(lean, arrives));
    const without = await settled(
      await settleAt(plain, new Date(plain.gameNow.getTime() - DAY_MS)),
    );

    const fuel =
      1 -
      (1 - effect('cost_index_sop', 'fuelBurn')) * (1 - effect('continuous_descent', 'fuelBurn'));
    const block = effect('continuous_descent', 'blockTime');
    const maintenance = effect('line_efficiency', 'maintenanceCost');

    // The figures explain themselves on the breakdown, by source.
    expect(withDoctrine.efficiency.fuelBurn?.fraction).toBeCloseTo(fuel, 9);
    expect(withDoctrine.crewFuelBoost.bySource.doctrine).toBeCloseTo(fuel, 9);
    expect(withDoctrine.efficiency.blockTime?.fraction).toBeCloseTo(block, 9);
    expect(withDoctrine.efficiency.maintenanceCost?.fraction).toBeCloseTo(maintenance, 9);
    expect(without.efficiency.fuelBurn?.fraction).toBe(0);

    // And they moved the bill: fewer block minutes, less fuel, a smaller reserve.
    expect(withDoctrine.blockSeconds / without.blockSeconds).toBeCloseTo(1 - block, 3);
    expect(withDoctrine.fuelTonnes).toBeLessThan(without.fuelTonnes * (1 - fuel) + 1e-9);
    const blockRatio = withDoctrine.blockSeconds / without.blockSeconds;
    expect(withDoctrine.maintenanceMinor / without.maintenanceMinor).toBeCloseTo(
      blockRatio * (1 - maintenance),
      2,
    );
  });

  it('is not doctrine until it is complete', async () => {
    const who = await makeAirline();
    await researched(who, 'cost_index_sop', new Date(who.gameNow.getTime() + WEEK_MS));
    const flown = await settled(await settleAt(who, new Date(who.gameNow.getTime() - DAY_MS)));
    expect(flown.efficiency.fuelBurn?.fraction).toBe(0);
  });

  it('resolves every one of the six quantities, each against its own ceiling', async () => {
    const who = await makeAirline();
    const longAgo = new Date(who.gameNow.getTime() - 50 * WEEK_MS);
    for (const node of RESEARCH_NODES.filter((row) => row.released)) {
      await researched(who, node.id, longAgo);
    }

    const { resolved, doctrineCrewXp } = await resolveAirlineEfficiency(
      db.db,
      who.own,
      who.gameNow,
      ECONOMY_CONFIG_V1,
    );
    for (const quantity of EFFICIENCY_QUANTITIES) {
      const stacked =
        1 -
        RESEARCH_NODES.filter((row) => row.released).reduce(
          (keep, row) => keep * (1 - effect(row.id, quantity)),
          1,
        );
      expect(stacked, quantity).toBeGreaterThan(0);
      expect(resolved[quantity].bySource.doctrine).toBeCloseTo(stacked, 9);
      expect(resolved[quantity].fraction).toBeCloseTo(Math.min(stacked, CEILINGS[quantity]), 9);
      expect(resolved[quantity].fraction).toBeLessThanOrEqual(CEILINGS[quantity]);
    }
    expect(doctrineCrewXp).toBeCloseTo(
      effect('efficient_conversion', 'crewXp') + effect('cadet_pipeline', 'crewXp'),
      9,
    );
  });

  // -------------------------------------------------------------------------
  // Lapse — the acceptance criterion
  // -------------------------------------------------------------------------

  it('decays visibly over game weeks once funding stops — on the page and on the bill', async () => {
    const who = await makeAirline();
    const completed = new Date(who.gameNow.getTime() - 12 * WEEK_MS);
    const stopped = new Date(who.gameNow.getTime() - 4 * WEEK_MS);
    await researched(who, 'cost_index_sop', completed, { funded: false, changedAt: stopped });
    const full = effect('cost_index_sop', 'fuelBurn');

    // Week by week, from the moment funding stopped.
    const readings: number[] = [];
    for (const weeks of [0, 2, 4, 6, 8]) {
      const at = new Date(stopped.getTime() + weeks * WEEK_MS);
      const doctrine = await airlineDoctrine(db.db, who.own.airlineId, at, BALANCE);
      readings.push(doctrine.efficiency.fuelBurn?.[0]?.fraction ?? 0);
    }
    const lapse = UPKEEP.lapseWeeks;
    expect(readings[0]).toBeCloseTo(full, 12);
    expect(readings[1]).toBeCloseTo(full * (1 - 2 / lapse), 12);
    expect(readings[2]).toBeCloseTo(full * (1 - 4 / lapse), 12);
    for (let index = 1; index < readings.length; index += 1) {
      expect(readings[index]).toBeLessThanOrEqual(readings[index - 1] ?? 1);
    }

    // The page says so: half gone, unfunded, and the date it reaches nothing.
    const page = ResearchResponse.parse(await readResearch(db.db, who.own, now));
    const node = page.branches
      .flatMap((branch) => branch.nodes)
      .find((row) => row.id === 'cost_index_sop');
    expect(node?.doctrine?.funded).toBe(false);
    expect(node?.doctrine?.strength).toBeCloseTo(1 - 4 / lapse, 6);
    expect(node?.doctrine?.settlesAt).toBe(
      new Date(stopped.getTime() + lapse * WEEK_MS).toISOString(),
    );
    const fuelRow = page.efficiency.find((row) => row.quantity === 'fuelBurn');
    expect(fuelRow?.bySource.doctrine).toBeCloseTo(full * (1 - 4 / lapse), 6);

    // And a flight is billed at the strength it had when it landed.
    const before = await settled(await settleAt(who, new Date(stopped.getTime() - DAY_MS)));
    const after = await settled(await settleAt(who, new Date(stopped.getTime() + 4 * WEEK_MS)));
    expect(before.crewFuelBoost.bySource.doctrine).toBeCloseTo(full, 9);
    expect(after.crewFuelBoost.bySource.doctrine).toBeCloseTo(full * (1 - 4 / lapse), 9);
  });

  // -------------------------------------------------------------------------
  // Upkeep
  // -------------------------------------------------------------------------

  it('bills a closed month once, for every node funded at any point of it', async () => {
    const who = await makeAirline();
    const period = previousMonth(who.gameNow);
    const monthStart = new Date(`${period}-01T00:00:00.000Z`);
    const nextMonthStart = new Date(monthStart.getTime() + 40 * DAY_MS);
    const monthEnd = new Date(
      Date.UTC(nextMonthStart.getUTCFullYear(), nextMonthStart.getUTCMonth(), 1),
    );
    const longAgo = new Date(monthStart.getTime() - 20 * WEEK_MS);

    // Funded throughout: owed.
    await researched(who, 'cost_index_sop', longAgo);
    // Unfunded since before the month: not owed.
    await researched(who, 'boarding_sop', longAgo, {
      funded: false,
      changedAt: new Date(monthStart.getTime() - WEEK_MS),
    });
    // Switched off on the month's last day: the month was used, and is owed.
    await researched(who, 'reporting_culture', longAgo, {
      funded: false,
      changedAt: new Date(monthEnd.getTime() - HOUR_MS),
    });
    // Completed after the month closed: not owed for it.
    await researched(who, 'service_standards', new Date(monthEnd.getTime() + HOUR_MS));

    const first = await runResearchUpkeep(db.db, who.own.worldId, who.gameNow);
    const expected = monthly('cost_index_sop') + monthly('reporting_culture');
    expect(first.totalMinor).toBeGreaterThanOrEqual(expected);
    expect(await upkeepMovements(who.own.airlineId)).toEqual([
      { amountMinor: -expected, reference: `research_upkeep:${who.own.airlineId}:${period}` },
    ]);

    // Attempted every tick, billed once.
    await runResearchUpkeep(db.db, who.own.worldId, who.gameNow);
    expect(await upkeepMovements(who.own.airlineId)).toHaveLength(1);
  });

  it('bills the closed month before it records a change of funding', async () => {
    const who = await makeAirline();
    await researched(who, 'cost_index_sop', new Date(who.gameNow.getTime() - 20 * WEEK_MS));

    const outcome = await setDoctrineFunding(
      db.db,
      who.own,
      'cost_index_sop',
      false,
      who.gameNow,
      BALANCE,
    );
    expect(outcome).toEqual({ ok: true });

    // The month that closed while it was funded is billed, by the change itself.
    expect(await upkeepMovements(who.own.airlineId)).toEqual([
      {
        amountMinor: -monthly('cost_index_sop'),
        reference: `research_upkeep:${who.own.airlineId}:${previousMonth(who.gameNow)}`,
      },
    ]);
    const [row] = await db.db
      .select()
      .from(researchProject)
      .where(eq(researchProject.airlineId, who.own.airlineId));
    expect(row?.funded).toBe(false);
    expect(row?.fundingChangedAt?.toISOString()).toBe(who.gameNow.toISOString());
    expect(row?.strengthAtChangePermille).toBe(1000);

    // A level, not a toggle: asking again changes nothing.
    await setDoctrineFunding(db.db, who.own, 'cost_index_sop', false, who.gameNow, BALANCE);
    const [again] = await db.db
      .select()
      .from(researchProject)
      .where(eq(researchProject.airlineId, who.own.airlineId));
    expect(again?.fundingChangedAt?.toISOString()).toBe(who.gameNow.toISOString());
    expect(await upkeepMovements(who.own.airlineId)).toHaveLength(1);
  });

  it('carries the strength across a resumption, rather than resetting it', async () => {
    const who = await makeAirline();
    const stopped = new Date(who.gameNow.getTime() - 4 * WEEK_MS);
    await researched(who, 'cost_index_sop', new Date(stopped.getTime() - 10 * WEEK_MS), {
      funded: false,
      changedAt: stopped,
    });
    await setDoctrineFunding(db.db, who.own, 'cost_index_sop', true, who.gameNow, BALANCE);
    const [row] = await db.db
      .select()
      .from(researchProject)
      .where(eq(researchProject.airlineId, who.own.airlineId));
    expect(row?.funded).toBe(true);
    expect(row?.strengthAtChangePermille).toBe(Math.round((1 - 4 / UPKEEP.lapseWeeks) * 1000));
  });

  it('refuses a node never researched, and one still being researched', async () => {
    const who = await makeAirline();
    expect(
      await setDoctrineFunding(db.db, who.own, 'boarding_sop', false, who.gameNow, BALANCE),
    ).toEqual({ ok: false, kind: 'absent' });

    await researched(who, 'cost_index_sop', new Date(who.gameNow.getTime() + WEEK_MS));
    expect(
      await setDoctrineFunding(db.db, who.own, 'cost_index_sop', false, who.gameNow, BALANCE),
    ).toEqual({ ok: false, kind: 'not_complete' });
    expect(await upkeepMovements(who.own.airlineId)).toEqual([]);
  });

  it('never lets one airline fund or read another’s doctrine', async () => {
    const owner = await makeAirline();
    const rival = await makeAirline();
    await researched(owner, 'cost_index_sop', new Date(owner.gameNow.getTime() - 20 * WEEK_MS));
    expect(
      await setDoctrineFunding(db.db, rival.own, 'cost_index_sop', false, rival.gameNow, BALANCE),
    ).toEqual({ ok: false, kind: 'absent' });
    const [row] = await db.db
      .select({ funded: researchProject.funded })
      .from(researchProject)
      .where(eq(researchProject.airlineId, owner.own.airlineId));
    expect(row?.funded).toBe(true);
    const rivalDoctrine = await airlineDoctrine(db.db, rival.own.airlineId, rival.gameNow, BALANCE);
    expect(rivalDoctrine.efficiency).toEqual({});
  });
});
