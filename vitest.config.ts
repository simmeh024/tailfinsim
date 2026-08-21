import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration.
 *
 * Per-package projects (M0-04) so each can diverge later — `web` will need a
 * jsdom environment, `server` will need database fixtures — without the others
 * inheriting that cost. Projects deliberately share the repository root rather
 * than setting their own, so every coverage path stays root-relative and the
 * threshold globs below match what the reporter actually emits.
 *
 * Coverage is collected everywhere but only **enforced** on `packages/sim`.
 * That is deliberate: the sim is the pure, deterministic core where a silent
 * regression is most expensive and hardest to notice. Thresholds for the other
 * packages get raised as they grow real logic.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['packages/shared/src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'sim',
          include: ['packages/sim/src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          include: ['packages/server/src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'node',
          // Refuses to run against a database that is not disposable. A setup
          // file rather than a call in each test, because the one thing this
          // must not depend on is every future test file remembering to ask.
          setupFiles: ['packages/server/src/test-setup.ts'],
          /**
           * One file at a time. **These tests share a single database.**
           *
           * Not a performance choice — a correctness one. Several suites do
           * table-wide work: the OurAirports importer's `--prune` deletes every
           * airport whose source id is absent from the incoming dataset, which
           * is right for the importer and lethal for whatever else is mid-test.
           * Run in parallel, it silently deletes another file's fixtures, and
           * when one of those is referenced by a `flight` it fails on a foreign
           * key that has nothing to do with what either test was proving.
           *
           * M2-06 is what surfaced it — settling a flight means holding an
           * airport reference for the length of a test — but the race predates
           * it and was only ever a matter of timing. The other projects keep
           * their parallelism; they share nothing.
           */
          fileParallelism: false,
        },
      },
      {
        // The only project needing a DOM. Kept separate rather than making
        // jsdom the default, because spinning one up for the sim's pure-function
        // tests would cost time for nothing.
        plugins: [react()],
        test: {
          name: 'web',
          include: ['packages/web/src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['packages/web/src/test-setup.ts'],
          css: true,
          /**
           * Longer than the default five seconds, and longer **on purpose than
           * the query budget `test-setup.ts` sets**.
           *
           * These two numbers are a pair, and getting them the wrong way round
           * is its own trap: raising the async-query budget to five seconds
           * against a five-second test timeout means a slow query eats the whole
           * test and the failure arrives as "Test timed out in 5000ms", which
           * names neither the query nor the gate it was waiting on. Measured
           * that way round first — it turned three legible failures into
           * illegible ones.
           *
           * So the test gets room for several gates at the query budget and the
           * query still loses first, with something to say. Nothing a passing
           * test ever spends: the whole project runs in about eighteen seconds.
           */
          testTimeout: 20000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/dist/**'],
      // Enforced for sim only. Other packages are measured, not gated.
      thresholds: {
        'packages/sim/src/**/*.ts': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
