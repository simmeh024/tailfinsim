/**
 * The fleet — individual aircraft, and where they physically are.
 *
 *   `positioning` — where an airframe is, derived from where it has flown, and
 *                   the ferry that moves it somewhere else (M2-07)
 *
 * The airframe *entity* is not here. M4-01 owns the type catalogue and M4-04
 * creates the individual aircraft when one is ordered; this module models the
 * one property of an aircraft that M2 needs and M4 does not supply — its place.
 */
export * from './positioning';
