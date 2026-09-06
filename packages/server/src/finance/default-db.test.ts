import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CREDIT } from '@tailfin/sim';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { listFleet } from '../aircraft/fleet';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airline, airport, creditStanding, loan, route, runway } from '../db/schema';
import { openRoute } from '../network/open-route';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { drawLoan, readCreditStanding } from './credit';
import { reviewWorldDefaults } from './default';
import { accrueLoanInterest } from './interest';
import { readProfitAndLoss } from './ledger';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §13.4's drain and §13.5's ladder against real PostgreSQL — M8-07's three
 * acceptance criteria, end to end.
 *
 * The arithmetic and the state machine are already proved without a database in
 * `packages/sim/src/finance/default-ladder.test.ts`. What needs Postgres is
 * everything the criteria are actually about: that the charge reaches the P&L as
 * its own line, that a seizure takes the aeroplane and leaves the livery, and
 * that an airline in administration can pay its way back out.
 *
 * Every instant here is measured from the loan's own `drawn_at` rather than from
 * the world's epoch. A world is founded at *its* game-now, which is already some
 * way past the epoch, so epoch-relative days would be off by the age of the
 * world — and the first version of this file was, by exactly one day.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [finance/default-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const CURE_DAYS = DEFAULT_CREDIT.defaultLadder.cureDays;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The founder facility, drawn in full: §13.2's $250K at 14%, +3% unsecured. */
const FACILITY_MINOR = 25_000_000;
const FACILITY_RATE_BPS = 1_700;
const PER_DAY_MINOR = Math.round(
  (FACILITY_MINOR * FACILITY_RATE_BPS) / 10_000 / DEFAULT_CREDIT.defaultLadder.daysPerYear,
);

describeDb('interest and the default ladder', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  let sequence = 0;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /**
   * An airport with one long, open runway — the office suite's shape.
   *
   * The runway row matters: `endpointsFor` reads the longest **open** runway
   * from `runway`, and an airport with `has_runway_data` but no rows resolves to
   * zero metres and refuses every reference aeroplane as `unreachable`. Which is
   * how the first draft of this file failed, on a route it had every reason to
   * believe was fine.
   */
  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const n = sequence++;
    const icao = `Q${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 7) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_910_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Credit test ${icao}`,
        isoCountry: 'US',
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
      sourceId: -(8_910_000 + n),
      airportId: created.id,
      identifier: '09/27',
      lengthFt: 12_000,
      widthFt: 150,
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
    return icao;
  }

  /** ~600 nm apart, same country: no authority gate, and reachable. */
  async function makeShortHaulPair(): Promise<{ from: string; to: string }> {
    const from = await makeAirport(5, -90);
    const to = await makeAirport(5, -80);
    return { from, to };
  }

  /** Cash in, through a real movement — the balance may not be written directly. */
  async function topUp(fixture: FoundedAirlineFixture, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'flight_settlement',
        reference: `credit-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /** Spend the airline down to exactly `keepMinor`, so a charge cannot be met. */
  async function spendDownTo(fixture: FoundedAirlineFixture, keepMinor: number): Promise<void> {
    const [row] = await db.db
      .select({ cash: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    const cash = Number(row?.cash ?? 0);
    if (cash <= keepMinor) return;
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: -(cash - keepMinor),
        cause: 'crew_payroll',
        reference: `credit-drain-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /** Draw the founder facility, and return the game instant it was drawn at. */
  async function borrow(
    fixture: FoundedAirlineFixture,
    options: { securedAirframeId?: string; principalMinor?: number } = {},
  ): Promise<Date> {
    const outcome = await drawLoan(db.db, own(fixture), {
      instrument: options.securedAirframeId === undefined ? 'working_capital' : 'aircraft_finance',
      principalMinor: options.principalMinor ?? FACILITY_MINOR,
      securedAirframeId: options.securedAirframeId,
    });
    if (!outcome.ok) throw new Error(`Draw refused: ${JSON.stringify(outcome.failure)}`);
    const [row] = await db.db
      .select({ drawnAt: loan.drawnAt })
      .from(loan)
      .where(eq(loan.airlineId, fixture.airline.id))
      .limit(1);
    if (!row) throw new Error('The loan was not written');
    return row.drawnAt;
  }

  /** Run both sweeps at `drawnAt + days`, in the order the tick runs them. */
  async function sweep(fixture: FoundedAirlineFixture, drawnAt: Date, days: number) {
    const gameNow = new Date(drawnAt.getTime() + days * DAY_MS);
    const accrued = await accrueLoanInterest(db.db, fixture.world.id, gameNow);
    const ladder = await reviewWorldDefaults(db.db, fixture.world.id, gameNow);
    return { accrued, ladder, gameNow };
  }

  async function stageOf(fixture: FoundedAirlineFixture): Promise<string> {
    const [row] = await db.db
      .select({ stage: creditStanding.defaultStage })
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));
    return row?.stage ?? 'none';
  }

  /**
   * Walk an airline down to a rung, one cure window per sweep.
   *
   * One window per step is the only way down: the state machine drops at most
   * one rung per review, so reaching administration takes five sweeps however
   * far the clock has moved between them.
   */
  async function descendTo(
    fixture: FoundedAirlineFixture,
    drawnAt: Date,
    rungs: number,
  ): Promise<void> {
    for (let step = 1; step <= rungs; step += 1) {
      await sweep(fixture, drawnAt, step * (CURE_DAYS + 1));
    }
  }

  it('charges a line a game day, and the P&L shows it as interest (AC1)', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);

    const { accrued } = await sweep(fixture, drawnAt, 3);
    expect(accrued.daysCharged).toBe(3);
    expect(accrued.arrearsAddedMinor).toBe(0);
    expect(accrued.paidMinor).toBe(PER_DAY_MINOR * 3);

    const day = (n: number) => new Date(drawnAt.getTime() + n * DAY_MS);
    const pnl = await readProfitAndLoss(db.db, {
      airlineId: fixture.airline.id,
      from: fixture.world.epoch,
      to: day(30),
    });
    const line = pnl.lines.find((l) => l.category === 'interest');
    // §13.4: *"appears in the daily P&L as its own line. It is never hidden in a
    // summary."* Three days is three entries, each dated on its own day.
    expect(line).toBeDefined();
    expect(line?.amountMinor).toBe(PER_DAY_MINOR * 3);
    expect(line?.entryCount).toBe(3);

    // …which is what makes a *daily* P&L answer with one day's drain, rather
    // than with everything the sweep happened to catch up on that morning.
    const oneDay = await readProfitAndLoss(db.db, {
      airlineId: fixture.airline.id,
      from: day(2),
      to: day(2),
    });
    expect(oneDay.lines.find((l) => l.category === 'interest')?.amountMinor).toBe(PER_DAY_MINOR);

    // Borrowing is not trading, but paying for it is: interest is a cost.
    expect(pnl.costMinor).toBeGreaterThanOrEqual(PER_DAY_MINOR * 3);
  });

  it('charges each game day exactly once, however often the sweep runs', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);

    await sweep(fixture, drawnAt, 5);
    const again = await accrueLoanInterest(
      db.db,
      fixture.world.id,
      new Date(drawnAt.getTime() + 5 * DAY_MS),
    );
    expect(again.daysCharged).toBe(0);

    // And a part-day adds nothing: the watermark moves in whole days only.
    const partial = await accrueLoanInterest(
      db.db,
      fixture.world.id,
      new Date(drawnAt.getTime() + 6 * DAY_MS - 1),
    );
    expect(partial.daysCharged).toBe(0);
  });

  it('turns what an airline cannot pay into arrears, and opens the ladder', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);
    await spendDownTo(fixture, 0);

    const { accrued, ladder, gameNow } = await sweep(fixture, drawnAt, 1);
    expect(accrued.paidMinor).toBe(0);
    expect(accrued.arrearsAddedMinor).toBe(PER_DAY_MINOR);
    expect(ladder.escalated).toBe(1);

    const [row] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));
    expect(row?.defaultStage).toBe('warning');
    // §13.5's "7 in-game days to cure", counted in the world's own calendar.
    expect(row?.cureByAt?.getTime()).toBe(gameNow.getTime() + CURE_DAYS * DAY_MS);

    const standing = await readCreditStanding(db.db, own(fixture));
    expect(standing.standing.stage).toBe('warning');
    expect(standing.standing.arrearsMinor).toBe(PER_DAY_MINOR);
    // A warning is a warning: §13.5 gives the airline the window to act in.
    expect(standing.standing.restricted).toBe(false);
    expect(standing.standing.dailyInterestMinor).toBe(PER_DAY_MINOR);
  });

  it('refuses a new route once the lender has restricted the airline', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);
    await spendDownTo(fixture, 0);
    await descendTo(fixture, drawnAt, 2);
    expect(await stageOf(fixture)).toBe('restriction');

    const pair = await makeShortHaulPair();
    const refused = await openRoute(db.db, own(fixture), {
      originIcao: pair.from,
      destinationIcao: pair.to,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.kind).toBe('credit-restriction');
    // Refused means nothing was written.
    expect(await db.db.select().from(route).where(eq(route.airlineId, fixture.airline.id))).toEqual(
      [],
    );

    const standing = await readCreditStanding(db.db, own(fixture));
    expect(standing.standing.restricted).toBe(true);
    expect(standing.standing.message).toContain('no new routes');
  });

  it('seizes the aeroplane and leaves the livery (AC2)', async () => {
    const fixture = await fixtures.create();
    await topUp(fixture, 50_000_000_000);
    const icao = await makeAirport(52, 4);
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`Lease did not deliver: ${JSON.stringify(acquired)}`);
    }
    const airframeId = acquired.airframe.id;

    // The livery document §13.5 says the player keeps.
    const liveryId = randomUUID();
    await db.db.update(airframe).set({ liveryId }).where(eq(airframe.id, airframeId));

    const drawnAt = await borrow(fixture, { securedAirframeId: airframeId });
    await spendDownTo(fixture, 0);
    await descendTo(fixture, drawnAt, 4);
    expect(await stageOf(fixture)).toBe('repossession');

    const [seized] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
    expect(seized?.repossessedAt).not.toBeNull();
    expect(seized?.status).toBe('grounded');
    // The whole point of AC2: the airframe is gone, the livery is not.
    expect(seized?.liveryId).toBe(liveryId);

    // And it has left the fleet, rather than sitting in it grounded for ever.
    const fleet = await listFleet(db.db, own(fixture));
    expect(fleet.airframes.map((a) => a.airframeId)).not.toContain(airframeId);

    // The lender holds its security now, so the loan no longer names one — and
    // cannot be seized against a second time.
    const [written] = await db.db.select().from(loan).where(eq(loan.airlineId, fixture.airline.id));
    expect(written?.securedAirframeId).toBeNull();
  });

  it('puts an airline into administration and lets it buy its way out (AC3)', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);
    await spendDownTo(fixture, 0);
    // A rating that has actually been earned, so "wrecked" has somewhere to fall
    // from. An airline that never left `startup` is a separate case below.
    await db.db
      .update(creditStanding)
      .set({ tier: 'C' })
      .where(eq(creditStanding.airlineId, fixture.airline.id));

    await descendTo(fixture, drawnAt, 5);
    expect(await stageOf(fixture)).toBe('administration');

    // "Control returned": nothing has ceased the airline, and nothing may.
    const [row] = await db.db
      .select({ status: airline.status })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    expect(row?.status).toBe('active');

    // "…with a wrecked rating" — down to `D`, and never to the profit-exempt
    // founder tier, which would make defaulting a way to be handed $250K.
    const [standing] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));
    expect(standing?.tier).toBe('D');

    // Administration is the bottom: a further sweep goes nowhere worse.
    await sweep(fixture, drawnAt, 60);
    expect(await stageOf(fixture)).toBe('administration');

    // Now pay. §13.5's *"recoverable, not run-ending"*, exercised from the very
    // last rung — the only place worth proving it, because every rung above
    // takes the same branch.
    await topUp(fixture, 10_000_000);
    const recovered = await sweep(fixture, drawnAt, 61);
    expect(recovered.ladder.cured).toBe(1);
    expect(await stageOf(fixture)).toBe('none');

    const after = await readCreditStanding(db.db, own(fixture));
    expect(after.standing.stage).toBe('none');
    expect(after.standing.arrearsMinor).toBe(0);
    expect(after.standing.restricted).toBe(false);
    expect(after.standing.message).toBeNull();

    // And the restriction lifts with it.
    const pair = await makeShortHaulPair();
    const opened = await openRoute(db.db, own(fixture), {
      originIcao: pair.from,
      destinationIcao: pair.to,
    });
    expect(opened.ok).toBe(true);
  });

  it('leaves an airline that never earned a rating on the founder tier', async () => {
    const fixture = await fixtures.create();
    const drawnAt = await borrow(fixture);
    await spendDownTo(fixture, 0);
    await descendTo(fixture, drawnAt, 5);

    // `startup` is already the bottom of the rating ladder and the dearest
    // credit in the game. Moving it to `D` would *raise* the cap from $250K to
    // $1M as a consequence of defaulting, which is the wrong direction.
    const [standing] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));
    expect(standing?.tier).toBe('startup');
    expect(standing?.defaultStage).toBe('administration');
  });

  it('does no work at all for a world where nobody has borrowed', async () => {
    const fixture = await fixtures.create();
    const gameNow = new Date(fixture.world.epoch.getTime() + 30 * DAY_MS);
    const accrued = await accrueLoanInterest(db.db, fixture.world.id, gameNow);
    const ladder = await reviewWorldDefaults(db.db, fixture.world.id, gameNow);
    expect(accrued.daysCharged).toBe(0);
    expect(ladder.escalated).toBe(0);
    expect(ladder.cured).toBe(0);
  });
});
