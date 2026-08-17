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

  it('defaults the log level by environment', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('LOG_LEVEL', '');

    vi.stubEnv('NODE_ENV', 'production');
    expect(loadEnv().logLevel).toBe('info');

    vi.stubEnv('NODE_ENV', 'development');
    expect(loadEnv().logLevel).toBe('debug');
  });

  it('lets an explicit log level win over the default', () => {
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOG_LEVEL', 'trace');
    expect(loadEnv().logLevel).toBe('trace');
  });
});
