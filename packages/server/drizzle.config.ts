import { defineConfig } from 'drizzle-kit';

import { loadEnv } from './src/env';

/**
 * drizzle-kit configuration.
 *
 * `out` is committed to the repository: migrations are SQL files under version
 * control, never generated at runtime (M0-05).
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: loadEnv().databaseUrl,
  },
  // Prompt before anything destructive, and print the SQL being run.
  strict: true,
  verbose: true,
});
