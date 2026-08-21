import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './db/client';
import { inspectMigrationPolicy } from './migration-policy';
import {
  classifyMigrationFailure,
  MIGRATION_EXIT_ALL_APPLIED,
  MIGRATION_EXIT_NOT_STARTED,
  MIGRATION_EXIT_ROLLED_BACK,
  MIGRATION_EXIT_UNKNOWN,
  migrationTagAt,
  readAppliedMigrationState,
  readMigrationPlan,
} from './migration-state';

/**
 * Standalone migration entry point.
 *
 * Run as a one-off command by the deploy script *before* the new server
 * starts — never by the app on boot. A process that migrates on startup races
 * itself the moment there is more than one replica, and turns a bad migration
 * into a crash loop instead of a failed deploy step.
 */

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

function errorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }

  return messages.join('\ncaused by: ');
}

const mode = process.argv[2] ?? '--apply';
if (!['--apply', '--database-name', '--pending-count'].includes(mode)) {
  process.stderr.write('usage: node dist/migrate.js [--apply|--database-name|--pending-count]\n');
  process.exitCode = 2;
} else {
  const { db, pool, close } = createDatabase();
  let exitCode = 0;

  try {
    const violations = await inspectMigrationPolicy(MIGRATIONS_FOLDER);
    if (violations.length > 0) {
      for (const violation of violations) {
        process.stderr.write(`migration policy: ${violation.tag}: ${violation.message}\n`);
      }
      process.stderr.write(
        'DATABASE STATE: NOT TOUCHED — migration policy failed before the migrator started.\n',
      );
      exitCode = MIGRATION_EXIT_NOT_STARTED;
    } else {
      const before = await readMigrationPlan(pool, MIGRATIONS_FOLDER);

      if (mode === '--database-name') {
        process.stdout.write(`${before.database}\n`);
      } else if (mode === '--pending-count') {
        process.stdout.write(`${String(before.pending.length)}\n`);
      } else {
        try {
          await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
          process.stderr.write(
            `migrations applied; database is at ${migrationTagAt(before.journal, before.journal.at(-1)?.when)}\n`,
          );
        } catch (error) {
          process.stderr.write(`migration error: ${errorChain(error)}\n`);

          try {
            const after = await readAppliedMigrationState(pool);
            const state = classifyMigrationFailure(before.applied, after, before.pending);
            const latest = migrationTagAt(before.journal, after.createdAt.at(-1));

            if (state === 'rolled_back') {
              process.stderr.write(
                `DATABASE STATE: ROLLED BACK — PostgreSQL left the pending batch unapplied; ` +
                  `the migration journal remains at ${latest}.\n`,
              );
              exitCode = MIGRATION_EXIT_ROLLED_BACK;
            } else if (state === 'all_applied') {
              process.stderr.write(
                `DATABASE STATE: ALL APPLIED — the journal reached ${latest}; the client failed ` +
                  'after PostgreSQL committed. The previous release remains compatible by policy.\n',
              );
              exitCode = MIGRATION_EXIT_ALL_APPLIED;
            } else {
              process.stderr.write(
                `DATABASE STATE: UNKNOWN/PARTIAL — the journal is at ${latest}, which is neither ` +
                  'the pre-migration state nor the complete pending batch. Follow the migration ' +
                  'recovery runbook before retrying or rolling code back.\n',
              );
              exitCode = MIGRATION_EXIT_UNKNOWN;
            }
          } catch (stateError) {
            process.stderr.write(
              `DATABASE STATE: UNKNOWN — the post-failure journal could not be read: ${errorChain(stateError)}. ` +
                'Follow the migration recovery runbook before retrying or rolling code back.\n',
            );
            exitCode = MIGRATION_EXIT_UNKNOWN;
          }
        }
      }
    }
  } catch (error) {
    process.stderr.write(`migration preflight failed: ${errorChain(error)}\n`);
    process.stderr.write(
      'DATABASE STATE: NOT TOUCHED BY THIS COMMAND — the migrator did not start.\n',
    );
    exitCode = MIGRATION_EXIT_NOT_STARTED;
  } finally {
    await close();
  }

  if (exitCode !== 0) process.exitCode = exitCode;
}
