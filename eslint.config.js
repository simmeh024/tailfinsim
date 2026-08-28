// @ts-check
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Tailfin lint rules.
 *
 * Two rules here are architectural rather than stylistic, and both encode
 * invariants from CONTRIBUTING.md:
 *
 *   1. `packages/sim` may not import from `server` or `web`. The sim is the
 *      pure, deterministic core; the replay harness (M13-01) and the economy
 *      regression suite (M13-02) depend on it staying that way.
 *   2. `packages/web` may not import from `sim`. The server is authoritative
 *      and the client never computes economic outcomes (design doc §21).
 */
/** The tick loop, which only the worker may start. See ADR-0019. */
const TICK_LOOP_IMPORT = {
  group: ['**/sim/tick', '**/sim/tick.js'],
  message:
    'Only the worker process runs things on a schedule. Put the work in packages/server/src/engine/ and let worker.ts drive it, or schedule an event with scheduleEvent() and let the worker drain it. See docs/adr/0019-web-worker-boundary.md.',
};

/**
 * The balance numbers as the build ships them — a seed, never what a world runs.
 * See CONTRIBUTING.md invariant 3, design doc §22.3 and M3-11.
 */
const SHIPPED_BALANCE_IMPORTS = [
  {
    name: '@tailfin/sim',
    importNames: [
      'DEFAULT_AIRPORT_FEES',
      'DEFAULT_BOOKING_CURVE',
      'DEFAULT_CLASS_MIX',
      'DEFAULT_DISRUPTION_COST',
      'DEFAULT_FUEL_MARKET',
      'DEFAULT_GRAVITY',
      'DEFAULT_ITINERARY',
      'DEFAULT_LOGIT',
      'DEFAULT_MODULATION',
      'DEFAULT_NPC',
      'DEFAULT_SCHED_FIT',
      'DEFAULT_SEGMENTS',
      'DEFAULT_SETTLEMENT',
      'EFFICIENCY_CEILINGS',
      'FARE_FLOOR_RATIO',
      'VIABLE_DAILY_PASSENGERS',
    ],
    message:
      "Balance numbers come from the world's pinned economy, not from the shipped defaults. Use loadWorldEconomyConfig() or loadEconomyConfig() from economy/loader.ts. See CONTRIBUTING.md invariant 3 and design doc §22.3.",
  },
  {
    name: '@tailfin/shared',
    importNames: ['ECONOMY_CONFIG_V1'],
    message:
      "The shipped payload is a seed, not the economy a world runs. economy/seed.ts is the only place that writes it; everything else loads the world's pinned version. See CONTRIBUTING.md invariant 3.",
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.tsbuildinfo', 'docs/**'],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Lets typescript-eslint find the right tsconfig per file via project
        // references, including root-level config files.
        projectService: {
          // Root config files, plus per-package tool configs that sit outside
          // any package's `rootDir` and so belong to no project.
          allowDefaultProject: [
            '*.js',
            'packages/*/drizzle.config.ts',
            'packages/*/vite.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX },
    rules: {
      // Required by M0-02. In a real-time server a dropped promise is a
      // silently lost flight resolution, so this is an error, not a warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          pathGroups: [{ pattern: '@tailfin/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Invariant 1 — the sim stays pure.
  {
    files: ['packages/sim/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tailfin/server', '@tailfin/server/*', '@tailfin/web', '@tailfin/web/*'],
              message:
                'packages/sim must stay pure: it may only depend on @tailfin/shared. See CONTRIBUTING.md.',
            },
            {
              group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto'],
              message:
                'packages/sim must not perform I/O. Pass data in; return data out. See CONTRIBUTING.md.',
            },
          ],
        },
      ],
    },
  },

  // Invariant 2 — the client never runs the economy.
  {
    files: ['packages/web/**/*.ts', 'packages/web/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@tailfin/sim', '@tailfin/sim/*'],
              message:
                'The server is authoritative; the client never computes economic outcomes. Call the API instead. See CONTRIBUTING.md.',
            },
            {
              // `node` is in web's tsconfig types for the theme-token scan test,
              // which reads files off disk. Nothing shipped to a browser may
              // import a Node builtin; the test-file override below exempts
              // tests only.
              group: ['node:*'],
              message:
                'packages/web ships to a browser. Node builtins are only permitted in this package’s tests.',
            },
          ],
        },
      ],
    },
  },

  // Two boundaries live on `packages/server/**`, and they exempt different files.
  //
  // ESLint replaces a rule's configuration wholesale rather than merging it, so
  // the last block matching a file is the only one that applies to it. Three
  // blocks, each *complete* for the files it claims, rather than two that
  // silently cancel each other:
  //
  //   1. everything in the server        — both restrictions
  //   2. the worker, the engine, the loop — no tick restriction (they are it)
  //   3. `economy/**`                     — no balance restriction (it is the loader)
  //
  // Written out three times on purpose. An `ignores` list shared between them
  // would have to exempt a file from *both* rules to exempt it from one, which
  // is how `engine/simulation.ts` lost its tick restriction the first time this
  // was written.

  // --- 1. The web/worker boundary (ADR-0019, OPS-08) and invariant 3 ---------
  //
  // Only the worker runs things on a schedule. Everything in the server package
  // except the engine and its entry point is web work or shared work, and none
  // of it may start a tick loop.
  //
  // Scoped to the *loop*, not to the queue: `sim/event-queue.ts` stays open to
  // the web process on purpose, because scheduling an event is web work — a
  // route writes a due row and the worker picks it up. That is the whole
  // communication channel, and closing it would break the boundary rather than
  // enforce it.
  //
  // `engine/boundary.test.ts` asserts the same thing across the whole module
  // graph, which is what catches a path this glob does not. This rule is here
  // for the version of that feedback that arrives while you are still typing.
  //
  // Invariant 3 rides along: M3-11 moved every balance number into
  // `economy_config`, and a world pins the version it runs. `packages/sim` still
  // exports the shipped payload as a default parameter, which is right for a
  // pure function a test calls directly and wrong for anything with a database
  // in reach — a route that quietly used it would price a world with numbers
  // nobody chose for that world, and the symptom is a figure that is merely
  // plausible rather than an error. The rule names the constants rather than the
  // module, because the same import statement legitimately carries the functions
  // and types beside them.
  {
    files: ['packages/server/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [TICK_LOOP_IMPORT], paths: SHIPPED_BALANCE_IMPORTS },
      ],
    },
  },

  // SEC-06 — handlers consume parsed bodies, never Fastify's raw body.
  // `http/request-body.ts` is the single boundary that may perform this read.
  {
    files: ['packages/server/src/**/*routes.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='request'][property.name='body']",
          message:
            'Parse request bodies through parseRequestBody(); handlers must never read request.body directly. See CONTRIBUTING.md and SEC-06.',
        },
      ],
    },
  },

  // --- 2. The engine, the worker and the loop itself -------------------------
  // They are what the tick restriction protects, so it cannot apply to them.
  // Invariant 3 still does: the worker settles flights and must read the world's
  // economy like everything else.
  {
    files: [
      'packages/server/src/worker.ts',
      'packages/server/src/engine/**/*.ts',
      'packages/server/src/sim/tick.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: SHIPPED_BALANCE_IMPORTS }],
    },
  },

  // --- 3. The economy loader -------------------------------------------------
  // The one module allowed to touch the shipped payload, because seeding it is
  // its job. Still no tick loop.
  {
    files: ['packages/server/src/economy/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [TICK_LOOP_IMPORT] }],
    },
  },

  // Tests may reach for things production code may not.
  //
  // `.tsx` included: a React component test is a test, and leaving it out meant a
  // shell test that reads a stylesheet off disk was refused the Node builtins that
  // the identical assertion in a `.ts` test is allowed.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Plain-JS config and build scripts belong to no TypeScript project, so they
  // get no type-aware rules. Without this they fail parsing outright.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Must stay last: turns off everything Prettier owns.
  prettierConfig,
);
