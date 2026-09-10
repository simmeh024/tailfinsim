/**
 * How hard an airport is to fly into (M9-02, §10.2).
 *
 * §10.2 names four things that make a field difficult:
 *
 * > *"short/sloped/high-altitude/terrain-constrained, steep approaches"*
 *
 * Two of those are already in the imported data and are **derived** here:
 * runway length and field elevation. The other two — slope, and terrain or a
 * steep approach — are properties of the geography and the procedures, and
 * OurAirports carries neither, so they are **seeded** from
 * `data/reference/airport-difficulty.csv`.
 *
 * That is the same split `airport-tiers.csv` already makes, and it is the
 * reading M1-02 settled on: *"the rule must be uniform and inspectable, the
 * inputs may be sourced"*. What is ruled out is airport codes scattered through
 * the rule.
 *
 * ## Thresholds live here, not in the economy
 *
 * These numbers say *what an airport is like*, which is a property of the
 * world's geography — the same class of fact as `tier.ts`'s runway bands, and
 * versioned the same way, by re-running the job. What a difficulty point is
 * **worth in XP** is balance and lives in `EconomyConfig.crew.xp`, so a world
 * can make hard flying pay better without re-rating every airport.
 *
 * That split matters for the same reason §22.3 and §22.5 are two pins: if the
 * two shared a number, a change to XP rates and a change to an airport's
 * geometry would be indistinguishable in a crew pool's history.
 */

/** Runway length at or above which length contributes nothing. */
export const EASY_RUNWAY_FT = 6_500;
/** Runway length at which the length term is saturated. */
export const HARD_RUNWAY_FT = 3_000;
/** Field elevation at or below which altitude contributes nothing. */
export const EASY_ELEVATION_FT = 4_000;
/** Field elevation at which the altitude term is saturated. */
export const HARD_ELEVATION_FT = 10_000;

/**
 * How much of the derived rating each term can contribute.
 *
 * They sum to more than 1 on purpose: a field that is both very short and very
 * high is harder than either alone, and the clamp is what stops the sum running
 * away. Runway is weighted above altitude because a short runway is a hard
 * limit on every landing, while altitude is mostly a performance calculation.
 */
export const RUNWAY_WEIGHT = 0.7;
export const ELEVATION_WEIGHT = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface AirportGeometry {
  /** The longest **open** runway, feet. Null where the source has no runway data. */
  longestRunwayFt: number | null;
  /** Field elevation, feet. Null means unknown, never sea level. */
  elevationFt: number | null;
}

export interface DifficultyRating {
  /** The stored value, 0-1. */
  difficulty: number;
  /** From the imported geometry alone. */
  derived: number;
  /** From the committed reference list, or 0 when the field is not on it. */
  seeded: number;
  /** Which of the two decided the answer — for the audit trail. */
  source: 'derived' | 'seeded' | 'equal';
  runwayTerm: number;
  elevationTerm: number;
  /** The reference list's reason, when it is what set the rating. */
  reason: string | null;
}

/**
 * Rate one airport.
 *
 * `max(derived, seeded)` rather than a sum, and that is deliberate: the seeded
 * list exists to supply what the geometry cannot see, not to add to it. Lukla
 * is short *and* sloped *and* high, and adding three terms would put it far past
 * the top of a 0-1 scale that other airports are measured against. Taking the
 * greater keeps the scale meaningful and means the list can only ever raise a
 * rating — so adding an airport to it can never quietly make a route easier.
 *
 * **Null geometry contributes nothing rather than the worst case.** 308
 * scheduled-service airports have no runway rows at all (`has_runway_data`),
 * and treating "we were not told" as "3,000 ft" would rate a third of Africa as
 * harder than Innsbruck. An unknown is an unknown.
 */
export function rateAirport(
  geometry: AirportGeometry,
  seeded: { rating: number; reason: string } | null,
): DifficultyRating {
  const runwayTerm =
    geometry.longestRunwayFt === null
      ? 0
      : clamp01((EASY_RUNWAY_FT - geometry.longestRunwayFt) / (EASY_RUNWAY_FT - HARD_RUNWAY_FT)) *
        RUNWAY_WEIGHT;

  const elevationTerm =
    geometry.elevationFt === null
      ? 0
      : clamp01(
          (geometry.elevationFt - EASY_ELEVATION_FT) / (HARD_ELEVATION_FT - EASY_ELEVATION_FT),
        ) * ELEVATION_WEIGHT;

  const derived = clamp01(runwayTerm + elevationTerm);
  const seededRating = seeded?.rating ?? 0;
  const difficulty = Math.max(derived, seededRating);

  return {
    difficulty: Math.round(difficulty * 1000) / 1000,
    derived: Math.round(derived * 1000) / 1000,
    seeded: seededRating,
    source: derived === seededRating ? 'equal' : derived > seededRating ? 'derived' : 'seeded',
    runwayTerm: Math.round(runwayTerm * 1000) / 1000,
    elevationTerm: Math.round(elevationTerm * 1000) / 1000,
    reason: difficulty === seededRating && seeded !== null ? seeded.reason : null,
  };
}
