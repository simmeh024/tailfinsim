import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { findCashDrift, moveAirlineCash } from './cash';

/**
 * Finding an airline whose balance is not its ledger (M11-36).
 *
 * AIR-06's promise is that `airline.cash_minor` **is** the sum of that airline's
 * movements. Two `CONSTRAINT TRIGGER`s enforce it — `airline_cash_reconciles` on
 * every insert and update of `airline`, and `cash_movement_reconciles` on every
 * insert and delete of a movement — both deferred to commit.
 *
 * So the honest answer is that **nothing which commits can produce drift**. That
 * is the whole reason this check is cheap to run and almost always silent: what
 * it catches is state that arrived without a statement, from a restore, a data
 * migration, or a `COPY` during an incident.
 *
 * Which makes the drifting case awkward to test, and the awkwardness is
 * load-bearing rather than incidental — see `withDriftedCash`.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [airline/cash-drift.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('finding cash drift', () => {
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

  it('says nothing when every airline reconciles', async () => {
    const a = await fixtures.create();
    const drift = await findCashDrift(db.db);
    expect(drift.find((d) => d.airlineId === a.airline.id)).toBeUndefined();
  });

  it('stays silent through ordinary money movement', async () => {
    // The point is that the application cannot break this. Move cash the way
    // everything in the game moves cash, then look again.
    const a = await fixtures.create();
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: a.airline.id,
        amountMinor: -1_234_500,
        cause: 'admin_adjustment',
        reference: `ordinary:${randomUUID()}`,
        occurredAt: new Date(),
      }),
    );

    expect((await findCashDrift(db.db)).find((d) => d.airlineId === a.airline.id)).toBeUndefined();
  });

  /**
   * What Postgres actually said, not what Drizzle wrapped it in.
   *
   * Drizzle's outer message is always `Failed query: ...`, so asserting on it
   * passes for any failure at all — the trap CLAUDE.md records. This walks
   * `error.cause` for the real one.
   */
  async function refusalFrom(promise: Promise<unknown>): Promise<string> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught, 'expected the write to be refused, but it succeeded').toBeDefined();
    const messages: string[] = [];
    let current: unknown = caught;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    return messages.join(' | ');
  }

  it('refuses a balance change with no movement behind it', async () => {
    // Stated as a test because it is the reason the check is almost always
    // silent, and because a future migration that weakened the trigger would
    // otherwise make `findCashDrift` quietly pointless rather than loudly wrong.
    const a = await fixtures.create();
    const refusal = await refusalFrom(
      db.db
        .update(airline)
        .set({ cashMinor: a.airline.cash + 1 })
        .where(eq(airline.id, a.airline.id)),
    );
    expect(refusal).toMatch(/does not equal movement total/);
  });

  /**
   * Run `body` against a database where one airline's balance has been moved
   * without a movement, then undo all of it.
   *
   * The constraint triggers are switched off inside the transaction and the
   * whole thing is rolled back, so nothing is ever committed and the triggers
   * are restored by the rollback rather than by remembering to re-enable them.
   * `ALTER TABLE ... DISABLE TRIGGER` takes an exclusive lock on `airline`, so
   * this is deliberately one short transaction in one test rather than the shape
   * of every case in the file.
   */
  async function withDriftedCash(
    airlineId: string,
    byMinor: number,
    body: (tx: Parameters<Parameters<typeof db.db.transaction>[0]>[0]) => Promise<void>,
  ): Promise<void> {
    class Rollback extends Error {}
    try {
      await db.db.transaction(async (tx) => {
        await tx.execute(sql`alter table "airline" disable trigger "airline_cash_reconciles"`);
        await tx
          .update(airline)
          .set({ cashMinor: sql`${airline.cashMinor} + ${byMinor}` })
          .where(eq(airline.id, airlineId));
        await body(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  it('names the airline, the world and the size of the difference', async () => {
    const drifting = await fixtures.create();
    const honest = await fixtures.create({ worldId: drifting.world.id });

    await withDriftedCash(drifting.airline.id, 500_000, async (tx) => {
      const drift = await findCashDrift(tx);
      const mine = drift.find((d) => d.airlineId === drifting.airline.id);

      expect(mine).toBeDefined();
      expect(mine?.airlineName).toBe(drifting.airline.name);
      expect(mine?.worldId).toBe(drifting.world.id);
      expect(mine?.balanceMinor).toBe(drifting.airline.cash + 500_000);
      expect(mine?.movementTotalMinor).toBe(drifting.airline.cash);
      // Signed, so the direction is readable: positive means the airline holds
      // money nothing explains.
      expect(mine?.differenceMinor).toBe(500_000);

      // And an airline beside it, in the same world, is not swept up.
      expect(drift.find((d) => d.airlineId === honest.airline.id)).toBeUndefined();
    });

    // Rolled back: the drift was never committed and the check is silent again.
    expect(
      (await findCashDrift(db.db)).find((d) => d.airlineId === drifting.airline.id),
    ).toBeUndefined();
  });

  it('costs one query whatever the airline count', async () => {
    // It runs on every Overview load, so it has to be one query rather than one
    // per airline — the shape CLAUDE.md records as the one that goes wrong, and
    // the one BUG-07 had to undo on the ground alert endpoint.
    const pool = db.pool as unknown as { query: (...args: unknown[]) => unknown };
    const original = pool.query.bind(pool);

    async function countQueries(run: () => Promise<unknown>): Promise<number> {
      let count = 0;
      pool.query = (...args: unknown[]) => {
        count += 1;
        return original(...args);
      };
      try {
        await run();
      } finally {
        pool.query = original;
      }
      return count;
    }

    const first = await fixtures.create();
    const withOne = await countQueries(() => findCashDrift(db.db));

    for (let i = 0; i < 5; i += 1) await fixtures.create({ worldId: first.world.id });
    const withSix = await countQueries(() => findCashDrift(db.db));

    expect(withOne).toBe(1);
    expect(withSix).toBe(withOne);
  });
});
