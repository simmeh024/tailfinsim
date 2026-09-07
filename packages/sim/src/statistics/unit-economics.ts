/**
 * §14.3's unit economics, from settled traffic (M8-09).
 *
 * The airline industry's own vocabulary, and it is worth being exact about it
 * because three of these look interchangeable and are not:
 *
 * | | Per what | Answers |
 * | --- | --- | --- |
 * | **RASK** | available seat-km | what a seat you *offered* earned |
 * | **Yield** | revenue passenger-km | what a seat you *sold* earned |
 * | **CASK** | available seat-km | what a seat you offered cost |
 *
 * RASK and yield differ by the load factor, exactly: `RASK = yield × LF`. An
 * airline improving yield while RASK falls is raising fares into a market that
 * is leaving, which is the single most useful thing this vocabulary can tell a
 * player and is invisible if the two are conflated.
 *
 * ## Money is minor units, distance is kilometres
 *
 * Every money figure in Tailfin is integer USD minor units (M8-02), so a "per
 * seat-kilometre" figure is minor units per km — a fraction, and deliberately
 * **not** rounded to an integer here. Rounding a CASK of 0.081 to zero would
 * make every unit economic identically free. The render boundary formats it.
 *
 * Distances arrive in nautical miles from the route table, so callers convert
 * once with {@link NM_TO_KM} rather than each doing it their own way.
 *
 * ## Nothing flew is `null`, never zero
 *
 * A route that flew nothing has no RASK. Zero would read as *"earned nothing per
 * seat"*, which is a claim about a bad month rather than about an absent one,
 * and it is the difference §14.1 exists to preserve: a number a player cannot
 * interrogate is bad, and a number that lies about what it measured is worse.
 *
 * There are no balance literals here. Everything is arithmetic over what
 * settlement already recorded.
 */

/** App. B.4's conversion, so the whole codebase divides by the same number. */
export const NM_TO_KM = 1.852;

/** One kilogram in tonnes — RTK is tonne-kilometres, not kilogram-kilometres. */
const KG_PER_TONNE = 1_000;

/** What a window of settled flying produced, before any ratio is taken. */
export interface TrafficTotals {
  /** Seats offered × distance flown, summed per flight. */
  askKm: number;
  /** Passengers carried × distance flown, summed per flight. */
  rpkKm: number;
  /** Cargo tonnes × distance flown, summed per flight. */
  rtkKm: number;
  seats: number;
  passengers: number;
  /** Demand that arrived and found no seat (§14.3's "you're turning away money"). */
  spilledPassengers: number;
  revenueMinor: number;
  costMinor: number;
  flights: number;
  blockHours: number;
  /** Arrivals within the on-time threshold, and how many were measured. */
  onTimeFlights: number;
}

/** An empty window. Exported so a caller folds onto a shared zero. */
export function emptyTraffic(): TrafficTotals {
  return {
    askKm: 0,
    rpkKm: 0,
    rtkKm: 0,
    seats: 0,
    passengers: 0,
    spilledPassengers: 0,
    revenueMinor: 0,
    costMinor: 0,
    flights: 0,
    blockHours: 0,
    onTimeFlights: 0,
  };
}

/** Available seat-kilometres for one flight. */
export function askOf(seats: number, distanceKm: number): number {
  return Math.max(0, seats) * Math.max(0, distanceKm);
}

/** Revenue passenger-kilometres for one flight. */
export function rpkOf(passengers: number, distanceKm: number): number {
  return Math.max(0, passengers) * Math.max(0, distanceKm);
}

/** Revenue tonne-kilometres for one flight, from a cargo load in kilograms. */
export function rtkOf(cargoKg: number, distanceKm: number): number {
  return (Math.max(0, cargoKg) / KG_PER_TONNE) * Math.max(0, distanceKm);
}

/** Add one settled flight to a running window. */
export function addFlight(
  totals: TrafficTotals,
  flight: {
    seats: number;
    passengers: number;
    spilledPassengers: number;
    cargoKg: number;
    distanceKm: number;
    revenueMinor: number;
    costMinor: number;
    blockSeconds: number;
    onTime: boolean;
  },
): TrafficTotals {
  return {
    askKm: totals.askKm + askOf(flight.seats, flight.distanceKm),
    rpkKm: totals.rpkKm + rpkOf(flight.passengers, flight.distanceKm),
    rtkKm: totals.rtkKm + rtkOf(flight.cargoKg, flight.distanceKm),
    seats: totals.seats + flight.seats,
    passengers: totals.passengers + flight.passengers,
    spilledPassengers: totals.spilledPassengers + flight.spilledPassengers,
    revenueMinor: totals.revenueMinor + flight.revenueMinor,
    costMinor: totals.costMinor + flight.costMinor,
    flights: totals.flights + 1,
    blockHours: totals.blockHours + flight.blockSeconds / 3_600,
    onTimeFlights: totals.onTimeFlights + (flight.onTime ? 1 : 0),
  };
}

/** A ratio, or null when its denominator says nothing happened. */
function per(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Revenue per available seat-kilometre. What a seat you offered earned. */
export function rask(totals: TrafficTotals): number | null {
  return per(totals.revenueMinor, totals.askKm);
}

/** Cost per available seat-kilometre. What a seat you offered cost. */
export function cask(totals: TrafficTotals): number | null {
  return per(totals.costMinor, totals.askKm);
}

/** Revenue per revenue passenger-kilometre. What a seat you *sold* earned. */
export function passengerYield(totals: TrafficTotals): number | null {
  return per(totals.revenueMinor, totals.rpkKm);
}

/** Passengers over seats, 0–1. Null when nothing was offered. */
export function loadFactor(totals: TrafficTotals): number | null {
  return per(totals.passengers, totals.seats);
}

/**
 * Share of the demand that arrived and found no seat.
 *
 * Over demand rather than over passengers, so it is the share of the market that
 * went elsewhere. A route carrying 100 and spilling 20 turned away a sixth of
 * what came to it, not a fifth of what it carried.
 */
export function spillRate(totals: TrafficTotals): number | null {
  return per(totals.spilledPassengers, totals.passengers + totals.spilledPassengers);
}

/** Share of arrivals inside the on-time threshold, 0–1. */
export function onTimeRate(totals: TrafficTotals): number | null {
  return per(totals.onTimeFlights, totals.flights);
}

/**
 * The load factor at which revenue would cover cost, given today's yield.
 *
 * `BELF = CASK / yield`, which is the industry's own identity and follows
 * directly from `RASK = yield × LF`: break even is `RASK = CASK`.
 *
 * **Not clamped to 1.** A route whose CASK exceeds its yield cannot break even
 * at *any* load — every extra passenger loses money — and `1.34` says that where
 * a clamped `1.00` would read as "nearly there". §14.4's ranked profit chart
 * needs to tell those two apart, because one is repriced and the other is
 * killed.
 *
 * Null when nothing was sold, because a yield of zero has no ratio.
 */
export function breakevenLoadFactor(totals: TrafficTotals): number | null {
  const yieldPerRpk = passengerYield(totals);
  const costPerAsk = cask(totals);
  if (yieldPerRpk === null || costPerAsk === null || yieldPerRpk <= 0) return null;
  return costPerAsk / yieldPerRpk;
}
