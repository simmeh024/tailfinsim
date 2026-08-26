import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { type ServerEnv } from '../env';

import { createOwnershipTestSuite, type OwnershipTestSuite } from './ownership';

/**
 * The ownership fixture builds what it claims (SEC-05).
 *
 * The worked example in `airline/cross-owner-routes.test.ts` trusts this fixture
 * to seat two genuinely distinct owners and a same-player cross-world airline. If
 * that were not true — if both airlines shared a player, or the "other" world was
 * the main one — the worked example would pass while proving nothing. This is the
 * guard on that.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ownership.test] DATABASE_URL not set — skipping.\n');
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

describeDb('the ownership fixture', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'ownership-selftest' });
  });

  afterAll(async () => {
    await suite.cleanup();
    await db.close();
  });

  it('seats two different players, each owning a different airline', () => {
    expect(suite.airlineA.player.id).not.toBe(suite.airlineB.player.id);
    expect(suite.airlineA.airline.id).not.toBe(suite.airlineB.airline.id);
    expect(suite.airlineA.player.id).toBe(suite.authorization.identities.playerA.playerId);
    expect(suite.airlineB.player.id).toBe(suite.authorization.identities.playerB.playerId);
  });

  it('puts both airlines in one shared world — the cross-player case', () => {
    expect(suite.airlineA.world.id).toBe(suite.worldMain.id);
    expect(suite.airlineB.world.id).toBe(suite.worldMain.id);
    expect(suite.airlineA.airline.worldId).toBe(suite.airlineB.airline.worldId);
  });

  it('gives playerA a second airline in a second world — the cross-world case', () => {
    // Same player, different world: the assertion the worked example turns on.
    expect(suite.airlineAOther.player.id).toBe(suite.airlineA.player.id);
    expect(suite.worldOther.id).not.toBe(suite.worldMain.id);
    expect(suite.airlineAOther.airline.worldId).toBe(suite.worldOther.id);
    expect(suite.airlineAOther.airline.id).not.toBe(suite.airlineA.airline.id);
  });

  it('addresses a request as a chosen player in a chosen world', async () => {
    // Proves the `as` helper carries a real session: playerA in worldMain resolves
    // to an airline and the routes list answers 200 rather than 401 or 409.
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/routes' },
    );
    expect(response.statusCode).toBe(200);
  });

  it('answers 401 without the session and 409 without an active world', async () => {
    // The two other doors the helper can open, so a test can tell "concealed"
    // (404) apart from "no session" (401) and "no airline here" (409).
    const guest = await suite.app.inject({ method: 'GET', url: '/api/routes' });
    expect(guest.statusCode).toBe(401);

    const noWorld = await suite.as({ actor: 'playerA' }, { method: 'GET', url: '/api/routes' });
    // playerA owns airlines in two worlds, so without an active world the airline
    // is ambiguous and the endpoint says so rather than guessing.
    expect(noWorld.statusCode).toBe(409);
  });
});
