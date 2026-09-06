import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, creditStanding, loan } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { drawLoan, readCreditStanding } from './credit';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §13 against real PostgreSQL, and M8-06's acceptance criteria end to end.
 *
 * The sim tests already prove the arithmetic. What needs a database is that the
 * arithmetic is fed the airline's *actual* trading: that a founded airline with
 * no history really can draw its founder facility, that a loss really does close
 * the door, and that a draw writes the loan and the AIR-06 movement together or
 * not at all. Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [finance/credit-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('credit standing and drawing a loan', () => {
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

  /** Trading, written as real AIR-06 movements so the ledger is the source. */
  async function trade(
    fixture: FoundedAirlineFixture,
    lines: { amountMinor: number; cause: 'flight_settlement' | 'crew_payroll' }[],
  ): Promise<void> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    for (const [index, line] of lines.entries()) {
      const occurredAt = new Date(gameNow);
      occurredAt.setUTCMonth(occurredAt.getUTCMonth() - index - 1);
      await db.db.transaction(async (tx) => {
        await moveAirlineCash(tx, {
          airlineId: fixture.airline.id,
          amountMinor: line.amountMinor,
          cause: line.cause,
          reference: `test ${String(index)}`,
          occurredAt,
        });
      });
    }
  }

  it('starts a founded airline on the founder facility, drawable at once', async () => {
    const fixture = await fixtures.create();
    const standing = await readCreditStanding(db.db, own(fixture));

    expect(standing.tier).toBe('startup');
    // §13.2's $250K, available with no trading whatever behind it.
    expect(standing.maxTotalDebtMinor).toBe(25_000_000);
    expect(standing.trailing.operatingProfitMinor).toBeLessThanOrEqual(0);
    expect(standing.canBorrow).toBe(true);
    expect(standing.annualRateBps).toBe(1_400);
  });

  it('draws the facility, writing the loan and the cash together', async () => {
    const fixture = await fixtures.create();
    const before = fixture.airline.cash;

    const outcome = await drawLoan(db.db, own(fixture), {
      instrument: 'working_capital',
      principalMinor: 20_000_000,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const rows = await db.db.select().from(loan).where(eq(loan.airlineId, fixture.airline.id));
    expect(rows).toHaveLength(1);
    // Working capital is the tier rate +3% — 14% becomes 17%.
    expect(rows[0]).toMatchObject({
      principalMinor: 20_000_000,
      outstandingMinor: 20_000_000,
      annualRateBps: 1_700,
      tierAtDraw: 'startup',
      status: 'active',
    });

    // The cash arrived, and the ledger reconciles — the deferred trigger would
    // have refused the transaction otherwise.
    expect(outcome.standing.outstandingDebtMinor).toBe(20_000_000);
    const [airlineRow] = await db.db
      .select({ cash: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixture.airline.id));
    expect(Number(airlineRow?.cash ?? 0)).toBe(before + 20_000_000);
  });

  it('refuses more than the founder facility allows', async () => {
    const fixture = await fixtures.create();
    const outcome = await drawLoan(db.db, own(fixture), {
      instrument: 'working_capital',
      principalMinor: 25_000_001,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('refused');
    // Refused means nothing happened: no loan row, and no cash.
    expect(await db.db.select().from(loan).where(eq(loan.airlineId, fixture.airline.id))).toEqual(
      [],
    );
  });

  it('closes the door on a loss-making airline once it has left the startup tier', async () => {
    const fixture = await fixtures.create();
    // Twelve months of trading at a loss, written as real movements.
    await trade(
      fixture,
      Array.from({ length: 12 }, () => ({
        amountMinor: -1_000_000,
        cause: 'crew_payroll' as const,
      })),
    );

    // Force the rating past `startup` so the profit test applies, then re-read.
    await db.db
      .insert(creditStanding)
      .values({ airlineId: fixture.airline.id, worldId: fixture.world.id, tier: 'C' })
      .onConflictDoUpdate({ target: creditStanding.airlineId, set: { tier: 'C' } });

    const standing = await readCreditStanding(db.db, own(fixture));
    expect(standing.trailing.operatingProfitMinor).toBeLessThan(0);
    expect(standing.limits.profitMultipleMinor).toBe(0);
    expect(standing.maxTotalDebtMinor).toBe(0);
    expect(standing.canBorrow).toBe(false);
    expect(standing.refusal).toContain('borrowing limit');
  });

  it('will not lend against another airline’s aeroplane', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const outcome = await drawLoan(db.db, own(mine), {
      instrument: 'aircraft_finance',
      principalMinor: 1_000_000,
      // A well-formed id that is not this airline's — concealed, per ADR-0020.
      securedAirframeId: theirs.airline.id,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe('unknown_airframe');
  });

  it('asks aircraft finance to name what it is secured on', async () => {
    const fixture = await fixtures.create();
    const outcome = await drawLoan(db.db, own(fixture), {
      instrument: 'aircraft_finance',
      principalMinor: 1_000_000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe('security_required');
  });

  it('records the rating review it performed, so hysteresis has a history', async () => {
    const fixture = await fixtures.create();
    await readCreditStanding(db.db, own(fixture));
    const [row] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));
    expect(row?.tier).toBe('startup');
    // Null would mean never reviewed, and one has just happened.
    expect(row?.lastReviewedAt).not.toBeNull();
  });

  it('does not re-review within the same game month', async () => {
    const fixture = await fixtures.create();
    const first = await readCreditStanding(db.db, own(fixture));
    const [before] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));

    await readCreditStanding(db.db, own(fixture));
    const [after] = await db.db
      .select()
      .from(creditStanding)
      .where(eq(creditStanding.airlineId, fixture.airline.id));

    // Otherwise a player could rush a rise by reloading the page.
    expect(after?.lastReviewedAt?.toISOString()).toBe(before?.lastReviewedAt?.toISOString());
    expect(first.tier).toBe(after?.tier);
  });

  it('keeps a drawn loan out of the P&L’s revenue and cost', async () => {
    const fixture = await fixtures.create();
    await drawLoan(db.db, own(fixture), {
      instrument: 'working_capital',
      principalMinor: 10_000_000,
    });
    const standing = await readCreditStanding(db.db, own(fixture));
    // Borrowing is not trading. A draw counted as revenue would make a loan look
    // like a good quarter, which is the confusion §13.1 exists to prevent.
    expect(standing.trailing.operatingProfitMinor).toBeLessThanOrEqual(0);
  });
});
