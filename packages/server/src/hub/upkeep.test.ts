import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineHub, cashMovement, hubFacility, ledgerEntry } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { listHubs } from './hubs';
import { billHubUpkeep } from './upkeep';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * App. B.5's monthly hub fee (M7-04).
 *
 * The property that matters most is not the arithmetic — the sim proves that —
 * but that this can be called on **every tick** and bills exactly once, replaying
 * identical facts each time. `crew/payroll.ts` shipped without that and failed
 * once a second on dev from the moment it deployed, with a test that passed
 * because all three of its calls shared one instant. So the replay here is
 * deliberately made at *different* instants inside the following month.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [hub/upkeep.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const M = 100_000_000;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('hub upkeep billing', () => {
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

  /** Backdate the founder hub so it was held before the month being billed. */
  async function openHubAt(fixture: FoundedAirlineFixture, openedAt: Date): Promise<string> {
    const [row] = await db.db
      .update(airlineHub)
      .set({ openedAt })
      .where(eq(airlineHub.airlineId, fixture.airline.id))
      .returning({ id: airlineHub.id });
    if (!row) throw new Error('no hub to backdate');
    return row.id;
  }

  async function cashOf(fixture: FoundedAirlineFixture): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    return row?.cashMinor ?? 0;
  }

  async function movements(fixture: FoundedAirlineFixture) {
    return db.db
      .select({
        amountMinor: cashMovement.amountMinor,
        reference: cashMovement.reference,
        occurredAt: cashMovement.occurredAt,
      })
      .from(cashMovement)
      .where(
        and(eq(cashMovement.airlineId, fixture.airline.id), eq(cashMovement.cause, 'hub_upkeep')),
      );
  }

  it('bills a twelfth of the hub’s annual fee for the month that has just ended', async () => {
    const a = await fixtures.create();
    await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));
    const expected = (await listHubs(db.db, own(a))).hubs[0];
    if (!expected) throw new Error('no hub');

    const before = await cashOf(a);
    const result = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T09:00:00.000Z'));

    expect(result.airlinesBilled).toBe(1);
    expect(result.totalMinor).toBe(Math.round(expected.totalAnnualFeeMinor / 12));
    expect(await cashOf(a)).toBe(before - result.totalMinor);

    const rows = await movements(a);
    expect(rows).toHaveLength(1);
    // Dated at the instant February closed, not at the instant the tick ran.
    expect(rows[0]?.occurredAt.toISOString()).toBe('2025-03-01T00:00:00.000Z');
    expect(rows[0]?.reference).toBe(`${a.airline.id}:2025-02`);
  });

  it('bills once however many times the tick calls it, at different instants', async () => {
    // The `crew/payroll.ts` failure, reproduced deliberately: three calls at three
    // different moments inside the following month. AIR-06's replay guard asserts
    // identical facts, so a run that recomputed `occurredAt` or re-read a changed
    // amount would throw here rather than no-op.
    const a = await fixtures.create();
    await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));

    const first = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-01T00:00:01.000Z'));
    const afterFirst = await cashOf(a);
    const second = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-14T13:37:00.000Z'));
    const third = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-31T23:59:59.000Z'));

    expect(first.airlinesBilled).toBe(1);
    expect(second.airlinesBilled).toBe(0);
    expect(third.airlinesBilled).toBe(0);
    expect(await cashOf(a)).toBe(afterFirst);
    expect(await movements(a)).toHaveLength(1);
  });

  it('bills each month separately, so a later month is a new charge', async () => {
    const a = await fixtures.create();
    await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));

    await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));
    const afterFebruary = await cashOf(a);
    const march = await billHubUpkeep(db.db, a.world.id, new Date('2025-04-02T00:00:00.000Z'));

    expect(march.airlinesBilled).toBe(1);
    expect(await cashOf(a)).toBeLessThan(afterFebruary);
    const rows = await movements(a);
    expect(rows.map((r) => r.reference).sort()).toEqual([
      `${a.airline.id}:2025-02`,
      `${a.airline.id}:2025-03`,
    ]);
  });

  it('gives a hub opened during the billed month a grace month', async () => {
    // Billing a hub for the month it opened would make the amount depend on when
    // in the following month the tick happened to run — the instability the
    // already-billed lookup exists to avoid. One grace month is the trade.
    const a = await fixtures.create();
    await openHubAt(a, new Date('2025-02-14T00:00:00.000Z'));

    expect(
      (await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'))).airlinesBilled,
    ).toBe(0);
    // The month after it opened is billed normally.
    expect(
      (await billHubUpkeep(db.db, a.world.id, new Date('2025-04-04T00:00:00.000Z'))).airlinesBilled,
    ).toBe(1);
  });

  it('adds an open facility’s pinned fee to the bill', async () => {
    const a = await fixtures.create();
    const hubId = await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));
    const bare = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));

    await db.db.insert(hubFacility).values({
      hubId,
      kind: 'lounge',
      openingCostMinor: 1 * M,
      annualFeeMinor: 12 * M,
      openedAt: new Date('2025-01-20T00:00:00.000Z'),
    });

    const withLounge = await billHubUpkeep(db.db, a.world.id, new Date('2025-04-04T00:00:00.000Z'));
    // The facility's own row says $12M a year, so exactly $1M more a month.
    expect(withLounge.totalMinor).toBe(bare.totalMinor + 1 * M);
  });

  it('ignores a facility opened after the billed month began', async () => {
    const a = await fixtures.create();
    const hubId = await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));
    await db.db.insert(hubFacility).values({
      hubId,
      kind: 'lounge',
      openingCostMinor: 1 * M,
      annualFeeMinor: 12 * M,
      openedAt: new Date('2025-02-20T00:00:00.000Z'),
    });

    const bare = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));
    const [hub] = await db.db
      .select({ id: airlineHub.id })
      .from(airlineHub)
      .where(eq(airlineHub.id, hubId));
    expect(hub).toBeDefined();
    // February's bill is the hub alone; the lounge starts contributing in March.
    const hubOnly = (await listHubs(db.db, own(a))).hubs[0]?.annualFeeMinor ?? 0;
    expect(bare.totalMinor).toBe(Math.round(hubOnly / 12));
  });

  it('writes an operating ledger line, not a capital one', async () => {
    // The fee is what a hub costs to *run*, so it belongs in the P&L. The
    // purchase does not, and they must not share a category.
    const a = await fixtures.create();
    await openHubAt(a, new Date('2025-01-10T00:00:00.000Z'));
    await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));

    const lines = await db.db
      .select({ category: ledgerEntry.category, amountMinor: ledgerEntry.amountMinor })
      .from(ledgerEntry)
      .where(
        and(eq(ledgerEntry.airlineId, a.airline.id), eq(ledgerEntry.category, 'hub_facility')),
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.amountMinor).toBeLessThan(0);
  });

  it('bills every airline in the world, and only that world', async () => {
    const a = await fixtures.create();
    const b = await fixtures.create({ worldId: a.world.id });
    const elsewhere = await fixtures.create();
    for (const fixture of [a, b, elsewhere]) {
      await openHubAt(fixture, new Date('2025-01-10T00:00:00.000Z'));
    }

    const result = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));
    expect(result.airlinesBilled).toBe(2);
    expect(await movements(elsewhere)).toHaveLength(0);
  });

  it('bills a hub whose tier predates M7-04 at its airport’s current tier', async () => {
    // A null `tier` means the hub was granted before the column existed. It is
    // read at the airport's tier rather than skipped — a free hub would be a
    // worse answer than an approximate one.
    const a = await fixtures.create();
    await db.db
      .update(airlineHub)
      .set({ tier: null, openedAt: new Date('2025-01-10T00:00:00.000Z') })
      .where(eq(airlineHub.airlineId, a.airline.id));

    const result = await billHubUpkeep(db.db, a.world.id, new Date('2025-03-04T00:00:00.000Z'));
    expect(result.airlinesBilled).toBe(1);
    expect(result.totalMinor).toBeGreaterThan(0);
  });
});
