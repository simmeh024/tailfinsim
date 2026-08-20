import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Migrations through this tag predate OPS-05. They were reviewed as the
 * starting point; editing them would be worse than grandfathering them because
 * they may already have been applied to a live database.
 */
export const MIGRATION_POLICY_BASELINE = '0019_large_hellfire_club';

export interface MigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

export type MigrationStrategy = { kind: 'expand' } | { kind: 'contract'; safeAfterIssue: string };

export interface MigrationPolicyViolation {
  tag: string;
  message: string;
}

const STRATEGY = /^--\s*tailfin:migration-strategy\s+(expand|contract-safe-after\s+(#\d+))\s*$/im;

const NON_TRANSACTIONAL_OPERATIONS: readonly [RegExp, string][] = [
  [/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, 'CREATE INDEX CONCURRENTLY'],
  [/\bREINDEX\b[\s\S]{0,80}\bCONCURRENTLY\b/i, 'REINDEX CONCURRENTLY'],
  [/\bVACUUM\b/i, 'VACUUM'],
  [/\bCLUSTER\b/i, 'CLUSTER'],
];

const EXPAND_INCOMPATIBLE_OPERATIONS: readonly [RegExp, string][] = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
  [/\bDROP\s+TYPE\b/i, 'DROP TYPE'],
  [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'],
  [/\bRENAME\s+(?:COLUMN|TO)\b/i, 'RENAME'],
  [/\bALTER\s+COLUMN\b[\s\S]{0,160}\bTYPE\b/i, 'ALTER COLUMN TYPE'],
  [/\bALTER\s+COLUMN\b[\s\S]{0,160}\bSET\s+NOT\s+NULL\b/i, 'SET NOT NULL'],
  [/\bALTER\s+COLUMN\b[\s\S]{0,160}\bDROP\s+DEFAULT\b/i, 'DROP DEFAULT'],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '');
}

function parseStrategy(source: string): MigrationStrategy | null {
  const header = source.split(/\r?\n/, 6).join('\n');
  const match = STRATEGY.exec(header);
  if (match?.[1] === 'expand') return { kind: 'expand' };
  if (match?.[2]) return { kind: 'contract', safeAfterIssue: match[2] };
  return null;
}

/**
 * Checks the mechanically knowable part of expand/contract.
 *
 * This is deliberately a deny-list, not a claim that SQL can be proved
 * backward-compatible with a regular expression. The marker makes the author
 * choose a phase; review and the issue named by a contract marker still own the
 * semantic part of the decision.
 */
export function migrationPolicyViolationsForSource(
  tag: string,
  source: string,
): MigrationPolicyViolation[] {
  const violations: MigrationPolicyViolation[] = [];
  const strategy = parseStrategy(source);
  const sql = stripComments(source);

  if (strategy === null) {
    violations.push({
      tag,
      message:
        'missing `-- tailfin:migration-strategy expand` or ' +
        '`-- tailfin:migration-strategy contract-safe-after #<issue>`',
    });
  }

  for (const [pattern, operation] of NON_TRANSACTIONAL_OPERATIONS) {
    if (pattern.test(sql)) {
      violations.push({
        tag,
        message: `${operation} cannot run inside Tailfin's atomic migration transaction`,
      });
    }
  }

  if (strategy?.kind === 'expand') {
    for (const [pattern, operation] of EXPAND_INCOMPATIBLE_OPERATIONS) {
      if (pattern.test(sql)) {
        violations.push({
          tag,
          message: `${operation} is a contract operation but this migration is marked expand`,
        });
      }
    }

    for (const statement of sql.split(';')) {
      if (
        /\bADD\s+COLUMN\s+[^;]*\bNOT\s+NULL\b/i.test(statement) &&
        !/\bDEFAULT\b/i.test(statement)
      ) {
        violations.push({
          tag,
          message:
            'a new NOT NULL column needs a database default so the previous release can still insert rows',
        });
      }
    }
  }

  return violations;
}

export async function readMigrationJournal(
  migrationsFolder: string,
): Promise<MigrationJournalEntry[]> {
  const raw: unknown = JSON.parse(
    await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  );
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as MigrationJournal).entries)
  ) {
    throw new Error('Drizzle migration journal has no entries array');
  }

  return (raw as MigrationJournal).entries.map((entry) => {
    if (
      !Number.isInteger(entry.idx) ||
      !Number.isSafeInteger(entry.when) ||
      typeof entry.tag !== 'string' ||
      entry.tag === ''
    ) {
      throw new Error('Drizzle migration journal contains an invalid entry');
    }
    return entry;
  });
}

/** Validate every migration added after OPS-05's immutable baseline. */
export async function inspectMigrationPolicy(
  migrationsFolder: string,
): Promise<MigrationPolicyViolation[]> {
  const journal = await readMigrationJournal(migrationsFolder);
  const baseline = journal.findIndex((entry) => entry.tag === MIGRATION_POLICY_BASELINE);
  if (baseline < 0) {
    return [
      {
        tag: MIGRATION_POLICY_BASELINE,
        message: 'migration policy baseline is missing from the Drizzle journal',
      },
    ];
  }

  const violations: MigrationPolicyViolation[] = [];
  for (const entry of journal.slice(baseline + 1)) {
    const source = await readFile(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    violations.push(...migrationPolicyViolationsForSource(entry.tag, source));
  }
  return violations;
}
