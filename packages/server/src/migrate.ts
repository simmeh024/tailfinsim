import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './db/client';

/**
 * Standalone migration entry point.
 *
 * Run as a one-off container by the deploy script *before* the new server
 * starts — never by the app on boot. A process that migrates on startup races
 * itself the moment there is more than one replica, and turns a bad migration
 * into a crash loop instead of a failed deploy step.
 */

const { db, close } = createDatabase();

try {
  await migrate(db, { migrationsFolder: './drizzle' });
  console.warn('migrations applied');
} finally {
  await close();
}
