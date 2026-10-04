import { randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MaintenanceResponse } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airline, airport, cashMovement, ledgerEntry } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { worldGameNow } from '../world/game-now';

import { acquireAircraft } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';

/**
 * Booking a check over HTTP: what a refusal leaves behind (SURFACE-04).
 *
 * SURFACE-04 puts a "Book" button on the Fleet page, and its acceptance criterion
 * is that **a refused booking leaves the airframe, cash and ledger provably
 * unchanged**. The cross-owner refusals are `security/resource-id-tampering`'s;
 * these are the two a player meets with their *own* aircraft — already in a check,
 * and not enough money — and each is proved at the API boundary against the row,
 * the balance, the movements and the ledger lines together.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [aircraft/maintenance-routes.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('aircraft/maintenance-routes');

describeDb('booking a check over HTTP', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
    suite = await createOwnershipTestSuite({ db, env, suite: 'maintenance-routes' });
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    await db.close();
  });

  async function leasedAirframe(): Promise<string> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Maintenance Route Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);

    const fixture = suite.airlineA;
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 1_000_000_000,
        cause: 'admin_adjustment',
        reference: `maintenance-routes-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
    const acquired = await acquireAircraft(
      db.db,
      { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' },
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: identity.icaoCode,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) throw new Error('lease did not deliver');
    return acquired.airframe.id;
  }

  /** Everything a booking could touch: the aircraft, the purse, the movements, the ledger. */
  async function snapshot(airframeId: string) {
    const airlineId = suite.airlineA.airline.id;
    const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
    const [cash] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    const [movements] = await db.db
      .select({ n: count() })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    const [lines] = await db.db
      .select({ n: count() })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.airlineId, airlineId));
    return { airframe: row, cash: cash?.cashMinor, movements: movements?.n, lines: lines?.n };
  }

  function book(payload: Record<string, unknown>) {
    return suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'POST', url: '/api/fleet/maintenance/checks', payload },
    );
  }

  it('quotes every tier it would charge, on the read the planner draws', async () => {
    const id = await leasedAirframe();
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'GET', url: '/api/fleet/maintenance' },
    );
    expect(response.statusCode).toBe(200);
    const body = MaintenanceResponse.parse(response.json());
    const entry = body.airframes.find((row) => row.airframeId === id);
    // A lease that has never flown has no recorded history yet — and is read
    // as last checked at the hours it has now, not as overdue.
    expect(entry?.historyRecorded).toBe(false);
    expect(entry?.dueTiers).toEqual([]);
    for (const tier of entry?.tiers ?? []) {
      expect(tier.costMinor).toBeGreaterThan(0);
      expect(tier.downtimeDays).toBeGreaterThan(0);
    }
  });

  it('refuses a second check on an aircraft already in one, and changes nothing', async () => {
    const id = await leasedAirframe();
    const first = await book({ airframeId: id, tier: 'a' });
    expect(first.statusCode, first.body).toBe(201);

    const before = await snapshot(id);
    const second = await book({ airframeId: id, tier: 'c' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      code: 'airframe_already_in_check',
      message: 'That aircraft is already in a check',
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it('refuses a check the airline cannot afford, and changes nothing', async () => {
    const id = await leasedAirframe();
    const fixture = suite.airlineA;
    // Leave less than any check costs.
    const [current] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: -((current?.cashMinor ?? 0) - 100),
        cause: 'admin_adjustment',
        reference: `maintenance-routes-drain-${randomUUID()}`,
        occurredAt: gameNow,
      }),
    );

    const before = await snapshot(id);
    const refused = await book({ airframeId: id, tier: 'd' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      code: 'insufficient_funds',
      message: 'The airline cannot afford that check',
    });
    expect(await snapshot(id)).toEqual(before);
    expect(before.airframe?.status).toBe('in_service');
  });

  it('refuses a body carrying anything but an airframe and a tier, and changes nothing', async () => {
    const id = await leasedAirframe();
    const before = await snapshot(id);
    for (const payload of [
      { airframeId: id, tier: 'b' },
      { airframeId: id, tier: 'a', costMinor: 1 },
      { airframeId: id, tier: 'a', downtimeDays: 0 },
    ]) {
      const response = await book(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await snapshot(id)).toEqual(before);
  });
});
