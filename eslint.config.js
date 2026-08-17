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
          allowDefaultProject: ['*.js', '*.ts', 'packages/*/drizzle.config.ts'],
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
          ],
        },
      ],
    },
  },

  // Tests may reach for things production code may not.
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
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
