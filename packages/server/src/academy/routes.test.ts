import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { openCrewBase } from '../crew/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { academy, airline, airport } from '../db/schema';
import { type ServerEnv } from '../env';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  resourceIdCases,
} from '../test-fixtures/resource-id';

import { foundAcademy } from './store';

import type { FoundedAirlineFixture } from '../test-fixtures/founded-airline';
import type { InjectOptions } from 'fastify';

/**
 * Cross-player ownership on the academy endpoints (M9-01, SEC-05, SEC-07).
 *
 * The academy is the most expensive building in §10, so the refusals have to be
 * airtight in both directions: a stranger's academy is concealed exactly like a
 * missing one (ADR-0020), and a refused write leaves the money where it was.
 * The second is the assertion that matters — a handler that answered 404 after
 * charging the capital would pass every status check on this page.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [academy/routes.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();

describeDb('cross-player ownership on the academy endpoints', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];
  let ownAcademyId: string;
  let competitorAcademyId: string;
  let ownBaseId: string;
  let competitorBaseId: string;

  async function makeAirport(icaoCode: string, index: number): Promise<void> {
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_700_000 + index),
        ident: `ACAD-${icaoCode}`,
        icaoCode,
        name: `M9-01 Airport ${icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + index / 10_000,
        longitude: 4 + index / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport created for ${icaoCode}`);
    madeAirports.push(created.id);
  }

  async function baseAndAcademy(
    fixture: FoundedAirlineFixture,
    icao: string,
  ): Promise<{ crewBaseId: string; academyId: string }> {
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    const founded = await foundAcademy(
      db.db,
      { worldId: fixture.world.id, airlineId: fixture.airline.id },
      opened.value.crewBaseId,
    );
    if (!founded.ok) throw new Error(`could not found an academy: ${founded.refusal}`);
    return { crewBaseId: opened.value.crewBaseId, academyId: founded.value.academyId };
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return row?.cashMinor ?? 0;
  }

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
    suite = await createOwnershipTestSuite({ db, env, suite: 'academy-routes' });

    await makeAirport('QSZA', 0);
    await makeAirport('QSZB', 1);

    ({ crewBaseId: ownBaseId, academyId: ownAcademyId } = await baseAndAcademy(
      suite.airlineA,
      'QSZA',
    ));
    ({ crewBaseId: competitorBaseId, academyId: competitorAcademyId } = await baseAndAcademy(
      suite.airlineB,
      'QSZB',
    ));
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  /** The two path-id endpoints, each as a request against a given academy id. */
  const pathSurfaces: { name: string; request: (id: string) => InjectOptions }[] = [
    {
      name: 'POST levels (upgrade)',
      request: (id) => ({ method: 'POST', url: `/api/academies/${id}/levels` }),
    },
    {
      name: 'POST modules (build)',
      request: (id) => ({
        method: 'POST',
        url: `/api/academies/${id}/modules`,
        payload: { kind: 'cbt_suite' },
      }),
    },
  ];

  it('lets an owner read their own academies and nobody else’s', async () => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/academies' },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{ academies: { id: string }[] }>();
    expect(body.academies.map((row) => row.id)).toEqual([ownAcademyId]);
  });

  it('refuses a guest', async () => {
    const response = await suite.app.inject({ method: 'GET', url: '/api/academies' });
    expect(response.statusCode).toBe(401);
  });

  it.each(pathSurfaces)(
    '$name conceals playerB’s academy from playerA, identically to a missing id',
    async ({ request }) => {
      const denied = await Promise.all(
        resourceIdCases({
          own: ownAcademyId,
          anotherPlayer: competitorAcademyId,
          wrongEntity: suite.worldMain.id,
          absent: ABSENT_RESOURCE_UUID,
        })
          .filter(({ expected }) => expected === 'conceal')
          .map(({ id }) =>
            suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request(id)),
          ),
      );

      for (const response of denied) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ code: 'academy_absent', message: 'No such academy' });
      }
      // ADR-0020: byte-identical, so the endpoint is not an oracle for which
      // ids name a real academy.
      expect(new Set(denied.map((response) => response.body)).size).toBe(1);
    },
  );

  it.each(pathSurfaces)('$name rejects malformed ids without a 500', async ({ request }) => {
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        request(encodeURIComponent(malformed)),
      );
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('leaves the target’s money and rows untouched when it refuses (SEC-07)', async () => {
    const before = await cashOf(suite.airlineB.airline.id);
    const [beforeRow] = await db.db
      .select({ level: academy.level, pendingLevel: academy.pendingLevel })
      .from(academy)
      .where(eq(academy.id, competitorAcademyId));

    for (const { request } of pathSurfaces) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        request(competitorAcademyId),
      );
      expect(response.statusCode).toBe(404);
    }

    expect(await cashOf(suite.airlineB.airline.id)).toBe(before);
    const [afterRow] = await db.db
      .select({ level: academy.level, pendingLevel: academy.pendingLevel })
      .from(academy)
      .where(eq(academy.id, competitorAcademyId));
    expect(afterRow).toEqual(beforeRow);
  });

  it('conceals another player’s crew base when founding, and charges nothing', async () => {
    const before = await cashOf(suite.airlineA.airline.id);
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'POST', url: '/api/academies', payload: { crewBaseId: competitorBaseId } },
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'base_absent', message: 'No such crew base' });
    expect(await cashOf(suite.airlineA.airline.id)).toBe(before);
  });

  it('refuses a second academy at a base that already has one', async () => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'POST', url: '/api/academies', payload: { crewBaseId: ownBaseId } },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('academy_exists');
  });

  it('rejects a module body that names a family for a room, or omits one for a sim', async () => {
    for (const payload of [
      { kind: 'cbt_suite', family: 'A320' },
      { kind: 'full_flight_sim' },
      { kind: 'not_a_module' },
    ]) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'POST', url: `/api/academies/${ownAcademyId}/modules`, payload },
      );
      expect(response.statusCode).toBe(400);
    }
  });
});
