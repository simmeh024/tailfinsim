import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { claimSlot, readAirportSlots, releaseSlot, resolveLegSlots } from './slots';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('network/slots-db');

/**
 * Holding and resolving airport slots over HTTP-shaped state (M7-05).
 *
 * Proves the owner-scoped claim/release, the per-band capacity, and the resolver
 * `resolveLegSlots` — the value schedule authoring feeds `context.slots`. The
 * refusal that value drives (`no_slot`) is proved in `@tailfin/sim`'s rotation
 * test, and the pure rules in `slots.test.ts`; this covers the database half.
 * Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/slots-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

const BAND = 8; // the 08:00 band

describeDb('airport slots', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
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

  async function makeAirport(
    slotLevel: number | null,
    tier: string | null,
    utcOffsetMinutes: number | null = null,
  ): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: `SLOT-${icao}`,
      icaoCode: icao,
      name: `Slot Field ${icao}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
      slotLevel,
      // The column is the airport_tier enum; the fixture only ever passes real values.
      tier: tier as 'flagship' | 'large' | 'medium' | 'small' | 'regional' | null,
      utcOffsetMinutes,
    });
    madeAirports.push(icao);
    return icao;
  }

  it('reads an uncoordinated airport as free — no bands to hold', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(null, 'regional');
    const slots = await readAirportSlots(db.db, own(a), icao);
    expect(slots?.coordinated).toBe(false);
    expect(slots?.bands).toEqual([]);
  });

  it('returns null for an airport that does not exist', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    expect(await readAirportSlots(db.db, own(a), 'ZZZZ')).toBeNull();
  });

  it('lays out 24 bands at a coordinated airport, capacity by tier', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'flagship');
    const slots = await readAirportSlots(db.db, own(a), icao);
    expect(slots?.coordinated).toBe(true);
    expect(slots?.bands).toHaveLength(24);
    const band = slots?.bands[BAND];
    expect(band).toMatchObject({
      band: BAND,
      capacity: 8,
      held: 0,
      heldByYou: false,
      available: 8,
    });
  });

  it('claims a band, idempotently, and shows it held', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'large');

    const first = await claimSlot(db.db, own(a), icao, BAND);
    expect(first.ok).toBe(true);
    // Claiming again is a success, not a second row.
    const second = await claimSlot(db.db, own(a), icao, BAND);
    expect(second.ok).toBe(true);

    const slots = await readAirportSlots(db.db, own(a), icao);
    const band = slots?.bands[BAND];
    expect(band).toMatchObject({ held: 1, heldByYou: true, available: 4 }); // large cap 5
  });

  it('refuses a claim at an uncoordinated airport and for an impossible band', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const free = await makeAirport(1, 'small');
    expect(await claimSlot(db.db, own(a), free, BAND)).toMatchObject({
      ok: false,
      problem: 'not_coordinated',
    });
    const coord = await makeAirport(3, 'large');
    expect(await claimSlot(db.db, own(a), coord, 24)).toMatchObject({
      ok: false,
      problem: 'invalid_band',
    });
    expect(await claimSlot(db.db, own(a), 'ZZZZ', BAND)).toMatchObject({
      ok: false,
      problem: 'unknown_airport',
    });
  });

  it('refuses a full band, then lets a claim through once one is released', async () => {
    // A Level-3 airport whose tier gives the default capacity of 4.
    const icao = await makeAirport(3, 'medium');
    const a = await fixtures.create({ baseCountry: 'GB' });
    const others = [] as FoundedAirlineFixture[];
    for (let i = 0; i < 4; i += 1) {
      const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
      others.push(b);
      expect((await claimSlot(db.db, own(b), icao, BAND)).ok).toBe(true);
    }

    // The band is now full: four holders at capacity four.
    expect(await claimSlot(db.db, own(a), icao, BAND)).toMatchObject({
      ok: false,
      problem: 'band_full',
    });

    // Free one and the waiting airline gets in.
    await releaseSlot(db.db, own(others[0]!), icao, BAND);
    expect((await claimSlot(db.db, own(a), icao, BAND)).ok).toBe(true);
  });

  it('releases a band, idempotently', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'flagship');
    await claimSlot(db.db, own(a), icao, BAND);

    const released = await releaseSlot(db.db, own(a), icao, BAND);
    expect(released.ok).toBe(true);
    const slots = await readAirportSlots(db.db, own(a), icao);
    expect(slots?.bands[BAND]?.heldByYou).toBe(false);

    // Releasing one you do not hold is a no-op success, not an error.
    expect((await releaseSlot(db.db, own(a), icao, BAND)).ok).toBe(true);
  });

  it('resolves leg slots: coordinated needs a holding, everything else is free', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const coord = await makeAirport(3, 'large');
    const free = await makeAirport(null, 'regional');
    const dest = await makeAirport(3, 'large'); // a destination is never slot-checked

    const legs = [
      { originIcao: coord, departureMinute: BAND * 60 + 15 }, // 08:15 → band 8
      { originIcao: free, departureMinute: 9 * 60 }, // uncoordinated → always fine
      { originIcao: dest, departureMinute: 10 * 60 }, // band 10, not held
    ];

    // Nothing held: only the uncoordinated leg passes.
    expect(await resolveLegSlots(db.db, own(a), legs)).toEqual([false, true, false]);

    // Hold the two coordinated origins' bands and every leg passes.
    await claimSlot(db.db, own(a), coord, 8);
    await claimSlot(db.db, own(a), dest, 10);
    expect(await resolveLegSlots(db.db, own(a), legs)).toEqual([true, true, true]);

    // Another airline's holdings do not count for you.
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    expect(await resolveLegSlots(db.db, own(b), legs)).toEqual([false, true, false]);
  });

  it('matches a leg to its slot by the origin’s LOCAL band, not the stored absolute one', async () => {
    // The airport sits at UTC+2. A slot is claimed for the local 08:00 band; a leg
    // whose *stored* (absolute) departure is 06:00 UTC is an 08:00 local departure
    // and must match that slot (M3-04a).
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'large', 120); // UTC+2
    await claimSlot(db.db, own(a), icao, 8); // claim the local 08:00 band

    const local0800 = [{ originIcao: icao, departureMinute: 6 * 60 }]; // 06:00 UTC = 08:00 local
    expect(await resolveLegSlots(db.db, own(a), local0800)).toEqual([true]);

    // A leg stored at 08:00 UTC is the local 10:00 band, which is not held.
    const local1000 = [{ originIcao: icao, departureMinute: 8 * 60 }];
    expect(await resolveLegSlots(db.db, own(a), local1000)).toEqual([false]);
  });
});
