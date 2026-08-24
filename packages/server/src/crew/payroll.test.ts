import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, cashMovement, crewPool } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { chargePositioning, previousMonth, runCrewPayroll } from './payroll';
import { hireCrew, openCrewBase } from './store';

/**
 * What crew cost every month (M5-02, §9.2).
 *
 * M5-02's third acceptance criterion has two halves. `dispatch.test.ts` proves
 * the first — a standby set covers a timeout the line crew cannot. This is the
 * second: **reserves cost money doing nothing**, which is what makes it a
 * decision rather than an obvious yes.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CREW = ECONOMY_CONFIG_V1.crew;

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/payroll.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('crew payroll', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  /** `TY` as the prefix — every suite that makes airports needs its own. */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFY-${String(n)}`;
    const icao = `TY${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_500_000 + n),
        ident,
        icaoCode: icao,
        name: `Payroll Test Hub ${ident}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
        utcOffsetMinutes: 60,
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('Could not create a payroll test hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  /** Two captains and four cabin crew, at one base. */
  async function airlineWithCrew() {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });

    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hub.icao,
    });
    if (!opened.ok) throw new Error(`Could not open a base: ${opened.refusal}`);

    for (const [rank, heads] of [
      ['captain', 2],
      ['cabin_crew', 4],
    ] as const) {
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId: opened.value.crewBaseId,
        family: 'A320neo',
        rank,
        heads,
      });
      if (!hired.ok) throw new Error(`Could not hire ${rank}: ${hired.refusal}`);
    }

    return { fixture, hub, crewBaseId: opened.value.crewBaseId };
  }

  async function cashOf(airlineId: string): Promise<number> {
    const rows = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return rows[0]?.cashMinor ?? 0;
  }

  async function movementsOf(
    airlineId: string,
    cause: 'crew_payroll' | 'crew_base_overhead' | 'crew_positioning',
  ) {
    return db.db
      .select({ amountMinor: cashMovement.amountMinor, reference: cashMovement.reference })
      .from(cashMovement)
      .where(and(eq(cashMovement.airlineId, airlineId), eq(cashMovement.cause, cause)));
  }

  /** Any instant in November, so the month billed is October. */
  const NOVEMBER = new Date(Date.UTC(2024, 10, 3, 9, 0, 0));

  const EXPECTED_SALARY =
    CREW.flightDeckSalaryMinor.captain * 2 + CREW.cabinSalaryMinor.cabin_crew * 4;

  it('bills salaries and base overhead as two separate movements', async () => {
    const { fixture } = await airlineWithCrew();
    const before = await cashOf(fixture.airline.id);

    const result = await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);
    expect(result.airlinesBilled).toBe(1);

    const salary = await movementsOf(fixture.airline.id, 'crew_payroll');
    const overhead = await movementsOf(fixture.airline.id, 'crew_base_overhead');
    expect(salary).toHaveLength(1);
    expect(overhead).toHaveLength(1);
    expect(salary[0]?.amountMinor).toBe(-EXPECTED_SALARY);
    expect(overhead[0]?.amountMinor).toBe(-CREW.base.monthlyOverheadMinor);

    /*
     * Two lines rather than one. §14.1 forbids a figure a player cannot
     * interrogate, and "why did I pay this" has two answers — the people and the
     * buildings — that a single movement would fuse into a number nobody can
     * argue with.
     */
    expect(await cashOf(fixture.airline.id)).toBe(
      before - EXPECTED_SALARY - CREW.base.monthlyOverheadMinor,
    );
  });

  it('bills once however many times the tick runs it', async () => {
    const { fixture } = await airlineWithCrew();

    await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);
    const afterFirst = await cashOf(fixture.airline.id);

    // Attempted every tick, on purpose: AIR-06 refuses a second movement with
    // the same cause and reference, so no "last billed" column is needed — and
    // ADR-0005 would have required resetting one on a world reset.
    const second = await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);
    const third = await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);

    expect(second.airlinesBilled).toBe(0);
    expect(third.airlinesBilled).toBe(0);
    expect(await cashOf(fixture.airline.id)).toBe(afterFirst);
    expect(await movementsOf(fixture.airline.id, 'crew_payroll')).toHaveLength(1);
  });

  it('bills again the following month', async () => {
    const { fixture } = await airlineWithCrew();
    await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);

    const december = new Date(Date.UTC(2024, 11, 2, 9, 0, 0));
    const again = await runCrewPayroll(db.db, fixture.world.id, december);

    expect(again.airlinesBilled).toBe(1);
    const salary = await movementsOf(fixture.airline.id, 'crew_payroll');
    expect(salary).toHaveLength(2);
    // The reference carries the world's own calendar month, so the two are
    // distinguishable in the ledger rather than merely being two rows.
    expect(new Set(salary.map((m) => m.reference)).size).toBe(2);
  });

  it('charges a reserve head exactly as much as a line head', async () => {
    /*
     * §9.2's *"cost money and do nothing most days"*, as arithmetic. A reserve
     * is a designation and not a separate pool, so designating one changes the
     * roster and not the bill — which is precisely why keeping reserves is a
     * decision: the money leaves whether or not the day goes wrong.
     */
    const { fixture, crewBaseId } = await airlineWithCrew();
    await db.db.update(crewPool).set({ reserve: 2 }).where(eq(crewPool.crewBaseId, crewBaseId));

    await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);
    const salary = await movementsOf(fixture.airline.id, 'crew_payroll');
    expect(salary[0]?.amountMinor).toBe(-EXPECTED_SALARY);
  });

  it('an airline with no crew base is not billed at all', async () => {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });
    const before = await cashOf(fixture.airline.id);

    const result = await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);
    expect(result.airlinesBilled).toBe(0);
    expect(await cashOf(fixture.airline.id)).toBe(before);
  });

  it('bills in full even when it takes the airline negative', async () => {
    const { fixture } = await airlineWithCrew();

    // Spend the balance down to almost nothing, then run payroll.
    const balance = await cashOf(fixture.airline.id);
    await db.db.transaction(async (tx) => {
      await moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: -(balance - 1),
        cause: 'flight_settlement',
        reference: `payroll-drain-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      });
    });

    await runCrewPayroll(db.db, fixture.world.id, NOVEMBER);

    /*
     * Payroll cannot refuse — the crew worked. So an airline that cannot make it
     * goes negative, and nothing yet acts on that: §11's bankruptcy is not
     * built. The alternative is worse than the gap, because payroll that
     * silently skipped would make "run out of money" the cheapest strategy in
     * the game.
     */
    expect(await cashOf(fixture.airline.id)).toBeLessThan(0);
    expect(await movementsOf(fixture.airline.id, 'crew_payroll')).toHaveLength(1);
  });

  it('charges a hotel per head per night, once per duty period', async () => {
    const { fixture } = await airlineWithCrew();
    const dutyPeriodId = randomUUID();
    const before = await cashOf(fixture.airline.id);

    const charged = await chargePositioning(db.db, {
      airlineId: fixture.airline.id,
      dutyPeriodId,
      heads: 4,
      nights: 2,
      occurredAt: NOVEMBER,
      duty: CREW.duty,
    });

    expect(charged).toBe(CREW.duty.hotelCostPerHeadPerNightMinor * 2 * 4);
    expect(await cashOf(fixture.airline.id)).toBe(before - charged);

    // Idempotent by the duty period id: a retry or two workers racing bill one
    // night, not two.
    await chargePositioning(db.db, {
      airlineId: fixture.airline.id,
      dutyPeriodId,
      heads: 4,
      nights: 2,
      occurredAt: NOVEMBER,
      duty: CREW.duty,
    });
    expect(await movementsOf(fixture.airline.id, 'crew_positioning')).toHaveLength(1);
  });
});

describe('the month payroll bills', () => {
  it('is the one that has just ended, in the world’s own calendar', () => {
    expect(previousMonth(new Date(Date.UTC(2024, 10, 3)))).toBe('2024-10');
    expect(previousMonth(new Date(Date.UTC(2024, 10, 30, 23, 59)))).toBe('2024-10');
  });

  it('rolls the year back at January', () => {
    expect(previousMonth(new Date(Date.UTC(2025, 0, 1)))).toBe('2024-12');
  });

  it('never bills a month still being worked', () => {
    // The first instant of a month bills the previous one, not itself.
    expect(previousMonth(new Date(Date.UTC(2024, 5, 1, 0, 0, 0)))).toBe('2024-05');
  });
});
