/**
 * How well a hub banks for connections (§7.4).
 *
 * A hub-and-spoke network lives or dies on its banks: a wave of arrivals lands,
 * passengers cross the terminal, a wave of departures leaves. This reads the
 * flights the worker has already materialised at the airline's founder hub and
 * answers the planner's question — *"does my schedule actually connect?"* — as
 * which arrivals can feed which departures, where the banks fall, and which
 * flights link to nothing.
 *
 * ## Why this needs no timezone
 *
 * A connection is only *"does this outbound leave the right amount of time after
 * that inbound"*. That is a difference between two instants, and a difference is
 * the same number in every clock — so the whole analysis runs on the flights'
 * own game-time timestamps and never converts a spoke's local time. That is what
 * lets this ship while the schedule editor's per-leg local times (which *are*
 * entangled with timezones) wait.
 *
 * ## The worker is what fills this
 *
 * Only the worker materialises a schedule into `flight` rows, so on a world with
 * no worker there are none and the analysis is empty — a hub that reads as
 * unscheduled rather than as broken, the same boundary the fleet and performance
 * pages carry. The figures describe the *planned* network ahead (materialised but
 * not yet flown), which is exactly what a network planner is asking about.
 */

import { and, eq, gte, lte, or } from 'drizzle-orm';

import type { HubConnectionsResponse, HubTerminalFlight } from '@tailfin/shared';
import { gameTime, type WorldClock } from '@tailfin/sim';

import { airlineHub, airport, flight, world } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The connect window, in minutes.
 *
 * A narrowbody minimum connect time is around half an hour; a bank rarely holds
 * together for more than two. Fixed here rather than taken from the client: they
 * are on the wire in the response so a future version can let a player widen the
 * window without changing the contract, and so nothing has to trust a query
 * string to bound a loop.
 */
export const MIN_CONNECT_MINUTES = 30;
export const MAX_CONNECT_MINUTES = 120;

/** How many dead-end / unfed flights to name; the counts beside them stay complete. */
export const TERMINAL_SAMPLE = 20;

/** The horizon the worker materialises — the ceiling on how far ahead we look. */
const HORIZON_DAYS = 14;

/** One flight touching the hub, reduced to the two facts the timing needs. */
export interface HubFlight {
  flightId: string;
  /** The spoke: an inbound's origin, an outbound's destination. */
  spokeIcao: string;
  /** The flight's moment at the hub — an arrival's touchdown or a departure's off-blocks. */
  atUtc: Date;
}

/** The connect window the builder should use. */
export interface ConnectWindow {
  minConnectMinutes: number;
  maxConnectMinutes: number;
}

const DEFAULT_WINDOW: ConnectWindow = {
  minConnectMinutes: MIN_CONNECT_MINUTES,
  maxConnectMinutes: MAX_CONNECT_MINUTES,
};

function toTerminal(f: HubFlight): HubTerminalFlight {
  return { flightId: f.flightId, spokeIcao: f.spokeIcao, atUtc: f.atUtc.toISOString() };
}

/**
 * Fold the hub's inbound and outbound flights into the connection analysis.
 *
 * Pure and testable: the caller resolves the hub and the flights, this does all
 * the arithmetic. An inbound at `t` feeds an outbound at `u` when `u − t` is
 * inside the connect window **and** the outbound does not simply return the
 * passenger to the city they arrived from — a turn-back is not a connection.
 *
 * Banks come from single-linkage clustering over every event time: a new bank
 * starts whenever the gap to the next event exceeds the window's maximum, which
 * is exactly the gap beyond which no arrival before it could feed any departure
 * after it. A connection is attributed to the bank holding its arrival.
 */
export function buildConnectionBanks(
  hubIcao: string,
  inbound: readonly HubFlight[],
  outbound: readonly HubFlight[],
  window: ConnectWindow = DEFAULT_WINDOW,
): HubConnectionsResponse {
  const minMs = window.minConnectMinutes * MS_PER_MINUTE;
  const maxMs = window.maxConnectMinutes * MS_PER_MINUTE;

  // Outbounds sorted by time, so each inbound's feasible window is a contiguous
  // slice found by binary search rather than a full re-scan.
  const outSorted = [...outbound].sort((a, b) => a.atUtc.getTime() - b.atUtc.getTime());
  const outTimes = outSorted.map((f) => f.atUtc.getTime());
  const outFed = new Array<boolean>(outSorted.length).fill(false);

  let feasibleConnections = 0;
  let connectingInbound = 0;
  const deadEnds: HubFlight[] = [];

  // Each arrival's onward feed count, computed once. The banks reuse it, so the
  // per-bank totals and the global total share one feasibility rule.
  const feedsByArrival = new Map<HubFlight, number>();

  for (const arr of inbound) {
    const t = arr.atUtc.getTime();
    const lo = lowerBound(outTimes, t + minMs);
    const hi = upperBound(outTimes, t + maxMs);
    let feeds = 0;
    for (let i = lo; i < hi; i += 1) {
      const out = outSorted[i];
      // A turn-back to the arrival city is not an onward connection.
      if (out === undefined || out.spokeIcao === arr.spokeIcao) continue;
      feeds += 1;
      outFed[i] = true;
    }
    feedsByArrival.set(arr, feeds);
    feasibleConnections += feeds;
    if (feeds > 0) connectingInbound += 1;
    else deadEnds.push(arr);
  }

  const unfed = outSorted.filter((_, i) => !outFed[i]);
  const connectingOutbound = outSorted.length - unfed.length;

  const banks = clusterBanks(inbound, outbound, maxMs, feedsByArrival);

  const soonest = (a: HubFlight, b: HubFlight): number => a.atUtc.getTime() - b.atUtc.getTime();
  deadEnds.sort(soonest);
  unfed.sort(soonest);

  return {
    hubIcao,
    minConnectMinutes: window.minConnectMinutes,
    maxConnectMinutes: window.maxConnectMinutes,
    horizonDays: spanDays(inbound, outbound),
    inboundFlights: inbound.length,
    outboundFlights: outbound.length,
    feasibleConnections,
    connectingInbound,
    connectingOutbound,
    deadEndArrivalCount: deadEnds.length,
    unfedDepartureCount: unfed.length,
    deadEndArrivals: deadEnds.slice(0, TERMINAL_SAMPLE).map(toTerminal),
    unfedDepartures: unfed.slice(0, TERMINAL_SAMPLE).map(toTerminal),
    banks,
  };
}

interface BankEvent {
  atMs: number;
  /** The onward feeds this event contributes — an arrival's count, or 0 for a departure. */
  feeds: number;
  arrival: boolean;
}

/**
 * Single-linkage clustering of every hub event into banks.
 *
 * A new bank starts whenever the gap to the next event exceeds `gapMs` — the
 * window's maximum, beyond which no earlier arrival could feed any later
 * departure. Each arrival carries its own feed count (from `feedsByArrival`), so
 * a bank's `connections` is the sum over the arrivals it contains, sharing the
 * one feasibility rule the global total used.
 */
function clusterBanks(
  inbound: readonly HubFlight[],
  outbound: readonly HubFlight[],
  gapMs: number,
  feedsByArrival: ReadonlyMap<HubFlight, number>,
): HubConnectionsResponse['banks'] {
  const events: BankEvent[] = [
    ...inbound.map((f) => ({
      atMs: f.atUtc.getTime(),
      feeds: feedsByArrival.get(f) ?? 0,
      arrival: true,
    })),
    ...outbound.map((f) => ({ atMs: f.atUtc.getTime(), feeds: 0, arrival: false })),
  ].sort((a, b) => a.atMs - b.atMs);

  const banks: HubConnectionsResponse['banks'] = [];
  let current: BankEvent[] = [];

  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first === undefined || last === undefined) return;
    let arrivals = 0;
    let departures = 0;
    let connections = 0;
    for (const e of current) {
      if (e.arrival) {
        arrivals += 1;
        connections += e.feeds;
      } else {
        departures += 1;
      }
    }
    banks.push({
      startUtc: new Date(first.atMs).toISOString(),
      endUtc: new Date(last.atMs).toISOString(),
      arrivals,
      departures,
      connections,
    });
    current = [];
  };

  for (const e of events) {
    const last = current[current.length - 1];
    if (last !== undefined && e.atMs - last.atMs > gapMs) flush();
    current.push(e);
  }
  flush();
  return banks;
}

/** How many days the analysed flights span, rounded up; zero when there are none. */
function spanDays(inbound: readonly HubFlight[], outbound: readonly HubFlight[]): number {
  const times = [...inbound, ...outbound].map((f) => f.atUtc.getTime());
  if (times.length === 0) return 0;
  const span = Math.max(...times) - Math.min(...times);
  return Math.ceil(span / MS_PER_DAY);
}

/** First index whose value is `>= target` (lower bound), on a sorted array. */
function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // `mid < hi <= length`, so the element exists; the guard only narrows the type.
    const value = sorted[mid] ?? Number.POSITIVE_INFINITY;
    if (value < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is `> target` (upper bound), on a sorted array. */
function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const value = sorted[mid] ?? Number.POSITIVE_INFINITY;
    if (value <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

/** The airline's founder hub ICAO, or null if it somehow has none. */
async function founderHubIcao(db: Database, airlineId: string): Promise<string | null> {
  // Prefer the founder grant; fall back to any hub, so a multi-hub airline (M7-04)
  // still resolves to a stable one rather than to nothing.
  const rows = await db
    .select({ icao: airport.icaoCode, founderGrant: airlineHub.founderGrant })
    .from(airlineHub)
    .innerJoin(airport, eq(airport.id, airlineHub.airportId))
    .where(eq(airlineHub.airlineId, airlineId));
  const first = rows[0];
  if (first === undefined) return null;
  const founder = rows.find((r) => r.founderGrant);
  return (founder ?? first).icao;
}

/**
 * The connection analysis for this airline's hub, or null if it has no hub.
 *
 * Owner-scoped like the rest of the network read side: the flights are queried
 * within the resolved airline, never by an id the client supplies. A founded
 * airline always holds a founder hub, so `null` is the defensive answer to a
 * state AIR-01 does not produce, not an ordinary miss.
 */
export async function hubConnections(
  db: Database,
  own: ResolvedPlayerAirline,
  now: Date = new Date(),
  window: ConnectWindow = DEFAULT_WINDOW,
): Promise<HubConnectionsResponse | null> {
  const hubIcao = await founderHubIcao(db, own.id);
  if (hubIcao === null) return null;

  const clock = await loadWorldClock(db, own.worldId);
  if (clock === null) return null;
  const gameNow = gameTime(clock, now);
  const until = new Date(gameNow.getTime() + HORIZON_DAYS * MS_PER_DAY);

  // The airline's own scheduled flights touching the hub, in the horizon ahead.
  // Windowed by scheduled departure (game time) on both sides: a flight that
  // departs ahead arrives ahead, so one bound keeps past, already-flown flights
  // out of a read about the network to come. Ferries are positioning legs that
  // carry no connecting passenger, so `kind = scheduled` is the connecting fleet.
  const rows = await db
    .select({
      id: flight.id,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      scheduledDeparture: flight.scheduledDeparture,
      estimatedArrival: flight.estimatedArrival,
    })
    .from(flight)
    .where(
      and(
        eq(flight.worldId, own.worldId),
        eq(flight.airlineId, own.id),
        eq(flight.kind, 'scheduled'),
        gte(flight.scheduledDeparture, gameNow),
        lte(flight.scheduledDeparture, until),
        or(eq(flight.originIcao, hubIcao), eq(flight.destinationIcao, hubIcao)),
      ),
    );

  const inbound: HubFlight[] = [];
  const outbound: HubFlight[] = [];
  for (const r of rows) {
    if (r.destinationIcao === hubIcao) {
      inbound.push({ flightId: r.id, spokeIcao: r.originIcao, atUtc: r.estimatedArrival });
    }
    if (r.originIcao === hubIcao) {
      outbound.push({ flightId: r.id, spokeIcao: r.destinationIcao, atUtc: r.scheduledDeparture });
    }
  }

  return buildConnectionBanks(hubIcao, inbound, outbound, window);
}
