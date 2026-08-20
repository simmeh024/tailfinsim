/**
 * Demand — how many people want to go, and who they are (M3).
 *
 *   `gravity`    — App. A.2's base pool for a city pair, and its segment mix
 *   `modulation` — what that pool is worth today: season, weekday, economy,
 *                  and the fare the market is charging
 *   `logit`      — App. A.3–A.4's share model: who, among the operators
 *                  competing for that pool, actually gets the passengers
 *   `sched-fit`  — A.3's `SchedFit` term: whether an operator's departures
 *                  fall at hours the segment actually wants to fly
 *   `capacity`   — A.5's spill and recapture: demand is not bookings, and the
 *                  passengers you turn away are a signal worth showing
 *   `class-allocation` — A.6's per-cabin run: the same models again, once per
 *                  cabin, on that cabin's own pool, fares and seats
 *   `itinerary`  — A.14's connecting products: the one-stop that competes in
 *                  the logit as a single option, and how its fare splits
 *   `booking-curve` — A.15's horizon: when the seats actually sell, and why a
 *                  fare change can only reach the ones not yet taken
 *
 * The first two are A.2's whole of step one — how big the market is, and how
 * big it is *today*. The third is the arbiter that splits it, and the one whose
 * exact decomposability the game's explainability rests on (A.9).
 *
 * `logit` returns demand; `capacity` turns it into bookings; `booking-curve`
 * decides which in-game day each of those bookings happens on.
 */
export * from './booking-curve';
export * from './capacity';
export * from './class-allocation';
export * from './gravity';
export * from './itinerary';
export * from './logit';
export * from './modulation';
export * from './sched-fit';
