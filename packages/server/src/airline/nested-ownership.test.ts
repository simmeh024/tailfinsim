import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, schedule, scheduleLeg } from '../db/schema';
import { type ServerEnv } from '../env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';

import { resolveOwnedScheduleLeg } from './nested-ownership';

/**
 * The copyable parent-chain authorization template (SEC-08).
 *
 * A new nested endpoint should create the equivalent of these four cases:
 * own chain, a sibling owned by another player, the same player in another
 * world, and a chain whose parent disappeared. The sibling case is the one a
 * shortcut such as "the caller owns an airline" fails to catch.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [nested-ownership.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 5_000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 's'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

interface NestedFixture {
  scheduleId: string;
  legId: string;
}

describeDb('nested parent-chain ownership (SEC-08)', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  let own: NestedFixture;
  let sibling: NestedFixture;
  let otherWorld: NestedFixture;
  let broken: NestedFixture;
  const airportIds: string[] = [];
  let originIcao: string;
  let destinationIcao: string;

  async function insertAirport(index: number): Promise<string> {
    const hex = randomUUID().replaceAll('-', '').slice(0, 4);
    // The database requires exactly four uppercase letters. Keep the source id
    // derived from the same random value so parallel database suites cannot
    // mistake this fixture's reference airports for one another.
    const icaoCode = [...hex]
      .map((digit) => String.fromCharCode('A'.charCodeAt(0) + Number.parseInt(digit, 16)))
      .join('');
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_600_000 + Number.parseInt(hex, 16)),
        ident: icaoCode,
        icaoCode,
        name: `SEC-08 ${icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + index / 100,
        longitude: 4 + index / 100,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`SEC-08 could not create airport ${icaoCode}`);
    airportIds.push(id);
    return icaoCode;
  }

  async function insertNested(worldId: string, airlineId: string): Promise<NestedFixture> {
    const schedules = await db.db
      .insert(schedule)
      .values({
        worldId,
        airlineId,
        // The schedule model intentionally has no airframe FK yet. This resolver
        // is about its real parent chain, schedule → airline.
        airframeId: randomUUID(),
        repeatKind: 'daily',
      })
      .returning({ id: schedule.id });
    const scheduleId = schedules[0]?.id;
    if (scheduleId === undefined) throw new Error('SEC-08 could not create schedule');

    const legs = await db.db
      .insert(scheduleLeg)
      .values({
        scheduleId,
        legIndex: 0,
        originIcao,
        destinationIcao,
        departureMinute: 0,
        blockMinutes: 60,
        turnaroundMinutes: 30,
      })
      .returning({ id: scheduleLeg.id });
    const legId = legs[0]?.id;
    if (legId === undefined) throw new Error('SEC-08 could not create schedule leg');
    return { scheduleId, legId };
  }

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'nested-ownership' });
    originIcao = await insertAirport(1);
    destinationIcao = await insertAirport(2);
    own = await insertNested(suite.worldMain.id, suite.airlineA.airline.id);
    sibling = await insertNested(suite.worldMain.id, suite.airlineB.airline.id);
    otherWorld = await insertNested(suite.worldOther.id, suite.airlineAOther.airline.id);
    broken = await insertNested(suite.worldMain.id, suite.airlineA.airline.id);
  });

  afterAll(async () => {
    if (suite !== undefined) await suite.cleanup();
    for (const id of airportIds) await db.db.delete(airport).where(eq(airport.id, id));
    if (db !== undefined) await db.close();
  });

  const playerAScope = () => ({
    playerId: suite.airlineA.player.id,
    worldId: suite.worldMain.id,
  });

  it('resolves a leaf only through playerA’s complete own chain', async () => {
    await expect(resolveOwnedScheduleLeg(db.db, playerAScope(), own.legId)).resolves.toEqual({
      id: own.legId,
      scheduleId: own.scheduleId,
      airlineId: suite.airlineA.airline.id,
      worldId: suite.worldMain.id,
    });
  });

  it('refuses a sibling chain even though playerA owns another airline in this world', async () => {
    await expect(resolveOwnedScheduleLeg(db.db, playerAScope(), sibling.legId)).resolves.toBeNull();
  });

  it('refuses playerA’s own chain when its world is not active', async () => {
    await expect(
      resolveOwnedScheduleLeg(db.db, playerAScope(), otherWorld.legId),
    ).resolves.toBeNull();
  });

  it('refuses a missing leaf and a deleted parent chain without throwing', async () => {
    await expect(resolveOwnedScheduleLeg(db.db, playerAScope(), randomUUID())).resolves.toBeNull();

    // Cascading removes the leaf when its parent is deleted. The resolver still
    // sees one clean absence, rather than assuming a parent exists and throwing.
    await db.db.delete(schedule).where(eq(schedule.id, broken.scheduleId));
    await expect(resolveOwnedScheduleLeg(db.db, playerAScope(), broken.legId)).resolves.toBeNull();
  });
});
