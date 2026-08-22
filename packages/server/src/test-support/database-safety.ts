/**
 * The guard that stands between the test suite and a database somebody cares
 * about.
 *
 * Database-backed tests insert and delete real rows. Some also arrange global
 * state, such as the number of administrators, to exercise invariants. Hostname
 * cannot distinguish a disposable database: CI, a laptop, dev, and production
 * can all reach Postgres through localhost. The database name is therefore the
 * fail-closed boundary.
 *
 * `DATABASE_URL` may be absent for ordinary local, database-free test runs.
 * When it is present, the selected database must end in `_test` or `_ci`.
 * Throwing instead of skipping prevents a misspelt CI URL from producing a
 * green run whose database tests never executed.
 */

const DISPOSABLE_DATABASE = /_(test|ci)$/;

export function databaseNameOf(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/^\//, '');
    return path === '' ? null : decodeURIComponent(path);
  } catch {
    return null;
  }
}

export function assertDisposableDatabaseUrl(url: string | undefined): void {
  if (url === undefined || url === '') return;

  const name = databaseNameOf(url);
  if (name === null) {
    throw new Error(
      'DATABASE_URL names no database, so the tests cannot tell whether it is safe to ' +
        'write to. Point it at a database whose name ends in _test or _ci.',
    );
  }

  if (!DISPOSABLE_DATABASE.test(name)) {
    throw new Error(
      [
        `Refusing to run the server tests against the database "${name}".`,
        '',
        'These tests are destructive: they create and delete players, and some arrange',
        'global state in order to prove security invariants. A database that is not',
        'disposable must never see them.',
        '',
        'A database is treated as disposable when its name ends in _test or _ci.',
        '',
        '  CI            tailfin_test   (see .github/workflows/ci.yml)',
        '  locally       createdb tailfin_test, then',
        '                DATABASE_URL=postgres://tailfin:tailfin_dev@127.0.0.1:5432/tailfin_test pnpm test',
        '',
        'If you are on the dev or production server: you are in the wrong place. Run the',
        'suite in CI, or against a scratch database restored from a backup.',
      ].join('\n'),
    );
  }
}
