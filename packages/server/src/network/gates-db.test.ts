import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, cashMovement, gateHolding } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { billGateLeases } from './gate-upkeep';
import { leaseStand, readAirportGates, releaseStand, resolveStand, standInventory } from './gates';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Holding and resolving airport stands (M7-06, App. B.6).
 *
 * The database half: who may lease what, App. B.6's exclusivity actually denying
 * a rival, the monthly bill, and the resolver that decides whether a turn is
 * worked from a jet bridge or a bus. The pure arithmetic — the requirement
 * formula, the growth table, per-gate utilisation — is `@tailfin/sim`'s
 * `route/gates.test.ts`, and the prices are `economy/gate-cost.test.ts`.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */
const nextAirport = createAirportIdentities('network/gates-db');

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/gates-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('airport stands', () => {
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

  async function makeAirport(tier: string | null): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: `GATE-${icao}`,
      icaoCode: icao,
      name: `Stand Field ${icao}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
      slotLevel: null,
      tier: tier as 'flagship' | 'large' | 'medium' | 'small' | 'regional' | null,
      utcOffsetMinutes: 0,
    });
    madeAirports.push(icao);
    return icao;
  }

  /** The quoted price for a stand, taken from the server rather than invented. */
  async function quoteFor(
    fixture: FoundedAirlineFixture,
    icao: string,
    position: string,
    contract: 'preferential' | 'exclusive',
  ): Promise<number> {
    const gates = await readAirportGates(db.db, own(fixture), icao);
    const stand = gates?.stands.find((row) => row.position === position);
    if (stand === undefined) throw new Error(`no stand ${position} at ${icao}`);
    return stand.annualFeeMinor[contract];
  }

  describe('the apron', () => {
    it('gives every airport stands — a stand is not a Level 3 privilege', async () => {
      // App. B.8: slots are "Level 3 airports only"; gates are scarce "anywhere
      // popular". A regional field has few stands, not none.
      const a = await fixtures.create({ baseCountry: 'GB' });
      const regional = await makeAirport('regional');
      const gates = await readAirportGates(db.db, own(a), regional);
      expect(gates?.stands.length).toBeGreaterThan(0);
      expect(gates?.stands.some((stand) => stand.kind === 'contact_gate')).toBe(true);
    });

    it('scales the apron with the airport, and numbers gates by pier', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const [flagship, small] = await Promise.all([makeAirport('flagship'), makeAirport('small')]);

      const big = await readAirportGates(db.db, own(a), flagship);
      const little = await readAirportGates(db.db, own(a), small);
      const contact = (gates: typeof big): number =>
        gates?.stands.filter((stand) => stand.kind === 'contact_gate').length ?? 0;

      expect(contact(big)).toBeGreaterThan(contact(little));
      expect(big?.stands.map((stand) => stand.position)).toContain('A1');
      // Piers of twelve, so the thirteenth gate starts the B pier.
      expect(big?.stands.map((stand) => stand.position)).toContain('B1');
      expect(big?.stands.map((stand) => stand.position)).toContain('R1');
    });

    it('returns null for an airport that does not exist', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      expect(await readAirportGates(db.db, own(a), 'ZZZZ')).toBeNull();
    });

    it('lays the same apron out for every airport of a tier', () => {
      // The inventory is computed, not stored — so it has to be stable, because
      // a lease addresses a stand by its label.
      expect(standInventory('medium')).toEqual(standInventory('medium'));
      expect(standInventory(null)).toEqual(standInventory('regional'));
    });
  });

  describe('leasing', () => {
    it('takes a stand at the price it quoted', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const fee = await quoteFor(a, icao, 'A1', 'preferential');

      const result = await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: fee,
      });
      expect(result.ok).toBe(true);

      const gates = await readAirportGates(db.db, own(a), icao);
      const stand = gates?.stands.find((row) => row.position === 'A1');
      expect(stand?.yourContract).toBe('preferential');
      expect(stand?.holders.some((holder) => holder.isYou)).toBe(true);
      // Pinned: the bill is a twelfth of what was agreed, not of today's price.
      expect(gates?.monthlyFeeMinor).toBe(Math.round(fee / 12));
    });

    it('refuses a quote that has gone stale', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const result = await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: 1,
      });
      expect(result).toEqual({ ok: false, problem: 'fee_changed' });
    });

    it('refuses a stand the airport does not have', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('regional'); // two contact gates, A1 and A2
      const result = await leaseStand(db.db, own(a), icao, {
        position: 'A9',
        contract: 'preferential',
        expectedAnnualFeeMinor: 0,
      });
      expect(result).toEqual({ ok: false, problem: 'unknown_stand' });
    });

    it('refuses to lease a common-use stand, because there is nothing to lease', async () => {
      // App. B.6's common use is a per-turn fee that reserves nothing. The schema
      // refuses the row as well; this is the reason the player is given.
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const result = await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'common_use',
        expectedAnnualFeeMinor: 0,
      });
      expect(result).toEqual({ ok: false, problem: 'not_leasable' });
    });

    it('is idempotent on the same terms, and does not reset the grace period', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const fee = await quoteFor(a, icao, 'A1', 'preferential');
      const lease = {
        position: 'A1',
        contract: 'preferential' as const,
        expectedAnnualFeeMinor: fee,
      };

      await leaseStand(db.db, own(a), icao, lease);
      const [first] = await db.db
        .select({ leasedAt: gateHolding.leasedAt })
        .from(gateHolding)
        .where(and(eq(gateHolding.airlineId, a.airline.id), eq(gateHolding.airportIcao, icao)));

      await leaseStand(db.db, own(a), icao, lease);
      const rows = await db.db
        .select({ leasedAt: gateHolding.leasedAt })
        .from(gateHolding)
        .where(and(eq(gateHolding.airlineId, a.airline.id), eq(gateHolding.airportIcao, icao)));

      expect(rows).toHaveLength(1);
      // Re-leasing on the same terms must not restart the utilisation floor's
      // grace period, or hoarding would be a matter of clicking.
      expect(rows[0]?.leasedAt.getTime()).toBe(first?.leasedAt.getTime());
    });

    it('gives a stand back, idempotently', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const fee = await quoteFor(a, icao, 'A1', 'preferential');
      await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: fee,
      });

      expect((await releaseStand(db.db, own(a), icao, 'A1')).ok).toBe(true);
      // Again, on a stand that is no longer held: a no-op, not an error.
      expect((await releaseStand(db.db, own(a), icao, 'A1')).ok).toBe(true);

      const gates = await readAirportGates(db.db, own(a), icao);
      expect(gates?.stands.find((row) => row.position === 'A1')?.yourContract).toBeNull();
      expect(gates?.monthlyFeeMinor).toBe(0);
    });
  });

  describe('App. B.6 exclusivity — "denies it to everyone else"', () => {
    /** Two airlines in one world, so they can contest the same apron. */
    async function twoAirlines(): Promise<[FoundedAirlineFixture, FoundedAirlineFixture]> {
      const first = await fixtures.create({ baseCountry: 'GB' });
      const second = await fixtures.create({ baseCountry: 'GB', worldId: first.world.id });
      return [first, second];
    }

    it('denies an exclusively held stand to a rival', async () => {
      const [mine, theirs] = await twoAirlines();
      const icao = await makeAirport('large');
      const fee = await quoteFor(mine, icao, 'A1', 'exclusive');

      expect(
        (
          await leaseStand(db.db, own(mine), icao, {
            position: 'A1',
            contract: 'exclusive',
            expectedAnnualFeeMinor: fee,
          })
        ).ok,
      ).toBe(true);

      const rival = await leaseStand(db.db, own(theirs), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: await quoteFor(theirs, icao, 'A1', 'preferential'),
      });
      expect(rival).toEqual({ ok: false, problem: 'exclusively_held' });

      // And the refusal left nothing behind: no row, no charge.
      const rows = await db.db
        .select({ id: gateHolding.id })
        .from(gateHolding)
        .where(
          and(eq(gateHolding.airlineId, theirs.airline.id), eq(gateHolding.airportIcao, icao)),
        );
      expect(rows).toHaveLength(0);
    });

    it('shows the rival that the stand is closed, and who closed it', async () => {
      // App. B.7: "you can see exactly who holds what, which makes gate
      // competition legible and personal". A denial nobody can attribute reads
      // like a bug.
      const [mine, theirs] = await twoAirlines();
      const icao = await makeAirport('large');
      await leaseStand(db.db, own(mine), icao, {
        position: 'A1',
        contract: 'exclusive',
        expectedAnnualFeeMinor: await quoteFor(mine, icao, 'A1', 'exclusive'),
      });

      const gates = await readAirportGates(db.db, own(theirs), icao);
      const stand = gates?.stands.find((row) => row.position === 'A1');
      expect(stand?.exclusivelyHeld).toBe(true);
      expect(stand?.available).toBe(false);
      expect(stand?.holders.map((holder) => holder.name)).toEqual([mine.airline.name]);
      // Their utilisation is not ours to see.
      expect(stand?.utilisation).toBeNull();
    });

    it('refuses an exclusive lease over a stand somebody else is already on', async () => {
      const [mine, theirs] = await twoAirlines();
      const icao = await makeAirport('large');
      await leaseStand(db.db, own(mine), icao, {
        position: 'A2',
        contract: 'preferential',
        expectedAnnualFeeMinor: await quoteFor(mine, icao, 'A2', 'preferential'),
      });

      const grab = await leaseStand(db.db, own(theirs), icao, {
        position: 'A2',
        contract: 'exclusive',
        expectedAnnualFeeMinor: await quoteFor(theirs, icao, 'A2', 'exclusive'),
      });
      expect(grab).toEqual({ ok: false, problem: 'contested' });
    });

    it('lets two airlines share a stand preferentially', async () => {
      // Only exclusivity denies. A preferential lease is priority, not a wall.
      const [mine, theirs] = await twoAirlines();
      const icao = await makeAirport('large');
      for (const who of [mine, theirs]) {
        const result = await leaseStand(db.db, own(who), icao, {
          position: 'A3',
          contract: 'preferential',
          expectedAnnualFeeMinor: await quoteFor(who, icao, 'A3', 'preferential'),
        });
        expect(result.ok).toBe(true);
      }
      const gates = await readAirportGates(db.db, own(mine), icao);
      expect(gates?.stands.find((row) => row.position === 'A3')?.holders).toHaveLength(2);
    });

    it('does not let a rival see our lease as our own', async () => {
      const [mine, theirs] = await twoAirlines();
      const icao = await makeAirport('large');
      await leaseStand(db.db, own(mine), icao, {
        position: 'A4',
        contract: 'preferential',
        expectedAnnualFeeMinor: await quoteFor(mine, icao, 'A4', 'preferential'),
      });

      const gates = await readAirportGates(db.db, own(theirs), icao);
      const stand = gates?.stands.find((row) => row.position === 'A4');
      expect(stand?.yourContract).toBeNull();
      expect(stand?.holders.every((holder) => !holder.isYou)).toBe(true);
      expect(gates?.monthlyFeeMinor).toBe(0);
    });
  });

  describe('what a turn is worked from', () => {
    it('puts a walk-up on a spare contact gate, and charges for it', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const stand = await resolveStand(db.db, own(a), icao, undefined);
      expect(stand.standType).toBe('contact');
      expect(stand.leased).toBe(false);
      expect(stand.turnFeeMinor).toBeGreaterThan(0);
    });

    it('charges nothing per turn once the stand is leased', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: await quoteFor(a, icao, 'A1', 'preferential'),
      });

      const stand = await resolveStand(db.db, own(a), icao, undefined);
      expect(stand).toMatchObject({ standType: 'contact', leased: true, turnFeeMinor: 0 });
    });

    it('bumps a walk-up onto a remote stand once every gate is leased', async () => {
      // App. B.6's "first come, and you can be bumped at peak", felt as the
      // bussing time rather than modelled as a fight over a particular gate.
      // This is what makes an exclusive lease bite on a rival who never reads
      // the gates page.
      const [mine, theirs] = await (async (): Promise<
        [FoundedAirlineFixture, FoundedAirlineFixture]
      > => {
        const first = await fixtures.create({ baseCountry: 'GB' });
        return [first, await fixtures.create({ baseCountry: 'GB', worldId: first.world.id })];
      })();
      const icao = await makeAirport('regional'); // two contact gates only

      for (const position of ['A1', 'A2']) {
        await leaseStand(db.db, own(mine), icao, {
          position,
          contract: 'exclusive',
          expectedAnnualFeeMinor: await quoteFor(mine, icao, position, 'exclusive'),
        });
      }

      const bumped = await resolveStand(db.db, own(theirs), icao, undefined);
      expect(bumped.standType).toBe('remote');
      expect(bumped.turnFeeMinor).toBeGreaterThan(0);
      // And the holder still turns at the baseline, which is what they paid for.
      expect((await resolveStand(db.db, own(mine), icao, undefined)).standType).toBe('contact');
    });
  });

  describe('the monthly bill', () => {
    it('bills a lease held through the closed month, once', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      const fee = await quoteFor(a, icao, 'A1', 'preferential');
      await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: fee,
      });

      // A lease gets one grace month: billed only for a month it was held before
      // that month began. Backdate it so there is a closed month to bill.
      await db.db
        .update(gateHolding)
        .set({ leasedAt: new Date('1970-01-05T00:00:00.000Z') })
        .where(eq(gateHolding.airlineId, a.airline.id));

      const gameNow = new Date('1970-03-10T00:00:00.000Z');
      const first = await billGateLeases(db.db, a.world.id, gameNow);
      expect(first.airlinesBilled).toBe(1);
      expect(first.totalMinor).toBe(Math.round(fee / 12));

      // Idempotent by reference — the same month cannot be billed twice.
      const second = await billGateLeases(db.db, a.world.id, gameNow);
      expect(second).toEqual({ airlinesBilled: 0, totalMinor: 0 });

      const movements = await db.db
        .select({ amountMinor: cashMovement.amountMinor })
        .from(cashMovement)
        .where(and(eq(cashMovement.airlineId, a.airline.id), eq(cashMovement.cause, 'gate_lease')));
      expect(movements).toHaveLength(1);
      expect(movements[0]?.amountMinor).toBe(-Math.round(fee / 12));
    });

    it('gives a new lease its grace month', async () => {
      const a = await fixtures.create({ baseCountry: 'GB' });
      const icao = await makeAirport('large');
      await leaseStand(db.db, own(a), icao, {
        position: 'A1',
        contract: 'preferential',
        expectedAnnualFeeMinor: await quoteFor(a, icao, 'A1', 'preferential'),
      });

      // The lease was signed at the world's game now, so the month before it
      // closed before the lease existed and there is nothing to charge.
      const billed = await billGateLeases(db.db, a.world.id, new Date('1970-02-10T00:00:00.000Z'));
      expect(billed).toEqual({ airlinesBilled: 0, totalMinor: 0 });
    });
  });
});
