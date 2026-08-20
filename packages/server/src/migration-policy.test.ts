import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inspectMigrationPolicy, migrationPolicyViolationsForSource } from './migration-policy';
import {
  classifyMigrationFailure,
  MIGRATION_EXIT_ALL_APPLIED,
  MIGRATION_EXIT_NOT_STARTED,
  MIGRATION_EXIT_ROLLED_BACK,
  MIGRATION_EXIT_UNKNOWN,
} from './migration-state';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const migrationsFolder = resolve(repoRoot, 'packages', 'server', 'drizzle');

describe('expand/contract migration policy', () => {
  it('accepts the current immutable baseline', async () => {
    await expect(inspectMigrationPolicy(migrationsFolder)).resolves.toEqual([]);
  });

  it('requires every future migration to choose a strategy', () => {
    const violations = migrationPolicyViolationsForSource(
      '0020_probe',
      'ALTER TABLE thing ADD value int;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('missing');
  });

  it.each([
    'DROP TABLE old_thing;',
    'ALTER TABLE thing DROP COLUMN old_value;',
    'ALTER TABLE thing RENAME COLUMN value TO old_value;',
    'ALTER TABLE thing ALTER COLUMN value TYPE bigint;',
    'ALTER TABLE thing ALTER COLUMN value SET NOT NULL;',
    'TRUNCATE thing;',
  ])('refuses an obvious contraction marked as expand: %s', (sql) => {
    const violations = migrationPolicyViolationsForSource(
      '0020_probe',
      `-- tailfin:migration-strategy expand\n${sql}`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('contract operation');
  });

  it('requires a default on a new required column', () => {
    const violations = migrationPolicyViolationsForSource(
      '0020_probe',
      '-- tailfin:migration-strategy expand\nALTER TABLE thing ADD COLUMN value integer NOT NULL;',
    );
    expect(violations[0]?.message).toContain('database default');
  });

  it('allows an explicitly staged contract tied to its issue', () => {
    expect(
      migrationPolicyViolationsForSource(
        '0021_remove_old_value',
        '-- tailfin:migration-strategy contract-safe-after #999\n' +
          'ALTER TABLE thing DROP COLUMN old_value;',
      ),
    ).toEqual([]);
  });

  it.each(['CREATE INDEX CONCURRENTLY value_idx ON thing(value);', 'VACUUM thing;'])(
    'refuses non-transactional SQL under either strategy: %s',
    (sql) => {
      const violations = migrationPolicyViolationsForSource(
        '0020_probe',
        `-- tailfin:migration-strategy contract-safe-after #999\n${sql}`,
      );
      expect(violations[0]?.message).toContain('atomic migration transaction');
    },
  );

  it('keeps the deploy-script exit contract stable', () => {
    expect([
      MIGRATION_EXIT_ROLLED_BACK,
      MIGRATION_EXIT_ALL_APPLIED,
      MIGRATION_EXIT_UNKNOWN,
      MIGRATION_EXIT_NOT_STARTED,
    ]).toEqual([20, 21, 22, 23]);
  });

  it('classifies unchanged, fully advanced and in-between journals', () => {
    const before = { createdAt: [100] };
    const pending = [
      { idx: 1, when: 200, tag: '0001_second' },
      { idx: 2, when: 300, tag: '0002_third' },
    ];

    expect(classifyMigrationFailure(before, { createdAt: [100] }, pending)).toBe('rolled_back');
    expect(classifyMigrationFailure(before, { createdAt: [100, 200, 300] }, pending)).toBe(
      'all_applied',
    );
    expect(classifyMigrationFailure(before, { createdAt: [100, 200] }, pending)).toBe('unknown');
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('Drizzle migration failure experiment on disposable PostgreSQL', () => {
  const probeTable = 'ops05_atomic_migration_probe';
  const migrationSchema = 'ops05_drizzle_probe';
  let folder = '';
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
    folder = await mkdtemp(join(tmpdir(), 'tailfin-ops05-migrations-'));
    await mkdir(join(folder, 'meta'));

    await writeFile(
      join(folder, 'meta', '_journal.json'),
      `${JSON.stringify(
        {
          version: '7',
          dialect: 'postgresql',
          entries: [
            {
              idx: 0,
              version: '7',
              when: 1_800_000_000_001,
              tag: '0000_expand',
              breakpoints: true,
            },
            { idx: 1, version: '7', when: 1_800_000_000_002, tag: '0001_fail', breakpoints: true },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(folder, '0000_expand.sql'),
      `ALTER TABLE ${probeTable} ADD COLUMN first_marker integer DEFAULT 7 NOT NULL;` +
        '--> statement-breakpoint\n' +
        `ALTER TABLE ${probeTable} ADD CONSTRAINT positive_payload CHECK (payload >= 0);`,
    );
    await writeFile(
      join(folder, '0001_fail.sql'),
      `SELECT pg_sleep(1);--> statement-breakpoint\n` +
        `ALTER TABLE ${probeTable} ADD COLUMN second_marker integer;--> statement-breakpoint\n` +
        'SELECT 1 / 0;',
    );
  });

  afterAll(async () => {
    await pool.query(`drop schema if exists ${migrationSchema} cascade`);
    await pool.query(`drop table if exists ${probeTable}`);
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  });

  it('rolls back the whole two-file batch and holds its table lock until then', async () => {
    await pool.query(`drop schema if exists ${migrationSchema} cascade`);
    await pool.query(`drop table if exists ${probeTable}`);
    await pool.query(
      `create table ${probeTable} as
         select value as id, value as payload
           from generate_series(1, 100000) value`,
    );

    const db = drizzle(pool);
    const started = performance.now();
    const migration = migrate(db, {
      migrationsFolder: folder,
      migrationsSchema: migrationSchema,
    });

    let lockObserved = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const locks = await pool.query<{ held: boolean }>(
        `select exists (
             select 1
               from pg_locks locks
               join pg_class relation on relation.oid = locks.relation
              where relation.relname = $1
                and locks.mode = 'AccessExclusiveLock'
                and locks.granted
           ) as held`,
        [probeTable],
      );
      if (locks.rows[0]?.held) {
        lockObserved = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    expect(lockObserved).toBe(true);

    const reader = await pool.connect();
    try {
      await reader.query(`set lock_timeout = '200ms'`);
      await expect(reader.query(`select count(*) from ${probeTable}`)).rejects.toMatchObject({
        code: '55P03',
      });
    } finally {
      reader.release();
    }

    await expect(migration).rejects.toThrow();
    const elapsedMs = Math.round(performance.now() - started);

    const columns = await pool.query<{ column_name: string }>(
      `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by column_name`,
      [probeTable],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(['id', 'payload']);

    const journal = await pool.query<{ count: string }>(
      `select count(*)::text as count from ${migrationSchema}.__drizzle_migrations`,
    );
    expect(journal.rows[0]?.count).toBe('0');

    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from ${probeTable}`,
    );
    expect(rows.rows[0]?.count).toBe('100000');

    process.stderr.write(
      `[OPS-05 experiment] PostgreSQL rolled back both migration files over 100,000 rows ` +
        `in ${String(elapsedMs)}ms; the batch held an AccessExclusiveLock until rollback.\n`,
    );
  }, 30_000);

  it('records a readable experiment rather than relying on the fixture name', async () => {
    const source = await readFile(
      resolve(repoRoot, 'docs', 'adr', '0016-migration-failure-strategy.md'),
      'utf8',
    );
    expect(source).toContain('100,000');
    expect(source).toContain('AccessExclusiveLock');
    expect(source).toContain('rolled back');
  });
});
