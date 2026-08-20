import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, cashMovement, player, world } from '../db/schema';
import { createWorld } from '../world/lifecycle';

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
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    if (madeWorlds.length > 0) {
      await db.db.delete(world).where(inArray(world.id, madeWorlds.splice(0)));
    }
    if (madePlayers.length > 0) {
      await db.db.delete(player).where(inArray(player.id, madePlayers.splice(0)));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirline(): Promise<string> {
    const n = sequence++;
    const createdWorld = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `cash-world-${String(n)}`,
    });
    madeWorlds.push(createdWorld.world.id);

    const players = await db.db
      .insert(player)
      .values({ displayName: `cash-player-${String(n)}` })
      .returning({ id: player.id });
    const playerId = players[0]?.id;
    if (!playerId) throw new Error('no player created');
    madePlayers.push(playerId);

    const airlines = await db.db
      .insert(airline)
      .values({
        worldId: createdWorld.world.id,
        playerId,
        name: `Cash Air ${String(n)}`,
        iataCode: String(n % 100).padStart(2, '0'),
        icaoCode: `C${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(
          65 + (Math.floor(n / 26) % 26),
        )}`,
        callsign: `CASH ${String(n)}`,
        baseCountry: 'NL',
      })
      .returning({ id: airline.id });
    const airlineId = airlines[0]?.id;
    if (!airlineId) throw new Error('no airline created');
    return airlineId;
  }

  const occurredAt = new Date('2024-10-20T12:00:00.000Z');

  it('records amount, cause, reference and resulting balance together', async () => {
    const airlineId = await makeAirline();
    const result = await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: 50_000_000,
        cause: 'airline_founding',
        reference: airlineId,
        occurredAt,
      }),
    );

    expect(result.status).toBe('applied');
    expect(result.movement).toMatchObject({
      airlineId,
      amountMinor: 50_000_000,
      cause: 'airline_founding',
      reference: airlineId,
      balanceAfterMinor: 50_000_000,
      occurredAt,
    });
    expect(await reconcileAirlineCash(db.db, airlineId)).toEqual({
      airlineId,
      balanceMinor: 50_000_000,
      movementTotalMinor: 50_000_000,
      reconciles: true,
    });
  });

  it('replaying a cause moves the balance once', async () => {
    const airlineId = await makeAirline();
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
      balanceMinor: 12_345,
      movementTotalMinor: 12_345,
      reconciles: true,
    });
    const rows = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.reference, input.reference));
    expect(rows).toHaveLength(1);
  });

  it('enforces cause idempotency by the named database constraint', async () => {
    const airlineId = await makeAirline();
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
    const airlineId = await makeAirline();

    await expectConstraint(
      db.db.transaction(async (tx) => {
        await tx.update(airline).set({ cashMinor: 500 }).where(eq(airline.id, airlineId));
      }),
      'airline_cash_reconciles',
    );
    expect(await reconcileAirlineCash(db.db, airlineId)).toMatchObject({
      balanceMinor: 0,
      movementTotalMinor: 0,
      reconciles: true,
    });
  });

  it('keeps a recorded movement immutable', async () => {
    const airlineId = await makeAirline();
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
    const airlineId = await makeAirline();

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
      balanceMinor: 17_500,
      movementTotalMinor: 17_500,
      reconciles: true,
    });
  });

  it('rolls the movement and balance back when the surrounding cause fails', async () => {
    const airlineId = await makeAirline();
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
      balanceMinor: 0,
      movementTotalMinor: 0,
      reconciles: true,
    });
  });

  it('refuses a replay that changes the facts behind the same cause', async () => {
    const airlineId = await makeAirline();
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
      balanceMinor: 1_000,
      movementTotalMinor: 1_000,
      reconciles: true,
    });
  });

  it('refuses unsafe arithmetic before a movement can be stored', async () => {
    const airlineId = await makeAirline();
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
