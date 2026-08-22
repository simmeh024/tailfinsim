/**
 * The airframe layer — what a specific aircraft, configured a specific way, can
 * actually do.
 *
 *   `effective-spec`  — base spec + option deltas + cabin weight, folded once,
 *                       which is the spec every other system reads
 *   `payload-range`   — OEW from spec + cabin + options, and the fuel/range trade
 *                       that falls out of it, naming the limit that bound it
 *   `availability`    — whether a type exists in this world at all (§7.2b)
 *   `used-market`     — what a second-hand airframe is worth, and which ones the
 *                       world is offering (App. C.5)
 *
 * App. C.6 makes this the only place a downstream system should look: everything
 * else *"reads only `effective_spec`"*, so nothing special-cases an option.
 */
export * from './effective-spec';

export * from './payload-range';

export * from './availability';

export * from './used-market';
