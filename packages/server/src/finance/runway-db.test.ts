import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, cashMovement } from '../db/schema';
import { hireOffice } from '../office/hires';
import { runOfficePayroll } from '../office/payroll';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { drawLoan } from './credit';
import { accrueLoanInterest } from './interest';
import { readCashRunway } from './runway';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §13.6's cash runway against real PostgreSQL — M8-08's two acceptance criteria.
 *
 * The walk itself is proved without a database in
 * `packages/sim/src/finance/runway.test.ts`. What needs Postgres is the part
 * that decides *what goes into it*, and one property in particular:
 *
 * > **the projection agrees with what the sweep will actually charge.**
 *
 * A runway is a promise about a future bill. If the projection and the payroll
 * ever compute that bill differently, the number is wrong in the one way nobody
 * can catch by reading it — so a test compares the two against a real month of
 * payroll rather than trusting that they share a function today.
 *
 * Crew is not re-tested here for the same reason it cannot drift: the projection
 * and `runCrewPayroll` call the *same* `foldCrewBills`, and swapping either for
 * a copy is what the office case below would notice if it happened here.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [finance/runway-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;

describeDb('the cash runway', () => {
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

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /** Money in or out through a real movement — the balance may not be written directly. */
  async function move(
    fixture: FoundedAirlineFixture,
    amountMinor: number,
    cause: 'flight_settlement' | 'aircraft_new_purchase',
    occurredAt: Date,
  ): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause,
        reference: `runway-test-${randomUUID()}`,
        occurredAt,
      }),
    );
  }

  async function cashOf(fixture: FoundedAirlineFixture): Promise<number> {
    const [row] = await db.db
      .select({ cash: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    return Number(row?.cash ?? 0);
  }

  it('reports a quiet airline as beyond the horizon rather than as a number', async () => {
    const fixture = await fixtures.create();
    const runway = await readCashRunway(db.db, own(fixture));

    expect(runway.days).toBeNull();
    expect(runway.horizonDays).toBe(365);
    expect(runway.critical).toBe(false);
    expect(runway.committedMinor).toBe(0);
    expect(runway.cashMinor).toBe(fixture.airline.cash);
  });

  it('shortens the moment a commitment is signed, before any bill is charged (AC1)', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    // A steady burn, so the runway is a finite number to move.
    for (let day = 1; day <= 20; day += 1) {
      await move(
        fixture,
        -500_000,
        'flight_settlement',
        new Date(gameNow.getTime() - day * DAY_MS),
      );
    }

    const before = await readCashRunway(db.db, own(fixture));
    expect(before.days).not.toBeNull();
    expect(before.dailyOperatingMinor).toBeLessThan(0);

    const hired = await hireOffice(db.db, own(fixture), {
      seat: 'route-planner',
      candidateId: 'route-planner-mara',
      candidateName: 'Mara Ellison',
      candidateRole: 'route-planner',
    });
    expect(hired.ok).toBe(true);

    const after = await readCashRunway(db.db, own(fixture));

    /*
     * This is the acceptance criterion. Nobody has been paid: the hire's salary
     * is charged on the first of next game month and no cash movement for it
     * exists. A burn rate measured from the ledger therefore cannot see it, and
     * every month from here is shorter than the runway said a moment ago.
     */
    expect(after.committedMinor).toBeGreaterThan(0);
    expect(after.days ?? Number.POSITIVE_INFINITY).toBeLessThan(
      before.days ?? Number.POSITIVE_INFINITY,
    );
    expect(after.upcoming.some((bill) => bill.kind === 'office')).toBe(true);
  });

  it('projects exactly what the payroll sweep goes on to charge', async () => {
    const fixture = await fixtures.create();
    await hireOffice(db.db, own(fixture), {
      seat: 'route-planner',
      candidateId: 'route-planner-mara',
      candidateName: 'Mara Ellison',
      candidateRole: 'route-planner',
    });
    await hireOffice(db.db, own(fixture), {
      seat: 'chief-pilot',
      candidateId: 'chief-pilot-sten',
      candidateName: 'Sten Halvorsen',
      candidateRole: 'chief-pilot',
    });

    const runway = await readCashRunway(db.db, own(fixture));
    const projected = runway.upcoming.find((bill) => bill.kind === 'office');
    expect(projected).toBeDefined();

    // Run the real sweep a month on, so it closes the month the projection was
    // looking at, and compare what it actually took out of the airline.
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const nextMonth = new Date(Date.UTC(gameNow.getUTCFullYear(), gameNow.getUTCMonth() + 1, 2));
    const charged = await runOfficePayroll(db.db, fixture.world.id, nextMonth);

    // The whole point: a projection that disagreed with the charge would be
    // wrong in the one way nobody can catch by reading the number.
    expect(charged.totalMinor).toBe(projected?.amountMinor);

    const movements = await db.db
      .select({ amountMinor: cashMovement.amountMinor, cause: cashMovement.cause })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, fixture.airline.id));
    const salaries = movements
      .filter((row) => row.cause === 'office_salary')
      .reduce((total, row) => total - row.amountMinor, 0);
    expect(salaries).toBe(projected?.amountMinor);
  });

  it('counts a loan day by day, and never twice', async () => {
    const fixture = await fixtures.create();
    const drawn = await drawLoan(db.db, own(fixture), {
      instrument: 'working_capital',
      principalMinor: 25_000_000,
    });
    expect(drawn.ok).toBe(true);

    const projected = await readCashRunway(db.db, own(fixture));
    const interest = projected.upcoming.filter((bill) => bill.kind === 'interest');
    expect(interest.length).toBeGreaterThan(0);
    // §13.4's charge is per game day, so the projection's is too — folding a
    // month onto the first would move the day the airline runs out.
    expect(interest[0]?.amountMinor).toBe(11_806);

    /*
     * Now let the accrual actually run, and read again. Interest has reached the
     * ledger, but it is `projected` rather than a `rate`, so the operating flow
     * must not have moved — counting it in both places would bill it twice.
     */
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    await accrueLoanInterest(db.db, fixture.world.id, new Date(gameNow.getTime() + 5 * DAY_MS));
    const after = await readCashRunway(db.db, own(fixture));
    expect(after.dailyOperatingMinor).toBe(projected.dailyOperatingMinor);
  });

  it('refuses to turn a one-off purchase into a burn rate', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    await move(fixture, 40_000_000_000, 'flight_settlement', new Date(gameNow.getTime() - DAY_MS));
    await move(
      fixture,
      -39_000_000_000,
      'aircraft_new_purchase',
      new Date(gameNow.getTime() - DAY_MS),
    );

    const runway = await readCashRunway(db.db, own(fixture));
    /*
     * A $390M aeroplane inside a thirty-day window is a burn of $13M a game day,
     * and would report an airline that just bought a fleet as having days to
     * live. The purchase is real and is emphatically not a rate.
     */
    expect(runway.dailyOperatingMinor).toBeGreaterThan(0);
    expect(runway.days).toBeNull();
  });

  it('raises §13.6’s flag below thirty days, and the server decides it (AC2)', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    // Spend down to a fortnight of the burn we are about to establish.
    const perDay = 500_000;
    for (let day = 1; day <= 30; day += 1) {
      await move(fixture, -perDay, 'flight_settlement', new Date(gameNow.getTime() - day * DAY_MS));
    }
    const keep = perDay * 14;
    await move(fixture, keep - (await cashOf(fixture)), 'flight_settlement', gameNow);

    const runway = await readCashRunway(db.db, own(fixture));
    expect(runway.days).not.toBeNull();
    expect(runway.days ?? 0).toBeLessThan(30);
    expect(runway.critical).toBe(true);
    expect(runway.criticalBelowDays).toBe(30);
  });
});
