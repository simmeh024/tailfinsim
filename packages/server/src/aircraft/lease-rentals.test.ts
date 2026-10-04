import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1, type AircraftAcquisitionInput } from '@tailfin/shared';

import { type ResolvedPlayerAirline } from '../airline/context';
import { previousMonth } from '../crew/payroll';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, cashMovement, ledgerEntry, usedAircraftListing } from '../db/schema';
import { readCashRunway } from '../finance/runway';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { acquireAircraft } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';
import {
  leaseRentalForMonth,
  leaseRentalLines,
  monthBounds,
  runLeaseRentals,
  type LeaseRentalLine,
} from './lease-rentals';

/**
 * §7.2's lease rent (OTHER-01).
 *
 * The acceptance criteria, end to end: a leased airframe is billed its monthly
 * rate on the world's game calendar, under `lease_finance`; owned airframes are
 * not; and the cash runway projects exactly the figure the sweep then charges.
 *
 * Every instant is derived from the world's own clock — game time can be decades
 * from the wall clock, and a literal date in a game-clock test has expired twice.
 */

const DAY_MS = 86_400_000;

describe('leaseRentalForMonth — prorated by the game time held', () => {
  const line = (deliveredAt: string, repossessedAt: string | null = null): LeaseRentalLine => ({
    airlineId: 'a',
    airframeId: 'f',
    registration: 'PH-TST',
    monthlyLeaseRateMinor: 3_000_000,
    deliveredAt: new Date(deliveredAt),
    repossessedAt: repossessedAt === null ? null : new Date(repossessedAt),
  });

  it('charges a whole month for an airframe held all month', () => {
    expect(leaseRentalForMonth(line('2031-01-15T00:00:00Z'), '2031-03')).toBe(3_000_000);
  });

  it('charges a delivery month only for the days after delivery', () => {
    // Delivered at the start of 21 April: ten of thirty days held.
    expect(leaseRentalForMonth(line('2031-04-21T00:00:00Z'), '2031-04')).toBe(1_000_000);
  });

  it('charges nothing for a month before delivery or after repossession', () => {
    expect(leaseRentalForMonth(line('2031-05-02T00:00:00Z'), '2031-04')).toBe(0);
    expect(
      leaseRentalForMonth(line('2031-01-01T00:00:00Z', '2031-03-31T00:00:00Z'), '2031-04'),
    ).toBe(0);
  });

  it('stops at repossession inside a month', () => {
    // Repossessed at the start of 11 April: ten days held.
    expect(
      leaseRentalForMonth(line('2031-01-01T00:00:00Z', '2031-04-11T00:00:00Z'), '2031-04'),
    ).toBe(1_000_000);
  });

  it('reads month bounds as [first, first of the next)', () => {
    const { start, end } = monthBounds('2031-12');
    expect(start.toISOString()).toBe('2031-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });
});

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [lease-rentals.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('aircraft/lease-rentals');

describeDb('lease rent against a real database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Lease Test Field ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'medium_airport',
      latitude: 52,
      longitude: 4,
      scheduledService: true,
      hasRunwayData: false,
      tier: 'medium',
      slotLevel: 2,
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function acquire(fixture: FoundedAirlineFixture, kind: 'lease' | 'used'): Promise<string> {
    const icao = await makeAirport();
    let input: AircraftAcquisitionInput;
    if (kind === 'lease') {
      input = {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: icao,
      };
    } else {
      // A used airframe is bought outright from a listing — owned, never rented.
      const atr = AIRCRAFT_CATALOGUE_V1.types.find((type) => type.designation === 'ATR 72-600');
      if (!atr) throw new Error('ATR 72-600 is missing from the catalogue');
      const [listing] = await db.db
        .insert(usedAircraftListing)
        .values({
          worldId: fixture.world.id,
          catalogueVersion: AIRCRAFT_CATALOGUE_V1.version,
          typeDesignation: atr.designation,
          registration: `PH-${randomUUID().slice(0, 3).toUpperCase()}`,
          buildOptionIds: '[]',
          cabinConfigId: randomUUID(),
          liveryId: randomUUID(),
          effectiveSpec: JSON.stringify(atr.baseSpec),
          ownerHistory: '[]',
          hours: 1_000,
          cycles: 800,
          askingPriceMinor: 10_000_000,
          locationIcao: icao,
        })
        .returning({ id: usedAircraftListing.id });
      if (!listing) throw new Error('Used listing was not created');
      input = { requestId: randomUUID(), kind: 'used', listingId: listing.id };
    }
    const acquired = await acquireAircraft(db.db, own(fixture), input, fixture.world.launchDate);
    if (!acquired.ok || acquired.airframe === null) throw new Error(`${kind} did not deliver`);
    return acquired.airframe.id;
  }

  async function rentalMovements(airlineId: string) {
    return db.db
      .select({
        id: cashMovement.id,
        amountMinor: cashMovement.amountMinor,
        reference: cashMovement.reference,
      })
      .from(cashMovement)
      .where(
        and(eq(cashMovement.airlineId, airlineId), eq(cashMovement.cause, 'aircraft_lease_rental')),
      );
  }

  it('bills a leased airframe its prorated month, once, under lease_finance', async () => {
    const fixture = await fixtures.create();
    const airframeId = await acquire(fixture, 'lease');
    const [line] = await leaseRentalLines(db.db, fixture.world.id, fixture.airline.id);
    if (!line) throw new Error('no lease line');
    expect(line.airframeId).toBe(airframeId);
    expect(line.monthlyLeaseRateMinor).toBeGreaterThan(0);

    // The first tick of the month after delivery bills the delivery month.
    const deliveryMonth = monthBounds(
      previousMonth(new Date(line.deliveredAt.getTime() + 40 * DAY_MS)),
    );
    const billedAt = new Date(deliveryMonth.end.getTime() + DAY_MS);
    const expected = leaseRentalForMonth(line, previousMonth(billedAt));
    expect(expected).toBeGreaterThan(0);

    const first = await runLeaseRentals(db.db, fixture.world.id, billedAt);
    expect(first.airlinesBilled).toBe(1);
    expect(first.totalMinor).toBe(expected);
    const movements = await rentalMovements(fixture.airline.id);
    expect(movements).toEqual([
      {
        id: expect.any(String) as string,
        amountMinor: -expected,
        reference: `aircraft_lease_rental:${fixture.airline.id}:${previousMonth(billedAt)}`,
      },
    ]);

    // One ledger line per airframe, as financing, dimensioned by the aeroplane.
    const ledger = await db.db
      .select({
        category: ledgerEntry.category,
        amountMinor: ledgerEntry.amountMinor,
        aircraftId: ledgerEntry.aircraftId,
      })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.cashMovementId, movements[0]!.id));
    expect(ledger).toEqual([
      { category: 'lease_finance', amountMinor: -expected, aircraftId: airframeId },
    ]);

    // Attempted every tick, billed once.
    const again = await runLeaseRentals(db.db, fixture.world.id, billedAt);
    expect(again.airlinesBilled).toBe(0);
    expect(await rentalMovements(fixture.airline.id)).toHaveLength(1);

    // And the next month is a whole month.
    const nextMonth = new Date(monthBounds(previousMonth(billedAt)).end.getTime() + 35 * DAY_MS);
    await runLeaseRentals(db.db, fixture.world.id, nextMonth);
    const amounts = (await rentalMovements(fixture.airline.id))
      .map((row) => row.amountMinor)
      .sort();
    expect(amounts).toContain(-line.monthlyLeaseRateMinor);
  });

  it('never bills an owned airframe a rental', async () => {
    const fixture = await fixtures.create();
    await acquire(fixture, 'used');
    expect(await leaseRentalLines(db.db, fixture.world.id, fixture.airline.id)).toEqual([]);
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const result = await runLeaseRentals(
      db.db,
      fixture.world.id,
      new Date(gameNow.getTime() + 60 * DAY_MS),
    );
    expect(result.airlinesBilled).toBe(0);
    expect(await rentalMovements(fixture.airline.id)).toEqual([]);
  });

  it('stops billing an airframe once it is repossessed', async () => {
    const fixture = await fixtures.create();
    const airframeId = await acquire(fixture, 'lease');
    const [line] = await leaseRentalLines(db.db, fixture.world.id, fixture.airline.id);
    if (!line) throw new Error('no lease line');
    // Repossessed before the month after delivery even begins.
    const afterDelivery = monthBounds(
      previousMonth(new Date(line.deliveredAt.getTime() + 40 * DAY_MS)),
    );
    await db.db
      .update(airframe)
      .set({ repossessedAt: afterDelivery.end })
      .where(eq(airframe.id, airframeId));

    const twoMonthsOn = new Date(afterDelivery.end.getTime() + 40 * DAY_MS);
    const result = await runLeaseRentals(db.db, fixture.world.id, twoMonthsOn);
    expect(result.airlinesBilled).toBe(0);
  });

  it('projects on the cash runway exactly what the sweep will charge', async () => {
    const fixture = await fixtures.create();
    await acquire(fixture, 'lease');
    const [line] = await leaseRentalLines(db.db, fixture.world.id, fixture.airline.id);
    if (!line) throw new Error('no lease line');

    const runway = await readCashRunway(db.db, own(fixture));
    const lease = runway.upcoming.find((commitment) => commitment.kind === 'lease');
    if (!lease) throw new Error('no lease commitment on the runway');
    // The commitment at a month boundary is the month that closes there, billed
    // by the very function the sweep uses.
    const period = previousMonth(new Date(lease.dueAt));
    expect(lease.amountMinor).toBe(leaseRentalForMonth(line, period));

    const charged = await runLeaseRentals(
      db.db,
      fixture.world.id,
      new Date(new Date(lease.dueAt).getTime() + DAY_MS),
    );
    expect(charged.totalMinor).toBe(lease.amountMinor);
  });
});
