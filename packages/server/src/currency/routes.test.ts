import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { type ServerEnv } from '../env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';

import { seedCurrencyRates } from './rates';

/**
 * The display-currency API over HTTP (M8-02).
 *
 * Proves the two routes behind `requireAuth`, that a choice round-trips through
 * `/api/me`, and that an unsupported code is refused before it reaches the
 * column. Requires `DATABASE_URL`; CI has it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [currency/routes.test] DATABASE_URL not set — skipping.\n');
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

describeDb('currency API', () => {
  let db: DatabaseHandle;
  let auth: AuthorizationTestSuite;

  beforeAll(async () => {
    db = createDatabase();
    await seedCurrencyRates(db.db);
    auth = await createAuthorizationTestSuite({ db, env, suite: 'currency-routes' });
  });

  afterAll(async () => {
    await auth.cleanup();
    await db.close();
  });

  it('refuses the currency list to a guest', async () => {
    const response = await auth.app.inject({ method: 'GET', url: '/api/currencies' });
    expect(response.statusCode).toBe(401);
  });

  it('lists currencies and rates to a signed-in player', async () => {
    const response = await auth.app.inject({
      method: 'GET',
      url: '/api/currencies',
      headers: { cookie: auth.identities.playerA.cookie! },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      currencies: { code: string; rateE6: number; top: boolean }[];
      top: string[];
    }>();
    expect(body.top).toEqual(['USD', 'EUR', 'GBP', 'JPY', 'AUD']);
    const usd = body.currencies.find((c) => c.code === 'USD');
    expect(usd).toMatchObject({ rateE6: 1_000_000, top: true });
  });

  it('refuses a currency change to a guest', async () => {
    const response = await auth.app.inject({
      method: 'PUT',
      url: '/api/me/currency',
      payload: { currency: 'EUR' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('records a choice and reflects it in /api/me', async () => {
    const put = await auth.app.inject({
      method: 'PUT',
      url: '/api/me/currency',
      headers: { cookie: auth.identities.playerB.cookie! },
      payload: { currency: 'JPY' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ currency: 'JPY' });

    const me = await auth.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: auth.identities.playerB.cookie! },
    });
    expect(me.json<{ player: { displayCurrency: string } }>().player.displayCurrency).toBe('JPY');
  });

  it('rejects an unsupported currency code before it reaches the column', async () => {
    const response = await auth.app.inject({
      method: 'PUT',
      url: '/api/me/currency',
      headers: { cookie: auth.identities.playerA.cookie! },
      payload: { currency: 'XXX' },
    });
    expect(response.statusCode).toBe(400);
  });
});
