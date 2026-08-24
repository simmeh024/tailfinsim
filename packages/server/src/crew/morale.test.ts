import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, cashMovement, crewBase, crewPool } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { readBaseMorale, returnSickCrew, reviewCrewMorale } from './morale';
import { runCrewPayroll } from './payroll';
import { openCrewBase } from './store';

/**
 * Crew morale against a real database (M5-03, §9.2).
 *
 * The pure model is tested in `packages/sim`. What is worth proving here is the
 * thing only a database and a clock can show: **§9.2's delayed, visible bill**
 * actually arrives. An airline cuts pay, banks the saving, and some game months
 * later finds itself short of crew it did not sack.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MORALE = ECONOMY_CONFIG_V1.crew.morale;

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/morale.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('crew morale', () => {
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

  /** `TM` as the prefix — every suite that makes airports needs its own. */
  async function makeIcaoHub(): Promise<{ ident: string; icao: string }> {
    const n = sequence++;
    const ident = `TFM-${String(n)}`;
    const icao = `TM${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_600_000 + n),
        ident,
        icaoCode: icao,
        name: `Morale Test Hub ${ident}`,
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
    if (id === undefined) throw new Error('Could not create a morale test hub');
    madeAirports.push(id);
    return { ident, icao };
  }

  /** A base with a pool big enough that a percentage rounds to a whole person. */
  async function airlineWithBase(heads = 50) {
    const hub = await makeIcaoHub();
    const fixture = await fixtures.create({ hubIdent: hub.ident });

    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: hub.icao,
    });
    if (!opened.ok) throw new Error(`Could not open a base: ${opened.refusal}`);
    const crewBaseId = opened.value.crewBaseId;

    // Hiring is capped per week, so a big pool is seeded directly. This is the
    // one place that is legitimate: the cap is M5-01's mechanic and not what is
    // under test, and a percentage of four heads rounds to nothing.
    await db.db.insert(crewPool).values({
      crewBaseId,
      family: 'A320neo',
      rank: 'cabin_crew',
      headcount: heads,
    });

    return { fixture, hub, crewBaseId };
  }

  async function baseRow(crewBaseId: string) {
    const rows = await db.db
      .select({
        morale: crewBase.morale,
        reviewedAt: crewBase.moraleReviewedAt,
        payBand: crewBase.payBand,
      })
      .from(crewBase)
      .where(eq(crewBase.id, crewBaseId))
      .limit(1);
    return rows[0];
  }

  async function poolRow(crewBaseId: string) {
    const rows = await db.db
      .select({ headcount: crewPool.headcount, sick: crewPool.sick, sickUntil: crewPool.sickUntil })
      .from(crewPool)
      .where(eq(crewPool.crewBaseId, crewBaseId))
      .limit(1);
    return rows[0];
  }

  const START = new Date(Date.UTC(2024, 9, 21, 9, 0, 0));
  const weeksLater = (weeks: number): Date => new Date(START.getTime() + weeks * 7 * 86_400_000);

  it('starts a base unreviewed rather than at zero morale', async () => {
    const { fixture, crewBaseId } = await airlineWithBase();

    // Null means *never reviewed*, and reads as the balance's starting value.
    // Zero would mean the crew already hate the place on opening day.
    expect((await baseRow(crewBaseId))?.morale).toBeNull();

    const readings = await readBaseMorale(db.db, fixture.world.id, fixture.airline.id, START);
    expect(readings[0]?.morale).toBe(MORALE.startingMorale);
  });

  it('itemises the factors, and they sum to the target', async () => {
    const { fixture } = await airlineWithBase();
    const reading = (await readBaseMorale(db.db, fixture.world.id, fixture.airline.id, START))[0];
    if (!reading) throw new Error('no base');

    // M5-03's second acceptance criterion. The breakdown is not commentary
    // beside the number, it is the number.
    expect(reading.contributions.map((c) => c.factor)).toEqual([
      'pay',
      'rosterStability',
      'hotel',
      'rest',
    ]);
    const summed = reading.contributions.reduce((total, c) => total + c.weighted, 0);
    expect(summed).toBeCloseTo(reading.target, 10);
  });

  it('does not review the same base twice inside a week', async () => {
    const { fixture, crewBaseId } = await airlineWithBase();

    expect((await reviewCrewMorale(db.db, fixture.world.id, START)).basesReviewed).toBe(1);
    const afterFirst = await baseRow(crewBaseId);

    /*
     * The review both drifts morale and rolls the bill, so running it every
     * tick would apply a week of attrition sixty times a minute. The tick calls
     * it every second on purpose; this is what stops that mattering.
     */
    const soon = new Date(START.getTime() + 3 * 86_400_000);
    expect((await reviewCrewMorale(db.db, fixture.world.id, soon)).basesReviewed).toBe(0);
    expect((await baseRow(crewBaseId))?.morale).toBe(afterFirst?.morale);
  });

  it('the documented failure case: sustained cost-cutting sends a bill months later', async () => {
    /*
     * §9.2's sentence, end to end. The airline cuts to lean pay and budget
     * hotels, saves real money immediately, and pays for it in crew who leave.
     */
    const { fixture, crewBaseId } = await airlineWithBase(50);
    await db.db
      .update(crewBase)
      .set({ payBand: 'lean', hotelTier: 'budget' })
      .where(eq(crewBase.id, crewBaseId));

    // Week one: the review runs and nobody has gone anywhere yet.
    await reviewCrewMorale(db.db, fixture.world.id, START);
    const early = await baseRow(crewBaseId);
    expect(early?.morale).toBeGreaterThan(0.5);
    expect((await poolRow(crewBaseId))?.headcount).toBe(50);

    // Six months of game time, reviewed weekly.
    for (let week = 1; week <= 26; week += 1) {
      await reviewCrewMorale(db.db, fixture.world.id, weeksLater(week));
    }

    const late = await baseRow(crewBaseId);
    const pool = await poolRow(crewBaseId);
    if (!late || !pool || early?.morale == null || late.morale == null) {
      throw new Error('missing rows');
    }

    // Morale has fallen a long way from where it started...
    expect(late.morale).toBeLessThan(early.morale);
    // ...and the bill is people. Not a warning, not a modifier: crew who left.
    expect(pool.headcount).toBeLessThan(50);
  });

  it('and the saving is real, which is what makes it a decision', async () => {
    const lean = await airlineWithBase(20);
    await db.db.update(crewBase).set({ payBand: 'lean' }).where(eq(crewBase.id, lean.crewBaseId));

    const generous = await airlineWithBase(20);
    await db.db
      .update(crewBase)
      .set({ payBand: 'generous' })
      .where(eq(crewBase.id, generous.crewBaseId));

    const november = new Date(Date.UTC(2024, 10, 3));
    await runCrewPayroll(db.db, lean.fixture.world.id, november);
    await runCrewPayroll(db.db, generous.fixture.world.id, november);

    const billFor = async (airlineId: string): Promise<number> => {
      const rows = await db.db
        .select({ amountMinor: cashMovement.amountMinor })
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airlineId));
      return rows
        .filter((row) => row.amountMinor < 0)
        .reduce((total, row) => total + Math.abs(row.amountMinor), 0);
    };

    // §9.2 calls cost-cutting a *viable* strategy. Viable means the money is
    // actually saved, not that a warning is shown.
    expect(await billFor(lean.fixture.airline.id)).toBeLessThan(
      await billFor(generous.fixture.airline.id),
    );
  });

  it('a well-paid base holds its crew', async () => {
    const { fixture, crewBaseId } = await airlineWithBase(50);
    await db.db
      .update(crewBase)
      .set({ payBand: 'generous', hotelTier: 'premium' })
      .where(eq(crewBase.id, crewBaseId));

    for (let week = 0; week <= 26; week += 1) {
      await reviewCrewMorale(db.db, fixture.world.id, weeksLater(week));
    }

    const late = await baseRow(crewBaseId);
    expect(late?.morale).toBeGreaterThan(MORALE.startingMorale);
    // Attrition never reaches zero — nobody keeps everyone — but it is a trickle.
    expect((await poolRow(crewBaseId))?.headcount).toBeGreaterThan(40);
  });

  it('sends crew off sick and gets them back', async () => {
    const { fixture, crewBaseId } = await airlineWithBase(50);
    await db.db
      .update(crewBase)
      .set({ payBand: 'lean', hotelTier: 'budget' })
      .where(eq(crewBase.id, crewBaseId));

    for (let week = 0; week <= 20; week += 1) {
      await reviewCrewMorale(db.db, fixture.world.id, weeksLater(week));
    }
    const ill = await poolRow(crewBaseId);
    expect(ill?.sick).toBeGreaterThan(0);
    expect(ill?.sickUntil).not.toBeNull();

    // Sick leave is days, not weeks: it must clear without waiting for the next
    // review, or a base would be short for the rest of the week whatever the
    // balance said.
    const recovered = await returnSickCrew(
      db.db,
      fixture.world.id,
      new Date(weeksLater(20).getTime() + (MORALE.sicknessDays + 1) * 86_400_000),
    );
    expect(recovered.returned).toBeGreaterThan(0);
    expect((await poolRow(crewBaseId))?.sick).toBe(0);
  });

  it('never commits more heads than the pool has', async () => {
    /*
     * The check constraint is the backstop; this is the arithmetic that must not
     * reach it. A pool whose crew are mostly in a classroom and on an aeroplane
     * has very few left to fall ill, and an unlucky week must not take the
     * committed total past the headcount — one over-committed pool would roll
     * back every other base's review in the same world.
     */
    const { fixture, crewBaseId } = await airlineWithBase(10);
    await db.db
      .update(crewPool)
      .set({ unavailable: 6, onDuty: 3 })
      .where(eq(crewPool.crewBaseId, crewBaseId));
    await db.db
      .update(crewBase)
      .set({ payBand: 'lean', hotelTier: 'budget' })
      .where(eq(crewBase.id, crewBaseId));

    for (let week = 0; week <= 12; week += 1) {
      await reviewCrewMorale(db.db, fixture.world.id, weeksLater(week));
    }

    const rows = await db.db
      .select({
        headcount: crewPool.headcount,
        unavailable: crewPool.unavailable,
        onDuty: crewPool.onDuty,
        sick: crewPool.sick,
      })
      .from(crewPool)
      .where(eq(crewPool.crewBaseId, crewBaseId));
    for (const row of rows) {
      expect(row.unavailable + row.onDuty + row.sick).toBeLessThanOrEqual(row.headcount);
    }
  });

  it('leaves another world’s bases alone', async () => {
    const mine = await airlineWithBase();
    const other = await airlineWithBase();

    await reviewCrewMorale(db.db, mine.fixture.world.id, START);

    expect((await baseRow(mine.crewBaseId))?.morale).not.toBeNull();
    // Game time is per world. A review that read every world's rows against one
    // clock would be wrong in all of them.
    expect((await baseRow(other.crewBaseId))?.morale).toBeNull();
  });
});
