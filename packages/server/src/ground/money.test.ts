import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AirportTier } from '@tailfin/shared';
import { realTimeAtGameTime, type WorldClock } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  airline,
  airlineHub,
  airport,
  cashMovement,
  flight,
  groundContract,
  groundSelfHandling,
  flightResult,
  ledgerEntry,
  world,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { settleArrivedFlight } from '../flight/settle';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  closeSelfHandling,
  expireGroundContracts,
  handlingArrangementFor,
  listAirlineContracts,
  openSelfHandling,
  readStation,
  signContract,
  terminateContract,
} from './contracts';
import { runGroundPayroll } from './payroll';

import type { ResolvedPlayerAirline } from '../airline/context';

const DAY = 86_400_000;

/**
 * What ground handling costs, and the alternative to a vendor (M5-06, §9.3).
 *
 * `contracts.test.ts` proves the two shared-world rules — one handler per line,
 * finite capacity. This file proves the three things the section asks for that
 * cost an airline money, and each of them was a column with nothing behind it
 * until now:
 *
 *   - *"Breaking one early costs a penalty"* — charged on an explicit exit **and**
 *     on a grade switch, because a switch is an early break and a free switch
 *     would mean nobody ever terminated;
 *   - *"contracts run for a fixed term with volume commitments"* — billed at the
 *     end for the departures the airline committed to and did not fly, and
 *     pro-rated on an early exit so leaving cannot escape a shortfall already run
 *     up;
 *   - *"self-handling as an alternative requiring a station and headcount"* — a
 *     hub, heads on a monthly payroll, and a per-turn price a vendor cannot match.
 *
 * Every one of them moves cash, so every one of them is checked against AIR-06's
 * ledger rather than against a return value.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ground/money.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('what ground handling costs', () => {
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

  async function makeAirport(icao: string, tier: AirportTier): Promise<string> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_800_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Ground Money Test ${icao}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude: 7,
        longitude: -30 - n,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    return icao;
  }

  /** Give this airline a hub at a station, which is §9.3's "station". */
  async function giveHub(fixture: FoundedAirlineFixture, icao: string): Promise<void> {
    const [row] = await db.db
      .select({ id: airport.id })
      .from(airport)
      .where(eq(airport.icaoCode, icao))
      .limit(1);
    if (!row) throw new Error(`no airport ${icao}`);
    await db.db
      .insert(airlineHub)
      .values({ airlineId: fixture.airline.id, airportId: row.id })
      .onConflictDoNothing();
  }

  async function clockOf(worldId: string): Promise<WorldClock> {
    const [row] = await db.db
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
      })
      .from(world)
      .where(eq(world.id, worldId))
      .limit(1);
    if (!row) throw new Error('no world');
    return { ...row, speedMultiplier: Number(row.speedMultiplier) };
  }

  /**
   * The wall-clock instant at which this world's game clock reads `gameAt`.
   *
   * A term is a span in the world's calendar, so a test that wants to be "sixty
   * game days later" has to hand the code the real instant that reads as such.
   */
  async function realTimeAt(worldId: string, gameAt: Date): Promise<Date> {
    return realTimeAtGameTime(await clockOf(worldId), gameAt);
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cash: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    return row?.cash ?? 0;
  }

  async function movementsOf(
    airlineId: string,
    cause: 'ground_contract_penalty' | 'ground_volume_shortfall' | 'ground_self_handling_payroll',
  ): Promise<{ amountMinor: number; reference: string }[]> {
    return db.db
      .select({ amountMinor: cashMovement.amountMinor, reference: cashMovement.reference })
      .from(cashMovement)
      .where(and(eq(cashMovement.airlineId, airlineId), eq(cashMovement.cause, cause)));
  }

  /** Sign a standard ramp contract and hand back its id and the term. */
  async function signStandard(
    fixture: FoundedAirlineFixture,
    icao: string,
    now = new Date(),
  ): Promise<{ id: string; termEnd: Date; committed: number; penaltyMinor: number }> {
    const result = await signContract(
      db.db,
      own(fixture),
      icao,
      { serviceLine: 'ramp_baggage', grade: 'standard' },
      now,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('sign failed');
    const line = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
    const contracted = line?.contracted;
    if (!contracted?.termEnd) throw new Error('expected a term');
    return {
      id: contracted.id,
      termEnd: new Date(contracted.termEnd),
      committed: contracted.committedDepartures ?? 0,
      penaltyMinor: contracted.earlyTerminationPenaltyMinor,
    };
  }

  /**
   * Somewhere for a test flight to go.
   *
   * A named airport rather than the fixture's hub, because `airport.icao_code` is
   * **nullable** — M1-01's note: the universal identifier is `ident` — and a
   * fallback to the origin makes the flight circular, which `flight_not_circular`
   * refuses.
   */
  let destination: string | null = null;
  async function elsewhere(): Promise<string> {
    destination ??= await makeAirport('GMZZ', 'large');
    return destination;
  }

  /** Record a flight that actually departed, so it counts against a commitment. */
  async function flew(
    fixture: FoundedAirlineFixture,
    icao: string,
    departedAt: Date,
  ): Promise<void> {
    await db.db.insert(flight).values({
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airframeId: randomUUID(),
      originIcao: icao,
      destinationIcao: await elsewhere(),
      scheduledDeparture: departedAt,
      actualDeparture: departedAt,
      estimatedArrival: new Date(departedAt.getTime() + 3_600_000),
    });
  }

  /**
   * Spend an airline down to almost nothing, through AIR-06.
   *
   * Not a direct `update airline set cash_minor`: a deferred constraint trigger
   * reconciles the balance against the sum of its movements, so money only ever
   * moves by a movement. That guard is the point of AIR-06 and a test must not
   * route around it.
   */
  async function spendDownTo(airlineId: string, leaveMinor: number): Promise<void> {
    const current = await cashOf(airlineId);
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: -(current - leaveMinor),
        cause: 'admin_adjustment',
        reference: `test:${randomUUID()}`,
        occurredAt: new Date(),
      }),
    );
  }

  // ------------------------------------------------------------------ penalty

  describe('breaking a contract early', () => {
    it('charges most of the penalty on the first day and books it as ground handling', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMP1', 'flagship');
      const signed = await signStandard(a, icao);

      // Nothing served yet, so essentially the whole term is being walked away
      // from — and the station view said so before the player pressed anything.
      expect(signed.penaltyMinor).toBeGreaterThan(0);

      const before = await cashOf(a.airline.id);
      const result = await terminateContract(db.db, own(a), signed.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.penaltyMinor).toBe(signed.penaltyMinor);
      expect(await cashOf(a.airline.id)).toBe(before - result.penaltyMinor);

      const [movement] = await movementsOf(a.airline.id, 'ground_contract_penalty');
      expect(movement?.amountMinor).toBe(-result.penaltyMinor);
      expect(movement?.reference).toBe(`contract:${signed.id}`);

      // AIR-06's projection: a player asking what handling cost them finds it.
      const [entry] = await db.db
        .select({ category: ledgerEntry.category })
        .from(ledgerEntry)
        .where(eq(ledgerEntry.airlineId, a.airline.id))
        .orderBy(ledgerEntry.recordedAt);
      expect(entry).toBeDefined();
      const categories = (
        await db.db
          .select({ category: ledgerEntry.category })
          .from(ledgerEntry)
          .where(eq(ledgerEntry.airlineId, a.airline.id))
      ).map((r) => r.category);
      expect(categories).toContain('ground_handling');
    });

    it('costs almost nothing on the last day of the term', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMP2', 'flagship');
      const signed = await signStandard(a, icao);

      // A day short of the term's end: nearly all of it served.
      const nearlyOver = await realTimeAt(a.world.id, new Date(signed.termEnd.getTime() - DAY));
      const result = await terminateContract(db.db, own(a), signed.id, nearlyOver);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.penaltyMinor).toBeLessThan(signed.penaltyMinor * 0.05);
    });

    it('charges the penalty on a grade switch too, because a switch is a break', async () => {
      // Otherwise switching would be the free exit and nobody would ever
      // terminate: sign premium, switch to budget, walk away owing nothing.
      const a = await fixtures.create();
      const icao = await makeAirport('GMP3', 'flagship');
      const signed = await signStandard(a, icao);

      const before = await cashOf(a.airline.id);
      const switched = await signContract(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        grade: 'budget',
      });
      expect(switched.ok).toBe(true);
      expect(await cashOf(a.airline.id)).toBe(before - signed.penaltyMinor);
      expect(await movementsOf(a.airline.id, 'ground_contract_penalty')).toHaveLength(1);
    });

    it('refuses the exit when the airline cannot pay for it, and changes nothing', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMP4', 'flagship');
      const signed = await signStandard(a, icao);

      // Leave the airline a few cents. Every other player-initiated spend in the
      // game refuses rather than going negative, and so does this.
      await spendDownTo(a.airline.id, 10);

      const result = await terminateContract(db.db, own(a), signed.id);
      expect(result).toEqual({ ok: false, code: 'insufficient_funds' });

      // The refusal proves the target and the money are both untouched (SEC-07).
      expect(await cashOf(a.airline.id)).toBe(10);
      const [row] = await db.db
        .select({ status: groundContract.status })
        .from(groundContract)
        .where(eq(groundContract.id, signed.id));
      expect(row?.status).toBe('active');
      expect(await movementsOf(a.airline.id, 'ground_contract_penalty')).toHaveLength(0);
    });

    it('answers 404 rather than throwing when two terminations race', async () => {
      /*
       * BUG-04. `breakContract` did not check that its status update matched a
       * row, so the loser of the race went on to bill anyway — reaching AIR-06
       * with the same `(cause, reference)` and a different amount and instant,
       * which makes `assertSameCause` throw. A double-clicked terminate produced
       * a 500 where the player should have seen an ordinary 404.
       */
      const a = await fixtures.create();
      const icao = await makeAirport('GMP6', 'flagship');
      const signed = await signStandard(a, icao);

      const [first, second] = await Promise.all([
        terminateContract(db.db, own(a), signed.id),
        terminateContract(db.db, own(a), signed.id),
      ]);

      // Exactly one wins; the other is refused the way any missing contract is.
      const outcomes = [first, second];
      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok)).toEqual([{ ok: false, code: 'not_found' }]);

      // And the penalty was charged once, not twice.
      expect(await movementsOf(a.airline.id, 'ground_contract_penalty')).toHaveLength(1);
    });

    it('answers 404 rather than throwing when a termination races the expiry sweep', async () => {
      // The same defect reached from the worker's side, which is the likelier of
      // the two: the sweep lapses a contract and bills its shortfall, and the
      // player's terminate — which read the row as active a moment earlier — used
      // to bill the same reference again with a different figure.
      const a = await fixtures.create();
      const icao = await makeAirport('GMP7', 'flagship');
      const signed = await signStandard(a, icao);
      const afterTerm = new Date(signed.termEnd.getTime() + DAY);

      const [sweep, terminated] = await Promise.all([
        expireGroundContracts(db.db, a.world.id, afterTerm),
        terminateContract(db.db, own(a), signed.id, await realTimeAt(a.world.id, afterTerm)),
      ]);

      // Whichever ordering the database chose, the contract is closed exactly
      // once and the shortfall billed exactly once.
      expect(sweep.expired + (terminated.ok ? 1 : 0)).toBe(1);
      expect(await movementsOf(a.airline.id, 'ground_volume_shortfall')).toHaveLength(1);

      const [row] = await db.db
        .select({ status: groundContract.status })
        .from(groundContract)
        .where(eq(groundContract.id, signed.id));
      expect(['terminated', 'expired']).toContain(row?.status);
    });

    it('will not break another airline’s contract', async () => {
      const a = await fixtures.create();
      const b = await fixtures.create({ worldId: a.world.id });
      const icao = await makeAirport('GMP5', 'flagship');
      const signed = await signStandard(a, icao);

      expect(await terminateContract(db.db, own(b), signed.id)).toEqual({
        ok: false,
        code: 'not_found',
      });
      expect(await movementsOf(a.airline.id, 'ground_contract_penalty')).toHaveLength(0);
      expect(await movementsOf(b.airline.id, 'ground_contract_penalty')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------- volume commitment

  describe('the volume commitment', () => {
    it('bills the departures a term ended without flying', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMV1', 'flagship');
      const signed = await signStandard(a, icao);
      expect(signed.committed).toBeGreaterThan(0);

      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      const before = await cashOf(a.airline.id);

      // The term ends with nothing flown out of the station at all.
      const result = await expireGroundContracts(
        db.db,
        a.world.id,
        new Date(signed.termEnd.getTime() + DAY),
      );
      expect(result.expired).toBe(1);
      expect(result.shortfalls).toBe(1);
      expect(result.shortfallMinor).toBe(
        signed.committed * economy.ground.contract.shortfallFeePerDepartureMinor,
      );
      expect(await cashOf(a.airline.id)).toBe(before - result.shortfallMinor);
    });

    it('bills nothing when the airline flew what it promised', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMV2', 'flagship');
      const signed = await signStandard(a, icao);

      // Fly the whole commitment inside the term.
      const start = signed.termEnd.getTime() - 90 * DAY;
      for (let i = 0; i < signed.committed; i += 1) {
        await flew(a, icao, new Date(start + (i + 1) * 3_600_000));
      }

      const before = await cashOf(a.airline.id);
      const result = await expireGroundContracts(
        db.db,
        a.world.id,
        new Date(signed.termEnd.getTime() + DAY),
      );
      expect(result.expired).toBe(1);
      expect(result.shortfalls).toBe(0);
      expect(await cashOf(a.airline.id)).toBe(before);
    });

    it('counts only flights that actually left the stand', async () => {
      // A cancelled or never-dispatched flight was never handled, so crediting it
      // would pay the airline for work the vendor did not do.
      const a = await fixtures.create();
      const icao = await makeAirport('GMV3', 'flagship');
      const signed = await signStandard(a, icao);
      const start = signed.termEnd.getTime() - 90 * DAY;

      for (let i = 0; i < signed.committed; i += 1) {
        await db.db.insert(flight).values({
          worldId: a.world.id,
          airlineId: a.airline.id,
          airframeId: randomUUID(),
          originIcao: icao,
          destinationIcao: await elsewhere(),
          scheduledDeparture: new Date(start + (i + 1) * 3_600_000),
          // Scheduled and never dispatched.
          actualDeparture: null,
          estimatedArrival: new Date(start + (i + 1) * 3_600_000 + 3_600_000),
        });
      }

      const result = await expireGroundContracts(
        db.db,
        a.world.id,
        new Date(signed.termEnd.getTime() + DAY),
      );
      expect(result.shortfalls).toBe(1);
    });

    it('does not count another station’s departures', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMV4', 'flagship');
      const elsewhere = await makeAirport('GMV5', 'flagship');
      const signed = await signStandard(a, icao);
      const start = signed.termEnd.getTime() - 90 * DAY;
      for (let i = 0; i < signed.committed; i += 1) {
        await flew(a, elsewhere, new Date(start + (i + 1) * 3_600_000));
      }
      const result = await expireGroundContracts(
        db.db,
        a.world.id,
        new Date(signed.termEnd.getTime() + DAY),
      );
      expect(result.shortfalls).toBe(1);
    });

    it('pro-rates the shortfall on an early exit rather than forgiving it', async () => {
      // The dodge this closes: sign premium, fly nothing, terminate the day
      // before the term ends and owe nothing at all.
      const a = await fixtures.create();
      const icao = await makeAirport('GMV6', 'flagship');
      const signed = await signStandard(a, icao);

      const nearlyOver = await realTimeAt(a.world.id, new Date(signed.termEnd.getTime() - DAY));
      const result = await terminateContract(db.db, own(a), signed.id, nearlyOver);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Nearly the whole commitment was owed, and none of it was flown.
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      expect(result.shortfallMinor).toBeGreaterThan(
        signed.committed * economy.ground.contract.shortfallFeePerDepartureMinor * 0.9,
      );
    });

    it('does not credit departures made after the term ended (BUG-10)', async () => {
      /*
       * The break path measured the shortfall to *now* while the expiry sweep
       * clamped to `term_end`. So terminating a contract whose term had already
       * run out — which happens whenever a worker is down over a boundary, and
       * always on a world with no worker at all — counted every departure since
       * the term ended and wiped out a shortfall genuinely incurred.
       */
      const a = await fixtures.create();
      const icao = await makeAirport('GMX1', 'flagship');
      const signed = await signStandard(a, icao);
      const termStart = signed.termEnd.getTime() - 90 * DAY;

      // Nothing flown inside the term...
      // ...and the whole commitment flown after it ended.
      for (let i = 0; i < signed.committed + 5; i += 1) {
        await flew(a, icao, new Date(signed.termEnd.getTime() + (i + 1) * 3_600_000));
      }
      expect(termStart).toBeLessThan(signed.termEnd.getTime());

      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      const wellAfter = new Date(signed.termEnd.getTime() + 30 * DAY);
      const result = await terminateContract(
        db.db,
        own(a),
        signed.id,
        await realTimeAt(a.world.id, wellAfter),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The full commitment is owed: those flights belong to nobody's contract.
      expect(result.shortfallMinor).toBe(
        signed.committed * economy.ground.contract.shortfallFeePerDepartureMinor,
      );
    });

    it('bills an overdue termination the same as the sweep would have (BUG-10)', async () => {
      // The two paths have to agree, which is the reason they now share a helper.
      // Separate worlds: a sweep is world-scoped, so one world would lapse both
      // contracts before the second could be terminated.
      const viaSweep = await fixtures.create();
      const viaExit = await fixtures.create();
      const sweepIcao = await makeAirport('GMX2', 'flagship');
      const exitIcao = await makeAirport('GMX3', 'flagship');

      const swept = await signStandard(viaSweep, sweepIcao);
      const exited = await signStandard(viaExit, exitIcao);

      // Both fly nothing in the term and a handful after it.
      for (let i = 0; i < 4; i += 1) {
        await flew(viaSweep, sweepIcao, new Date(swept.termEnd.getTime() + (i + 1) * 3_600_000));
        await flew(viaExit, exitIcao, new Date(exited.termEnd.getTime() + (i + 1) * 3_600_000));
      }

      const sweepResult = await expireGroundContracts(
        db.db,
        viaSweep.world.id,
        new Date(swept.termEnd.getTime() + 10 * DAY),
      );
      const exitResult = await terminateContract(
        db.db,
        own(viaExit),
        exited.id,
        await realTimeAt(viaExit.world.id, new Date(exited.termEnd.getTime() + 10 * DAY)),
      );

      expect(sweepResult.expired).toBe(1);
      expect(exitResult.ok).toBe(true);
      if (!exitResult.ok) return;
      expect(exitResult.shortfallMinor).toBe(sweepResult.shortfallMinor);
    });

    it('is unchanged for a termination inside the term (BUG-10)', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMX4', 'flagship');
      const signed = await signStandard(a, icao);
      const start = signed.termEnd.getTime() - 90 * DAY;
      for (let i = 0; i < 10; i += 1) await flew(a, icao, new Date(start + (i + 1) * 3_600_000));

      const halfway = new Date(signed.termEnd.getTime() - 45 * DAY);
      const result = await terminateContract(
        db.db,
        own(a),
        signed.id,
        await realTimeAt(a.world.id, halfway),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Half the commitment owed, ten flown: a real but partial shortfall.
      expect(result.shortfallMinor).toBeGreaterThan(0);
    });

    it('bills each term once, however many times the sweep runs', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMV7', 'flagship');
      const signed = await signStandard(a, icao);
      const after = new Date(signed.termEnd.getTime() + DAY);

      const first = await expireGroundContracts(db.db, a.world.id, after);
      const second = await expireGroundContracts(db.db, a.world.id, after);
      expect(first.expired).toBe(1);
      expect(second).toEqual({ expired: 0, shortfalls: 0, shortfallMinor: 0 });
      expect(await movementsOf(a.airline.id, 'ground_volume_shortfall')).toHaveLength(1);
    });

    it('warns about a live shortfall before the term closes', async () => {
      // §9.3's alert, applied to the more expensive surprise of the two: a term
      // running out short is billed at the end, when nothing can be done.
      const a = await fixtures.create();
      const icao = await makeAirport('GMV8', 'flagship');
      const signed = await signStandard(a, icao);

      const halfway = await realTimeAt(a.world.id, new Date(signed.termEnd.getTime() - 45 * DAY));
      const listed = await listAirlineContracts(db.db, own(a), halfway);
      const alert = listed.contracts.find((c) => c.icao === icao);
      expect(alert?.kind).toBe('vendor');
      expect(alert?.committedDepartures).toBe(signed.committed);
      expect(alert?.departuresFlown).toBe(0);
      // Half the term served with nothing flown: about half the commitment owed.
      expect(alert?.shortfallFeeMinor).toBeGreaterThan(0);
      expect(alert?.earlyTerminationPenaltyMinor).toBeGreaterThan(0);
    });

    it('counts each contract’s own departures when several are listed (BUG-07)', async () => {
      /*
       * The alert used to run one `count` per contract. Batching them is a single
       * query joined against a `values` list of windows, and the thing that can
       * go wrong is the join: every contract has its own station *and* its own
       * term start, so a shared window would credit the wrong flights to the
       * wrong contract.
       *
       * Three contracts, three stations, three different departure counts, and
       * one of them signed later than the others.
       */
      const a = await fixtures.create();
      const busy = await makeAirport('GMB1', 'flagship');
      const quiet = await makeAirport('GMB2', 'flagship');
      const idle = await makeAirport('GMB3', 'flagship');

      const signedBusy = await signStandard(a, busy);
      const signedQuiet = await signStandard(a, quiet);

      const start = signedBusy.termEnd.getTime() - 90 * DAY;
      for (let i = 0; i < 7; i += 1) await flew(a, busy, new Date(start + (i + 1) * 3_600_000));
      for (let i = 0; i < 2; i += 1) await flew(a, quiet, new Date(start + (i + 1) * 3_600_000));

      // Signed a fortnight later, so the flights above are outside its term and
      // must not be credited to it.
      const lateAt = await realTimeAt(a.world.id, new Date(start + 14 * DAY));
      const signedIdle = await signContract(
        db.db,
        own(a),
        idle,
        { serviceLine: 'ramp_baggage', grade: 'standard' },
        lateAt,
      );
      expect(signedIdle.ok).toBe(true);
      await flew(a, idle, new Date(start + 15 * DAY));
      // ...and one at `idle` *before* its term started, which must not count.
      await flew(a, idle, new Date(start + 1 * DAY));

      const listed = await listAirlineContracts(
        db.db,
        own(a),
        await realTimeAt(a.world.id, new Date(start + 30 * DAY)),
      );
      const at = (icao: string) => listed.contracts.find((c) => c.icao === icao);

      expect(at(busy)?.departuresFlown).toBe(7);
      expect(at(quiet)?.departuresFlown).toBe(2);
      expect(at(idle)?.departuresFlown).toBe(1);
      expect(signedQuiet.committed).toBeGreaterThan(0);
    });

    it('gives the same figures listed together as one at a time (BUG-07)', async () => {
      // The batch replaced a per-contract query, so it has to agree with what
      // the single-contract path — still used by the expiry sweep and by an
      // early exit — computes for the same window.
      const a = await fixtures.create();
      const icao = await makeAirport('GMB4', 'flagship');
      const signed = await signStandard(a, icao);
      const start = signed.termEnd.getTime() - 90 * DAY;
      for (let i = 0; i < 5; i += 1) await flew(a, icao, new Date(start + (i + 1) * 3_600_000));

      const at = new Date(start + 45 * DAY);
      const listed = await listAirlineContracts(db.db, own(a), await realTimeAt(a.world.id, at));
      const alert = listed.contracts.find((c) => c.icao === icao);

      // Terminating measures the same window to the same instant.
      const terminated = await terminateContract(
        db.db,
        own(a),
        signed.id,
        await realTimeAt(a.world.id, at),
      );
      expect(terminated.ok).toBe(true);
      if (!terminated.ok) return;
      expect(alert?.shortfallFeeMinor).toBe(terminated.shortfallMinor);
    });

    it('reports the real departure count for a contract that owes no volume (BUG-09)', async () => {
      // A budget handler asks for no volume, so the pro-rated commitment is zero
      // and `shortfall` used to return before counting anything — publishing a
      // fabricated `departuresFlown: 0` for a station the airline had flown out
      // of hundreds of times. The field is nullable precisely so it can say "not
      // measured" instead.
      const a = await fixtures.create();
      const icao = await makeAirport('GMF1', 'flagship');
      const signed = await signContract(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        grade: 'budget',
      });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;

      const line = signed.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      const termEnd = line?.contracted?.termEnd;
      if (!termEnd) throw new Error('expected a term');
      const start = new Date(termEnd).getTime() - 90 * DAY;
      for (let i = 0; i < 6; i += 1) await flew(a, icao, new Date(start + (i + 1) * 3_600_000));

      const listed = await listAirlineContracts(
        db.db,
        own(a),
        await realTimeAt(a.world.id, new Date(start + 30 * DAY)),
      );
      const alert = listed.contracts.find((c) => c.icao === icao);
      expect(alert?.committedDepartures).toBe(0);
      expect(alert?.departuresFlown).toBe(6);
      expect(alert?.shortfallFeeMinor).toBe(0);
    });

    it('reports the real count inside the term’s first days too (BUG-09)', async () => {
      // The same early return fires whenever `round(commitment × served)` is
      // still zero, which is every contract for its first day or so.
      const a = await fixtures.create();
      const icao = await makeAirport('GMF2', 'flagship');
      const signed = await signStandard(a, icao);
      // An hour into the term, where `round(commitment x served)` is still zero.
      const termStart = new Date(signed.termEnd.getTime() - 90 * DAY);
      await flew(a, icao, new Date(termStart.getTime() + 3_600_000));

      // Two hours in: `round(63 x 2h/90d)` is still zero, so the old early
      // return fired — and the departure an hour ago plainly happened.
      const listed = await listAirlineContracts(
        db.db,
        own(a),
        await realTimeAt(a.world.id, new Date(termStart.getTime() + 2 * 3_600_000)),
      );
      const alert = listed.contracts.find((c) => c.icao === icao);
      expect(alert?.committedDepartures).toBeGreaterThan(0);
      expect(alert?.departuresFlown).toBe(1);
    });

    it('reports null, not zero, when there is no term to count from (BUG-09)', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMF3', 'flagship');
      await db.db.insert(groundContract).values({
        worldId: a.world.id,
        airlineId: a.airline.id,
        airportIcao: icao,
        serviceLine: 'ramp_baggage',
        grade: 'premium',
        status: 'active',
      });

      const listed = await listAirlineContracts(db.db, own(a));
      const alert = listed.contracts.find((c) => c.icao === icao);
      expect(alert?.departuresFlown).toBeNull();
    });

    it('never bills a contract signed before terms were priced', async () => {
      // `term_start`, `volume_commitment` and `penalty_minor` are all null on such
      // a row, and null means nobody agreed anything. It still lapses.
      const a = await fixtures.create();
      const icao = await makeAirport('GMV9', 'flagship');
      const clock = await clockOf(a.world.id);
      const gameNow = new Date(clock.epoch.getTime() + 10 * DAY);
      await db.db.insert(groundContract).values({
        worldId: a.world.id,
        airlineId: a.airline.id,
        airportIcao: icao,
        serviceLine: 'ramp_baggage',
        grade: 'premium',
        status: 'active',
        termEnd: gameNow,
      });

      const result = await expireGroundContracts(
        db.db,
        a.world.id,
        new Date(gameNow.getTime() + DAY),
      );
      expect(result).toEqual({ expired: 1, shortfalls: 0, shortfallMinor: 0 });
      expect(await movementsOf(a.airline.id, 'ground_volume_shortfall')).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ self-handling

  describe('handling a line yourself', () => {
    it('needs a hub at the station, which is §9.3’s "station"', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS1', 'large');
      expect(
        await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 20 }),
      ).toEqual({ ok: false, code: 'needs_hub' });
      expect(
        await db.db
          .select({ id: groundSelfHandling.id })
          .from(groundSelfHandling)
          .where(eq(groundSelfHandling.airlineId, a.airline.id)),
      ).toHaveLength(0);
    });

    it('says on the station view why it is unavailable, and what it would take', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS2', 'large');
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      const station = await readStation(db.db, own(a), icao);
      const ramp = station?.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.selfHandling).toEqual({
        available: false,
        unavailableReason: 'needs_hub',
        requiredHeadcount: economy.ground.selfHandling.requiredHeadcountByTier.large,
        salaryPerHeadMinor: economy.ground.selfHandling.salaryPerHeadMinor,
      });
    });

    it('opens with a hub, and reports how well it is staffed', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS3', 'large');
      await giveHub(a, icao);
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      const required = economy.ground.selfHandling.requiredHeadcountByTier.large;

      const result = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: required,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ramp = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.contracted?.kind).toBe('self');
      expect(ramp?.contracted?.grade).toBeNull();
      expect(ramp?.contracted?.headcount).toBe(required);
      expect(ramp?.contracted?.staffing).toBe(1);
      // No term and nothing to commit to: there is no counterparty.
      expect(ramp?.contracted?.termEnd).toBeNull();
      expect(ramp?.contracted?.committedDepartures).toBeNull();
      expect(ramp?.contracted?.earlyTerminationPenaltyMinor).toBe(0);
    });

    it('reports an understaffed operation as understaffed', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS4', 'large');
      await giveHub(a, icao);
      const result = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: 4,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ramp = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.contracted?.staffing).toBeLessThan(1);
      expect(ramp?.contracted?.staffing).toBeGreaterThan(0);
    });

    it('restaffs in place rather than opening a second operation', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS5', 'large');
      await giveHub(a, icao);
      await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 6 });
      const result = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: 24,
      });
      expect(result.ok).toBe(true);

      const rows = await db.db
        .select({ headcount: groundSelfHandling.headcount, status: groundSelfHandling.status })
        .from(groundSelfHandling)
        .where(eq(groundSelfHandling.airlineId, a.airline.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ headcount: 24, status: 'active' });
    });

    it('is exclusive with a vendor — taking a line back breaks the contract', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS6', 'flagship');
      await giveHub(a, icao);
      const signed = await signStandard(a, icao);

      const before = await cashOf(a.airline.id);
      const result = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: 10,
      });
      expect(result.ok).toBe(true);

      // The vendor's contract is gone, its slot is free, and the break was paid
      // for: "open self-handling with one head" must not be the free way out.
      const [contract] = await db.db
        .select({ status: groundContract.status })
        .from(groundContract)
        .where(eq(groundContract.id, signed.id));
      expect(contract?.status).toBe('terminated');
      expect(await cashOf(a.airline.id)).toBeLessThan(before);
      expect(await movementsOf(a.airline.id, 'ground_contract_penalty')).toHaveLength(1);
    });

    it('is exclusive the other way too — signing a vendor closes the operation', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS7', 'flagship');
      await giveHub(a, icao);
      await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 10 });

      const signed = await signContract(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        grade: 'premium',
      });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      const ramp = signed.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.contracted?.kind).toBe('vendor');

      const active = await db.db
        .select({ status: groundSelfHandling.status })
        .from(groundSelfHandling)
        .where(
          and(
            eq(groundSelfHandling.airlineId, a.airline.id),
            eq(groundSelfHandling.status, 'active'),
          ),
        );
      expect(active).toHaveLength(0);
    });

    it('closes without a penalty, dropping the line back to walk-up', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMS8', 'large');
      await giveHub(a, icao);
      const opened = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: 10,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const id = opened.station.lines.find((l) => l.serviceLine === 'ramp_baggage')?.contracted?.id;
      if (!id) throw new Error('no operation id');

      const before = await cashOf(a.airline.id);
      expect(await closeSelfHandling(db.db, own(a), id)).toBe(icao);
      expect(await cashOf(a.airline.id)).toBe(before);

      const station = await readStation(db.db, own(a), icao);
      expect(station?.lines.find((l) => l.serviceLine === 'ramp_baggage')?.contracted).toBeNull();
    });

    it('will not close another airline’s operation', async () => {
      const a = await fixtures.create();
      const b = await fixtures.create({ worldId: a.world.id });
      const icao = await makeAirport('GMS9', 'large');
      await giveHub(a, icao);
      const opened = await openSelfHandling(db.db, own(a), icao, {
        serviceLine: 'ramp_baggage',
        headcount: 10,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const id = opened.station.lines.find((l) => l.serviceLine === 'ramp_baggage')?.contracted?.id;
      if (!id) throw new Error('no operation id');

      expect(await closeSelfHandling(db.db, own(b), id)).toBeNull();
      const [row] = await db.db
        .select({ status: groundSelfHandling.status })
        .from(groundSelfHandling)
        .where(eq(groundSelfHandling.id, id));
      expect(row?.status).toBe('active');
    });

    it('is what the sim reads for the turn, ahead of any vendor', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMSA', 'large');
      await giveHub(a, icao);
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 7 });

      expect(
        await handlingArrangementFor(db.db, a.airline.id, icao, 'ramp_baggage', economy),
      ).toEqual({
        kind: 'self',
        headcount: 7,
        requiredHeadcount: economy.ground.selfHandling.requiredHeadcountByTier.large,
      });
    });

    it('reads as walk-up when the airline has arranged nothing', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMSB', 'large');
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      expect(
        await handlingArrangementFor(db.db, a.airline.id, icao, 'ramp_baggage', economy),
      ).toEqual({ kind: 'walk_up' });
    });

    it('lists an operation on the network alert with no term and no shortfall', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMSC', 'large');
      await giveHub(a, icao);
      await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 14 });

      const listed = await listAirlineContracts(db.db, own(a));
      const alert = listed.contracts.find((c) => c.icao === icao);
      expect(alert).toMatchObject({
        kind: 'self',
        grade: null,
        headcount: 14,
        termEnd: null,
        expiring: false,
        committedDepartures: null,
        departuresFlown: null,
        shortfallFeeMinor: 0,
        earlyTerminationPenaltyMinor: 0,
      });
    });
  });

  // ------------------------------------------------------------------ payroll

  describe('self-handling payroll', () => {
    /**
     * Payroll is an **accrual**, not a monthly snapshot of the headcount.
     *
     * The first version billed the previous month against whoever was on the
     * books when the sweep ran. Staffing is free and instant to change, so that
     * was trivially avoidable — and self-handling with no payroll is not a trade
     * against a vendor, it is strictly better than one at every station.
     */

    /** Midnight on the first of the month after the world's epoch. */
    async function firstMonthEnd(worldId: string): Promise<Date> {
      const { epoch } = await clockOf(worldId);
      return new Date(Date.UTC(epoch.getUTCFullYear(), epoch.getUTCMonth() + 1, 1));
    }

    async function paidBy(airlineId: string): Promise<number> {
      const movements = await movementsOf(airlineId, 'ground_self_handling_payroll');
      return movements.reduce((total, m) => total - m.amountMinor, 0);
    }

    it('cannot be dodged by dropping the headcount before the sweep', async () => {
      // BUG-03, exactly: run 40 heads all month, drop to 1 on the last day, and
      // the old sweep billed 1 head for the whole month. Restaffing afterwards
      // cost nothing, so the dodge was repeatable with no downtime.
      const honest = await fixtures.create();
      const dodger = await fixtures.create({ worldId: honest.world.id });
      const icaoA = await makeAirport('GMR1', 'large');
      const icaoB = await makeAirport('GMR2', 'large');
      await giveHub(honest, icaoA);
      await giveHub(dodger, icaoB);

      const monthEnd = await firstMonthEnd(honest.world.id);
      const openAt = await realTimeAt(
        honest.world.id,
        await clockOf(honest.world.id).then((c) => c.epoch),
      );

      await openSelfHandling(
        db.db,
        own(honest),
        icaoA,
        { serviceLine: 'ramp_baggage', headcount: 40 },
        openAt,
      );
      await openSelfHandling(
        db.db,
        own(dodger),
        icaoB,
        { serviceLine: 'ramp_baggage', headcount: 40 },
        openAt,
      );

      // The dodge: drop to one head an hour before the month closes.
      await openSelfHandling(
        db.db,
        own(dodger),
        icaoB,
        { serviceLine: 'ramp_baggage', headcount: 1 },
        await realTimeAt(dodger.world.id, new Date(monthEnd.getTime() - 3_600_000)),
      );

      await runGroundPayroll(db.db, honest.world.id, new Date(monthEnd.getTime() + DAY));

      // Within an hour of 40 heads of each other, which is the sliver the dodger
      // genuinely did run at one head.
      const honestPaid = await paidBy(honest.airline.id);
      const dodgerPaid = await paidBy(dodger.airline.id);
      expect(dodgerPaid).toBeGreaterThan(honestPaid * 0.99);
    });

    it('charges the whole staff for the span it actually worked', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMR3', 'large');
      await giveHub(a, icao);
      const economy = await loadWorldEconomyConfig(db.db, a.world.id);
      const { epoch } = await clockOf(a.world.id);
      const monthEnd = await firstMonthEnd(a.world.id);

      await openSelfHandling(
        db.db,
        own(a),
        icao,
        { serviceLine: 'ramp_baggage', headcount: 10 },
        await realTimeAt(a.world.id, epoch),
      );
      await runGroundPayroll(db.db, a.world.id, new Date(monthEnd.getTime() + DAY));

      // A month's salary is quoted monthly and accrues daily, so a year comes to
      // exactly twelve of them: the rate is salary / (365/12) a day.
      const days = (monthEnd.getTime() - epoch.getTime()) / DAY;
      const expected = Math.round(
        (10 * economy.ground.selfHandling.salaryPerHeadMinor * days) / (365 / 12),
      );
      // Opening happens a moment after the epoch instant asked for, so allow a
      // few minutes of drift rather than pinning to the minor unit.
      expect(await paidBy(a.airline.id)).toBeGreaterThan(expected * 0.999);
      expect(await paidBy(a.airline.id)).toBeLessThanOrEqual(expected);
    });

    it('bills once a month however many ticks run', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMR4', 'large');
      await giveHub(a, icao);
      await openSelfHandling(db.db, own(a), icao, { serviceLine: 'ramp_baggage', headcount: 12 });
      const monthEnd = await firstMonthEnd(a.world.id);
      const gameNow = new Date(monthEnd.getTime() + DAY);

      const first = await runGroundPayroll(db.db, a.world.id, gameNow);
      expect(first.airlinesBilled).toBe(1);
      const afterFirst = await cashOf(a.airline.id);

      // Attempted every tick, settled once: the watermark is the guard, so a
      // second run finds a zero-length span rather than reaching AIR-06's replay
      // check with a different amount.
      const second = await runGroundPayroll(db.db, a.world.id, gameNow);
      expect(second).toEqual({ airlinesBilled: 0, totalMinor: 0, headcount: 0 });
      expect(await cashOf(a.airline.id)).toBe(afterFirst);
    });

    it('pays for the part of a month a closed operation worked', async () => {
      // The other half of the dodge: a station used for three weeks and closed
      // before the sweep used to cost nothing at all.
      const a = await fixtures.create();
      const icao = await makeAirport('GMR5', 'large');
      await giveHub(a, icao);
      const { epoch } = await clockOf(a.world.id);
      const opened = await openSelfHandling(
        db.db,
        own(a),
        icao,
        { serviceLine: 'ramp_baggage', headcount: 15 },
        await realTimeAt(a.world.id, epoch),
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const id = opened.station.lines.find((l) => l.serviceLine === 'ramp_baggage')?.contracted?.id;
      if (!id) throw new Error('no operation id');

      await closeSelfHandling(
        db.db,
        own(a),
        id,
        await realTimeAt(a.world.id, new Date(epoch.getTime() + 21 * DAY)),
      );
      expect(await paidBy(a.airline.id)).toBeGreaterThan(0);

      // And nothing further accrues once it is closed.
      const paid = await paidBy(a.airline.id);
      await runGroundPayroll(db.db, a.world.id, new Date(epoch.getTime() + 120 * DAY));
      expect(await paidBy(a.airline.id)).toBe(paid);
    });

    it('self-heals when the worker was down across a boundary', async () => {
      // The watermark is behind, so the next tick settles the whole span at once
      // rather than skipping a payday.
      const a = await fixtures.create();
      const icao = await makeAirport('GMR6', 'large');
      await giveHub(a, icao);
      const { epoch } = await clockOf(a.world.id);
      await openSelfHandling(
        db.db,
        own(a),
        icao,
        { serviceLine: 'ramp_baggage', headcount: 8 },
        await realTimeAt(a.world.id, epoch),
      );

      // Nothing ran for four months.
      const result = await runGroundPayroll(
        db.db,
        a.world.id,
        new Date(epoch.getTime() + 120 * DAY),
      );
      expect(result.airlinesBilled).toBe(1);

      const oneMonth =
        8 *
        (await loadWorldEconomyConfig(db.db, a.world.id)).ground.selfHandling.salaryPerHeadMinor;
      // Three whole months at least, since settlement stops at the start of the
      // current month rather than at today.
      expect(await paidBy(a.airline.id)).toBeGreaterThan(oneMonth * 2.9);
    });

    it('charges nothing for a month still being worked', async () => {
      const a = await fixtures.create();
      const icao = await makeAirport('GMR7', 'large');
      await giveHub(a, icao);
      const { epoch } = await clockOf(a.world.id);
      await openSelfHandling(
        db.db,
        own(a),
        icao,
        { serviceLine: 'ramp_baggage', headcount: 8 },
        await realTimeAt(a.world.id, epoch),
      );

      // Half way through the opening month: nothing has closed yet.
      const result = await runGroundPayroll(
        db.db,
        a.world.id,
        new Date(epoch.getTime() + 10 * DAY),
      );
      expect(result).toEqual({ airlinesBilled: 0, totalMinor: 0, headcount: 0 });
      expect(await paidBy(a.airline.id)).toBe(0);
    });

    it('bills nothing in a world where nobody handles anything themselves', async () => {
      const a = await fixtures.create();
      const clock = await clockOf(a.world.id);
      expect(
        await runGroundPayroll(db.db, a.world.id, new Date(clock.epoch.getTime() + 60 * DAY)),
      ).toEqual({ airlinesBilled: 0, totalMinor: 0, headcount: 0 });
    });

    it('is scoped to one world', async () => {
      const a = await fixtures.create();
      const b = await fixtures.create();
      const icao = await makeAirport('GMR8', 'large');
      await giveHub(b, icao);
      await openSelfHandling(db.db, own(b), icao, { serviceLine: 'ramp_baggage', headcount: 9 });

      const clock = await clockOf(a.world.id);
      const result = await runGroundPayroll(
        db.db,
        a.world.id,
        new Date(clock.epoch.getTime() + 60 * DAY),
      );
      expect(result.airlinesBilled).toBe(0);
      expect(await movementsOf(b.airline.id, 'ground_self_handling_payroll')).toHaveLength(0);
    });
  });

  // ------------------------------------------------------- what a turn costs

  describe('what a turn costs a settled flight', () => {
    /**
     * The §9.3 trade, where a player actually meets it: the `handling` line of a
     * settled `flight_result`.
     *
     * One station and one world throughout, with the arrangement changed between
     * flights — so the handler is the only thing that can have moved the bill.
     * Everything else about these flights is identical by construction.
     */
    async function settleFrom(
      fixture: FoundedAirlineFixture,
      originIcao: string,
      destinationIcao: string,
    ): Promise<{ handlingMinor: number; detail: string }> {
      const departs = new Date('2026-08-17T06:00:00.000Z');
      const [f] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId: randomUUID(),
          originIcao,
          destinationIcao,
          scheduledDeparture: departs,
          actualDeparture: departs,
          estimatedArrival: new Date(departs.getTime() + 75 * 60_000),
          load: JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } }),
        })
        .returning({ id: flight.id });
      if (!f) throw new Error('no flight');

      const outcome = await db.db.transaction((tx) =>
        settleArrivedFlight(tx, f.id, new Date(departs.getTime() + 75 * 60_000)),
      );
      expect(outcome.status).toBe('settled');

      const [row] = await db.db
        .select({ breakdown: flightResult.breakdown })
        .from(flightResult)
        .where(eq(flightResult.flightId, f.id));
      if (!row) throw new Error('no result');
      const breakdown = JSON.parse(row.breakdown) as {
        costs: { source: string; amountMinor: number; detail: string }[];
      };
      const handling = breakdown.costs.find((c) => c.source === 'handling');
      if (!handling) throw new Error('no handling line');
      return { handlingMinor: handling.amountMinor, detail: handling.detail };
    }

    it('prices the five ways of getting an aeroplane away in the designed order', async () => {
      /*
       * The whole of §9.3's price axis, on one station in one world. Before
       * M5-06's money every one of these five numbers was identical — which is
       * why the budget handler, slower and clumsier at *the same price*, was a
       * choice no player would ever have made.
       *
       * The order is: your own people, then budget, standard, walk-up, premium.
       * Two parts of it carry the design:
       *
       *   - **walk-up is dearer than standard.** Handling bought on the day
       *     costs more than handling bought on a term, which is what makes
       *     signing anything worth doing — and a budget contract nearly halves
       *     it while *matching* walk-up's reliability, which is why the cheap
       *     handler is a real choice rather than a trap.
       *   - **premium is dearer than walk-up.** It is not a discount for
       *     committing; it is the best service in the market, and it costs the
       *     most of anything a vendor sells.
       */
      const a = await fixtures.create();
      const origin = await makeAirport('GTC1', 'flagship');
      const destination = await makeAirport('GTC2', 'large');
      await giveHub(a, origin);

      const walkUp = await settleFrom(a, origin, destination);

      await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'premium' });
      const premium = await settleFrom(a, origin, destination);

      await signContract(db.db, own(a), origin, {
        serviceLine: 'ramp_baggage',
        grade: 'standard',
      });
      const standard = await settleFrom(a, origin, destination);

      await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });
      const budget = await settleFrom(a, origin, destination);

      await openSelfHandling(db.db, own(a), origin, {
        serviceLine: 'ramp_baggage',
        headcount: 40,
      });
      const mine = await settleFrom(a, origin, destination);

      expect(mine.handlingMinor).toBeLessThan(budget.handlingMinor);
      expect(budget.handlingMinor).toBeLessThan(standard.handlingMinor);
      expect(standard.handlingMinor).toBeLessThan(walkUp.handlingMinor);
      expect(walkUp.handlingMinor).toBeLessThan(premium.handlingMinor);
    });

    it('says on the line why it cost what it did', async () => {
      // §14.1: no figure a player cannot interrogate. A multiplier applied
      // silently would leave "why is my handling 992 and not 735" unanswerable.
      const a = await fixtures.create();
      const origin = await makeAirport('GTC3', 'flagship');
      const destination = await makeAirport('GTC4', 'large');

      const walkUp = await settleFrom(a, origin, destination);
      expect(walkUp.detail).toMatch(/for how this station is handled/);

      await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'standard' });
      const standard = await settleFrom(a, origin, destination);
      // The standard grade *is* the rate, so there is no multiplier to explain.
      expect(standard.detail).not.toMatch(/for how this station is handled/);
    });

    it('reads the origin’s handler, not the destination’s', async () => {
      // The departure turn is the one being billed, so it is the origin's ramp
      // that works it.
      const a = await fixtures.create();
      const origin = await makeAirport('GTC5', 'flagship');
      const destination = await makeAirport('GTC6', 'flagship');

      await signContract(db.db, own(a), destination, {
        serviceLine: 'ramp_baggage',
        grade: 'budget',
      });
      const stillWalkUp = await settleFrom(a, origin, destination);

      await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });
      const contracted = await settleFrom(a, origin, destination);

      expect(contracted.handlingMinor).toBeLessThan(stillWalkUp.handlingMinor);
    });

    it('charges an understaffed operation the same per turn as a full one', async () => {
      // Understaffing saves money on the payroll, not on the turn — folding it in
      // here would pay a player twice for the same cut, and the consequence of
      // the cut is a worse handler rather than a cheaper one.
      const a = await fixtures.create();
      const origin = await makeAirport('GTC7', 'large');
      const destination = await makeAirport('GTC8', 'large');
      await giveHub(a, origin);

      await openSelfHandling(db.db, own(a), origin, {
        serviceLine: 'ramp_baggage',
        headcount: 28,
      });
      const full = await settleFrom(a, origin, destination);

      await openSelfHandling(db.db, own(a), origin, { serviceLine: 'ramp_baggage', headcount: 2 });
      const thin = await settleFrom(a, origin, destination);

      expect(thin.handlingMinor).toBe(full.handlingMinor);
    });
  });
});
