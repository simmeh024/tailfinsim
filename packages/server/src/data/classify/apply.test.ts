import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../db/client';
import { airport } from '../../db/schema';

import { B3_NAMED_FLAGSHIPS, checkDistribution, classifyAirports } from './apply';
import { type AirportTier } from './tier';

/**
 * The classifier over the real imported dataset.
 *
 * This is the acceptance criterion in test form, and it only means anything
 * against the actual 86,000 airports — so it skips unless the database has been
 * imported. CI's database is migrated but empty, so these skip there too; the
 * rules themselves are covered without a database in `tier.test.ts`.
 *
 * Run against a box that has had `data:airports` applied:
 *   DATABASE_URL=... pnpm vitest run packages/server/src/data/classify
 */

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('classifyAirports over the imported dataset', () => {
  let db: DatabaseHandle;
  let imported = 0;

  beforeAll(async () => {
    db = createDatabase();
    const rows = await db.db.select({ n: sql<number>`count(*)::int` }).from(airport);
    imported = rows[0]?.n ?? 0;
    if (imported < 50_000) {
      console.warn(
        `\n  [apply.test] only ${String(imported)} airports present — ` +
          'run data:airports first. Distribution assertions will skip.\n',
      );
    }
  });

  afterAll(async () => {
    await db.close();
  });

  const itImported = () => (imported >= 50_000 ? it : it.skip);

  itImported()(
    'lands every tier inside App. B.3 20% band',
    async () => {
      const result = await classifyAirports(db.db, { log: () => undefined });
      for (const check of result.distribution) {
        expect(
          check.passed,
          `${check.tier}: ${String(check.actual)} outside ${String(check.min)}–${String(check.max)}`,
        ).toBe(true);
      }
    },
    120_000,
  );

  itImported()(
    'puts every airport B.3 names as flagship in the flagship tier',
    async () => {
      const result = await classifyAirports(db.db, { log: () => undefined });
      const wrong = result.namedFlagships.filter((f) => f.tier !== 'flagship');
      expect(wrong, `not flagship: ${wrong.map((f) => f.iata).join(', ')}`).toEqual([]);
      expect(result.namedFlagships).toHaveLength(B3_NAMED_FLAGSHIPS.length);
    },
    120_000,
  );

  itImported()(
    'is reproducible — a second run changes nothing',
    async () => {
      // "Classification is reproducible from a single script" (M1-02). A rerun
      // that drifted would mean the rules depend on something other than the
      // data, which is the thing that makes a classification untrustworthy.
      const first = await classifyAirports(db.db, { log: () => undefined });
      const second = await classifyAirports(db.db, { log: () => undefined });
      expect(second.counts).toEqual(first.counts);
      expect(second.untiered).toBe(first.untiered);
    },
    180_000,
  );

  itImported()(
    'gives a tier to every scheduled-service airport and to no other',
    async () => {
      await classifyAirports(db.db, { log: () => undefined });

      const mismatched = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(airport)
        .where(
          sql`(${airport.scheduledService} AND ${airport.kind} <> 'closed' AND ${airport.tier} IS NULL)
              OR (NOT ${airport.scheduledService} AND ${airport.tier} IS NOT NULL)`,
        );
      expect(mismatched[0]?.n).toBe(0);
    },
    120_000,
  );

  itImported()(
    'writes an audit trail for every classified airport',
    async () => {
      await classifyAirports(db.db, { log: () => undefined });

      const rows = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(airport)
        .where(sql`${airport.tier} IS NOT NULL AND ${airport.tierBasis} IS NULL`);
      expect(rows[0]?.n).toBe(0);
    },
    120_000,
  );
});

describe('checkDistribution', () => {
  const counts = (over: Partial<Record<AirportTier, number>> = {}) => ({
    flagship: 25,
    large: 120,
    medium: 500,
    small: 1_200,
    regional: 2_200,
    ...over,
  });

  it('passes on the exact B.3 targets', () => {
    expect(checkDistribution(counts()).every((c) => c.passed)).toBe(true);
  });

  it('allows 20% either side', () => {
    expect(
      checkDistribution(counts({ flagship: 30 })).find((c) => c.tier === 'flagship')?.passed,
    ).toBe(true);
    expect(
      checkDistribution(counts({ flagship: 20 })).find((c) => c.tier === 'flagship')?.passed,
    ).toBe(true);
  });

  it('fails beyond 20%', () => {
    expect(
      checkDistribution(counts({ flagship: 40 })).find((c) => c.tier === 'flagship')?.passed,
    ).toBe(false);
    expect(
      checkDistribution(counts({ regional: 100 })).find((c) => c.tier === 'regional')?.passed,
    ).toBe(false);
  });

  it('reports every tier, not only the failures', () => {
    expect(checkDistribution(counts({ medium: 0 }))).toHaveLength(5);
  });
});
