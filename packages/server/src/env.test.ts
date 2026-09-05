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

  it('permits a quarantine recovery export only on the explicitly labelled dev environment', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ENVIRONMENT_LABEL', 'dev');
    vi.stubEnv('DEV_QUARANTINE_A320NEO_RECOVERY_GLB', '/private/a320neo-recovery.glb');
    expect(loadEnv().devQuarantineA320neoRecoveryGlb).toBe('/private/a320neo-recovery.glb');

    vi.stubEnv('ENVIRONMENT_LABEL', 'production');
    expect(() => loadEnv()).toThrow(/may only be configured when ENVIRONMENT_LABEL=dev/);
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

describe('loadEnv — CORS (SEC-HARD-08)', () => {
  /**
   * The boot refusal, exercised where a boot actually happens.
   *
   * `security/cors.test.ts` proves the policy; this proves it is wired to
   * `loadEnv`, which is the difference between a correct function and a correct
   * server. Production is the label that matters: the same build runs
   * everywhere, so a value added "just for dev" is one variable from the live
   * host, and the live host has to be the one that will not start.
   */
  function production(value: string): () => unknown {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('ENVIRONMENT_LABEL', 'production');
    vi.stubEnv('PUBLIC_ORIGIN', 'https://tailfinsim.com');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', value);
    return () => loadEnv();
  }

  it('trusts nothing cross-origin when the variable is unset', () => {
    expect(production('')()).toMatchObject({ corsAllowedOrigins: [] });
  });

  it('refuses to boot production with a wildcard origin', () => {
    expect(production('*')).toThrow(/wildcard/i);
  });

  it('refuses to boot production with a localhost origin', () => {
    expect(production('http://localhost:5173')).toThrow(/may not trust/i);
  });

  it('refuses to boot production with a lookalike domain', () => {
    // `https://tailfinsim.com.evil.example` ends in our domain and is not ours.
    expect(production('https://tailfinsim.com.evil.example')).toThrow(/may not trust/i);
  });

  it('refuses even its own origin, because nothing would consume it', () => {
    // Permitted by the table and still refused: this build registers no CORS
    // plugin, and a variable that silently does nothing is worse than one that
    // stops the server and says what to do instead.
    expect(production('https://tailfinsim.com')).toThrow(/registers no CORS plugin/i);
  });
});

describe('loadEnv — rate limits (SEC-HARD-09)', () => {
  it('reads a per-class budget', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('RATE_LIMIT_WRITE_MAX', '30');
    vi.stubEnv('RATE_LIMIT_WRITE_WINDOW_MS', '10000');
    expect(loadEnv().rateLimits).toMatchObject({ write: { max: 30, windowMs: 10_000 } });
  });

  it('refuses to boot on a class name that does not exist', () => {
    // A variable that silently does nothing is the shape of every long-running
    // configuration mystery — and here it would mean somebody believed they had
    // tightened a limit that was never touched.
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('RATE_LIMIT_ORDERS_MAX', '10');
    expect(() => loadEnv()).toThrow(/names no rate-limit class/);
    // And it says what the classes are, rather than leaving a guess.
    expect(() => loadEnv()).toThrow(/read, write/);
  });

  it('does not mistake the single-ceiling variables for a class', () => {
    // `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` are the older spelling and
    // still mean the read budget; parsing them as a class named MAX would
    // refuse to boot on a box that has been running for months.
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('RATE_LIMIT_MAX', '900');
    vi.stubEnv('RATE_LIMIT_WINDOW_MS', '30000');
    const env = loadEnv();
    expect(env.rateLimits).toEqual({});
    expect(env.rateLimitMax).toBe(900);
  });
});
