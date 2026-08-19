/**
 * Demand — how many people want to go, and who they are (M3).
 *
 *   `gravity`    — App. A.2's base pool for a city pair, and its segment mix
 *   `modulation` — what that pool is worth today: season, weekday, economy,
 *                  and the fare the market is charging
 *
 * The share model between competing operators is M3-03's. These two are A.2's
 * whole of step one: how big the market is, and how big it is *today*.
 */
export * from './gravity';
export * from './modulation';
