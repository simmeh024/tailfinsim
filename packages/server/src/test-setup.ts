/**
 * The guard that stands between the test suite and a database somebody cares
 * about.
 *
 * ## Why this exists
 *
 * The database-backed tests are destructive by nature. They insert players,
 * delete them again, and at least one of them has to arrange for there to be
 * exactly one admin in order to prove that the last one cannot be revoked.
 * Against a throwaway database that is all correct and necessary.
 *
 * It was run once against the dev box, by sourcing that box's `.env` to get a
 * real `DATABASE_URL`, and it revoked a real person's admin access. Nothing in
 * the code stopped it, because nothing in the code was looking. The suite has no
 * idea whether the database it was handed is disposable — unless it asks.
 *
 * ## How it decides
 *
 * By name, and only by name. Host is no help: CI, a laptop and the production
 * box all reach Postgres on localhost, so "is this local?" cannot distinguish
 * them. What can is that a disposable database is *named* as one.
 *
 *   tailfin_test   ✓   tailfin        ✗  (production, and the compose default)
 *   tailfin_ci     ✓   tailfin_dev    ✗  (the dev box — the one this bit)
 *   anything_test  ✓
 *
 * ## It throws; it does not skip
 *
 * Skipping would be the more comfortable failure and the wrong one. A misspelt
 * database name in CI would then produce a green run with every database test
 * silently absent — the suite would report success for work it never did.
 * Throwing fails closed and fails loudly, in the one direction worth failing in.
 *
 * `DATABASE_URL` being *unset* is left alone: that is the ordinary local case,
 * and the test files already skip their database suites when they see it. This
 * guard has an opinion only about a URL that is present and points somewhere it
 * should not.
 */

const DISPOSABLE = /_(test|ci)$/;

function databaseNameOf(url: string): string | null {
  try {
    // The pathname is `/name`; a URL with no path at all names no database.
    const path = new URL(url).pathname.replace(/^\//, '');
    return path === '' ? null : decodeURIComponent(path);
  } catch {
    return null;
  }
}

const url = process.env.DATABASE_URL;

if (url !== undefined && url !== '') {
  const name = databaseNameOf(url);

  if (name === null) {
    throw new Error(
      'DATABASE_URL names no database, so the tests cannot tell whether it is safe to ' +
        'write to. Point it at a database whose name ends in _test.',
    );
  }

  if (!DISPOSABLE.test(name)) {
    throw new Error(
      [
        `Refusing to run the server tests against the database "${name}".`,
        '',
        'These tests are destructive: they create and delete players, and one of them',
        'arranges for there to be exactly one admin in order to prove the last one',
        'cannot be revoked. A database that is not disposable must never see them.',
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
