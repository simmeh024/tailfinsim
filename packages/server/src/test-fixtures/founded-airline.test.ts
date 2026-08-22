import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, cashMovement, player, world } from '../db/schema';

import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from './founded-airline';

const url = process.env.DATABASE_URL;
if (!url)
  console.warn(
    '\n  [test-fixtures/founded-airline.test] DATABASE_URL not set — skipping fixture tests.\n',
  );
const describeDb = url ? describe : describe.skip;

describeDb('the founded-airline test fixture', () => {
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

  it('creates a reachable airline with configured cash from a real movement', async () => {
    const created = await fixtures.create();
    const movements = await db.db
      .select()
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, created.airline.id));

    expect(created.world.status).toBe('open');
    expect(created.airline).toMatchObject({
      worldId: created.world.id,
      playerId: created.player.id,
    });
    expect(created.airline.cash).toBeGreaterThan(0);
    expect(created.hub).toMatchObject({
      airlineId: created.airline.id,
      airportIdent: created.hubAirport.ident,
      founderGrant: true,
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      airlineId: created.airline.id,
      amountMinor: created.airline.cash,
      cause: 'airline_founding',
      reference: created.airline.id,
      balanceAfterMinor: created.airline.cash,
    });
  });

  it('allocates different generated codes to two airlines in one world', async () => {
    const first = await fixtures.create();
    const second = await fixtures.create({
      worldId: first.world.id,
      hubIdent: first.hubAirport.ident,
    });

    expect(second.airline.iataCode).not.toBe(first.airline.iataCode);
    expect(second.airline.icaoCode).not.toBe(first.airline.icaoCode);
  });

  it('cleans only the identities it created', async () => {
    const first = await fixtures.create();
    const second = await fixtures.create({
      worldId: first.world.id,
      hubIdent: first.hubAirport.ident,
    });

    await second.cleanup();

    expect(await db.db.select().from(airline).where(eq(airline.id, second.airline.id))).toEqual([]);
    expect(await db.db.select().from(player).where(eq(player.id, second.player.id))).toEqual([]);
    expect(await db.db.select().from(airline).where(eq(airline.id, first.airline.id))).toHaveLength(
      1,
    );
    expect(await db.db.select().from(player).where(eq(player.id, first.player.id))).toHaveLength(1);
    expect(await db.db.select().from(world).where(eq(world.id, first.world.id))).toHaveLength(1);
    expect(
      await db.db.select().from(airport).where(eq(airport.id, first.hubAirport.id)),
    ).toHaveLength(1);
  });

  it('removes its complete graph with an idempotent cleanup', async () => {
    const created = await fixtures.create();
    await created.cleanup();
    await created.cleanup();

    expect(await db.db.select().from(airline).where(eq(airline.id, created.airline.id))).toEqual(
      [],
    );
    expect(await db.db.select().from(player).where(eq(player.id, created.player.id))).toEqual([]);
    expect(await db.db.select().from(world).where(eq(world.id, created.world.id))).toEqual([]);
    expect(await db.db.select().from(airport).where(eq(airport.id, created.hubAirport.id))).toEqual(
      [],
    );
  });
});
