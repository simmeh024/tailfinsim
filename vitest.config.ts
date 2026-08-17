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
        },
      },
      {
        test: {
          name: 'web',
          include: ['packages/web/src/**/*.{test,spec}.{ts,tsx}'],
          environment: 'node',
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
