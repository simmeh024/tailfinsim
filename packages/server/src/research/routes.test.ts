import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, ResearchResponse } from '@tailfin/shared';

import { openCrewBase } from '../crew/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { academy, airline, airport, researchAccount, researchProject } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { ABSENT_RESOURCE_UUID, MALFORMED_RESOURCE_IDS } from '../test-fixtures/resource-id';

import { accrueResearchPoints } from './points';

import type { FoundedAirlineFixture } from '../test-fixtures/founded-airline';

/**
 * The research API over HTTP (M9-05, SEC-05, SEC-06, SEC-07).
 *
 * The node is a catalogue selector rather than an owned resource, so there is
 * no foreign id to conceal. What has to hold instead is that the airline is
 * the session's and nobody else's: one player's points and projects never show
 * in another's tree, a start moves only the caller's money, and a request body
 * cannot carry anything but a node — no count of points, no cash, no weeks.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [research/routes.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('research/routes');
const FORMULA = ECONOMY_CONFIG_V1.research.pointsFormula;
const T1 = ECONOMY_CONFIG_V1.research.nodes.cost_index_sop;

describeDb('the research endpoints', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  async function academyAt(fixture: FoundedAirlineFixture, level: number): Promise<void> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Research Route Field ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'medium_airport',
      latitude: 52,
      longitude: 4,
      scheduledService: true,
      hasRunwayData: false,
      tier: 'medium',
      slotLevel: 2,
    });
    madeAirports.push(identity.icaoCode);
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: identity.icaoCode,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    await db.db.insert(academy).values({
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId: opened.value.crewBaseId,
      level,
    });
  }

  /** Points the only way there is: the settlement accrual, one long block of flying. */
  async function bankPoints(fixture: FoundedAirlineFixture, points: number): Promise<void> {
    await db.db.transaction((tx) =>
      accrueResearchPoints(
        tx,
        {
          flightId: randomUUID(),
          airlineId: fixture.airline.id,
          worldId: fixture.world.id,
          blockMinutes: points * FORMULA.scalingFactorHours * 60,
        },
        FORMULA,
      ),
    );
  }

  async function standing(airlineId: string) {
    const [cash] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    const [points] = await db.db
      .select({ earned: researchAccount.earnedMilli, spent: researchAccount.spentMilli })
      .from(researchAccount)
      .where(eq(researchAccount.airlineId, airlineId));
    const projects = await db.db
      .select({ nodeId: researchProject.nodeId })
      .from(researchProject)
      .where(eq(researchProject.airlineId, airlineId));
    return { cash: cash?.cashMinor, points: points ?? null, projects };
  }

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'research-routes' });
    // playerA: a Training Room and enough points for a tier-1 node and a half.
    await academyAt(suite.airlineA, 1);
    await bankPoints(suite.airlineA, 150);
    // playerB, in the same world: nothing at all.
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  it('refuses a guest, to read and to start', async () => {
    expect((await suite.app.inject({ method: 'GET', url: '/api/research' })).statusCode).toBe(401);
    const post = await suite.app.inject({
      method: 'POST',
      url: '/api/research/projects',
      payload: { nodeId: 'cost_index_sop' },
    });
    expect(post.statusCode).toBe(401);
  });

  it('serves the whole tree, valid against the wire contract', async () => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/research' },
    );
    expect(response.statusCode).toBe(200);
    const body = ResearchResponse.parse(response.json());
    expect(body.points.balance).toBeCloseTo(150, 6);
    const { fleetFlightHoursPerDay, ...terms } = body.formula;
    expect(terms).toEqual({
      academyLevelSum: 1,
      academyStaffQuality: FORMULA.academyStaffQuality,
      scalingFactorHours: FORMULA.scalingFactorHours,
    });
    // An observation over the last game week; the store test pins its value.
    expect(fleetFlightHoursPerDay).toBeGreaterThanOrEqual(0);
    expect(body.academy).toEqual({ highestLevel: 1, researchTier: 1 });
    expect(body.branches.map((branch) => branch.nodes.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(body.active).toBeNull();
  });

  it('shows another player none of playerA’s points', async () => {
    const response = await suite.as(
      { actor: 'playerB', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/research' },
    );
    const body = ResearchResponse.parse(response.json());
    expect(body.points).toEqual({ balance: 0, earnedTotal: 0, recentPerDay: 0 });
    expect(body.academy.highestLevel).toBe(0);
  });

  it('accepts a node and nothing else in the body — no points, no cash, no weeks', async () => {
    const before = await standing(suite.airlineA.airline.id);
    for (const payload of [
      {},
      { nodeId: 'free_research_points' },
      { nodeId: ABSENT_RESOURCE_UUID },
      { nodeId: 'cost_index_sop', researchPoints: 1_000_000 },
      { nodeId: 'cost_index_sop', cashMinor: 1 },
      { nodeId: 'cost_index_sop', buildWeeks: 0 },
      ...MALFORMED_RESOURCE_IDS.map((nodeId) => ({ nodeId })),
    ]) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'POST', url: '/api/research/projects', payload },
      );
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await standing(suite.airlineA.airline.id)).toEqual(before);
  });

  it('refuses an airline with no academy with a 409 naming the gate, and moves nothing', async () => {
    const before = await standing(suite.airlineB.airline.id);
    const response = await suite.as(
      { actor: 'playerB', worldId: suite.worldMain.id },
      { method: 'POST', url: '/api/research/projects', payload: { nodeId: 'cost_index_sop' } },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'academy_level',
      message: 'This tier needs a higher academy level',
    });
    expect(await standing(suite.airlineB.airline.id)).toEqual(before);
  });

  it('starts a project for the caller only, and answers with the whole tree', async () => {
    const otherBefore = await standing(suite.airlineB.airline.id);
    const otherWorldBefore = await standing(suite.airlineAOther.airline.id);
    const before = await standing(suite.airlineA.airline.id);

    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'POST', url: '/api/research/projects', payload: { nodeId: 'cost_index_sop' } },
    );
    expect(response.statusCode).toBe(200);
    const body = ResearchResponse.parse(response.json());
    expect(body.active?.nodeId).toBe('cost_index_sop');
    expect(body.points.balance).toBeCloseTo(50, 6);

    const after = await standing(suite.airlineA.airline.id);
    expect(after.cash).toBe((before.cash ?? 0) - T1.cashCostMinor);
    expect(after.points?.spent).toBe(T1.researchPoints * 1_000);
    expect(after.projects).toEqual([{ nodeId: 'cost_index_sop' }]);

    // The same player in another world, and another player in this one, are
    // exactly where they were.
    expect(await standing(suite.airlineB.airline.id)).toEqual(otherBefore);
    expect(await standing(suite.airlineAOther.airline.id)).toEqual(otherWorldBefore);
  });

  it('refuses a second project while one runs, and the running one again', async () => {
    const before = await standing(suite.airlineA.airline.id);
    for (const [nodeId, code] of [
      ['boarding_sop', 'project_running'],
      ['cost_index_sop', 'already_in_progress'],
    ] as const) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'POST', url: '/api/research/projects', payload: { nodeId } },
      );
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe(code);
    }
    expect(await standing(suite.airlineA.airline.id)).toEqual(before);
  });

  it('scopes the tree to the world the request names', async () => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldOther.id },
      { method: 'GET', url: '/api/research' },
    );
    expect(response.statusCode).toBe(200);
    const body = ResearchResponse.parse(response.json());
    expect(body.active).toBeNull();
    expect(body.points.balance).toBe(0);
  });
});
