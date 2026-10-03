import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, type CrewRosterResponse } from '@tailfin/shared';
import { xpForLevel } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { academy, airline, airport, crewMember, crewPool } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  resourceIdCases,
} from '../test-fixtures/resource-id';

import { nameEligibleCrew } from './roster';
import { hireCrew, openCrewBase } from './store';

import type { FoundedAirlineFixture } from '../test-fixtures/founded-airline';
import type { InjectOptions } from 'fastify';

/**
 * The Training Captain endpoints over HTTP (M9-04, SEC-05, SEC-07).
 *
 * The designation costs money both ways, so the refusals have to be airtight in
 * both directions: another player's pilot is concealed exactly like a missing
 * one (ADR-0020), and a refused write leaves the member, the cash and the
 * ledger where they were. The second is the assertion that matters — a handler
 * that answered 404 after charging the course would pass every status check
 * here.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/roster-routes.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('crew/roster-routes');
const SKILLS = ECONOMY_CONFIG_V1.crew.skills;
const TRAINING = ECONOMY_CONFIG_V1.crew.trainingCaptain;
const GAME_NOW = new Date('2026-05-01T12:00:00.000Z');

const ABSENT_BODY = { code: 'member_absent', message: 'No such crew member' };

describeDb('the roster’s Training Captain endpoints', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  let ownBaseId: string;
  let ownMemberId: string;
  let ownJuniorId: string;
  let competitorMemberId: string;
  let otherWorldMemberId: string;

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `M9-04 Airport ${identity.icaoCode}`,
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
    return identity.icaoCode;
  }

  /**
   * A base with two named captains — one at the top level, one not — and a
   * Centre of Excellence beside them. Pool XP and academy level are written
   * directly: neither is money, and the alternatives are years of flying and
   * forty game weeks of building.
   */
  async function rosterAt(
    fixture: FoundedAirlineFixture,
  ): Promise<{ crewBaseId: string; veteranId: string; juniorId: string }> {
    const icao = await makeAirport();
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: icao,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    const crewBaseId = opened.value.crewBaseId;
    const hired = await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 2,
    });
    if (!hired.ok) throw new Error(`could not hire: ${hired.refusal}`);
    await db.db
      .update(crewPool)
      .set({ xp: xpForLevel(SKILLS.maxLevel, SKILLS) * 2 })
      .where(eq(crewPool.crewBaseId, crewBaseId));
    await nameEligibleCrew(db.db, fixture.world.id, GAME_NOW);
    await db.db.insert(academy).values({
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId,
      level: 5,
    });

    const members = await db.db
      .select({ id: crewMember.id })
      .from(crewMember)
      .where(eq(crewMember.crewBaseId, crewBaseId))
      .orderBy(crewMember.ordinal);
    const [veteran, junior] = members;
    if (!veteran || !junior) throw new Error('expected two named captains');
    // The second is set below the top, so a refusal has somebody to refuse.
    await db.db
      .update(crewMember)
      .set({ level: SKILLS.maxLevel - 1 })
      .where(eq(crewMember.id, junior.id));
    return { crewBaseId, veteranId: veteran.id, juniorId: junior.id };
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

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'roster-routes' });

    ({
      crewBaseId: ownBaseId,
      veteranId: ownMemberId,
      juniorId: ownJuniorId,
    } = await rosterAt(suite.airlineA));
    ({ veteranId: competitorMemberId } = await rosterAt(suite.airlineB));
    ({ veteranId: otherWorldMemberId } = await rosterAt(suite.airlineAOther));
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  const asA = (request: InjectOptions) =>
    suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request);

  /** Both directions, each as a request against a given member id. */
  const surfaces: { name: string; request: (id: string) => InjectOptions }[] = [
    {
      name: 'POST (make Training Captain)',
      request: (id) => ({ method: 'POST', url: `/api/crew/roster/${id}/training-captain` }),
    },
    {
      name: 'DELETE (return to the line)',
      request: (id) => ({ method: 'DELETE', url: `/api/crew/roster/${id}/training-captain` }),
    },
  ];

  it('refuses a guest, to read or to write', async () => {
    expect((await suite.app.inject({ method: 'GET', url: '/api/crew/roster' })).statusCode).toBe(
      401,
    );
    for (const { request } of surfaces) {
      expect((await suite.app.inject(request(ownMemberId))).statusCode).toBe(401);
    }
  });

  it('shows the owner their own pilots, with what the designation would cost', async () => {
    const response = await asA({ method: 'GET', url: '/api/crew/roster' });
    expect(response.statusCode).toBe(200);
    const body = response.json<CrewRosterResponse>();
    expect(body.members.map((m) => m.id).sort()).toEqual([ownMemberId, ownJuniorId].sort());
    const veteran = body.members.find((m) => m.id === ownMemberId);
    expect(veteran?.trainingCaptain).toEqual({
      since: null,
      convertRefusal: null,
      conversionCostMinor: TRAINING.conversionCostMinor,
      reversionCostMinor: TRAINING.reversionCostMinor,
    });
    expect(body.members.find((m) => m.id === ownJuniorId)?.trainingCaptain.convertRefusal).toBe(
      'below_max_level',
    );
    expect(body.trainingCoverage.map((row) => row.crewBaseId)).toEqual([ownBaseId]);
    expect(body.maxLevel).toBe(SKILLS.maxLevel);
  });

  it.each(surfaces)(
    '$name conceals another player’s pilot, identically to a missing id',
    async ({ request }) => {
      const denied = await Promise.all(
        [
          ...resourceIdCases({
            own: ownMemberId,
            anotherPlayer: competitorMemberId,
            // A real id of the wrong kind, and one this player owns.
            wrongEntity: ownBaseId,
            absent: ABSENT_RESOURCE_UUID,
          })
            .filter(({ expected }) => expected === 'conceal')
            .map(({ id }) => id),
          // The same player's pilot in another world is not in this world's roster.
          otherWorldMemberId,
        ].map((id) => asA(request(id))),
      );

      for (const response of denied) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(ABSENT_BODY);
      }
      // ADR-0020: byte-identical, so the endpoint is not an oracle for which ids
      // name a real pilot.
      expect(new Set(denied.map((response) => response.body)).size).toBe(1);
    },
  );

  it.each(surfaces)('$name rejects malformed ids without a 500', async ({ request }) => {
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await asA(request(encodeURIComponent(malformed)));
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('leaves the target’s pilot, money and ledger untouched when it refuses (SEC-07)', async () => {
    const before = {
      cash: await cashOf(suite.airlineB.airline.id),
      row: await designation(competitorMemberId),
    };

    for (const { request } of surfaces) {
      expect((await asA(request(competitorMemberId))).statusCode).toBe(404);
    }

    expect(await cashOf(suite.airlineB.airline.id)).toBe(before.cash);
    expect(await designation(competitorMemberId)).toEqual(before.row);
  });

  it('states a refusal as a 409 with its code, and charges nothing', async () => {
    const before = await cashOf(suite.airlineA.airline.id);
    const tooJunior = await asA({
      method: 'POST',
      url: `/api/crew/roster/${ownJuniorId}/training-captain`,
    });
    expect(tooJunior.statusCode).toBe(409);
    expect(tooJunior.json<{ code: string }>().code).toBe('below_max_level');

    const notOne = await asA({
      method: 'DELETE',
      url: `/api/crew/roster/${ownJuniorId}/training-captain`,
    });
    expect(notOne.statusCode).toBe(409);
    expect(notOne.json<{ code: string }>().code).toBe('not_training_captain');

    expect(await cashOf(suite.airlineA.airline.id)).toBe(before);
  });

  it('converts and reverts the owner’s pilot, returning the whole board each time', async () => {
    const start = await cashOf(suite.airlineA.airline.id);

    /*
     * A hostile body on a bodyless write: the designation's instant and its
     * counter are the server's, and a body naming them must change nothing
     * (SEC-06). The stored row is read back rather than trusting the response.
     */
    const converted = await asA({
      method: 'POST',
      url: `/api/crew/roster/${ownMemberId}/training-captain`,
      payload: {
        trainingCaptainSince: '2000-01-01T00:00:00.000Z',
        trainingCaptainChanges: 99,
        airlineId: suite.airlineB.airline.id,
      },
    });
    expect(converted.statusCode).toBe(200);
    const board = converted.json<CrewRosterResponse>();
    const since = board.members.find((m) => m.id === ownMemberId)?.trainingCaptain.since;
    expect(since).not.toBeNull();
    expect(board.trainingCoverage[0]?.trainingCaptains).toBe(1);

    const stored = await designation(ownMemberId);
    expect(stored?.changes).toBe(1);
    expect(stored?.since?.toISOString()).toBe(since);
    expect(stored?.since?.getUTCFullYear()).not.toBe(2000);
    expect(await cashOf(suite.airlineA.airline.id)).toBe(start - TRAINING.conversionCostMinor);

    const again = await asA({
      method: 'POST',
      url: `/api/crew/roster/${ownMemberId}/training-captain`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('already_training_captain');

    const reverted = await asA({
      method: 'DELETE',
      url: `/api/crew/roster/${ownMemberId}/training-captain`,
    });
    expect(reverted.statusCode).toBe(200);
    expect(
      reverted.json<CrewRosterResponse>().members.find((m) => m.id === ownMemberId)?.trainingCaptain
        .since,
    ).toBeNull();
    expect(await designation(ownMemberId)).toEqual({ since: null, changes: 2 });
    expect(await cashOf(suite.airlineA.airline.id)).toBe(
      start - TRAINING.conversionCostMinor - TRAINING.reversionCostMinor,
    );
  });
});
