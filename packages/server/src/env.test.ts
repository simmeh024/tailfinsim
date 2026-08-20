import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from './env';

/**
 * Every test stubs DATABASE_URL explicitly rather than relying on a local
 * `.env`, so the suite behaves identically on a developer machine and in CI
 * where no `.env` file exists.
 */
const VALID_URL = 'postgres://tailfin:secret@127.0.0.1:5432/tailfin';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadEnv', () => {
  it('reads the database URL from the environment', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    expect(loadEnv().databaseUrl).toBe(VALID_URL);
  });

  it('throws an actionable error when DATABASE_URL is absent', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => loadEnv()).toThrow(/Missing required environment variable DATABASE_URL/);
    // The message must point somewhere useful — this is the first error a new
    // contributor will hit.
    expect(() => loadEnv()).toThrow(/\.env\.example/);
  });

  it('rejects an unrecognised NODE_ENV rather than guessing', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('NODE_ENV', 'staging');
    expect(() => loadEnv()).toThrow(/NODE_ENV must be one of/);
  });

  it('rejects a non-integer pool size', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('DATABASE_POOL_MAX', 'lots');
    expect(() => loadEnv()).toThrow(/must be an integer/);
  });

  it('defaults the pool size to 10', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('DATABASE_POOL_MAX', '');
    expect(loadEnv().databasePoolMax).toBe(10);
  });

  it('bounds the connect timeout rather than inheriting pg’s "wait forever"', () => {
    // The default matters more than the configurability: an unbounded connect
    // makes /healthz hang instead of answering 503, and deploy.sh reads /healthz.
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('DATABASE_CONNECT_TIMEOUT_MS', '');
    expect(loadEnv().databaseConnectTimeoutMs).toBe(5000);

    vi.stubEnv('DATABASE_CONNECT_TIMEOUT_MS', '250');
    expect(loadEnv().databaseConnectTimeoutMs).toBe(250);
  });

  it('defaults the log level by environment', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('LOG_LEVEL', '');

    vi.stubEnv('NODE_ENV', 'production');
    expect(loadEnv().logLevel).toBe('info');

    vi.stubEnv('NODE_ENV', 'development');
    expect(loadEnv().logLevel).toBe('debug');
  });

  it('closes registration by default', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ALLOW_REGISTRATION', '');
    // The important half of this test is the *default*: forgetting to set the
    // variable must not open signups.
    expect(loadEnv().allowRegistration).toBe(false);
  });

  it('opens registration only on an explicit affirmative', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    for (const yes of ['true', 'TRUE', '1']) {
      vi.stubEnv('ALLOW_REGISTRATION', yes);
      expect(loadEnv().allowRegistration).toBe(true);
    }
    for (const no of ['false', 'FALSE', '0']) {
      vi.stubEnv('ALLOW_REGISTRATION', no);
      expect(loadEnv().allowRegistration).toBe(false);
    }
  });

  it('rejects a non-boolean registration flag rather than assuming', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ALLOW_REGISTRATION', 'yes');
    expect(() => loadEnv()).toThrow(/must be true\/false/);
  });

  it('defaults the environment label to local, never to production', () => {
    // A box that forgot to say which it is must not claim to be the live one.
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ENVIRONMENT_LABEL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(loadEnv().environmentLabel).toBe('local');
  });

  it('reads the environment label independently of NODE_ENV', () => {
    // The dev box runs NODE_ENV=production too — that is the point of it — so
    // the badge cannot be derived from NODE_ENV.
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENVIRONMENT_LABEL', 'dev');
    expect(loadEnv().environmentLabel).toBe('dev');
    expect(loadEnv().nodeEnv).toBe('production');
  });

  it('rejects an unrecognised environment label', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ENVIRONMENT_LABEL', 'staging');
    expect(() => loadEnv()).toThrow(/ENVIRONMENT_LABEL must be one of/);
  });

  it('lets an explicit log level win over the default', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', 'trace');
    expect(loadEnv().logLevel).toBe('trace');
  });
});

/**
 * Auth configuration (M0-11).
 *
 * All three variables are stubbed in every case, never left to whatever a local
 * `.env` happens to hold, so these behave the same on a developer machine as in
 * CI.
 */
describe('loadEnv — auth', () => {
  const CLIENT_ID = 'x.apps.googleusercontent.com';
  const CLIENT_SECRET = 'GOCSPX-not-a-real-secret';
  const SECRET = 'a'.repeat(48);

  function stubAuth(id: string, secret: string, session: string): void {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('GOOGLE_CLIENT_ID', id);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', secret);
    vi.stubEnv('SESSION_SECRET', session);
  }

  it('leaves auth disabled when nothing is configured', () => {
    stubAuth('', '', '');
    const env = loadEnv();
    expect(env.authEnabled).toBe(false);
    expect(env.googleClientId).toBeUndefined();
  });

  it('enables auth when all three are present', () => {
    stubAuth(CLIENT_ID, CLIENT_SECRET, SECRET);
    expect(loadEnv().authEnabled).toBe(true);
  });

  it('refuses to boot on a half-configured setup', () => {
    // The trap this exists to prevent: a server that looks signed-in-capable and
    // only fails at the callback, after the player has already been to Google.
    stubAuth(CLIENT_ID, '', SECRET);
    expect(() => loadEnv()).toThrow(/partially configured/);

    stubAuth('', CLIENT_SECRET, SECRET);
    expect(() => loadEnv()).toThrow(/partially configured/);

    stubAuth(CLIENT_ID, CLIENT_SECRET, '');
    expect(() => loadEnv()).toThrow(/partially configured/);
  });

  it('rejects a session secret too short to be worth signing with', () => {
    stubAuth(CLIENT_ID, CLIENT_SECRET, 'short');
    expect(() => loadEnv()).toThrow(/at least 32 characters/);
  });

  it('strips trailing slashes from the public origin', () => {
    // The redirect URI is built from this and must match Google's registration
    // character for character, so `//api/auth/...` would break sign-in.
    stubAuth('', '', '');
    vi.stubEnv('PUBLIC_ORIGIN', 'https://dev.tailfinsim.com///');
    expect(loadEnv().publicOrigin).toBe('https://dev.tailfinsim.com');
  });

  it('defaults the public origin to localhost', () => {
    stubAuth('', '', '');
    vi.stubEnv('PUBLIC_ORIGIN', '');
    expect(loadEnv().publicOrigin).toBe('http://localhost:3000');
  });

  it('defaults the session lifetime to 30 days', () => {
    stubAuth('', '', '');
    vi.stubEnv('SESSION_TTL_HOURS', '');
    expect(loadEnv().sessionTtlHours).toBe(720);
  });

  it('defaults privileged sessions to one 12-hour operator shift', () => {
    stubAuth('', '', '');
    vi.stubEnv('SESSION_TTL_HOURS', '');
    vi.stubEnv('ADMIN_SESSION_TTL_HOURS', '');
    expect(loadEnv().adminSessionTtlHours).toBe(12);
  });

  it('requires the privileged lifetime to be shorter than the player lifetime', () => {
    stubAuth('', '', '');
    vi.stubEnv('SESSION_TTL_HOURS', '12');
    vi.stubEnv('ADMIN_SESSION_TTL_HOURS', '12');
    expect(() => loadEnv()).toThrow(/must be shorter/);
  });

  it('refuses production when the public origin would make cookies insecure', () => {
    stubAuth('', '', '');
    vi.stubEnv('ENVIRONMENT_LABEL', 'production');
    vi.stubEnv('PUBLIC_ORIGIN', 'http://tailfinsim.com');
    expect(() => loadEnv()).toThrow(/requires an https PUBLIC_ORIGIN/);

    vi.stubEnv('PUBLIC_ORIGIN', 'https://tailfinsim.com');
    expect(loadEnv().publicOrigin).toBe('https://tailfinsim.com');
  });
});
