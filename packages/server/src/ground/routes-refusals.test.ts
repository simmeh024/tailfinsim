import { randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GroundStationResponse } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  airline,
  airport,
  cashMovement,
  groundContract,
  groundSelfHandling,
  ledgerEntry,
} from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { worldGameNow } from '../world/game-now';

import { signContract } from './contracts';

/**
 * Ground handling's writes over HTTP: what a refusal leaves behind (SURFACE-05).
 *
 * SURFACE-05 puts Sign, End and Handle-it-yourself buttons on the Network page's
 * Ground view, and its acceptance criterion is that **a refused signing leaves
 * cash, ledger and contract state provably unchanged**. The cross-owner
 * refusals are `security/resource-id-tampering`'s; these are the ones a player
 * meets at their own stations — a full vendor, a grade the station does not
 * offer, a contract they cannot afford to break — each proved at the API
 * boundary against the contracts, the balance, the movements and the ledger.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ground/routes-refusals.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('ground/routes-refusals');

describeDb('ground handling refusals over HTTP', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  let rivals: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'ground-refusals' });
    rivals = createFoundedAirlineFixtureHarness(db.db);
  });

  afterAll(async () => {
    await rivals.cleanup();
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    await db.close();
  });

  async function makeStation(tier: 'medium' | 'regional'): Promise<string> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Ground Refusal Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return identity.icaoCode;
  }

  /** Everything a ground write could touch for playerA. */
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
    const contracts = await db.db
      .select()
      .from(groundContract)
      .where(eq(groundContract.airlineId, airlineId));
    const operations = await db.db
      .select()
      .from(groundSelfHandling)
      .where(eq(groundSelfHandling.airlineId, airlineId));
    return {
      cash: cash?.cashMinor,
      movements: movements?.n,
      lines: lines?.n,
      contracts,
      operations,
    };
  }

  function asA(method: 'GET' | 'POST' | 'DELETE', path: string, payload?: Record<string, unknown>) {
    return suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method, url: path, ...(payload === undefined ? {} : { payload }) },
    );
  }

  it('refuses a full vendor as a market fact, and changes nothing', async () => {
    const icao = await makeStation('medium');
    const read = await asA('GET', `/api/ground/${icao}`);
    expect(read.statusCode).toBe(200);
    const station = GroundStationResponse.parse(read.json());
    const premium = station.lines
      .find((line) => line.serviceLine === 'ramp_baggage')
      ?.offers.find((offer) => offer.grade === 'premium');
    if (premium === undefined) throw new Error('a medium station offers a premium ramp handler');

    // Rivals in the same world take every premium slot.
    for (let i = 0; i < premium.capacity; i += 1) {
      const rival = await rivals.create({ worldId: suite.worldMain.id });
      const signed = await signContract(
        db.db,
        { id: rival.airline.id, worldId: rival.world.id, status: 'active' },
        icao,
        { serviceLine: 'ramp_baggage', grade: 'premium' },
      );
      expect(signed.ok).toBe(true);
    }

    const before = await snapshot();
    const refused = await asA('POST', `/api/ground/${icao}/contracts`, {
      serviceLine: 'ramp_baggage',
      grade: 'premium',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      code: 'capacity_exhausted',
      message: 'That handler is full — every contract slot is taken',
    });
    expect(await snapshot()).toEqual(before);

    // And the station says so: the slot count, not an error.
    const after = GroundStationResponse.parse((await asA('GET', `/api/ground/${icao}`)).json());
    const full = after.lines
      .find((line) => line.serviceLine === 'ramp_baggage')
      ?.offers.find((offer) => offer.grade === 'premium');
    expect(full?.taken).toBe(full?.capacity);
  });

  it('refuses a grade the station does not offer, and changes nothing', async () => {
    const icao = await makeStation('regional');
    const before = await snapshot();
    const refused = await asA('POST', `/api/ground/${icao}/contracts`, {
      serviceLine: 'ramp_baggage',
      grade: 'premium',
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'grade_not_offered' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to replace or end a contract the airline cannot afford to break, and changes nothing', async () => {
    const icao = await makeStation('medium');
    const signed = await asA('POST', `/api/ground/${icao}/contracts`, {
      serviceLine: 'cleaning',
      grade: 'standard',
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const contract = GroundStationResponse.parse(signed.json()).lines.find(
      (line) => line.serviceLine === 'cleaning',
    )?.contracted;
    if (!contract) throw new Error('no contract signed');
    expect(contract.earlyTerminationPenaltyMinor).toBeGreaterThan(0);

    // Leave less than the break fee.
    const [current] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, suite.airlineA.airline.id));
    await db.db.transaction(async (tx) =>
      moveAirlineCash(tx, {
        airlineId: suite.airlineA.airline.id,
        amountMinor: -((current?.cashMinor ?? 0) - 1),
        cause: 'admin_adjustment',
        reference: `ground-refusals-drain-${randomUUID()}`,
        occurredAt: await worldGameNow(tx, suite.worldMain.id),
      }),
    );

    const before = await snapshot();
    const replace = await asA('POST', `/api/ground/${icao}/contracts`, {
      serviceLine: 'cleaning',
      grade: 'budget',
    });
    expect(replace.statusCode).toBe(422);
    expect(replace.json()).toMatchObject({ code: 'insufficient_funds' });
    expect(await snapshot()).toEqual(before);

    const end = await asA('DELETE', `/api/ground/contracts/${contract.id}`);
    expect(end.statusCode).toBe(422);
    expect(end.json()).toMatchObject({ code: 'insufficient_funds' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a request carrying anything but the line and the choice, and changes nothing', async () => {
    const icao = await makeStation('medium');
    const before = await snapshot();
    for (const [path, payload] of [
      [
        `/api/ground/${icao}/contracts`,
        { serviceLine: 'cleaning', grade: 'standard', penaltyMinor: 0 },
      ],
      [`/api/ground/${icao}/contracts`, { serviceLine: 'cleaning', grade: 'gold' }],
      [`/api/ground/${icao}/self-handling`, { serviceLine: 'cleaning', headcount: 0 }],
      [
        `/api/ground/${icao}/self-handling`,
        { serviceLine: 'cleaning', headcount: 3, salaryPerHeadMinor: 1 },
      ],
    ] as const) {
      const response = await asA('POST', path, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });
});
