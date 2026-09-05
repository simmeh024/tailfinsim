import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AdminEconomyConfigCompareResponse,
  canonicalEconomyJson,
  ECONOMY_CONFIG_V1_VERSION,
  type EconomyConfig,
} from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { ECONOMY_CONFIG_V1 } from '../economy/config';
import { seedEconomyConfig } from '../economy/seed';
import { createEconomyConfigVersion, validateCreateRequest } from '../economy/versions';
import { type ServerEnv } from '../env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';

import { BOOTSTRAP_ACTOR } from './grants';

/**
 * `GET /api/admin/economy-config/:version/diff`, over the wire (M11-37).
 *
 * The route has existed since M3-11 and answered with an object assembled inline
 * in the handler — no named schema in `@tailfin/shared`, and so no response
 * schema on the route either. That was invisible while nothing consumed it. The
 * economy console consumes it, and a client that hand-writes the shape is a
 * second definition of the contract waiting to drift from the first.
 *
 * Naming it fixed that and introduced a new way to be wrong: Fastify serialises
 * through the JSON Schema, and `fast-json-stringify` **drops** what the schema
 * does not mention, silently and with a 200. A schema missing `changes` would
 * turn every comparison in the console into "nothing differs" — which is a
 * plausible answer, so nobody would notice.
 *
 * Hence the assertion is over the parsed body rather than over the handler's
 * return value: what matters is what actually reaches a client.
 *
 * Requires `DATABASE_URL`; CI provides it. The versions created here **cannot be
 * cleaned up** — `economy_config` refuses DELETE by trigger, which is the point
 * of the table — so every name is unique per run.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [admin/economy-diff.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** The same shape the authorization sweep uses; auth on, logging off. */
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

describeDb('the economy diff route', () => {
  let db: DatabaseHandle;
  let suite: AuthorizationTestSuite;
  let retuned: string;

  /** A retune of the shipped payload: one number moved, deliberately. */
  const FUEL_PATH = 'fuel.basePricePerTonne';

  beforeAll(async () => {
    db = createDatabase();
    await seedEconomyConfig(db.db);

    suite = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'economy-diff',
    });

    retuned = `t-diff-${randomUUID().slice(0, 8)}`;
    const draft = JSON.parse(canonicalEconomyJson(ECONOMY_CONFIG_V1)) as EconomyConfig;
    draft.fuel.basePricePerTonne = ECONOMY_CONFIG_V1.fuel.basePricePerTonne + 7;

    // Through the same validation the route uses, so the fixture is a version
    // an admin could actually have created rather than a row this test invented.
    const validated = validateCreateRequest({
      version: retuned,
      payloadJson: JSON.stringify(draft),
      parentVersion: ECONOMY_CONFIG_V1_VERSION,
      notes: 'Fuel up, for the diff route test.',
    });
    expect(validated.ok, 'the fixture payload did not validate').toBe(true);
    if (!validated.ok) throw new Error(validated.message);

    const created = await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);
    expect(created.ok, 'the fixture version could not be created').toBe(true);
  });

  afterAll(async () => {
    await suite.cleanup();
    await suite.app.close();
    await db.close();
  });

  async function diff(version: string, against: string) {
    return suite.app.inject({
      method: 'GET',
      url: `/api/admin/economy-config/${version}/diff?against=${against}`,
      headers: { cookie: suite.identities.admin.cookie ?? '' },
    });
  }

  it('answers with both versions and the fields that differ', async () => {
    const response = await diff(retuned, ECONOMY_CONFIG_V1_VERSION);
    expect(response.statusCode).toBe(200);

    // Parsed with the schema the client imports, against the bytes the server
    // actually sent. A field the response schema forgot is absent here, and the
    // parse is what says so rather than an assertion having to guess at it.
    const parsed = AdminEconomyConfigCompareResponse.safeParse(response.json());
    expect(parsed.error?.issues).toBeUndefined();

    const body = parsed.data;
    expect(body?.from).toBe(ECONOMY_CONFIG_V1_VERSION);
    expect(body?.to).toBe(retuned);

    // Not merely "some changes": the one that was actually made, with both
    // sides. `changes` surviving as an empty array would pass a length check
    // and would still have broken the console.
    const fuel = body?.changes.find((change) => change.path === FUEL_PATH);
    expect(fuel).toBeDefined();
    expect(fuel?.before).toBe(ECONOMY_CONFIG_V1.fuel.basePricePerTonne);
    expect(fuel?.after).toBe(ECONOMY_CONFIG_V1.fuel.basePricePerTonne + 7);
  });

  it('compares in the direction it is asked, not in version order', async () => {
    // The console's promotion case runs backwards as often as forwards — a
    // rollback compares the newer version against the older one. A route that
    // normalised the order would report the retune the wrong way round and an
    // admin would agree to the opposite of what happens.
    const response = await diff(ECONOMY_CONFIG_V1_VERSION, retuned);
    expect(response.statusCode).toBe(200);

    const body = AdminEconomyConfigCompareResponse.parse(response.json());
    expect(body.from).toBe(retuned);
    expect(body.to).toBe(ECONOMY_CONFIG_V1_VERSION);

    const fuel = body.changes.find((change) => change.path === FUEL_PATH);
    expect(fuel?.before).toBe(ECONOMY_CONFIG_V1.fuel.basePricePerTonne + 7);
    expect(fuel?.after).toBe(ECONOMY_CONFIG_V1.fuel.basePricePerTonne);
  });

  it('answers 400 when nothing was named to compare against', async () => {
    // A comparison needs two versions, and an omitted one is the request's
    // fault rather than a missing resource. The console cannot produce this,
    // but a hand-typed URL can, and the difference between 400 and an empty
    // 200 is the difference between "you left something out" and "nothing
    // differs".
    const response = await suite.app.inject({
      method: 'GET',
      url: `/api/admin/economy-config/${retuned}/diff`,
      headers: { cookie: suite.identities.admin.cookie ?? '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'against_required' });
  });

  it('answers 404 for a version that is not there', async () => {
    const response = await diff(retuned, 'no-such-version');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'economy_config_not_found' });
  });
});
