import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { ledgerEntry } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { readProfitAndLoss } from './ledger';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ledger.test] DATABASE_URL not set — skipping finance tests.\n');
const describeDb = url ? describe : describe.skip;

describeDb('M8-01 ledger and P&L', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => fixtures.cleanup());
  afterAll(async () => db.close());

  it('stores attributable lines whose signed total is the cash movement', async () => {
    const fixture = await fixtures.create();
    const occurredAt = new Date('2024-10-20T12:00:00.000Z');

    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 7_000,
        cause: 'flight_settlement',
        reference: 'm8-01-ledger-flight',
        occurredAt,
        ledgerLines: [
          {
            amountMinor: 10_000,
            category: 'ticket',
            counterparty: 'passengers',
            flightId: '00000000-0000-0000-0000-000000000001',
            cabinClass: 'business',
          },
          { amountMinor: -3_000, category: 'fuel', counterparty: 'fuel_supplier' },
        ],
      }),
    );

    const rows = await db.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.airlineId, fixture.airline.id));
    expect(rows).toHaveLength(3);
    const settlementRows = rows.filter((row) => row.amountMinor !== fixture.airline.cash);
    expect(settlementRows.map((row) => row.amountMinor).sort((a, b) => a - b)).toEqual([
      -3_000, 10_000,
    ]);
    expect(settlementRows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(7_000);
  });

  /*
   * The guard nothing was asserting.
   *
   * `ledger_entry_immutable` has existed since 0042 and had no test, which only
   * became load-bearing when TIME-02's migration 0051 had to **drop and restore
   * it** to re-date the six wall-clock causes. A restore that silently did not
   * happen would leave the money ledger editable, and every other test in this
   * file would still pass.
   *
   * The constraint name is walked out of `error.cause` rather than matched
   * against the outer message: Drizzle wraps driver errors as
   * `Failed query: ...`, which any failure produces (CLAUDE.md).
   */
  it('keeps a recorded ledger line immutable', async () => {
    const fixture = await fixtures.create();

    // The founding movement already wrote its own line, so there is a real row
    // to attempt an UPDATE against -- an UPDATE matching nothing fires no
    // row-level trigger and would pass for the wrong reason.
    const [line] = await db.db
      .select({ id: ledgerEntry.id })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.airlineId, fixture.airline.id))
      .limit(1);
    if (!line) throw new Error('the founding movement wrote no ledger line');

    const error: unknown = await db.db
      .update(ledgerEntry)
      .set({ occurredAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(ledgerEntry.id, line.id))
      .then(
        () => null,
        (cause: unknown) => cause,
      );

    const reported: string[] = [];
    let current = error;
    while (current instanceof Error) {
      const name = (current as { constraint?: unknown }).constraint;
      if (typeof name === 'string') reported.push(name);
      current = current.cause;
    }
    expect(reported, `Postgres reported ${reported.join(', ') || 'no constraint'}`).toContain(
      'ledger_entry_immutable',
    );
  });

  it('returns revenue, cost and dimensional P&L totals', async () => {
    const fixture = await fixtures.create();
    const occurredAt = new Date('2024-10-20T12:00:00.000Z');

    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 7_000,
        cause: 'flight_settlement',
        reference: 'm8-01-pnl-flight',
        occurredAt,
        ledgerLines: [
          {
            amountMinor: 10_000,
            category: 'ticket',
            counterparty: 'passengers',
            routeId: '00000000-0000-0000-0000-000000000002',
            cabinClass: 'economy',
          },
          {
            amountMinor: -3_000,
            category: 'fuel',
            counterparty: 'fuel_supplier',
            routeId: '00000000-0000-0000-0000-000000000002',
          },
        ],
      }),
    );

    const report = await readProfitAndLoss(db.db, {
      airlineId: fixture.airline.id,
      from: new Date('2024-10-20T00:00:00.000Z'),
      to: new Date('2024-10-21T00:00:00.000Z'),
    });

    expect(report).toMatchObject({
      revenueMinor: 10_000,
      costMinor: 3_000,
      operatingProfitMinor: 7_000,
    });
    expect(report.lines).toEqual([
      { category: 'ticket', amountMinor: 10_000, entryCount: 1 },
      { category: 'fuel', amountMinor: 3_000, entryCount: 1 },
    ]);
    expect(report.byRoute).toContainEqual({
      key: '00000000-0000-0000-0000-000000000002',
      revenueMinor: 10_000,
      costMinor: 3_000,
      operatingProfitMinor: 7_000,
    });
    expect(report.byCabinClass).toContainEqual({
      key: 'economy',
      revenueMinor: 10_000,
      costMinor: 0,
      operatingProfitMinor: 10_000,
    });
  });
});
