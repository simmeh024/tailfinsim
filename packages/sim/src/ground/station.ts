import { HANDLER_GRADES } from '@tailfin/shared';
import type { AirportTier, GroundServiceLine, HandlerGrade } from '@tailfin/shared';

import { deriveRng, intBetween } from '../random';

import { DEFAULT_GROUND_HANDLING, type GroundHandlingConfig } from './vendor';

/**
 * Which handlers a station offers, for one service line (M5-06, §9.3).
 *
 * §9.3 makes vendors a per-station fact, and there are thousands of stations —
 * so they are **derived, not stored**: a station's offering is a pure function of
 * the world seed, the airport and the service line, the same way a flight's
 * disruption is a function of the world and the flight. No `ground_vendor` table
 * of millions of rows to reset on a world reset (ADR-0005); the contracts an
 * airline signs against these offers are the only thing worth persisting, and
 * they are few.
 *
 * The stream is keyed on `('ground', icao, serviceLine)`, never on time or on how
 * many stations were generated first, so two workers and a replay agree, and a
 * station's fuelling vendors are uncorrelated with its catering ones.
 */

/** One grade a station offers for a service line, with how many airlines it will take. */
export interface StationVendorOffer {
  grade: HandlerGrade;
  /** Contract slots — the finite capacity §9.3 lets competing airlines exhaust. */
  capacity: number;
}

/**
 * The vendors a station offers for one service line, cheapest grade first.
 *
 * Base capacity comes from the airport tier; a small per-station jitter makes two
 * large airports differ without changing which grades a tier can support. A grade
 * the tier does not offer (capacity 0) is simply absent — a regional strip has a
 * budget ramp and nothing else.
 */
export function stationVendors(
  worldSeed: string,
  icao: string,
  serviceLine: GroundServiceLine,
  tier: AirportTier,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): StationVendorOffer[] {
  const rng = deriveRng(worldSeed, 'ground', icao, serviceLine);
  const base = config.stationCapacity[tier];

  const offers: StationVendorOffer[] = [];
  for (const grade of HANDLER_GRADES) {
    const baseCapacity = base[grade];
    if (baseCapacity <= 0) continue;
    // Jitter ±1 around the tier's base, floored at one — an offered grade always
    // has at least one slot, or "offered" would be a lie.
    const capacity = Math.max(1, baseCapacity + intBetween(rng, -1, 1));
    offers.push({ grade, capacity });
  }
  return offers;
}
