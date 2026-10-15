import { randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type CreditStandingResponse, type FinancePnlResponse } from '@tailfin/shared';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, airport, cashMovement, ledgerEntry, loan } from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  resourceIdCases,
} from '../test-fixtures/resource-id';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { InjectOptions } from 'fastify';

/**
 * The Finance page's server half, over HTTP (SURFACE-02, -03, -06).
 *
 * Three surfaces over shipped endpoints, and the smallest changes they needed:
 *
 *   - `GET /api/finance/pnl` ends its default period at the **world's** now, and
 *     takes `?days=` so the page's §14.2 period control can ask for one without
 *     reading a clock it should not (SURFACE-03).
 *   - `GET /api/statistics/:metricId/breakdown` takes the same period (SURFACE-06).
 *   - `GET /api/credit` carries what SURFACE-02 renders and must not compute:
 *     each instrument's price, §13.1's multipliers, the next rung's terms and
 *     §13.4's interest as a share of profit.
 *
 * And SURFACE-02's own criteria at the API boundary: the draw's body id is
 * concealed in all four SEC-07 cases, and a refused draw leaves the airline's
 * cash, its ledger and its loans exactly as they were.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [finance/finance-surface-routes] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('finance/surface-routes');
const DAY_MS = 86_400_000;

describeDb('the Finance page’s endpoints', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];
  let ownAirframeId: string;
  let competitorAirframeId: string;

  function own(fixture: OwnershipTestSuite['airlineA']): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  const asA = (request: InjectOptions) =>
    suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request);

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Finance surface ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'medium_airport',
      latitude: 52,
      longitude: 4,
      scheduledService: true,
      hasRunwayData: false,
      tier: 'medium',
      slotLevel: 2,
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  async function lease(fixture: OwnershipTestSuite['airlineA'], icao: string): Promise<string> {
    const acquired = await acquireAircraft(db.db, own(fixture), {
      requestId: randomUUID(),
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: icao,
    });
    if (!acquired.ok || acquired.airframe === null) throw new Error('lease did not deliver');
    return acquired.airframe.id;
  }

  /** A day of trading, dated on the world's clock: revenue 10,000 and fuel 3,000. */
  async function tradeOn(fixture: OwnershipTestSuite['airlineA'], at: Date): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 7_000,
        cause: 'flight_settlement',
        reference: `surface-${randomUUID()}`,
        occurredAt: at,
        ledgerLines: [
          { amountMinor: 10_000, category: 'ticket', counterparty: 'passengers' },
          { amountMinor: -3_000, category: 'fuel', counterparty: 'fuel_supplier' },
        ],
      }),
    );
  }

  /** Everything a refused draw must not have touched. */
  async function moneyOf(airlineId: string) {
    const [cash] = await db.db
      .select({ cash: airline.cashMinor })
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
    const loans = await db.db
      .select({ id: loan.id })
      .from(loan)
      .where(eq(loan.airlineId, airlineId));
    return {
      cash: Number(cash?.cash ?? Number.NaN),
      movements: movements?.n ?? -1,
      ledgerLines: lines?.n ?? -1,
      loans: loans.length,
    };
  }

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
    suite = await createOwnershipTestSuite({ db, env, suite: 'finance-surface-routes' });
    await suite.app.ready();
    const icao = await makeAirport();
    ownAirframeId = await lease(suite.airlineA, icao);
    competitorAirframeId = await lease(suite.airlineB, icao);
  });

  afterAll(async () => {
    await suite.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  // ---------------------------------------------------------------- the P&L

  describe('GET /api/finance/pnl', () => {
    it('ends its default period at the world’s now, not the reader’s', async () => {
      /*
       * The fixture world runs on the flagship calendar, years from the wall
       * clock — so a default period ending at `new Date()`, which is what this
       * used to do, would find nothing dated yesterday on the world's clock.
       */
      const gameNow = await worldGameNow(db.db, suite.worldMain.id);
      await tradeOn(suite.airlineA, new Date(gameNow.getTime() - DAY_MS));

      const response = await asA({ method: 'GET', url: '/api/finance/pnl' });
      expect(response.statusCode).toBe(200);
      const body = response.json<FinancePnlResponse>();
      expect(Math.abs(Date.parse(body.to) - gameNow.getTime())).toBeLessThan(60 * DAY_MS);
      expect(body.revenueMinor).toBeGreaterThanOrEqual(10_000);
    });

    it('reads the period the page asks for, in game days', async () => {
      const gameNow = await worldGameNow(db.db, suite.worldMain.id);
      await tradeOn(suite.airlineA, new Date(gameNow.getTime() - 20 * DAY_MS));

      const week = (
        await asA({ method: 'GET', url: '/api/finance/pnl?days=7' })
      ).json<FinancePnlResponse>();
      const month = (
        await asA({ method: 'GET', url: '/api/finance/pnl?days=30' })
      ).json<FinancePnlResponse>();

      expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * DAY_MS);
      // The trade twenty days ago is in the month and not in the week.
      expect(month.revenueMinor - week.revenueMinor).toBeGreaterThanOrEqual(10_000);
    });

    it('refuses a period that is not one', async () => {
      for (const query of ['days=0', 'days=abc', 'days=400', 'days=7&from=2024-01-01T00:00:00Z']) {
        const response = await asA({ method: 'GET', url: `/api/finance/pnl?${query}` });
        expect(response.statusCode, query).toBe(400);
      }
    });
  });

  // ------------------------------------------------------------- statistics

  describe('GET /api/statistics/:metricId/breakdown', () => {
    it('answers over §14.2’s three windows, and says which', async () => {
      for (const days of [7, 30, 90]) {
        const response = await asA({
          method: 'GET',
          url: `/api/statistics/load_factor/breakdown?days=${String(days)}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<{ windowDays: number }>().windowDays).toBe(days);
      }
    });

    it('refuses any other window rather than explaining a figure the page cannot show', async () => {
      for (const days of ['14', '0', 'x', '365']) {
        const response = await asA({
          method: 'GET',
          url: `/api/statistics/load_factor/breakdown?days=${days}`,
        });
        expect(response.statusCode, days).toBe(400);
      }
    });
  });

  // ----------------------------------------------------------------- credit

  describe('GET /api/credit', () => {
    it('prices each instrument, and carries what the page must not compute', async () => {
      const response = await asA({ method: 'GET', url: '/api/credit' });
      expect(response.statusCode).toBe(200);
      const credit = response.json<CreditStandingResponse>();

      // SEC-09: the client draws at a price it was told.
      expect(credit.instruments.map((quote) => quote.instrument).sort()).toEqual([
        'aircraft_finance',
        'facility',
        'working_capital',
      ]);
      const rate = (instrument: string) =>
        credit.instruments.find((quote) => quote.instrument === instrument)?.annualRateBps ?? 0;
      // Unsecured money is dearer than the tier rate and secured money cheaper.
      expect(rate('working_capital')).toBeGreaterThan(credit.annualRateBps);
      expect(rate('aircraft_finance')).toBeLessThan(credit.annualRateBps);
      expect(rate('facility')).toBe(credit.annualRateBps);

      // §13.1's multipliers, so the formula can be shown as one.
      expect(credit.formula.profitMultiple).toBeGreaterThan(0);
      expect(credit.formula.assetAdvanceRate).toBeGreaterThan(0);
      // §13.2's next rung and the asymmetry that governs reaching it.
      expect(credit.nextTier?.tier).toBe('D');
      expect(credit.nextTier?.requires.profitableMonths).toBeGreaterThan(0);
      expect(credit.rating.reviewsToRise).toBeGreaterThan(0);
    });

    it('states §13.4’s interest per month and as a share of profit, loan by loan', async () => {
      // A fresh airline in the other world, so the book is just this loan.
      const before = (
        await suite.as(
          { actor: 'playerA', worldId: suite.worldOther.id },
          { method: 'GET', url: '/api/credit' },
        )
      ).json<CreditStandingResponse>();
      expect(before.interest.monthlyMinor).toBe(0);

      const drawn = await suite.as(
        { actor: 'playerA', worldId: suite.worldOther.id },
        {
          method: 'POST',
          url: '/api/credit/loans',
          payload: { instrument: 'working_capital', principalMinor: 12_000_000 },
        },
      );
      expect(drawn.statusCode).toBe(201);
      const after = drawn.json<CreditStandingResponse>();
      const [book] = after.loans;
      expect(book?.monthlyInterestMinor).toBe(
        Math.round(Math.round((12_000_000 * (book?.annualRateBps ?? 0)) / 10_000) / 12),
      );
      expect(after.interest.monthlyMinor).toBe(book?.monthlyInterestMinor);
      // A founded airline has earned nothing yet: there is no profit for the
      // interest to be a share of, and the answer says so rather than inventing one.
      expect(after.interest.shareOfOperatingProfit).toBeNull();
      expect(book?.shareOfOperatingProfit).toBeNull();
    });
  });

  // -------------------------------------------- the draw, at the API boundary

  describe('POST /api/credit/loans, SEC-07', () => {
    const draw = (securedAirframeId: string): InjectOptions => ({
      method: 'POST',
      url: '/api/credit/loans',
      payload: { instrument: 'aircraft_finance', principalMinor: 1_000_000, securedAirframeId },
    });

    it('conceals another player’s airframe exactly like a missing one, and moves nothing', async () => {
      const before = await moneyOf(suite.airlineA.airline.id);
      const refused = await Promise.all(
        resourceIdCases({
          own: ownAirframeId,
          anotherPlayer: competitorAirframeId,
          // A real id of the wrong kind: the airline's own id.
          wrongEntity: suite.airlineA.airline.id,
          absent: ABSENT_RESOURCE_UUID,
        })
          .filter(({ expected }) => expected === 'conceal')
          .map(({ id }) => asA(draw(id))),
      );

      for (const response of refused) {
        expect(response.statusCode).toBe(404);
        expect(response.json<{ code: string }>().code).toBe('unknown_airframe');
      }
      expect(new Set(refused.map((response) => response.body)).size).toBe(1);
      expect(await moneyOf(suite.airlineA.airline.id)).toEqual(before);
      // And the competitor's books are untouched too.
      expect(
        await db.db
          .select({ id: loan.id })
          .from(loan)
          .where(and(eq(loan.airlineId, suite.airlineB.airline.id))),
      ).toEqual([]);
    });

    it('rejects a malformed airframe id before anything is read', async () => {
      const before = await moneyOf(suite.airlineA.airline.id);
      for (const malformed of MALFORMED_RESOURCE_IDS) {
        const response = await asA(draw(malformed));
        expect(response.statusCode, JSON.stringify(malformed)).toBe(400);
      }
      expect(await moneyOf(suite.airlineA.airline.id)).toEqual(before);
    });

    it('lends against the airline’s own airframe', async () => {
      const response = await asA(draw(ownAirframeId));
      expect(response.statusCode).toBe(201);
      const credit = response.json<CreditStandingResponse>();
      expect(credit.loans.some((entry) => entry.securedAirframeId === ownAirframeId)).toBe(true);
    });

    it('refuses a draw past the airline’s capacity, leaving cash, ledger and loans unchanged', async () => {
      const standing = (
        await asA({ method: 'GET', url: '/api/credit' })
      ).json<CreditStandingResponse>();
      const before = await moneyOf(suite.airlineA.airline.id);

      const response = await asA({
        method: 'POST',
        url: '/api/credit/loans',
        payload: {
          instrument: 'working_capital',
          principalMinor: standing.headroomMinor + 1,
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ code: string }>().code).toBe('refused');
      expect(await moneyOf(suite.airlineA.airline.id)).toEqual(before);
    });

    it('refuses a body that tries to set a rate or a term — terms are the server’s (SEC-09)', async () => {
      const before = await moneyOf(suite.airlineA.airline.id);
      const response = await asA({
        method: 'POST',
        url: '/api/credit/loans',
        payload: {
          instrument: 'working_capital',
          principalMinor: 100_000,
          annualRateBps: 1,
          termMonths: 999,
        },
      });
      // A strict request schema: the client cannot even send a price.
      expect(response.statusCode).toBe(400);
      expect(await moneyOf(suite.airlineA.airline.id)).toEqual(before);
    });
  });

  it('refuses a guest everywhere the page reads or writes', async () => {
    for (const request of [
      { method: 'GET' as const, url: '/api/finance/pnl' },
      { method: 'GET' as const, url: '/api/credit' },
      { method: 'GET' as const, url: '/api/statistics/load_factor/breakdown?days=7' },
      {
        method: 'POST' as const,
        url: '/api/credit/loans',
        payload: { instrument: 'working_capital', principalMinor: 100 },
      },
    ]) {
      expect((await suite.app.inject(request)).statusCode).toBe(401);
    }
  });
});
