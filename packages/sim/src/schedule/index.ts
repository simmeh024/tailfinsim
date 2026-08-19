/**
 * Repeating schedules — the promise that the airline works while nobody is
 * watching (M2-03, §8.2, App. F.3).
 *
 *   `rotation`    — the cycle model, and the nine checks that refuse a bad one
 *                   with a reason a player can act on
 *   `materialise` — walking that rule forward into dated flights, idempotently,
 *                   and working out what an edit does to the ones already booked
 */
export * from './rotation';
export * from './materialise';
