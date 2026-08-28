import { describe, expect, it } from 'vitest';

import { assertDisposableDatabaseUrl, databaseNameOf } from './database-safety';

describe('the server test database guard', () => {
  it('allows database-free local runs', () => {
    expect(() => assertDisposableDatabaseUrl(undefined)).not.toThrow();
    expect(() => assertDisposableDatabaseUrl('')).not.toThrow();
  });

  it.each(['tailfin_test', 'tailfin_e2e_test', 'feature_ci', 'name%5Ftest'])(
    'allows the disposable database %s',
    (name) => {
      expect(() => assertDisposableDatabaseUrl(`postgres://localhost/${name}`)).not.toThrow();
    },
  );

  it.each(['tailfin', 'tailfin_dev', 'test_tailfin'])(
    'rejects the non-disposable database %s',
    (name) => {
      expect(() => assertDisposableDatabaseUrl(`postgres://localhost/${name}`)).toThrow(
        new RegExp(`database "${name}"`),
      );
    },
  );

  it.each(['not a URL', 'postgres://localhost', 'postgres://localhost/'])(
    'rejects a URL that cannot name a database: %s',
    (url) => {
      expect(() => assertDisposableDatabaseUrl(url)).toThrow(/names no database/);
    },
  );

  it('decodes the selected database name', () => {
    expect(databaseNameOf('postgres://localhost/tailfin%5Ftest')).toBe('tailfin_test');
  });

  it('explains the destructive boundary and both accepted suffixes', () => {
    expect(() => assertDisposableDatabaseUrl('postgres://localhost/tailfin_dev')).toThrow(
      /destructive[\s\S]*_test or _ci/,
    );
  });
});
