import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AirportTier } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineHub, airport, cashMovement, ledgerEntry } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { listHubs, openHubFacility, purchaseHub, searchHubCandidates } from './hubs';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Hub purchase and facilities (M7-04, App. B.5).
 *
 * The three things worth proving over a real database rather than in the sim: the
 * curve is charged against **hubs owned across every tier**, the money moves
 * through AIR-06 exactly once, and a hub is concealed from everyone but its owner.
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [hub/hubs.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Minor units per $1M, at the 100-per-unit scale the config uses. */
const M = 100_000_000;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('hub purchase', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let seq = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  /** A playable airport of a given tier. Codes come from the serial allocator. */
  async function makeAirport(tier: AirportTier, slotLevel: number | null = null): Promise<string> {
    const n = seq++;
    const ident = `H${String(n).padStart(3, '0')}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_800_000 + n),
        ident,
        icaoCode: `KH${String(n).padStart(2, '0')}`,
        name: `Hub Test ${ident}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude: 12 + n * 0.01,
        longitude: -70 - n * 0.01,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        slotLevel,
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${ident}`);
    madeAirports.push(created.id);
    return ident;
  }

  /**
   * Top the airline up so the purchase under test is the constraint.
   *
   * Through AIR-06 rather than a direct `UPDATE`, because `airline.cash_minor` is
   * guarded by the `airline_cash_reconciles` trigger: a balance that does not
   * equal the sum of its movements is refused at the database. Writing the column
   * directly is not a shortcut here, it is an error.
   */
  async function fund(fixture: FoundedAirlineFixture, minor: number): Promise<void> {
    const current = await cashOf(fixture);
    if (minor === current) return;
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: minor - current,
        cause: 'admin_adjustment',
        reference: `hub-test-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  async function cashOf(fixture: FoundedAirlineFixture): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    return row?.cashMinor ?? 0;
  }

  it('counts the founder hub, so the next hub is the second on the curve', async () => {
    const a = await fixtures.create();
    const hubs = await listHubs(db.db, own(a));
    expect(hubs.hubs).toHaveLength(1);
    expect(hubs.hubs[0]?.founderGrant).toBe(true);
    expect(hubs.hubs[0]?.purchaseCostMinor).toBe(0);
    // hubsOwned = 1 → the "2nd" row of App. B.5's table.
    expect(hubs.nextHub).toMatchObject({
      hubsOwned: 1,
      small: 2 * M,
      medium: 5 * M,
      large: 10 * M,
      flagship: 25 * M,
    });
  });

  it('buys a hub, charges the quoted price and moves it through AIR-06 once', async () => {
    const a = await fixtures.create();
    await fund(a, 50 * M);
    const ident = await makeAirport('medium');

    const before = await cashOf(a);
    const result = await purchaseHub(db.db, own(a), {
      airportIdent: ident,
      expectedCostMinor: 5 * M,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.hubs.hubs).toHaveLength(2);
    expect(await cashOf(a)).toBe(before - 5 * M);

    const [hub] = await db.db
      .select({ id: airlineHub.id, tier: airlineHub.tier, cost: airlineHub.purchaseCostMinor })
      .from(airlineHub)
      .innerJoin(airport, eq(airport.id, airlineHub.airportId))
      .where(and(eq(airlineHub.airlineId, a.airline.id), eq(airport.ident, ident)));
    expect(hub?.tier).toBe('medium');
    expect(hub?.cost).toBe(5 * M);

    const movements = await db.db
      .select({ amountMinor: cashMovement.amountMinor, reference: cashMovement.reference })
      .from(cashMovement)
      .where(and(eq(cashMovement.airlineId, a.airline.id), eq(cashMovement.cause, 'hub_purchase')));
    expect(movements).toHaveLength(1);
    expect(movements[0]?.amountMinor).toBe(-5 * M);
    expect(movements[0]?.reference).toBe(hub?.id);

    // The ledger line carries the hub dimension, so M8-01 can group by it.
    const lines = await db.db
      .select({ category: ledgerEntry.category, hubId: ledgerEntry.hubId })
      .from(ledgerEntry)
      .where(
        and(eq(ledgerEntry.airlineId, a.airline.id), eq(ledgerEntry.category, 'hub_purchase')),
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.hubId).toBe(hub?.id);
  });

  it('doubles the price with every hub owned, whatever tier those hubs were', async () => {
    // App. B.5's whole strategic point, and the one thing the sim's pure test
    // cannot show: the multiplier counts hubs owned across tiers, not hubs of the
    // tier being bought. Founder hub + two smalls, then a flagship as hub 4.
    const a = await fixtures.create();
    await fund(a, 200 * M);

    const first = await makeAirport('small');
    const second = await makeAirport('small');
    expect(
      (await purchaseHub(db.db, own(a), { airportIdent: first, expectedCostMinor: 2 * M })).ok,
    ).toBe(true);
    expect(
      (await purchaseHub(db.db, own(a), { airportIdent: second, expectedCostMinor: 4 * M })).ok,
    ).toBe(true);

    const flagship = await makeAirport('flagship');
    const quoted = await listHubs(db.db, own(a));
    // Three hubs owned → the "4th" row: $100M for a flagship, not $25M.
    expect(quoted.nextHub.flagship).toBe(100 * M);

    const result = await purchaseHub(db.db, own(a), {
      airportIdent: flagship,
      expectedCostMinor: 100 * M,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a stale quote rather than charging the new price', async () => {
    const a = await fixtures.create();
    await fund(a, 100 * M);
    const first = await makeAirport('small');
    const second = await makeAirport('small');

    await purchaseHub(db.db, own(a), { airportIdent: first, expectedCostMinor: 2 * M });

    // The client still holds the $2M quote it was given before the first purchase.
    const before = await cashOf(a);
    const result = await purchaseHub(db.db, own(a), {
      airportIdent: second,
      expectedCostMinor: 2 * M,
    });
    expect(result).toEqual({ ok: false, problem: 'cost_changed' });
    // Refused writes change nothing — no hub, no money.
    expect(await cashOf(a)).toBe(before);
    expect((await listHubs(db.db, own(a))).hubs).toHaveLength(2);
  });

  it('refuses a purchase the airline cannot afford, and moves no money', async () => {
    const a = await fixtures.create();
    await fund(a, 1 * M);
    const ident = await makeAirport('flagship');

    const result = await purchaseHub(db.db, own(a), {
      airportIdent: ident,
      expectedCostMinor: 25 * M,
    });
    expect(result).toEqual({ ok: false, problem: 'insufficient_funds' });
    expect(await cashOf(a)).toBe(1 * M);
    expect((await listHubs(db.db, own(a))).hubs).toHaveLength(1);
  });

  it('refuses a second hub at an airport it already bases at', async () => {
    const a = await fixtures.create();
    await fund(a, 50 * M);
    const ident = await makeAirport('medium');
    await purchaseHub(db.db, own(a), { airportIdent: ident, expectedCostMinor: 5 * M });

    const result = await purchaseHub(db.db, own(a), {
      airportIdent: ident,
      expectedCostMinor: 10 * M,
    });
    expect(result).toEqual({ ok: false, problem: 'already_a_hub' });
  });

  it('refuses an airport with no scheduled service, and an unknown one', async () => {
    const a = await fixtures.create();
    await fund(a, 50 * M);
    const n = seq++;
    const [untiered] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_900_000 + n),
        ident: `U${String(n).padStart(3, '0')}`,
        name: 'Untiered strip',
        isoCountry: 'US',
        kind: 'small_airport',
        latitude: 30,
        longitude: -100 - n * 0.01,
        scheduledService: false,
        hasRunwayData: false,
        tier: null,
      })
      .returning({ id: airport.id, ident: airport.ident });
    if (!untiered) throw new Error('no untiered airport');
    madeAirports.push(untiered.id);

    expect(
      await purchaseHub(db.db, own(a), {
        airportIdent: untiered.ident,
        expectedCostMinor: 0,
      }),
    ).toEqual({ ok: false, problem: 'airport_not_playable' });

    expect(
      await purchaseHub(db.db, own(a), { airportIdent: 'ZZZZ', expectedCostMinor: 0 }),
    ).toEqual({ ok: false, problem: 'unknown_airport' });
  });

  it('prices a regional airport in the small band, the cheapest of the four', async () => {
    // B.3 classifies five tiers; App. B.5 prices four. Regional has no band of
    // its own and is sold at the cheapest one.
    const a = await fixtures.create();
    await fund(a, 50 * M);
    const ident = await makeAirport('regional');
    const candidates = await searchHubCandidates(db.db, own(a), ident);
    const found = candidates.airports.find((row) => row.ident === ident);
    expect(found?.airportTier).toBe('regional');
    expect(found?.tier).toBe('small');
    expect(found?.purchaseCostMinor).toBe(2 * M);
  });

  it('shows a flagship candidate its fee and its slot scarcity before confirming', async () => {
    // M7-04's third acceptance criterion. The free flagship is permitted; what
    // makes it a decision rather than a trap is that both halves of App. B.5's
    // self-balancing argument are on the object before anything is charged.
    const a = await fixtures.create();
    const ident = await makeAirport('flagship', 3);
    const candidates = await searchHubCandidates(db.db, own(a), ident);
    const found = candidates.airports.find((row) => row.ident === ident);

    expect(found?.tier).toBe('flagship');
    expect(found?.annualFeeMinor).toBe(0.5 * M);
    expect(found?.slots.coordinated).toBe(true);
    expect(found?.slots.slotLevel).toBe(3);
    expect(found?.slots.capacityPerBand).toBeGreaterThan(0);
  });

  it('reports no scarcity at an uncoordinated airport rather than a notional cap', async () => {
    const a = await fixtures.create();
    const ident = await makeAirport('medium', 1);
    const candidates = await searchHubCandidates(db.db, own(a), ident);
    const found = candidates.airports.find((row) => row.ident === ident);
    expect(found?.slots).toEqual({
      slotLevel: 1,
      coordinated: false,
      capacityPerBand: 0,
      bandsFull: 0,
    });
  });

  it('marks a candidate the airline already bases at', async () => {
    const a = await fixtures.create();
    const candidates = await searchHubCandidates(db.db, own(a), a.hubAirport.ident);
    const found = candidates.airports.find((row) => row.ident === a.hubAirport.ident);
    expect(found?.alreadyHeld).toBe(true);
  });

  it('keeps two airlines’ curves independent', async () => {
    const a = await fixtures.create();
    const b = await fixtures.create({ worldId: a.world.id });
    await fund(a, 100 * M);

    const ident = await makeAirport('small');
    await purchaseHub(db.db, own(a), { airportIdent: ident, expectedCostMinor: 2 * M });

    // A bought a second hub; B still has only its founder grant, so B's next hub
    // is still the second on the curve.
    expect((await listHubs(db.db, own(a))).nextHub.hubsOwned).toBe(2);
    expect((await listHubs(db.db, own(b))).nextHub.hubsOwned).toBe(1);
  });
});

describeDb('hub facilities', () => {
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

  async function fundedFounderHub(): Promise<{
    fixture: FoundedAirlineFixture;
    hubId: string;
  }> {
    const fixture = await fixtures.create();
    const [balance] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    // Through AIR-06: `airline_cash_reconciles` refuses a hand-written balance.
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 500 * M - (balance?.cashMinor ?? 0),
        cause: 'admin_adjustment',
        reference: `hub-facility-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
    const hubs = await listHubs(db.db, own(fixture));
    const hubId = hubs.hubs[0]?.id;
    if (hubId === undefined) throw new Error('fixture has no hub');
    return { fixture, hubId };
  }

  it('lists all five facilities on a hub with none open, each priced', async () => {
    const { fixture, hubId } = await fundedFounderHub();
    const hubs = await listHubs(db.db, own(fixture));
    const hub = hubs.hubs.find((row) => row.id === hubId);
    expect(hub?.facilities).toHaveLength(5);
    expect(hub?.facilities.every((f) => f.openedAt === null)).toBe(true);
    expect(hub?.facilities.every((f) => f.openingCostMinor > 0)).toBe(true);
    // A hub with nothing built still bills its own fee, and only that.
    expect(hub?.totalAnnualFeeMinor).toBe(hub?.annualFeeMinor);
  });

  it('opens a facility, charges it and adds its fee to the hub bill', async () => {
    const { fixture, hubId } = await fundedFounderHub();
    const before = await listHubs(db.db, own(fixture));
    const lounge = before.hubs[0]?.facilities.find((f) => f.kind === 'lounge');
    if (!lounge) throw new Error('no lounge quote');

    const result = await openHubFacility(db.db, own(fixture), hubId, {
      kind: 'lounge',
      expectedCostMinor: lounge.openingCostMinor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hub = result.hubs.hubs.find((row) => row.id === hubId);
    expect(hub?.facilities.find((f) => f.kind === 'lounge')?.openedAt).not.toBeNull();
    expect(hub?.facilities.find((f) => f.kind === 'lounge')?.blockedBy).toBe('already_open');
    expect(hub?.totalAnnualFeeMinor).toBe(
      (before.hubs[0]?.annualFeeMinor ?? 0) + lounge.annualFeeMinor,
    );

    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    expect(row?.cashMinor).toBe(500 * M - lounge.openingCostMinor);
  });

  it('refuses heavy check until the maintenance line is built — App. B.5’s own order', async () => {
    const { fixture, hubId } = await fundedFounderHub();
    const quote = (hubs: Awaited<ReturnType<typeof listHubs>>, kind: string) =>
      hubs.hubs[0]?.facilities.find((f) => f.kind === kind)?.openingCostMinor ?? 0;

    const before = await listHubs(db.db, own(fixture));
    expect(before.hubs[0]?.facilities.find((f) => f.kind === 'heavy_check')?.blockedBy).toBe(
      'requires_maintenance_line',
    );

    expect(
      await openHubFacility(db.db, own(fixture), hubId, {
        kind: 'heavy_check',
        expectedCostMinor: quote(before, 'heavy_check'),
      }),
    ).toEqual({ ok: false, problem: 'requires_maintenance_line' });

    await openHubFacility(db.db, own(fixture), hubId, {
      kind: 'maintenance_line',
      expectedCostMinor: quote(before, 'maintenance_line'),
    });
    const after = await listHubs(db.db, own(fixture));
    expect(after.hubs[0]?.facilities.find((f) => f.kind === 'heavy_check')?.blockedBy).toBeNull();

    const result = await openHubFacility(db.db, own(fixture), hubId, {
      kind: 'heavy_check',
      expectedCostMinor: quote(after, 'heavy_check'),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a facility that is already open', async () => {
    const { fixture, hubId } = await fundedFounderHub();
    const quoted =
      (await listHubs(db.db, own(fixture))).hubs[0]?.facilities.find((f) => f.kind === 'lounge')
        ?.openingCostMinor ?? 0;
    await openHubFacility(db.db, own(fixture), hubId, {
      kind: 'lounge',
      expectedCostMinor: quoted,
    });
    expect(
      await openHubFacility(db.db, own(fixture), hubId, {
        kind: 'lounge',
        expectedCostMinor: quoted,
      }),
    ).toEqual({ ok: false, problem: 'facility_already_open' });
  });

  it('conceals another owner’s hub behind the same refusal as an absent one', async () => {
    // ADR-0020: a cross-owner id and a nonexistent id run the identical
    // owner-scoped query and produce the identical answer.
    const a = await fixtures.create();
    const b = await fixtures.create({ worldId: a.world.id });
    const theirs = (await listHubs(db.db, own(b))).hubs[0]?.id;
    if (theirs === undefined) throw new Error('no hub for B');

    const crossOwner = await openHubFacility(db.db, own(a), theirs, {
      kind: 'lounge',
      expectedCostMinor: 0,
    });
    const absent = await openHubFacility(db.db, own(a), '00000000-0000-4000-8000-000000000000', {
      kind: 'lounge',
      expectedCostMinor: 0,
    });
    expect(crossOwner).toEqual({ ok: false, problem: 'unknown_hub' });
    expect(absent).toEqual(crossOwner);

    // And nothing was built on B's hub.
    const theirHub = (await listHubs(db.db, own(b))).hubs[0];
    expect(theirHub?.facilities.every((f) => f.openedAt === null)).toBe(true);
  });
});
