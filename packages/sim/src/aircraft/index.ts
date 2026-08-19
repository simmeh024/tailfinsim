/**
 * The airframe layer — what a specific aircraft, configured a specific way, can
 * actually do.
 *
 *   `payload-range` — OEW from spec + cabin + options, and the fuel/range trade
 *                     that falls out of it, naming the limit that bound it
 *
 * App. C.6 makes this the only place a downstream system should look: everything
 * else *"reads only `effective_spec`"*, so nothing special-cases an option.
 */
export * from './payload-range';
