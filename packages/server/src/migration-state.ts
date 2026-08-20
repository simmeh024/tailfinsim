import { readMigrationJournal, type MigrationJournalEntry } from './migration-policy';

import type pg from 'pg';

export const MIGRATION_EXIT_ROLLED_BACK = 20;
export const MIGRATION_EXIT_ALL_APPLIED = 21;
export const MIGRATION_EXIT_UNKNOWN = 22;
export const MIGRATION_EXIT_NOT_STARTED = 23;

export interface AppliedMigrationState {
  createdAt: number[];
}

export interface MigrationPlan {
  database: string;
  journal: MigrationJournalEntry[];
  applied: AppliedMigrationState;
  pending: MigrationJournalEntry[];
}

export type MigrationFailureState = 'rolled_back' | 'all_applied' | 'unknown';

export async function readAppliedMigrationState(pool: pg.Pool): Promise<AppliedMigrationState> {
  const relation = await pool.query<{ relation: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as relation`,
  );
  if (relation.rows[0]?.relation === null || relation.rows[0]?.relation === undefined) {
    return { createdAt: [] };
  }

  const rows = await pool.query<{ created_at: string | null }>(
    `select created_at::text as created_at
       from drizzle.__drizzle_migrations
      order by created_at, id`,
  );
  if (rows.rows.some((row) => row.created_at === null)) {
    throw new Error('Drizzle migration journal contains a null created_at value');
  }
  const createdAt = rows.rows.map((row) => Number(row.created_at));
  if (createdAt.some((value) => !Number.isSafeInteger(value))) {
    throw new Error('Drizzle migration journal contains an invalid created_at value');
  }
  return {
    createdAt,
  };
}

export async function readMigrationPlan(
  pool: pg.Pool,
  migrationsFolder: string,
): Promise<MigrationPlan> {
  const [databaseResult, journal, applied] = await Promise.all([
    pool.query<{ database: string }>('select current_database() as database'),
    readMigrationJournal(migrationsFolder),
    readAppliedMigrationState(pool),
  ]);
  const latest = applied.createdAt.at(-1) ?? Number.NEGATIVE_INFINITY;

  return {
    database: databaseResult.rows[0]?.database ?? 'unknown',
    journal,
    applied,
    pending: journal.filter((entry) => entry.when > latest),
  };
}

function same(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Distinguishes the three states an operator needs after the client reports a
 * migration failure. PostgreSQL transaction atomicity makes the first two the
 * expected outcomes; anything between them is treated as unknown, never
 * guessed safe.
 */
export function classifyMigrationFailure(
  before: AppliedMigrationState,
  after: AppliedMigrationState,
  pending: readonly MigrationJournalEntry[],
): MigrationFailureState {
  if (same(before.createdAt, after.createdAt)) return 'rolled_back';

  const expected = [...before.createdAt, ...pending.map((entry) => entry.when)];
  if (same(expected, after.createdAt)) return 'all_applied';

  return 'unknown';
}

export function migrationTagAt(
  journal: readonly MigrationJournalEntry[],
  createdAt: number | undefined,
): string {
  if (createdAt === undefined) return 'none';
  return journal.find((entry) => entry.when === createdAt)?.tag ?? `unknown(${String(createdAt)})`;
}
