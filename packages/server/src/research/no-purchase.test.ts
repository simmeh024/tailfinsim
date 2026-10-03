import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EconomyConfig, ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

/**
 * *"Research points cannot be purchased through any path"* — issue #92's fourth
 * acceptance criterion, and §10.3's *"You cannot buy RP."*
 *
 * A criterion with "any path" in it cannot be proved by testing the paths that
 * exist, because the failure is a path somebody adds later. So this proves it
 * against the **source**: the shape that makes a purchase impossible is a small
 * set of facts about which file may write what, and a change that breaks one of
 * them fails here rather than relying on a reviewer to notice.
 *
 *   1. Only `research/points.ts` names the `researchAccount` table, and only
 *      its settlement accrual ever raises `earned_milli`.
 *   2. That accrual is called from `flight/settle.ts` and nowhere else — points
 *      are earned by flying, with academies.
 *   3. No admin route, no cash code and no route under `/api/research` beyond
 *      the read and the start reaches either.
 *   4. The database CHECKs are the last line, and `store.test.ts` proves them
 *      against real Postgres.
 *
 * No database: this runs on every pull request.
 */

const SERVER_SRC = join(import.meta.dirname, '..');

/** Every non-test TypeScript file under `packages/server/src`, as a POSIX path relative to it. */
function sourceFiles(directory = SERVER_SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(relative(SERVER_SRC, path).split(sep).join('/'));
    }
  }
  return files.sort();
}

function read(file: string): string {
  return readFileSync(join(SERVER_SRC, file), 'utf8');
}

/** Code with comments removed, so prose about a rule cannot trip the rule. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The text of one exported function, from its declaration to the next one. */
function exportedFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`export (async )?function ${name}\\b`));
  if (start < 0) throw new Error(`no exported function ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next < 0 ? rest : rest.slice(0, next);
}

const FILES = sourceFiles();

describe('research points cannot be purchased through any path (issue #92, §10.3)', () => {
  it('finds the server source at all', () => {
    // Guards the guard: an empty file list would make every assertion below pass.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES).toContain('research/points.ts');
    expect(FILES).toContain('flight/settle.ts');
  });

  it('lets only research/points.ts touch the research_account table', () => {
    const touching = FILES.filter((file) => /\bresearchAccount\b/.test(code(file)));
    expect(touching).toEqual(['db/schema.ts', 'research/points.ts']);

    // And nothing reaches it around drizzle with raw SQL.
    const raw = FILES.filter((file) =>
      /(insert\s+into|update)\s+"?research_account/i.test(code(file)),
    );
    expect(raw).toEqual([]);
  });

  it('raises earned_milli in the settlement accrual and nowhere else', () => {
    const points = code('research/points.ts');
    // The two writers in the file, and what each may write.
    const accrue = exportedFunction(points, 'accrueResearchPoints');
    const debit = exportedFunction(points, 'debitResearchPoints');
    expect(accrue).toMatch(/\.insert\(researchAccount\)/);
    expect(accrue).toMatch(/earnedMilli: sql`\$\{researchAccount\.earnedMilli\} \+/);
    expect(debit).toMatch(/\.update\(researchAccount\)/);
    expect(debit).not.toMatch(/earnedMilli/);

    // Every write to the table is inside one of those two functions.
    const writes = points.match(/\.(insert|update)\(researchAccount\)/g) ?? [];
    expect(writes).toHaveLength(2);

    // And the file that owns the points has no business with money.
    expect(points).not.toMatch(/moveAirlineCash|cashMovement|cash_minor|cashMinor/);
  });

  it('calls the accrual from flight settlement and from nothing else', () => {
    const callers = FILES.filter(
      (file) => file !== 'research/points.ts' && /\baccrueResearchPoints\(/.test(code(file)),
    );
    expect(callers).toEqual(['flight/settle.ts']);
  });

  it('gives no admin route or console a way to grant points', () => {
    const admin = FILES.filter((file) => file.startsWith('admin/') || file === 'admin-cli.ts');
    expect(admin.length).toBeGreaterThan(0);
    for (const file of admin) {
      expect(code(file), file).not.toMatch(
        /research\/points|researchAccount|accrueResearchPoints|debitResearchPoints|earnedMilli/,
      );
    }
  });

  it('registers no research route beyond the read and the start', async () => {
    const research = (await collectRegisteredRoutes())
      .filter((route) => route.url.includes('research'))
      .map((route) => route.key)
      .sort();
    expect(research).toEqual(['GET /api/research', 'POST /api/research/projects']);
  });

  it('has no balance field that could turn money or time into points', () => {
    // The economy is the other place a lever could hide: a "points per cash"
    // rate or a rush multiplier would be a purchase path a retune could switch
    // on. The schema refuses any field beyond the formula and the node terms.
    const withLever = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as {
      research: Record<string, unknown>;
    };
    withLever.research.pointsPerCashMinor = 0.001;
    expect(EconomyConfig.safeParse(withLever).success).toBe(false);

    const withRush = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as {
      research: { nodes: Record<string, Record<string, unknown>> };
    };
    withRush.research.nodes.cost_index_sop!.rushCostMinor = 1;
    expect(EconomyConfig.safeParse(withRush).success).toBe(false);
  });
});
