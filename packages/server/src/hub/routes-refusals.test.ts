import { randomUUID } from 'node:crypto';

import { asc, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HubCandidateListResponse, HubsResponse, type AirportTier } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airlineHub, airport, cashMovement, hubFacility, ledgerEntry } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { worldGameNow } from '../world/game-now';

import type { InjectOptions } from 'fastify';

/**
 * Buying a hub and building a facility over HTTP: what a refusal leaves behind
 * (SURFACE-09).
 *
 * SURFACE-09 puts a Buy and a Build button on the Network page, and its
 * acceptance criterion is that **a refused purchase leaves cash, ledger and hubs
 * provably unchanged**. `hubs.test.ts` proves the domain function's refusals
 * against the balance and the hub count; this proves every refusal code the page
 * surfaces at the API boundary — status, body, and the airline's hubs,
 * facilities, balance, cash movements and ledger lines together. The cross-owner
 * hub id is `security/resource-id-tampering`'s.
 *
 * It also proves the page's two load-bearing assumptions: the quote the page
 * shows is the figure the server charges, and a write answers with the same
 * whole state a fresh read returns, so the page can render the answer rather than
 * re-fetch.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [hub/routes-refusals.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('hub/routes-refusals');

describeDb('hub purchases and facilities over HTTP', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'hub-routes-refusals' });
  });

  afterAll(async () => {
    // The airline first: its hubs hold the airports below with `restrict`.
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    await db.close();
  });

  /** A playable airport, or with `tier: null` one with no scheduled service. */
  async function makeAirport(tier: AirportTier | null): Promise<string> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Hub Route Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: tier === null ? 'small_airport' : 'medium_airport',
        latitude: 51.5,
        longitude: 5,
        scheduledService: tier !== null,
        hasRunwayData: false,
        tier,
        slotLevel: tier === null ? null : 2,
      })
      .returning({ id: airport.id, ident: airport.ident });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return created.ident;
  }

  function as(request: InjectOptions) {
    return suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request);
  }

  /** Set the airline's balance through AIR-06, as `airline_cash_reconciles` requires. */
  async function setCash(minor: number): Promise<void> {
    const airlineId = suite.airlineA.airline.id;
    const [current] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    const delta = minor - (current?.cashMinor ?? 0);
    if (delta === 0) return;
    const occurredAt = await worldGameNow(db.db, suite.worldMain.id);
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: delta,
        cause: 'admin_adjustment',
        reference: `hub-routes-refusals-${randomUUID()}`,
        occurredAt,
      }),
    );
  }

  /** Everything a purchase or a build could touch. */
  async function snapshot() {
    const airlineId = suite.airlineA.airline.id;
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
    const hubs = await db.db
      .select()
      .from(airlineHub)
      .where(eq(airlineHub.airlineId, airlineId))
      .orderBy(asc(airlineHub.id));
    const facilities =
      hubs.length === 0
        ? []
        : await db.db
            .select()
            .from(hubFacility)
            .where(
              inArray(
                hubFacility.hubId,
                hubs.map((row) => row.id),
              ),
            )
            .orderBy(asc(hubFacility.id));
    return { cash: cash?.cashMinor, movements: movements?.n, lines: lines?.n, hubs, facilities };
  }

  async function quote(ident: string) {
    const response = await as({
      method: 'GET',
      url: `/api/hubs/candidates?query=${encodeURIComponent(ident)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const found = HubCandidateListResponse.parse(response.json()).airports.find(
      (row) => row.ident === ident,
    );
    if (!found) throw new Error(`no candidate ${ident}`);
    return found;
  }

  async function readHubs() {
    const response = await as({ method: 'GET', url: '/api/hubs' });
    expect(response.statusCode, response.body).toBe(200);
    return HubsResponse.parse(response.json());
  }

  function buy(payload: Record<string, unknown>) {
    return as({ method: 'POST', url: '/api/hubs', payload });
  }

  function build(hubId: string, payload: Record<string, unknown>) {
    return as({ method: 'POST', url: `/api/hubs/${hubId}/facilities`, payload });
  }

  async function founderHubId(): Promise<string> {
    const held = await readHubs();
    const founder = held.hubs.find((row) => row.founderGrant);
    if (!founder) throw new Error('no founder hub');
    return founder.id;
  }

  it('charges exactly the quoted price, and answers with the state a fresh read returns', async () => {
    const ident = await makeAirport('medium');
    const quoted = await quote(ident);
    expect(quoted.purchaseCostMinor).toBeGreaterThan(0);
    await setCash(quoted.purchaseCostMinor * 3);
    const before = await snapshot();

    const bought = await buy({ airportIdent: ident, expectedCostMinor: quoted.purchaseCostMinor });
    expect(bought.statusCode, bought.body).toBe(200);
    const body = HubsResponse.parse(bought.json());
    expect(body.hubs.find((row) => row.airportIdent === ident)?.purchaseCostMinor).toBe(
      quoted.purchaseCostMinor,
    );
    // The whole state: the page renders this and does not re-read.
    expect(body).toEqual(await readHubs());

    const after = await snapshot();
    expect(after.cash).toBe((before.cash ?? 0) - quoted.purchaseCostMinor);
    expect(after.hubs).toHaveLength(before.hubs.length + 1);
  });

  it('refuses a purchase it cannot afford, and changes nothing', async () => {
    const ident = await makeAirport('medium');
    const quoted = await quote(ident);
    await setCash(quoted.purchaseCostMinor - 1);
    const before = await snapshot();

    const refused = await buy({ airportIdent: ident, expectedCostMinor: quoted.purchaseCostMinor });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      code: 'insufficient_funds',
      message: 'Not enough cash for that purchase',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a stale quote rather than charging the new price, and changes nothing', async () => {
    const ident = await makeAirport('medium');
    const quoted = await quote(ident);
    await setCash(quoted.purchaseCostMinor * 10);
    const before = await snapshot();

    // The figure a tab quoted before this airline's previous purchase.
    const refused = await buy({
      airportIdent: ident,
      expectedCostMinor: quoted.purchaseCostMinor - 1,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'hub_cost_changed' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a second hub at an airport it already holds, and changes nothing', async () => {
    await setCash(10_000_000_000);
    const before = await snapshot();
    const refused = await buy({
      airportIdent: suite.airlineA.hubAirport.ident,
      expectedCostMinor: 0,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: 'already_a_hub',
      message: 'This airline already has a hub at that airport',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an airport with no scheduled service, and an unknown one, changing nothing', async () => {
    const untiered = await makeAirport(null);
    await setCash(10_000_000_000);
    const before = await snapshot();

    const notPlayable = await buy({ airportIdent: untiered, expectedCostMinor: 0 });
    expect(notPlayable.statusCode).toBe(422);
    expect(notPlayable.json()).toMatchObject({ code: 'airport_not_playable' });

    const unknown = await buy({ airportIdent: 'NO-SUCH-FIELD', expectedCostMinor: 0 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: 'not_found', message: 'No such airport' });

    expect(await snapshot()).toEqual(before);
  });

  it('refuses heavy check before the maintenance line, and changes nothing', async () => {
    const hubId = await founderHubId();
    await setCash(10_000_000_000);
    const heavy = (await readHubs()).hubs
      .find((row) => row.id === hubId)
      ?.facilities.find((row) => row.kind === 'heavy_check');
    expect(heavy?.blockedBy).toBe('requires_maintenance_line');
    const before = await snapshot();

    const refused = await build(hubId, {
      kind: 'heavy_check',
      expectedCostMinor: heavy?.openingCostMinor ?? 0,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'requires_maintenance_line' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a facility it cannot afford, or at a stale price, and changes nothing', async () => {
    const hubId = await founderHubId();
    const lounge = (await readHubs()).hubs
      .find((row) => row.id === hubId)
      ?.facilities.find((row) => row.kind === 'lounge');
    if (lounge === undefined) throw new Error('no lounge on the founder hub');
    expect(lounge.openedAt).toBeNull();

    await setCash(lounge.openingCostMinor - 1);
    let before = await snapshot();
    const unaffordable = await build(hubId, {
      kind: 'lounge',
      expectedCostMinor: lounge.openingCostMinor,
    });
    expect(unaffordable.statusCode).toBe(422);
    expect(unaffordable.json()).toMatchObject({ code: 'insufficient_funds' });
    expect(await snapshot()).toEqual(before);

    await setCash(lounge.openingCostMinor * 10);
    before = await snapshot();
    const stale = await build(hubId, {
      kind: 'lounge',
      expectedCostMinor: lounge.openingCostMinor + 1,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'hub_cost_changed' });
    expect(await snapshot()).toEqual(before);
  });

  it('builds a facility once, then refuses it again and changes nothing', async () => {
    const hubId = await founderHubId();
    const line = (await readHubs()).hubs
      .find((row) => row.id === hubId)
      ?.facilities.find((row) => row.kind === 'maintenance_line');
    if (line === undefined) throw new Error('no maintenance line on the founder hub');
    expect(line.openedAt).toBeNull();
    await setCash(line.openingCostMinor * 10);

    const first = await build(hubId, {
      kind: 'maintenance_line',
      expectedCostMinor: line.openingCostMinor,
    });
    expect(first.statusCode, first.body).toBe(200);
    const answered = HubsResponse.parse(first.json());
    const hub = answered.hubs.find((row) => row.id === hubId);
    expect(hub?.facilities.find((row) => row.kind === 'maintenance_line')?.openedAt).not.toBeNull();
    // The server, not the page, says heavy check is now buildable.
    expect(hub?.facilities.find((row) => row.kind === 'heavy_check')?.blockedBy).toBeNull();
    expect(answered).toEqual(await readHubs());

    const before = await snapshot();
    const again = await build(hubId, {
      kind: 'maintenance_line',
      expectedCostMinor: line.openingCostMinor,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      code: 'facility_already_open',
      message: 'That facility is already open at this hub',
    });
    expect(await snapshot()).toEqual(before);
  });
});
