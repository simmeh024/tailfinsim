import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadEnv } from '../env';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  /** Closes the pool. Called on SIGTERM by the graceful shutdown path (M0-08). */
  close: () => Promise<void>;
}

/**
 * Create a connection pool and a Drizzle instance bound to it.
 *
 * Returns a handle rather than a module-level singleton so tests can create an
 * isolated database per suite, and so the process can shut the pool down
 * deterministically.
 */
export function createDatabase(): DatabaseHandle {
  const env = loadEnv();

  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    // Bounded on purpose — `pg`'s default is to wait indefinitely. See the field
    // comment in env.ts for why that breaks the health check.
    connectionTimeoutMillis: env.databaseConnectTimeoutMs,
  });

  return {
    db: drizzle(pool, { schema }),
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
