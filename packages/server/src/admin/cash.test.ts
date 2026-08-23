import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { reconcileAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, airline, cashMovement } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { adjustAirlineCash } from './cash';
import { BOOTSTRAP_ACTOR } from './grants';

/**
 * Operator cash adjustments (AIR-06, §22).
 *
 * The point of this path is that it is **not** a back door into the balance: it
 * goes through the same movement, cause, reference and reconciliation as a lease
 * deposit, and leaves an audit row saying who and why. These tests are mostly
 * about proving that, rather than that a number went up.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [admin/cash.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('operator cash adjustments', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    await db.close();
  });

  async function cashOf(airlineId: string): Promise<number> {
    const rows = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return rows[0]?.cashMinor ?? 0;
  }

  it('moves money through AIR-06, and the ledger still reconciles', async () => {
    const fixture = await fixtures.create();
    const before = await cashOf(fixture.airline.id);

    const result = await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
      airlineId: fixture.airline.id,
      amountMinor: 5_000_000_000,
      reason: 'testing M5-02',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.balanceAfterMinor).toBe(before + 5_000_000_000);
    expect(await cashOf(fixture.airline.id)).toBe(before + 5_000_000_000);

    // The whole reason this is not a direct UPDATE: the movement log folds to
    // the materialised balance, and that has to keep being true.
    const reconciliation = await reconcileAirlineCash(db.db, fixture.airline.id);
    expect(reconciliation?.reconciles).toBe(true);
  });

  it('records its own cause, never borrowing another', async () => {
    const fixture = await fixtures.create();
    await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
      airlineId: fixture.airline.id,
      amountMinor: 1_000,
      reason: 'why',
    });

    const causes = await db.db
      .select({ cause: cashMovement.cause })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, fixture.airline.id));
    // A grant filed as a flight settlement is a lie nobody can later untangle
    // from the real ones.
    expect(causes.map((row) => row.cause)).toContain('admin_adjustment');
    expect(causes.filter((row) => row.cause === 'flight_settlement')).toHaveLength(0);
  });

  it('writes an audit row carrying the reason', async () => {
    const fixture = await fixtures.create();
    await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
      airlineId: fixture.airline.id,
      amountMinor: 250_000,
      reason: 'compensating a bug',
    });

    const rows = await db.db
      .select({ action: adminAudit.action, after: adminAudit.after })
      .from(adminAudit)
      .where(eq(adminAudit.subjectId, fixture.airline.id));
    const entry = rows.find((row) => row.action === 'airline.cash_adjusted');
    expect(entry).toBeDefined();
    // The why is the only part that cannot be reconstructed from the ledger.
    expect(entry?.after).toContain('compensating a bug');
  });

  it('refuses to take an airline below zero', async () => {
    const fixture = await fixtures.create();
    const before = await cashOf(fixture.airline.id);

    const result = await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
      airlineId: fixture.airline.id,
      amountMinor: -(before + 1),
      reason: 'clawing back too much',
    });

    expect(result).toEqual({ ok: false, code: 'would_overdraw' });
    // And it rolled back: no movement, no audit row, balance untouched. AIR-11
    // removed the zero-cash state and an operator typo must not restore it.
    expect(await cashOf(fixture.airline.id)).toBe(before);
    const movements = await db.db
      .select({ cause: cashMovement.cause })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, fixture.airline.id));
    expect(movements.filter((row) => row.cause === 'admin_adjustment')).toHaveLength(0);
  });

  it('refuses an unknown airline and a zero amount', async () => {
    expect(
      await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
        airlineId: '00000000-0000-4000-8000-0000000000ff',
        amountMinor: 100,
        reason: 'nobody',
      }),
    ).toEqual({ ok: false, code: 'airline_not_found' });

    const fixture = await fixtures.create();
    expect(
      await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
        airlineId: fixture.airline.id,
        amountMinor: 0,
        reason: 'nothing',
      }),
    ).toEqual({ ok: false, code: 'zero_amount' });
  });
});
