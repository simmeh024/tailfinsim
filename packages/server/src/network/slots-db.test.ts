import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, world } from '../db/schema';
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

const BAND = 8; // the 08:00 band — peak, and therefore the tightest of the day
const OFF_PEAK_BAND = 3; // 03:00 — App. B.5's "you get 05:40 and 23:10"

/** Real milliseconds in a day, for ageing a world's launch date. */
const DAY_MS = 86_400_000;

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

  /**
   * Make a world read as `gameDays` old, so a release wave has landed.
   *
   * A world's age is `gameNow − epoch`, and `gameNow` is
   * `epoch + speed × (realNow − launchDate)` — so a freshly created fixture is
   * always about zero days old whatever epoch it was given. Backdating
   * `launch_date` is the only way to age one, and it is the fixture's own world.
   */
  async function ageWorld(fixture: FoundedAirlineFixture, gameDays: number): Promise<void> {
    const speed = Number(fixture.world.speedMultiplier);
    const realMs = (gameDays / speed) * DAY_MS;
    await db.db
      .update(world)
      .set({ launchDate: new Date(Date.now() - realMs) })
      .where(eq(world.id, fixture.world.id));
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

  it('lays out 24 bands at a coordinated airport, shaped by hour', async () => {
    // Capacity is no longer flat across the day (M7-05): a flagship's base of 8
    // is halved at peak and nearly doubled overnight, which is what makes App.
    // B.5's "you get 05:40 and 23:10" true rather than aspirational.
    const a = await fixtures.create({ baseCountry: 'GB' });
    await ageWorld(a, 90); // fully released, so this is about shape alone
    const icao = await makeAirport(3, 'flagship');
    const slots = await readAirportSlots(db.db, own(a), icao);
    expect(slots?.coordinated).toBe(true);
    expect(slots?.bands).toHaveLength(24);

    expect(slots?.bands[BAND]).toMatchObject({
      band: BAND,
      shape: 'peak',
      capacity: 4,
      released: 4,
      held: 0,
      heldByYou: false,
      available: 4,
      holders: [],
    });
    expect(slots?.bands[OFF_PEAK_BAND]).toMatchObject({
      shape: 'off_peak',
      capacity: 14,
      released: 14,
      available: 14,
    });
  });

  it('holds back half the board on opening day, and opens the rest on schedule', async () => {
    // §21's third open question: "first-come-first-served creates a permanent
    // land grab. Consider scheduled slot release waves." This is the wave.
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'flagship');

    const young = await readAirportSlots(db.db, own(a), icao);
    expect(young?.releases).toMatchObject({
      releasedFraction: 0.5,
      nextWaveAtGameDay: 30,
    });
    // Eventual capacity 14 overnight; half of it open on day one.
    expect(young?.bands[OFF_PEAK_BAND]).toMatchObject({ capacity: 14, released: 7 });

    await ageWorld(a, 30);
    const middle = await readAirportSlots(db.db, own(a), icao);
    expect(middle?.releases).toMatchObject({ releasedFraction: 0.75, nextWaveAtGameDay: 90 });
    expect(middle?.bands[OFF_PEAK_BAND]?.released).toBe(11); // ceil(14 × 0.75)

    await ageWorld(a, 90);
    const mature = await readAirportSlots(db.db, own(a), icao);
    expect(mature?.releases).toMatchObject({
      releasedFraction: 1,
      nextWaveAtGameDay: null,
      nextWaveInGameDays: null,
    });
    expect(mature?.bands[OFF_PEAK_BAND]?.released).toBe(14);
  });

  it('refuses a claim the wave has not opened yet, and allows it once it has', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const icao = await makeAirport(3, 'medium'); // default base 4 → peak capacity 2

    // Day one: peak releases ceil(2 × 0.5) = 1. One airline takes it.
    const first = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    expect((await claimSlot(db.db, own(first), icao, BAND)).ok).toBe(true);
    expect(await claimSlot(db.db, own(a), icao, BAND)).toMatchObject({
      ok: false,
      problem: 'band_full',
    });

    // The second wave opens the second seat, and the waiting airline gets in
    // without anybody giving anything up. That is the whole point.
    await ageWorld(a, 90);
    expect((await claimSlot(db.db, own(a), icao, BAND)).ok).toBe(true);
  });

  it('leaves a newcomer an off-peak slot at an airport whose peak is gone', async () => {
    // M7-05's first acceptance criterion, end to end: "a new player joining a
    // mature world can still obtain off-peak slots at a Level 3 airport".
    const a = await fixtures.create({ baseCountry: 'GB' });
    await ageWorld(a, 90);
    const icao = await makeAirport(3, 'medium'); // peak 2, off-peak 7

    for (let i = 0; i < 2; i += 1) {
      const incumbent = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
      expect((await claimSlot(db.db, own(incumbent), icao, BAND)).ok).toBe(true);
    }

    // The newcomer is locked out of 08:00…
    expect(await claimSlot(db.db, own(a), icao, BAND)).toMatchObject({
      ok: false,
      problem: 'band_full',
    });
    // …and still gets 03:00, which is exactly the deal B.5 describes.
    expect((await claimSlot(db.db, own(a), icao, OFF_PEAK_BAND)).ok).toBe(true);
  });

  it('names every airline holding a band, not just a count', async () => {
    // The third acceptance criterion. Slots are "the scarce resource of the
    // shared world" — a scarce resource you cannot attribute is a closed door.
    const a = await fixtures.create({ baseCountry: 'GB' });
    await ageWorld(a, 90);
    const rival = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    const icao = await makeAirport(3, 'flagship');

    await claimSlot(db.db, own(a), icao, OFF_PEAK_BAND);
    await claimSlot(db.db, own(rival), icao, OFF_PEAK_BAND);

    const slots = await readAirportSlots(db.db, own(a), icao);
    const holders = slots?.bands[OFF_PEAK_BAND]?.holders ?? [];
    expect(holders).toHaveLength(2);

    const mine = holders.find((h) => h.airlineId === a.airline.id);
    const theirs = holders.find((h) => h.airlineId === rival.airline.id);
    expect(mine?.isYou).toBe(true);
    expect(theirs?.isYou).toBe(false);
    expect(theirs?.name).toBe(rival.airline.name);
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
    // Large base 5, peak-shaped to 3, half released on a fresh world → 2 seats.
    // One taken leaves one, and the second claim added no row.
    expect(band).toMatchObject({
      capacity: 3,
      released: 2,
      held: 1,
      heldByYou: true,
      available: 1,
    });
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
    const icao = await makeAirport(3, 'medium');
    const a = await fixtures.create({ baseCountry: 'GB' });
    await ageWorld(a, 90); // everything released, so this is about exhaustion

    // Fill exactly the released capacity, read from the server rather than
    // assumed — so retuning the shape or the waves does not silently turn this
    // into a test that stops filling the band.
    const before = await readAirportSlots(db.db, own(a), icao);
    const seats = before?.bands[OFF_PEAK_BAND]?.released ?? 0;
    expect(seats).toBeGreaterThan(0);

    const others = [] as FoundedAirlineFixture[];
    for (let i = 0; i < seats; i += 1) {
      const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
      others.push(b);
      expect((await claimSlot(db.db, own(b), icao, OFF_PEAK_BAND)).ok).toBe(true);
    }

    expect(await claimSlot(db.db, own(a), icao, OFF_PEAK_BAND)).toMatchObject({
      ok: false,
      problem: 'band_full',
    });

    // Free one and the waiting airline gets in.
    await releaseSlot(db.db, own(others[0]!), icao, OFF_PEAK_BAND);
    expect((await claimSlot(db.db, own(a), icao, OFF_PEAK_BAND)).ok).toBe(true);
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
