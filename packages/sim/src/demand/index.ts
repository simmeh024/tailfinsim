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
 *
 * The first two are A.2's whole of step one — how big the market is, and how
 * big it is *today*. The third is the arbiter that splits it, and the one whose
 * exact decomposability the game's explainability rests on (A.9).
 *
 * What follows demand is not here yet: spill and recapture are A.5 (M3-05), and
 * connecting itineraries are A.14 (M3-07). `logit` returns demand, which is
 * deliberately not the same thing as bookings.
 */
export * from './gravity';
export * from './logit';
export * from './modulation';
export * from './sched-fit';
