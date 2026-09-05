import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';

import {
  GROUND_SERVICE_LINES,
  type AirportTier,
  type GroundContractAlert,
  type GroundContractsResponse,
  type GroundContractView,
  type GroundServiceLine,
  type GroundServiceLineView,
  type GroundStationResponse,
  type HandlerGrade,
  type OpenSelfHandlingRequest,
  type SignContractRequest,
} from '@tailfin/shared';
import {
  committedDepartures,
  contractExpiring,
  contractTermEnd,
  elapsedTermFraction,
  gameTime,
  handlerProfile,
  selfHandlingProfile,
  stationVendors,
  type HandlingArrangement,
  type WorldClock,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import {
  airlineHub,
  airport,
  flight,
  groundContract,
  groundSelfHandling,
  world,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { settleSelfHandlingAccrual } from './payroll';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { PinnedEconomyConfig } from '../economy/config';

/**
 * Ground handling contracts (M5-06, §9.3).
 *
 * The vendors are derived; this owns the rows an airline signs against them, the
 * two rules that make ground ops a shared world — **one active handler per
 * service line at a station**, and a vendor's **finite capacity** that competing
 * airlines exhaust — and, since the milestone's money landed, the three ways
 * ground handling costs an airline something other than a per-turn fee:
 *
 *   - **the early-termination penalty** (§9.3: *"breaking one early costs a
 *     penalty"*), pro-rated to what is left of the term and charged on a grade
 *     switch as well as an explicit exit, because a switch *is* an early break;
 *   - **the volume shortfall**, billed when a term ends without the committed
 *     departures having been flown, and pro-rated on an early exit so that
 *     leaving cannot be used to escape a shortfall already run up;
 *   - **self-handling**, which is not a contract with anyone: it needs a hub at
 *     the station and heads on the payroll, and it trades a per-turn fee for a
 *     fixed monthly one.
 *
 * Owner-scoped throughout — the airline is resolved from the session, never
 * accepted from the client.
 *
 * ## Exclusivity spans two tables, so a lock spans them too
 *
 * A partial unique index gives each table its own one-active-per-line rule, but
 * no constraint can say *"a vendor contract and your own people may not both
 * work this line"*. Every writer therefore takes
 * `pg_advisory_xact_lock(hashtext(world:icao:line))` and closes the other kind
 * inside it. That lock is deliberately coarser than the `world:icao:line:grade`
 * key it replaced: a line-level lock still serialises everyone contending for any
 * grade's last slot, so the capacity limit stays exact, and it is the only key
 * both writers can agree on.
 */

interface StationContext {
  seed: string;
  tier: AirportTier | null;
  clock: WorldClock;
  economy: PinnedEconomyConfig;
  /** Whether this airline holds a hub here — §9.3's *"requiring a station"*. */
  hasHub: boolean;
}

async function loadStationContext(
  db: Database,
  worldId: string,
  airlineId: string,
  icao: string,
): Promise<StationContext | null> {
  const clock = await loadWorldClock(db, worldId);
  if (clock === null) return null;
  const [w] = await db
    .select({ seed: world.seed })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!w) return null;
  const [a] = await db
    .select({ id: airport.id, tier: airport.tier })
    .from(airport)
    .where(eq(airport.icaoCode, icao))
    .limit(1);
  if (!a) return null;
  if (a.tier === null) return null;

  const [hub] = await db
    .select({ id: airlineHub.id })
    .from(airlineHub)
    .where(and(eq(airlineHub.airlineId, airlineId), eq(airlineHub.airportId, a.id)))
    .limit(1);

  return {
    seed: w.seed,
    tier: a.tier,
    clock,
    economy: await loadWorldEconomyConfig(db, worldId),
    hasHub: hub !== undefined,
  };
}

/** The world's clock parameters, or null for an unknown world. */
async function loadWorldClock(db: Database, worldId: string): Promise<WorldClock | null> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/**
 * Heads a station needs staffed for the airline to handle it itself.
 *
 * The station's requirement rather than the schedule's — see the economy config's
 * note on why. A field with no tier is charged the `medium` requirement rather
 * than refused, the same fallback per-station fuel pricing makes: a tier is null
 * only where there is no scheduled service, and an aeroplane that got there still
 * needed handling.
 */
export function requiredHeadcount(tier: AirportTier | null, economy: PinnedEconomyConfig): number {
  return economy.ground.selfHandling.requiredHeadcountByTier[tier ?? 'medium'];
}

/** The money terms `handlingPriceFactor` needs, sliced out of a world's economy. */
export function handlingPriceBalanceOf(economy: PinnedEconomyConfig): {
  walkUpPriceIndex: number;
  selfHandlingTurnPriceIndex: number;
} {
  return {
    walkUpPriceIndex: economy.ground.walkUpPriceIndex,
    selfHandlingTurnPriceIndex: economy.ground.selfHandling.turnPriceIndex,
  };
}

/** What a grade's full-term break fee is, at signing. */
function fullTermPenaltyMinor(grade: HandlerGrade, economy: PinnedEconomyConfig): number {
  return Math.round(
    economy.ground.contract.terminationPenaltyPerTermMinor * handlerProfile(grade).priceIndex,
  );
}

/** What a grade's term commits the airline to flying. */
function commitmentFor(grade: HandlerGrade, economy: PinnedEconomyConfig): number {
  return committedDepartures(economy.ground.contract.committedDeparturesPerDay[grade]);
}

interface ActiveRow {
  id: string;
  airlineId: string;
  serviceLine: string;
  grade: string;
  termStart: Date | null;
  termEnd: Date | null;
  volumeCommitment: number | null;
  penaltyMinor: number | null;
}

async function activeAt(db: Database, worldId: string, icao: string): Promise<ActiveRow[]> {
  return db
    .select({
      id: groundContract.id,
      airlineId: groundContract.airlineId,
      serviceLine: groundContract.serviceLine,
      grade: groundContract.grade,
      termStart: groundContract.termStart,
      termEnd: groundContract.termEnd,
      volumeCommitment: groundContract.volumeCommitment,
      penaltyMinor: groundContract.penaltyMinor,
    })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.worldId, worldId),
        eq(groundContract.airportIcao, icao),
        eq(groundContract.status, 'active'),
      ),
    );
}

interface SelfRow {
  id: string;
  serviceLine: string;
  headcount: number;
}

/** This airline's own operations at one station. */
async function selfHandlingAt(db: Database, airlineId: string, icao: string): Promise<SelfRow[]> {
  return db
    .select({
      id: groundSelfHandling.id,
      serviceLine: groundSelfHandling.serviceLine,
      headcount: groundSelfHandling.headcount,
    })
    .from(groundSelfHandling)
    .where(
      and(
        eq(groundSelfHandling.airlineId, airlineId),
        eq(groundSelfHandling.airportIcao, icao),
        eq(groundSelfHandling.status, 'active'),
      ),
    );
}

/**
 * The instant a term stops accruing obligations.
 *
 * Never past `term_end`: after it the vendor has stopped working, so departures
 * made later are not its departures and a shortfall measured through them would
 * be forgiven by flights it had nothing to do with.
 *
 * Both money paths need this and they used to disagree. `expireGroundContracts`
 * clamped, with a comment saying why; `breakContract` measured to *now*, so
 * terminating a contract whose term had already run out — which is what happens
 * whenever a worker is down over a boundary, and always on a world that has no
 * worker at all — credited every departure since the term ended and wiped out a
 * shortfall the airline had genuinely incurred. One helper, so the two cannot
 * drift apart again.
 */
function obligationsEndAt(row: ActiveRow, gameNow: Date): Date {
  if (row.termEnd === null) return gameNow;
  return row.termEnd.getTime() < gameNow.getTime() ? row.termEnd : gameNow;
}

/**
 * What walking away from a contract costs right now.
 *
 * The stored full-term figure, pro-rated to the part of the term **not served**.
 * A row with no term — signed before terms were priced — costs nothing to leave,
 * which is the truthful answer for a contract nobody agreed a term with.
 */
function penaltyNowMinor(row: ActiveRow, gameNow: Date): number {
  if (row.penaltyMinor === null || row.termStart === null || row.termEnd === null) return 0;
  const unserved = 1 - elapsedTermFraction(row.termStart, row.termEnd, gameNow);
  return Math.max(0, Math.round(row.penaltyMinor * unserved));
}

/** The vendor-contract half of a station's line view. */
function contractView(
  row: ActiveRow,
  serviceLine: GroundServiceLine,
  gameNow: Date,
): GroundContractView {
  return {
    id: row.id,
    serviceLine,
    kind: 'vendor',
    grade: row.grade as HandlerGrade,
    headcount: null,
    staffing: null,
    termEnd: row.termEnd === null ? null : row.termEnd.toISOString(),
    expiring: contractExpiring(row.termEnd, gameNow),
    committedDepartures: row.volumeCommitment,
    earlyTerminationPenaltyMinor: penaltyNowMinor(row, gameNow),
  };
}

/** The self-handling half of a station's line view. */
function selfView(
  row: SelfRow,
  serviceLine: GroundServiceLine,
  required: number,
): GroundContractView {
  return {
    id: row.id,
    serviceLine,
    kind: 'self',
    grade: null,
    headcount: row.headcount,
    staffing: selfHandlingProfile(row.headcount, required).staffing,
    // No term, so nothing to expire and nothing to commit to: there is no
    // counterparty to have agreed either with.
    termEnd: null,
    expiring: false,
    committedDepartures: null,
    earlyTerminationPenaltyMinor: 0,
  };
}

/** Build the station view from its offers and the world's active contracts there. */
function buildStation(
  icao: string,
  ctx: StationContext,
  active: readonly ActiveRow[],
  own: readonly SelfRow[],
  airlineId: string,
  gameNow: Date,
): GroundStationResponse {
  // Contracts taken per (service line, grade), across every airline in the world.
  const taken = new Map<string, number>();
  for (const row of active) {
    const key = `${row.serviceLine}:${row.grade}`;
    taken.set(key, (taken.get(key) ?? 0) + 1);
  }

  const required = requiredHeadcount(ctx.tier, ctx.economy);

  const lines: GroundServiceLineView[] = GROUND_SERVICE_LINES.map((serviceLine) => {
    const mine = active.find((r) => r.airlineId === airlineId && r.serviceLine === serviceLine);
    const mineSelf = own.find((r) => r.serviceLine === serviceLine);
    return {
      serviceLine,
      // Exclusive by construction, and the advisory lock is what makes that true
      // rather than this ordering — but if both somehow existed, the airline's own
      // people are what is actually working the turn.
      contracted:
        mineSelf !== undefined
          ? selfView(mineSelf, serviceLine, required)
          : mine !== undefined
            ? contractView(mine, serviceLine, gameNow)
            : null,
      offers: stationVendors(ctx.seed, icao, serviceLine, ctx.tier ?? 'medium').map((offer) => {
        const profile = handlerProfile(offer.grade);
        return {
          grade: offer.grade,
          capacity: offer.capacity,
          taken: taken.get(`${serviceLine}:${offer.grade}`) ?? 0,
          reliability: profile.reliability,
          speedFactor: profile.speedFactor,
          quality: profile.quality,
          priceIndex: profile.priceIndex,
          committedDepartures: commitmentFor(offer.grade, ctx.economy),
          fullTermPenaltyMinor: fullTermPenaltyMinor(offer.grade, ctx.economy),
        };
      }),
      selfHandling: {
        available: ctx.hasHub,
        unavailableReason: ctx.hasHub ? null : 'needs_hub',
        requiredHeadcount: required,
        salaryPerHeadMinor: ctx.economy.ground.selfHandling.salaryPerHeadMinor,
      },
      walkUpPriceIndex: ctx.economy.ground.walkUpPriceIndex,
    };
  });

  return { icao, lines };
}

/** A station's vendors and this airline's arrangements there, or null for an unknown station. */
export async function readStation(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  now: Date = new Date(),
): Promise<GroundStationResponse | null> {
  const ctx = await loadStationContext(db, own.worldId, own.id, icao);
  if (ctx === null) return null;
  const [active, mine] = await Promise.all([
    activeAt(db, own.worldId, icao),
    selfHandlingAt(db, own.id, icao),
  ]);
  return buildStation(icao, ctx, active, mine, own.id, gameTime(ctx.clock, now));
}

/**
 * Departures this airline actually flew out of a station inside a window.
 *
 * Flights that **left the stand** — a cancelled or never-dispatched flight was
 * never handled, so counting it against a volume commitment would credit the
 * airline for work the vendor did not do. Game time throughout, like the term it
 * is measured against.
 */
async function departuresFlown(
  db: Database,
  airlineId: string,
  icao: string,
  from: Date,
  to: Date,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(flight)
    .where(
      and(
        eq(flight.airlineId, airlineId),
        eq(flight.originIcao, icao),
        isNotNull(flight.actualDeparture),
        gte(flight.actualDeparture, from),
        lt(flight.actualDeparture, to),
      ),
    );
  return row?.count ?? 0;
}

/**
 * The same count, for many contracts at once.
 *
 * `listAirlineContracts` needs one window per contract and they do not share
 * bounds — every term starts when it was signed — so a single grouped `count`
 * over the widest span would over-count the later ones. Joining the flights
 * against a `values` list of windows keeps it exact and keeps it to **one**
 * query: the alternative was one round trip per contract, which for four service
 * lines across twenty stations was eighty sequential counts on the endpoint a
 * client polls for its alerts.
 *
 * Raw SQL because a per-row window is not something the query builder expresses,
 * and a correlated subquery is the shape CLAUDE.md records as having come back
 * empty against real Postgres. Every value is a bound parameter; the casts are on
 * the literals so the `values` list has types before the join reads them.
 */
async function departuresFlownBatch(
  db: Database,
  airlineId: string,
  windows: readonly { key: string; icao: string; from: Date; to: Date }[],
): Promise<Map<string, number>> {
  if (windows.length === 0) return new Map();

  const rows = sql.join(
    windows.map(
      (w) =>
        sql`(${w.key}::text, ${w.icao}::text, ${w.from.toISOString()}::timestamptz, ${w.to.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );

  const result = await db.execute<{ key: string; flown: number }>(sql`
    select v.key as key, count(f.id)::int as flown
    from (values ${rows}) as v(key, icao, term_start, term_end)
    left join "flight" f
      on f.airline_id = ${airlineId}::uuid
     and f.origin_icao = v.icao
     and f.actual_departure is not null
     and f.actual_departure >= v.term_start
     and f.actual_departure < v.term_end
    group by v.key
  `);

  return new Map(result.rows.map((row) => [row.key, row.flown]));
}

/**
 * What a term's unflown commitment costs, and how short it is, given the count.
 *
 * Pure, so the caller decides how the departures were counted — one query for one
 * contract, or one query for all of them.
 *
 * `upTo` is where the measurement stops: the term's end at expiry, or *now* on an
 * early exit — and on an early exit the commitment is pro-rated to the part of
 * the term served, so leaving early neither forgives a shortfall already run up
 * nor invents one for months the airline never had.
 */
function shortfallFrom(
  row: ActiveRow,
  flown: number,
  upTo: Date,
  economy: PinnedEconomyConfig,
): { committed: number; flown: number; feeMinor: number } {
  // A row with no term owes nothing, but it did fly whatever it flew: reporting
  // a count of zero here would be a fabricated figure rather than an absent one.
  if (row.termStart === null || row.termEnd === null || row.volumeCommitment === null) {
    return { committed: 0, flown, feeMinor: 0 };
  }
  const served = elapsedTermFraction(row.termStart, row.termEnd, upTo);
  const committed = Math.round(row.volumeCommitment * served);
  // A commitment of nothing is owed nothing — a budget handler asks for no
  // volume, and the first days of any term round to zero. The departures still
  // happened, and `flown` still says how many.
  if (committed <= 0) return { committed: 0, flown, feeMinor: 0 };

  const short = Math.max(0, committed - flown);
  return {
    committed,
    flown,
    feeMinor: Math.round(short * economy.ground.contract.shortfallFeePerDepartureMinor),
  };
}

/** {@link shortfallFrom} for one contract, counting its departures itself. */
async function shortfall(
  db: Database,
  row: ActiveRow,
  airlineId: string,
  icao: string,
  upTo: Date,
  economy: PinnedEconomyConfig,
): Promise<{ committed: number; flown: number; feeMinor: number }> {
  // No term start is the one case with nothing to count *from*. Everything else
  // is counted, including a contract that owes no volume — see `shortfallFrom`.
  if (row.termStart === null) return { committed: 0, flown: 0, feeMinor: 0 };
  const flown = await departuresFlown(db, airlineId, icao, row.termStart, upTo);
  return shortfallFrom(row, flown, upTo, economy);
}

/** Thrown to roll a write back when the airline cannot pay for it. */
class InsufficientFunds extends Error {
  constructor() {
    super('The airline does not have enough cash for this ground handling operation');
  }
}

/** Thrown to roll the sign transaction back when the vendor has no slot left. */
class CapacityExhausted extends Error {
  constructor() {
    super('The handler has no capacity left');
  }
}

/**
 * Serialise every writer contending for one service line at one station.
 *
 * The key is the line rather than the vendor slot, because exclusivity spans two
 * tables and this is the only key both writers can agree on. See the module note.
 *
 * **Every writer of `ground_contract` takes it, including the expiry sweep**, and
 * every one of them takes it *before* touching a row. Two things follow, and the
 * second is why the sweep joins in: the lock alone serialises player against
 * player, and it also serialises player against worker — without which a
 * termination and a lapse could both decide they owed the same contract's
 * shortfall, reach AIR-06 with the same reference and different amounts, and
 * throw. A single ordering (advisory lock, then rows) is also what keeps these
 * paths free of deadlock.
 */
async function lockLine(
  tx: Database,
  worldId: string,
  icao: string,
  serviceLine: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${worldId}:${icao}:${serviceLine}`}))`,
  );
}

/**
 * Break a vendor contract this airline holds, charging what breaking it costs.
 *
 * One place, three callers: an explicit termination, a grade switch, and opening
 * self-handling on a line a vendor was working. All three are §9.3's *"breaking
 * one early"*, and routing them through one function is what stops a switch being
 * the free exit.
 *
 * Two movements rather than one, for §14.1's reason: *"why did I pay 31,400"* has
 * two answers — the term you walked away from and the flights you never flew —
 * and one line would fuse them into a figure nobody can argue with.
 *
 * **Returns null when there was nothing to break.** The status update is what
 * decides that, and checking it is not defensive tidiness: billing a contract
 * somebody else already closed reaches AIR-06 with the same `(cause, reference)`
 * and a *different* amount and instant, which makes `assertSameCause` throw. A
 * player double-clicking terminate, or terminating a contract the expiry sweep
 * had just lapsed, turned a 404 into a 500 that way.
 */
async function breakContract(
  tx: Database,
  row: ActiveRow,
  airlineId: string,
  icao: string,
  gameNow: Date,
  economy: PinnedEconomyConfig,
): Promise<{ penaltyMinor: number; shortfallMinor: number } | null> {
  const closed = await tx
    .update(groundContract)
    .set({ status: 'terminated' })
    .where(and(eq(groundContract.id, row.id), eq(groundContract.status, 'active')))
    .returning({ id: groundContract.id });
  // Somebody else closed it. Their transaction owns whatever it owes.
  if (closed.length === 0) return null;

  const penalty = penaltyNowMinor(row, gameNow);
  // Clamped to the term's end, not measured to now — see `obligationsEndAt`.
  const short = await shortfall(tx, row, airlineId, icao, obligationsEndAt(row, gameNow), economy);

  for (const [amount, cause] of [
    [penalty, 'ground_contract_penalty'],
    [short.feeMinor, 'ground_volume_shortfall'],
  ] as const) {
    if (amount <= 0) continue;
    const movement = await moveAirlineCash(tx, {
      airlineId,
      amountMinor: -amount,
      cause,
      // The contract, not a fresh uuid: a contract is broken once, so this is a
      // natural idempotency key and a replay is a no-op rather than a second bill.
      reference: `contract:${row.id}`,
      occurredAt: gameNow,
    });
    if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();
  }

  return { penaltyMinor: penalty, shortfallMinor: short.feeMinor };
}

export type SignOutcome =
  | { ok: true; station: GroundStationResponse }
  | {
      ok: false;
      code: 'unknown_station' | 'grade_not_offered' | 'capacity_exhausted' | 'insufficient_funds';
    };

/**
 * Sign a handler for a service line, replacing whatever was working it.
 *
 * The advisory lock serialises airlines racing for the last opening, so the
 * capacity limit is exact under competition rather than a best-effort count — the
 * property the "capacity can be exhausted" criterion asks for. Switching grades
 * breaks the incumbent first, which frees its slot **and charges the penalty**;
 * so does taking a line back off your own people.
 */
export async function signContract(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  request: SignContractRequest,
  now: Date = new Date(),
): Promise<SignOutcome> {
  const ctx = await loadStationContext(db, own.worldId, own.id, icao);
  if (ctx === null) return { ok: false, code: 'unknown_station' };

  const offer = stationVendors(ctx.seed, icao, request.serviceLine, ctx.tier ?? 'medium').find(
    (o) => o.grade === request.grade,
  );
  if (offer === undefined) return { ok: false, code: 'grade_not_offered' };

  // The term runs from the world's clock, not the wall clock: a contract lasts a
  // business season in the world's calendar (§9.3).
  const gameNow = gameTime(ctx.clock, now);
  const termEnd = contractTermEnd(gameNow);

  return db
    .transaction(async (tx) => {
      await lockLine(tx, own.worldId, icao, request.serviceLine);

      // Retire whatever this airline had on this line. A vendor contract is
      // *broken* — its term was an agreement — while its own operation is simply
      // closed, because there was nobody to agree a term with.
      const incumbents = await activeAt(tx, own.worldId, icao);
      const incumbent = incumbents.find(
        (r) => r.airlineId === own.id && r.serviceLine === request.serviceLine,
      );
      if (incumbent) {
        // A null means it was closed between the read and here, which the line
        // lock makes impossible today — but the signature says it can happen, and
        // signing on top of it is the right answer either way.
        await breakContract(tx, incumbent, own.id, icao, gameNow, ctx.economy);
      }
      await tx
        .update(groundSelfHandling)
        .set({ status: 'closed', closedAt: gameNow })
        .where(
          and(
            eq(groundSelfHandling.airlineId, own.id),
            eq(groundSelfHandling.airportIcao, icao),
            eq(groundSelfHandling.serviceLine, request.serviceLine),
            eq(groundSelfHandling.status, 'active'),
          ),
        );

      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(groundContract)
        .where(
          and(
            eq(groundContract.worldId, own.worldId),
            eq(groundContract.airportIcao, icao),
            eq(groundContract.serviceLine, request.serviceLine),
            eq(groundContract.grade, request.grade),
            eq(groundContract.status, 'active'),
          ),
        );
      if (count >= offer.capacity) {
        // Roll the termination back — the airline keeps the handler it had.
        throw new CapacityExhausted();
      }

      await tx.insert(groundContract).values({
        worldId: own.worldId,
        airlineId: own.id,
        airportIcao: icao,
        serviceLine: request.serviceLine,
        grade: request.grade,
        status: 'active',
        termStart: gameNow,
        termEnd,
        // Both fixed at signing, so the contract is judged at the end against what
        // was agreed rather than against whatever the economy says by then.
        volumeCommitment: commitmentFor(request.grade, ctx.economy),
        penaltyMinor: fullTermPenaltyMinor(request.grade, ctx.economy),
      });

      const [active, mine] = await Promise.all([
        activeAt(tx, own.worldId, icao),
        selfHandlingAt(tx, own.id, icao),
      ]);
      return {
        ok: true as const,
        station: buildStation(icao, ctx, active, mine, own.id, gameNow),
      };
    })
    .catch((error: unknown): SignOutcome => {
      if (error instanceof CapacityExhausted) {
        return { ok: false, code: 'capacity_exhausted' as const };
      }
      if (error instanceof InsufficientFunds) {
        return { ok: false, code: 'insufficient_funds' as const };
      }
      throw error;
    });
}

export type SelfHandlingOutcome =
  | { ok: true; station: GroundStationResponse }
  | { ok: false; code: 'unknown_station' | 'needs_hub' | 'insufficient_funds' };

/**
 * Handle a service line with your own people, or restaff an operation already open
 * (§9.3).
 *
 * §9.3 asks for self-handling *"requiring a station and headcount"*, and the hub
 * is the station: an airline that has not bought its way into an airport has no
 * ground operation there to staff. That is also what stops self-handling being
 * the universally correct answer — App. B.5 doubles the price of every hub you
 * already own, so a network of self-handled outstations is not something a player
 * can quietly accumulate.
 *
 * Restaffing goes through the same request rather than a separate resize: the
 * client says what the staffing should be, which is the only thing it knows.
 */
export async function openSelfHandling(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  request: OpenSelfHandlingRequest,
  now: Date = new Date(),
): Promise<SelfHandlingOutcome> {
  const ctx = await loadStationContext(db, own.worldId, own.id, icao);
  if (ctx === null) return { ok: false, code: 'unknown_station' };
  if (!ctx.hasHub) return { ok: false, code: 'needs_hub' };

  const gameNow = gameTime(ctx.clock, now);

  return db
    .transaction(async (tx) => {
      await lockLine(tx, own.worldId, icao, request.serviceLine);

      // Taking the line off a vendor is breaking its contract, and costs what
      // breaking it costs. Charged here rather than waived, because otherwise
      // "open self-handling with one head" would be the free way out of a term.
      const incumbents = await activeAt(tx, own.worldId, icao);
      const incumbent = incumbents.find(
        (r) => r.airlineId === own.id && r.serviceLine === request.serviceLine,
      );
      if (incumbent) {
        // Null when it was closed between the read and here; taking the line over
        // is still the right outcome, and there is nothing left to charge for.
        await breakContract(tx, incumbent, own.id, icao, gameNow, ctx.economy);
      }

      /*
       * Update or insert, rather than an upsert. The unique index is **partial**
       * — `where status = 'active'` — and Postgres will not infer a partial index
       * from an `on conflict` target without being handed the predicate too; the
       * first version of this was an upsert and every write failed with *"no
       * unique or exclusion constraint matching the ON CONFLICT specification"*.
       *
       * Two statements under the line lock is also simply clearer than an upsert
       * carrying two separate `where` clauses, and the lock is what makes it safe.
       */
      const [existing] = await tx
        .select({ id: groundSelfHandling.id })
        .from(groundSelfHandling)
        .where(
          and(
            eq(groundSelfHandling.airlineId, own.id),
            eq(groundSelfHandling.airportIcao, icao),
            eq(groundSelfHandling.serviceLine, request.serviceLine),
            eq(groundSelfHandling.status, 'active'),
          ),
        )
        .limit(1);

      if (existing) {
        /*
         * Settle what the *current* staffing has already earned before changing
         * it. This is what stops the monthly bill being avoidable: without it,
         * dropping to one head on the last day of the month billed one head for
         * the whole month, and restaffing afterwards cost nothing.
         */
        await settleSelfHandlingAccrual(tx, existing.id, gameNow, ctx.economy);

        // Restaffing keeps `opened_at`: it is the same operation, and moving its
        // start would rewrite when the airline took the station on.
        await tx
          .update(groundSelfHandling)
          .set({ headcount: request.headcount })
          .where(eq(groundSelfHandling.id, existing.id));
      } else {
        await tx.insert(groundSelfHandling).values({
          worldId: own.worldId,
          airlineId: own.id,
          airportIcao: icao,
          serviceLine: request.serviceLine,
          headcount: request.headcount,
          status: 'active',
          openedAt: gameNow,
          // Paid up to the moment it opened, so the first settlement charges from
          // here rather than from the world's epoch.
          billedThroughAt: gameNow,
        });
      }

      const [active, mine] = await Promise.all([
        activeAt(tx, own.worldId, icao),
        selfHandlingAt(tx, own.id, icao),
      ]);
      return {
        ok: true as const,
        station: buildStation(icao, ctx, active, mine, own.id, gameNow),
      };
    })
    .catch((error: unknown): SelfHandlingOutcome => {
      if (error instanceof InsufficientFunds) {
        return { ok: false, code: 'insufficient_funds' as const };
      }
      throw error;
    });
}

/**
 * Close an operation of your own, dropping the line back to walk-up handling.
 *
 * No penalty: there was no term and no counterparty. What it costs is what it
 * stops costing — next month's payroll for those heads, which is the only reason
 * to close one.
 */
export async function closeSelfHandling(
  db: Database,
  own: ResolvedPlayerAirline,
  id: string,
  now: Date = new Date(),
): Promise<string | null> {
  const clock = await loadWorldClock(db, own.worldId);
  const gameNow = clock === null ? now : gameTime(clock, now);
  const economy = await loadWorldEconomyConfig(db, own.worldId);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(groundSelfHandling)
      .set({ status: 'closed', closedAt: gameNow })
      .where(
        and(
          eq(groundSelfHandling.id, id),
          eq(groundSelfHandling.airlineId, own.id),
          eq(groundSelfHandling.status, 'active'),
        ),
      )
      .returning({ icao: groundSelfHandling.airportIcao });
    if (!row) return null;

    /*
     * Pay for the part of the month that was worked. Closing is otherwise the
     * other half of the payroll dodge: a station used for three weeks and closed
     * before the month-end sweep would have cost nothing at all.
     *
     * After the status flip, so a concurrent sweep cannot pick the row up again —
     * and the settlement reads the row by id rather than by status, so closing it
     * first does not hide the accrual from this call.
     */
    await settleSelfHandlingAccrual(tx, id, gameNow, economy);
    return row.icao;
  });
}

export type TerminateOutcome =
  | { ok: true; icao: string; penaltyMinor: number; shortfallMinor: number }
  | { ok: false; code: 'not_found' | 'insufficient_funds' };

/**
 * Terminate a vendor contract this airline holds, early, and pay for it.
 *
 * The explicit half of §9.3's *"breaking one early costs a penalty"*. Refused
 * when the airline cannot pay, which is how every other player-initiated spend in
 * the game behaves — an airline with no cash is locked into its handler, which is
 * a real consequence of running out of money rather than an inconsistency.
 */
export async function terminateContract(
  db: Database,
  own: ResolvedPlayerAirline,
  contractId: string,
  now: Date = new Date(),
): Promise<TerminateOutcome> {
  const clock = await loadWorldClock(db, own.worldId);
  if (clock === null) return { ok: false, code: 'not_found' };
  const gameNow = gameTime(clock, now);
  const economy = await loadWorldEconomyConfig(db, own.worldId);

  return db
    .transaction(async (tx) => {
      const columns = {
        id: groundContract.id,
        airlineId: groundContract.airlineId,
        icao: groundContract.airportIcao,
        serviceLine: groundContract.serviceLine,
        grade: groundContract.grade,
        termStart: groundContract.termStart,
        termEnd: groundContract.termEnd,
        volumeCommitment: groundContract.volumeCommitment,
        penaltyMinor: groundContract.penaltyMinor,
      };
      const mine = and(
        eq(groundContract.id, contractId),
        eq(groundContract.airlineId, own.id),
        eq(groundContract.status, 'active'),
      );

      /*
       * Two reads, and the first exists only to learn the lock key.
       *
       * The line lock has to be taken before the row this transaction is going to
       * bill for is decided, or the decision is made against a state another
       * writer is still changing — which is how terminating a contract the expiry
       * sweep had just lapsed came to bill a shortfall twice and throw. But the
       * key is `(world, airport, service line)` and only the row knows it, so the
       * first read finds the key and the second, under the lock, is the one that
       * counts.
       */
      const [keyRow] = await tx.select(columns).from(groundContract).where(mine).limit(1);
      if (!keyRow) return { ok: false as const, code: 'not_found' as const };

      await lockLine(tx, own.worldId, keyRow.icao, keyRow.serviceLine);

      const [row] = await tx.select(columns).from(groundContract).where(mine).limit(1);
      // Closed while this transaction waited for the lock. That is an ordinary
      // "no such contract", not an error.
      if (!row) return { ok: false as const, code: 'not_found' as const };

      const charged = await breakContract(tx, row, own.id, row.icao, gameNow, economy);
      if (charged === null) return { ok: false as const, code: 'not_found' as const };
      return {
        ok: true as const,
        icao: row.icao,
        penaltyMinor: charged.penaltyMinor,
        shortfallMinor: charged.shortfallMinor,
      };
    })
    .catch((error: unknown): TerminateOutcome => {
      if (error instanceof InsufficientFunds) {
        return { ok: false, code: 'insufficient_funds' as const };
      }
      throw error;
    });
}

export interface ExpiryResult {
  /** Contracts whose term ran out and were lapsed back to walk-up handling. */
  expired: number;
  /** Of those, how many ended short of their committed departures. */
  shortfalls: number;
  /** What those shortfalls cost, in minor units. */
  shortfallMinor: number;
}

/**
 * Lapse every contract in this world whose term has ended, and bill what it owes
 * (M5-06, §9.3).
 *
 * The other half of *"Contracts run for a fixed term with volume commitments"*:
 * signing sets `term_end` and the commitment, and this is what makes the end mean
 * something. A lapsed contract flips to `expired`, which frees its vendor slot
 * (capacity counts only `active` rows) and drops the airline back to walk-up
 * handling — and if the term closed short of what it committed to, the vendor
 * bills for the capacity it held and the airline did not use.
 *
 * Runs on the **worker** against the world's game clock, like every crew and
 * maintenance sweep. **Production has no worker**, so there a term would never
 * lapse: a contract signed on opening day would run for ever, its vendor slot
 * would never come free for a competitor, and no shortfall would ever be billed —
 * which reads as a generous market rather than a missing process.
 * `groundContractsExpired` is the counter that tells that apart from a world where
 * nothing has reached its term yet.
 *
 * World-scoped and idempotent twice over: the status flip means a second run finds
 * nothing still `active` past its term, and the shortfall movement is keyed on the
 * contract, so two workers racing bill each term once.
 *
 * Insolvency is not modelled here and the shortfall can cause it, exactly as crew
 * payroll can: the vendor held the capacity, so the bill cannot be refused, and an
 * airline that cannot pay goes negative. What must not happen is the sweep
 * skipping it, which would make "sign premium everywhere and never fly" free.
 */
export async function expireGroundContracts(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<ExpiryResult> {
  const due = await db
    .select({
      id: groundContract.id,
      airlineId: groundContract.airlineId,
      icao: groundContract.airportIcao,
      serviceLine: groundContract.serviceLine,
      grade: groundContract.grade,
      termStart: groundContract.termStart,
      termEnd: groundContract.termEnd,
      volumeCommitment: groundContract.volumeCommitment,
      penaltyMinor: groundContract.penaltyMinor,
    })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.worldId, worldId),
        eq(groundContract.status, 'active'),
        isNotNull(groundContract.termEnd),
        lte(groundContract.termEnd, gameNow),
      ),
    );
  if (due.length === 0) return { expired: 0, shortfalls: 0, shortfallMinor: 0 };

  const economy = await loadWorldEconomyConfig(db, worldId);
  let expired = 0;
  let shortfalls = 0;
  let shortfallMinor = 0;

  for (const row of due) {
    const billed = await db.transaction(async (tx) => {
      /*
       * The same line lock every other writer takes, in the same order (lock,
       * then rows). Without it a player's termination and this lapse could both
       * decide they owed the contract's shortfall, reach AIR-06 with the same
       * reference and different amounts, and throw — which surfaced as a 500 on
       * the player's request rather than as anything the worker noticed.
       */
      await lockLine(tx, worldId, row.icao, row.serviceLine);

      const lapsed = await tx
        .update(groundContract)
        .set({ status: 'expired' })
        .where(and(eq(groundContract.id, row.id), eq(groundContract.status, 'active')))
        .returning({ id: groundContract.id });
      // Another writer got here first — a second worker, or a player terminating
      // it a moment before its term ran out. Their transaction owns the bill.
      if (lapsed.length === 0) return null;

      // Measured to the term's own end rather than to now: a sweep that ran late
      // must not credit the airline for flights after the vendor stopped working.
      const short = await shortfall(
        tx,
        row,
        row.airlineId,
        row.icao,
        obligationsEndAt(row, gameNow),
        economy,
      );
      if (short.feeMinor <= 0) return 0;

      await moveAirlineCash(tx, {
        airlineId: row.airlineId,
        amountMinor: -short.feeMinor,
        cause: 'ground_volume_shortfall',
        reference: `contract:${row.id}`,
        occurredAt: row.termEnd ?? gameNow,
      });
      return short.feeMinor;
    });

    if (billed === null) continue;
    expired += 1;
    if (billed > 0) {
      shortfalls += 1;
      shortfallMinor += billed;
    }
  }

  return { expired, shortfalls, shortfallMinor };
}

/**
 * Every arrangement this airline holds, across all stations, with what is about to
 * cost it money.
 *
 * §9.3's alert *"before it lapses"* wants the whole network in one read rather
 * than a page-by-page sweep — and since the commitment landed there is a second
 * thing worth warning about that a station page cannot show either: a term running
 * out **short of its committed departures**. That one is the more expensive
 * surprise, because it is billed at the end, when nothing can be done about it.
 */
export async function listAirlineContracts(
  db: Database,
  own: ResolvedPlayerAirline,
  now: Date = new Date(),
): Promise<GroundContractsResponse> {
  const clock = await loadWorldClock(db, own.worldId);
  if (clock === null) return { contracts: [] };
  const gameNow = gameTime(clock, now);
  const economy = await loadWorldEconomyConfig(db, own.worldId);

  const [rows, mine] = await Promise.all([
    db
      .select({
        id: groundContract.id,
        airlineId: groundContract.airlineId,
        icao: groundContract.airportIcao,
        serviceLine: groundContract.serviceLine,
        grade: groundContract.grade,
        termStart: groundContract.termStart,
        termEnd: groundContract.termEnd,
        volumeCommitment: groundContract.volumeCommitment,
        penaltyMinor: groundContract.penaltyMinor,
      })
      .from(groundContract)
      .where(and(eq(groundContract.airlineId, own.id), eq(groundContract.status, 'active'))),
    db
      .select({
        id: groundSelfHandling.id,
        icao: groundSelfHandling.airportIcao,
        serviceLine: groundSelfHandling.serviceLine,
        headcount: groundSelfHandling.headcount,
      })
      .from(groundSelfHandling)
      .where(
        and(eq(groundSelfHandling.airlineId, own.id), eq(groundSelfHandling.status, 'active')),
      ),
  ]);

  const contracts: GroundContractAlert[] = [];

  /*
   * Every contract's departures in one query rather than one each. Measured to
   * *now*, so the figure falls as the airline flies — which is the whole point of
   * surfacing it before the term closes.
   */
  const flownBy = await departuresFlownBatch(
    db,
    own.id,
    rows
      .filter((row) => row.termStart !== null)
      .map((row) => ({
        key: row.id,
        icao: row.icao,
        // Non-null by the filter above; a term with no start has nothing to count.
        from: row.termStart!,
        to: gameNow,
      })),
  );

  for (const row of rows) {
    const short = shortfallFrom(row, flownBy.get(row.id) ?? 0, gameNow, economy);
    contracts.push({
      id: row.id,
      icao: row.icao,
      serviceLine: row.serviceLine as GroundServiceLine,
      kind: 'vendor',
      grade: row.grade as HandlerGrade,
      headcount: null,
      staffing: null,
      termEnd: row.termEnd === null ? null : row.termEnd.toISOString(),
      expiring: contractExpiring(row.termEnd, gameNow),
      committedDepartures: row.volumeCommitment,
      departuresFlown: row.termStart === null ? null : short.flown,
      shortfallFeeMinor: short.feeMinor,
      earlyTerminationPenaltyMinor: penaltyNowMinor(row, gameNow),
    });
  }

  if (mine.length > 0) {
    // One query for every station the airline handles itself, rather than one per
    // row — the pattern CLAUDE.md records after a correlated subquery came back
    // empty against real Postgres.
    const tiers = await db
      .select({ icao: airport.icaoCode, tier: airport.tier })
      .from(airport)
      .where(
        inArray(
          airport.icaoCode,
          mine.map((r) => r.icao),
        ),
      );
    const tierOf = new Map(tiers.map((t) => [t.icao, t.tier]));

    for (const row of mine) {
      const required = requiredHeadcount(tierOf.get(row.icao) ?? null, economy);
      contracts.push({
        id: row.id,
        icao: row.icao,
        serviceLine: row.serviceLine as GroundServiceLine,
        kind: 'self',
        grade: null,
        headcount: row.headcount,
        staffing: selfHandlingProfile(row.headcount, required).staffing,
        termEnd: null,
        expiring: false,
        committedDepartures: null,
        departuresFlown: null,
        shortfallFeeMinor: 0,
        earlyTerminationPenaltyMinor: 0,
      });
    }
  }

  return { contracts };
}

/**
 * How an airline's turns at a station are actually being handled, for the sim.
 *
 * The one lookup the turnaround, disruption and settlement models share, and the
 * only place that knows the three cases are three cases. Walk-up is the answer
 * when nothing is arranged, which is a real state rather than a missing row: the
 * airline scrambles the bags itself, at budget-grade reliability and above
 * standard price.
 *
 * `tier` is passed in by a caller that already has the airport row — a settlement
 * does — so the common path costs one indexed read rather than two.
 */
export async function handlingArrangementFor(
  db: Database,
  airlineId: string,
  icao: string,
  serviceLine: GroundServiceLine,
  economy: PinnedEconomyConfig,
  tier?: AirportTier | null,
): Promise<HandlingArrangement> {
  const [mine, contracted] = await Promise.all([
    db
      .select({ headcount: groundSelfHandling.headcount })
      .from(groundSelfHandling)
      .where(
        and(
          eq(groundSelfHandling.airlineId, airlineId),
          eq(groundSelfHandling.airportIcao, icao),
          eq(groundSelfHandling.serviceLine, serviceLine),
          eq(groundSelfHandling.status, 'active'),
        ),
      )
      .limit(1),
    db
      .select({ grade: groundContract.grade })
      .from(groundContract)
      .where(
        and(
          eq(groundContract.airlineId, airlineId),
          eq(groundContract.airportIcao, icao),
          eq(groundContract.serviceLine, serviceLine),
          eq(groundContract.status, 'active'),
        ),
      )
      .limit(1),
  ]);

  const own = mine[0];
  if (own) {
    let stationTier = tier;
    if (stationTier === undefined) {
      const [a] = await db
        .select({ tier: airport.tier })
        .from(airport)
        .where(eq(airport.icaoCode, icao))
        .limit(1);
      stationTier = a?.tier ?? null;
    }
    return {
      kind: 'self',
      headcount: own.headcount,
      requiredHeadcount: requiredHeadcount(stationTier, economy),
    };
  }

  const vendor = contracted[0];
  if (vendor) return { kind: 'vendor', grade: vendor.grade as HandlerGrade };
  return { kind: 'walk_up' };
}

/**
 * The grade an airline uses for a service line at a station.
 *
 * Kept for callers that only want the vendor grade. New code should read
 * {@link handlingArrangementFor}, which can also answer *"their own people"* —
 * this cannot, and returns null for a self-handled line as it does for walk-up.
 */
export async function contractedGrade(
  db: Database,
  airlineId: string,
  icao: string,
  serviceLine: GroundServiceLine,
): Promise<HandlerGrade | null> {
  const [row] = await db
    .select({ grade: groundContract.grade })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.airlineId, airlineId),
        eq(groundContract.airportIcao, icao),
        eq(groundContract.serviceLine, serviceLine),
        eq(groundContract.status, 'active'),
      ),
    )
    .limit(1);
  return row ? (row.grade as HandlerGrade) : null;
}
