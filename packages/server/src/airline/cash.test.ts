import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, cashMovement } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { moveAirlineCash, reconcileAirlineCash } from './cash';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [cash.test] DATABASE_URL not set — skipping cash movement tests.\n');
const describeDb = url ? describe : describe.skip;

async function expectConstraint(promise: PromiseLike<unknown>, constraint: string): Promise<void> {
  const error: unknown = await Promise.resolve(promise).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error, 'expected the write to be refused, but it succeeded').toBeDefined();

  const reported: string[] = [];
  let current = error;
  while (current instanceof Error) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === 'string') reported.push(name);
    current = current.cause;
  }
  expect(reported, `Postgres reported ${reported.join(', ') || 'no constraint'}`).toContain(
    constraint,
  );
}

describeDb('cash movements', () => {
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

  async function makeAirline(): Promise<{ airlineId: string; openingCashMinor: number }> {
    const created = await fixtures.create();
    return { airlineId: created.airline.id, openingCashMinor: created.airline.cash };
  }

  const occurredAt = new Date('2024-10-20T12:00:00.000Z');

  it('records amount, cause, reference and resulting balance together', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();
    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      airlineId,
      amountMinor: openingCashMinor,
      cause: 'airline_founding',
      reference: airlineId,
      balanceAfterMinor: openingCashMinor,
    });
    expect(await reconcileAirlineCash(db.db, airlineId)).toEqual({
      airlineId,
      balanceMinor: openingCashMinor,
      movementTotalMinor: openingCashMinor,
      reconciles: true,
    });
  });

  it('replaying a cause moves the balance once', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();
    const input = {
      airlineId,
      amountMinor: 12_345,
      cause: 'flight_settlement' as const,
      reference: 'flight-replay-1',
      occurredAt,
    };

    const first = await db.db.transaction((tx) => moveAirlineCash(tx, input));
    const second = await db.db.transaction((tx) => moveAirlineCash(tx, input));

    expect(first.status).toBe('applied');
    expect(second.status).toBe('already-applied');
    expect(await reconcileAirlineCash(db.db, airlineId)).toMatchObject({
      balanceMinor: openingCashMinor + 12_345,
      movementTotalMinor: openingCashMinor + 12_345,
      reconciles: true,
    });
    const rows = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.reference, input.reference));
    expect(rows).toHaveLength(1);
  });

  it('enforces cause idempotency by the named database constraint', async () => {
    const { airlineId } = await makeAirline();
    const input = {
      airlineId,
      amountMinor: 1_000,
      cause: 'flight_settlement' as const,
      reference: 'flight-constraint-1',
      occurredAt,
    };
    const applied = await db.db.transaction((tx) => moveAirlineCash(tx, input));

    await expectConstraint(
      db.db.insert(cashMovement).values({
        ...input,
        balanceAfterMinor: applied.movement.balanceAfterMinor,
      }),
      'cash_movement_cause_reference_key',
    );
  });

  it('refuses a direct balance update that has no explaining movement', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();

    await expectConstraint(
      db.db.transaction(async (tx) => {
        await tx.update(airline).set({ cashMinor: 500 }).where(eq(airline.id, airlineId));
      }),
      'airline_cash_reconciles',
    );
    expect(await reconcileAirlineCash(db.db, airlineId)).toMatchObject({
      balanceMinor: openingCashMinor,
      movementTotalMinor: openingCashMinor,
      reconciles: true,
    });
  });

  it('keeps a recorded movement immutable', async () => {
    const { airlineId } = await makeAirline();
    const applied = await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: 1_000,
        cause: 'flight_settlement',
        reference: 'flight-immutable',
        occurredAt,
      }),
    );

    await expectConstraint(
      db.db
        .update(cashMovement)
        .set({ amountMinor: 2_000 })
        .where(eq(cashMovement.id, applied.movement.id)),
      'cash_movement_immutable',
    );
  });

  it('serialises different causes so concurrent updates cannot lose money', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();

    const results = await Promise.all([
      db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId,
          amountMinor: 25_000,
          cause: 'flight_settlement',
          reference: 'flight-concurrent-a',
          occurredAt,
        }),
      ),
      db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId,
          amountMinor: -7_500,
          cause: 'flight_settlement',
          reference: 'flight-concurrent-b',
          occurredAt,
        }),
      ),
    ]);

    expect(results.every((result) => result.status === 'applied')).toBe(true);
    expect(await reconcileAirlineCash(db.db, airlineId)).toEqual({
      airlineId,
      balanceMinor: openingCashMinor + 17_500,
      movementTotalMinor: openingCashMinor + 17_500,
      reconciles: true,
    });
  });

  it('rolls the movement and balance back when the surrounding cause fails', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();
    class CauseFailed extends Error {}

    await expect(
      db.db.transaction(async (tx) => {
        await moveAirlineCash(tx, {
          airlineId,
          amountMinor: 99_000,
          cause: 'flight_settlement',
          reference: 'flight-rolled-back',
          occurredAt,
        });
        throw new CauseFailed('the cause failed after moving cash');
      }),
    ).rejects.toThrow(CauseFailed);

    expect(await reconcileAirlineCash(db.db, airlineId)).toEqual({
      airlineId,
      balanceMinor: openingCashMinor,
      movementTotalMinor: openingCashMinor,
      reconciles: true,
    });
  });

  it('refuses a replay that changes the facts behind the same cause', async () => {
    const { airlineId, openingCashMinor } = await makeAirline();
    const base = {
      airlineId,
      cause: 'flight_settlement' as const,
      reference: 'flight-changed-facts',
      occurredAt,
    };
    await db.db.transaction((tx) => moveAirlineCash(tx, { ...base, amountMinor: 1_000 }));

    await expect(
      db.db.transaction((tx) => moveAirlineCash(tx, { ...base, amountMinor: 2_000 })),
    ).rejects.toThrow(/different facts/);
    expect(await reconcileAirlineCash(db.db, airlineId)).toMatchObject({
      balanceMinor: openingCashMinor + 1_000,
      movementTotalMinor: openingCashMinor + 1_000,
      reconciles: true,
    });
  });

  it('refuses unsafe arithmetic before a movement can be stored', async () => {
    const { airlineId } = await makeAirline();
    await expect(
      db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId,
          amountMinor: Number.MAX_SAFE_INTEGER + 1,
          cause: 'flight_settlement',
          reference: 'flight-unsafe',
          occurredAt,
        }),
      ),
    ).rejects.toThrow(/safe integer/);
  });
});
