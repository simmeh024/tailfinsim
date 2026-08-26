import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { HEADQUARTERS_EXPANSION_TIERS, OFFICE_ROLES } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, cashMovement, officeExpansion, officeHire, runway } from '../db/schema';
import { openRoute } from '../network/open-route';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
} from '../test-fixtures/founded-airline';

import { requiresExtendedAuthority, hasExtendedAuthority } from './authority';
import { purchaseExpansion } from './expansion';
import { dismissOffice, hireOffice, readOfficeState } from './hires';
import { runOfficePayroll } from './payroll';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Office hires — the server half (M5-04, §9.1).
 *
 * The two acceptance criteria live here: a hire's effect is a concrete unlock
 * (the Safety & Compliance seat, gating long-haul and international routes), and
 * that gate is genuinely unreachable without the hire. Plus the parts that make
 * it a real feature: hires persist and are billed monthly, and every read and
 * write is the caller's own office.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [office.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describe('when a route needs extended authority', () => {
  it('is a domestic short sector: no', () => {
    expect(
      requiresExtendedAuthority({
        originCountry: 'US',
        destinationCountry: 'US',
        greatCircleNm: 400,
      }),
    ).toBe(false);
  });

  it('leaves the country: yes, at any distance', () => {
    expect(
      requiresExtendedAuthority({
        originCountry: 'US',
        destinationCountry: 'CA',
        greatCircleNm: 200,
      }),
    ).toBe(true);
  });

  it('is long-haul within one country: yes', () => {
    expect(
      requiresExtendedAuthority({
        originCountry: 'US',
        destinationCountry: 'US',
        greatCircleNm: 2_500,
      }),
    ).toBe(true);
  });
});

describeDb('the office, on the database', () => {
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

  /** An airport with one long, open runway, at a chosen position and country. */
  async function makeAirport(
    icao: string,
    country: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_600_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Office Airport ${icao}`,
        isoCountry: country,
        kind: 'large_airport',
        latitude,
        longitude,
        scheduledService: true,
        hasRunwayData: true,
        tier: 'large',
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    await db.db.insert(runway).values({
      sourceId: -(9_600_000 + n),
      airportId: created.id,
      identifier: '09/27',
      lengthFt: 12_000, // ~3,650 m: comfortably above the reference takeoff run
      widthFt: 150,
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
  }

  describe('hiring', () => {
    it('fills a seat, and reads it back with the seat salary', async () => {
      const airline = await fixtures.create();
      const result = await hireOffice(db.db, own(airline), {
        seat: 'route-planner',
        candidateId: 'rp-1',
        candidateName: 'Mara Ellison',
        candidateRole: 'route-planner',
      });
      expect(result.ok).toBe(true);

      const state = await readOfficeState(db.db, own(airline));
      expect(state.hires).toHaveLength(1);
      expect(state.hires[0]).toMatchObject({
        seat: 'route-planner',
        candidateName: 'Mara Ellison',
        monthlySalaryMinor: OFFICE_ROLES['route-planner'].monthlySalaryMinor,
      });
      expect(state.hasExtendedAuthority).toBe(false);
    });

    it('holds one person per seat — a rival is a replace, not a second row', async () => {
      const airline = await fixtures.create();
      await hireOffice(db.db, own(airline), {
        seat: 'route-planner',
        candidateId: 'rp-1',
        candidateName: 'Mara Ellison',
        candidateRole: 'route-planner',
      });
      await hireOffice(db.db, own(airline), {
        seat: 'route-planner',
        candidateId: 'rp-2',
        candidateName: 'Tom Bakker',
        candidateRole: 'route-planner',
      });

      const state = await readOfficeState(db.db, own(airline));
      expect(state.hires).toHaveLength(1);
      expect(state.hires[0]?.candidateName).toBe('Tom Bakker');
    });

    it('flips extended authority when the Safety & Compliance seat is filled', async () => {
      const airline = await fixtures.create();
      expect(await hasExtendedAuthority(db.db, airline.airline.id)).toBe(false);

      await hireOffice(db.db, own(airline), {
        seat: 'safety-compliance',
        candidateId: 'sc-1',
        candidateName: 'Claire Fontaine',
        candidateRole: 'safety-compliance',
      });
      expect(await hasExtendedAuthority(db.db, airline.airline.id)).toBe(true);
      expect((await readOfficeState(db.db, own(airline))).hasExtendedAuthority).toBe(true);

      await dismissOffice(db.db, own(airline), 'safety-compliance');
      expect(await hasExtendedAuthority(db.db, airline.airline.id)).toBe(false);
    });

    it('keeps one airline’s office out of another’s (SEC-05)', async () => {
      const a = await fixtures.create();
      const b = await fixtures.create({ worldId: a.world.id });
      await hireOffice(db.db, own(a), {
        seat: 'chief-pilot',
        candidateId: 'cp-1',
        candidateName: 'Sten Halvorsen',
        candidateRole: 'chief-pilot',
      });

      expect((await readOfficeState(db.db, own(b))).hires).toEqual([]);
      expect(await hasExtendedAuthority(db.db, b.airline.id)).toBe(false);
      // Dismissing from B does not touch A's hire.
      await dismissOffice(db.db, own(b), 'chief-pilot');
      expect((await readOfficeState(db.db, own(a))).hires).toHaveLength(1);
    });
  });

  describe('the long-haul gate on opening a route', () => {
    it('refuses an international route without the Safety & Compliance hire', async () => {
      const airline = await fixtures.create();
      // ~400 nm apart, different countries.
      await makeAirport('OFIA', 'US', 40, -74);
      await makeAirport('OFIB', 'CA', 45, -73);

      const refused = await openRoute(db.db, own(airline), {
        originIcao: 'OFIA',
        destinationIcao: 'OFIB',
      });
      expect(refused).toMatchObject({ ok: false, kind: 'authority', reason: 'international' });

      // Hire the seat, and the same route opens.
      await hireOffice(db.db, own(airline), {
        seat: 'safety-compliance',
        candidateId: 'sc-1',
        candidateName: 'Claire Fontaine',
        candidateRole: 'safety-compliance',
      });
      const opened = await openRoute(db.db, own(airline), {
        originIcao: 'OFIA',
        destinationIcao: 'OFIB',
      });
      expect(opened.ok).toBe(true);
    });

    it('refuses a long-haul domestic route without the hire, and allows a short one', async () => {
      const airline = await fixtures.create();
      // Same country, ~2,300 nm apart (38.5 degrees of longitude at latitude 5).
      await makeAirport('OFLA', 'US', 5, -100);
      await makeAirport('OFLB', 'US', 5, -61.5);
      // Same country, ~600 nm apart (10 degrees at latitude 5).
      await makeAirport('OFSA', 'US', 5, -90);
      await makeAirport('OFSB', 'US', 5, -80);

      const longHaul = await openRoute(db.db, own(airline), {
        originIcao: 'OFLA',
        destinationIcao: 'OFLB',
      });
      expect(longHaul).toMatchObject({ ok: false, kind: 'authority', reason: 'long-haul' });

      // A short domestic sector needs no authority and opens.
      const shortHaul = await openRoute(db.db, own(airline), {
        originIcao: 'OFSA',
        destinationIcao: 'OFSB',
      });
      expect(shortHaul.ok).toBe(true);
    });
  });

  describe('office payroll', () => {
    it('bills the seat salaries once a month, and is idempotent across ticks', async () => {
      const airline = await fixtures.create();
      await hireOffice(db.db, own(airline), {
        seat: 'safety-compliance',
        candidateId: 'sc-1',
        candidateName: 'Claire Fontaine',
        candidateRole: 'safety-compliance',
      });
      await hireOffice(db.db, own(airline), {
        seat: 'route-planner',
        candidateId: 'rp-1',
        candidateName: 'Mara Ellison',
        candidateRole: 'route-planner',
      });

      // The world clock is somewhere in a month; payroll bills the previous one.
      const gameNow = new Date('2024-11-15T12:00:00.000Z');
      const expected =
        OFFICE_ROLES['safety-compliance'].monthlySalaryMinor +
        OFFICE_ROLES['route-planner'].monthlySalaryMinor;

      const first = await runOfficePayroll(db.db, airline.world.id, gameNow);
      expect(first).toEqual({ airlinesBilled: 1, totalMinor: expected });

      // Every subsequent tick in the same month is a no-op — the AIR-06 reference
      // is the whole month, so nothing is billed twice.
      const again = await runOfficePayroll(db.db, airline.world.id, gameNow);
      expect(again).toEqual({ airlinesBilled: 0, totalMinor: 0 });

      const movements = await db.db
        .select({ cause: cashMovement.cause, amountMinor: cashMovement.amountMinor })
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airline.airline.id));
      const office = movements.filter((m) => m.cause === 'office_salary');
      expect(office).toHaveLength(1);
      expect(Number(office[0]?.amountMinor)).toBe(-expected);
    });

    it('bills nothing for an airline with an empty office', async () => {
      const airline = await fixtures.create();
      const result = await runOfficePayroll(
        db.db,
        airline.world.id,
        new Date('2024-11-15T12:00:00.000Z'),
      );
      expect(result).toEqual({ airlinesBilled: 0, totalMinor: 0 });
      // And the office_hire table for this airline is genuinely empty.
      const rows = await db.db
        .select({ id: officeHire.id })
        .from(officeHire)
        .where(eq(officeHire.airlineId, airline.airline.id));
      expect(rows).toEqual([]);
    });
  });

  describe('headquarters expansion', () => {
    const [tier1, tier2] = HEADQUARTERS_EXPANSION_TIERS;
    if (!tier1 || !tier2) throw new Error('expected two expansion tiers');

    /** Top an airline up with real AIR-06 cash so it can afford an expansion. */
    async function fund(airlineId: string, amountMinor: number): Promise<void> {
      await db.db.transaction((tx) =>
        moveAirlineCash(tx, {
          airlineId,
          amountMinor,
          cause: 'admin_adjustment',
          reference: `test-fund:${airlineId}`,
          occurredAt: new Date('2024-01-01T00:00:00.000Z'),
        }),
      );
    }

    it('locks a neutral seat until the airline has expanded', async () => {
      const a = await fixtures.create();
      const locked = await hireOffice(db.db, own(a), {
        seat: 'neutral-1',
        candidateId: 'rp-1',
        candidateName: 'Mara Ellison',
        candidateRole: 'route-planner',
      });
      expect(locked).toEqual({ ok: false, code: 'seat_locked' });

      await fund(a.airline.id, 5_000_000_000);
      expect(await purchaseExpansion(db.db, own(a))).toEqual({ ok: true, neutralSeats: 2 });

      const filled = await hireOffice(db.db, own(a), {
        seat: 'neutral-1',
        candidateId: 'rp-1',
        candidateName: 'Mara Ellison',
        candidateRole: 'route-planner',
      });
      expect(filled.ok).toBe(true);

      const state = await readOfficeState(db.db, own(a));
      expect(state.neutralSeats).toBe(2);
      expect(state.hires.map((h) => h.seat)).toContain('neutral-1');
    });

    it('does not let a neutral Safety hire unlock authority', async () => {
      const a = await fixtures.create();
      await fund(a.airline.id, 5_000_000_000);
      await purchaseExpansion(db.db, own(a));
      const hired = await hireOffice(db.db, own(a), {
        seat: 'neutral-1',
        candidateId: 'sc-1',
        candidateName: 'Claire Fontaine',
        candidateRole: 'safety-compliance',
      });
      expect(hired.ok).toBe(true);
      // A Safety candidate in a neutral seat is not the gate — no authority.
      expect(await hasExtendedAuthority(db.db, a.airline.id)).toBe(false);
      expect((await readOfficeState(db.db, own(a))).hasExtendedAuthority).toBe(false);
    });

    it('refuses a role seat filled by the wrong role', async () => {
      const a = await fixtures.create();
      const bad = await hireOffice(db.db, own(a), {
        seat: 'route-planner',
        candidateId: 'cp-1',
        candidateName: 'Sten Halvorsen',
        candidateRole: 'chief-pilot',
      });
      expect(bad).toEqual({ ok: false, code: 'role_mismatch' });
    });

    it('charges each tier via AIR-06 and advances to the ten-office ceiling', async () => {
      const a = await fixtures.create();
      await fund(a.airline.id, 5_000_000_000);

      expect(await purchaseExpansion(db.db, own(a))).toEqual({ ok: true, neutralSeats: 2 });
      let state = await readOfficeState(db.db, own(a));
      expect(state.neutralSeats).toBe(2);
      expect(state.nextExpansion).toEqual({
        addsSeats: 2,
        totalSeats: 10,
        costMinor: tier2.costMinor,
      });

      expect(await purchaseExpansion(db.db, own(a))).toEqual({ ok: true, neutralSeats: 4 });
      state = await readOfficeState(db.db, own(a));
      expect(state.neutralSeats).toBe(4);
      expect(state.nextExpansion).toBeNull();

      // No third tier — the ten-office ceiling refuses.
      expect(await purchaseExpansion(db.db, own(a))).toEqual({ ok: false, code: 'maxed' });

      const spent = await db.db
        .select({ cause: cashMovement.cause, amountMinor: cashMovement.amountMinor })
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, a.airline.id));
      const expansions = spent
        .filter((m) => m.cause === 'office_expansion')
        .map((m) => Number(m.amountMinor))
        .sort((x, y) => x - y);
      expect(expansions).toEqual([-tier2.costMinor, -tier1.costMinor]);
    });

    it('refuses to expand when the airline cannot afford it', async () => {
      const a = await fixtures.create();
      // A fresh airline opens with far less than the first tier costs.
      expect(await purchaseExpansion(db.db, own(a))).toEqual({
        ok: false,
        code: 'insufficient_funds',
      });
      const rows = await db.db
        .select({ id: officeExpansion.id })
        .from(officeExpansion)
        .where(eq(officeExpansion.airlineId, a.airline.id));
      expect(rows).toEqual([]);
    });
  });
});
