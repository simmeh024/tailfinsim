import { and, eq } from 'drizzle-orm';

import { AircraftSpec } from '@tailfin/shared';
import { DEFAULT_FUEL_BURN, type FuelBurnConfig } from '@tailfin/sim';

import { airframe } from '../db/schema';

import type { Database } from '../db/client';

/**
 * What the aeroplane that actually flew brings to the money (IMPROVE-02).
 *
 * Until this module, every flight in the game was costed as a 23-tonne
 * turboprop — `settle.ts`'s `PLACEHOLDER_AIRFRAME`, which this change removes.
 * A player who leased a 777 was billed an ATR's fuel and an ATR's landing fee,
 * so the one decision the fleet page exists to support did not reach their
 * balance sheet at all.
 *
 * The catalogue and the per-airframe effective spec have existed since M4. What
 * was missing was the arithmetic between them and the settlement, which is what
 * this file is.
 *
 * **Fare previews are still the other half.** `network/economics.ts` draws every
 * floor against a hand-authored `REFERENCE_AIRFRAME`, and moving it to the
 * airline's operating fleet needs a decision about mixed-fleet and unassigned
 * routes rather than only this arithmetic — the second half of IMPROVE-02.
 *
 * ## Everything reads `effective_spec`
 *
 * App. C.6's rule, and the reason options need no special case anywhere here: a
 * fitted option is folded into the stored spec when the aircraft is configured
 * — sharklets are a `burnFactor` of 0.965 applied to `fuelBurnKgPerHour`, a
 * heavier MTOW variant moves `mtowTonnes` — so reading the effective spec means
 * reading the aircraft as built. Nothing in this module knows what an option is.
 *
 * ## Aircraft performance is not the economy
 *
 * Two versioned things, deliberately separate (§22.5 and §22.3). What the
 * aeroplane weighs and burns is the **catalogue's** business, pinned per world by
 * `aircraft_catalogue_version`; what a tonne of fuel costs is the **economy's**,
 * pinned by `economy_config_version`. A settlement records both, because "why
 * was this flight billed that much?" needs both to answer.
 *
 * The one number below that comes from the economy is `tripFuelFraction`, and it
 * is an input rather than a constant for exactly that reason.
 */

/** What the settlement needs to know about the airframe that flew. */
export interface SettlementAirframe {
  maxTakeoffWeightT: number;
  cruiseSpeedKt: number;
  /** Tonnes per nautical mile, range-calibrated — App. C.6's `effective_spec`. */
  cruiseBurnTPerNm: number;
}

/**
 * The aircraft a settlement was calculated against, and enough to say which.
 *
 * The identity travels with the performance because a `flight_result` has to be
 * explicable years later (invariant 4). "This flight burned 4.2 t" is a number;
 * "this A320neo with sharklets, from catalogue v1, burned 4.2 t" is evidence.
 */
export interface FlightAirframeBasis {
  airframeId: string;
  /** §22.5's pin. Separate from the economy version, and both are recorded. */
  catalogueVersion: string;
  typeDesignation: string;
  /** The options actually fitted, already folded into `performance`. */
  buildOptionIds: readonly string[];
  performance: SettlementAirframe;
}

/**
 * The flight's airframe could not be resolved, so it must not be settled.
 *
 * Thrown rather than defaulted. Billing a flight against a plausible-looking
 * aeroplane that is not the one that flew is the failure this whole change
 * exists to remove, and doing it quietly for the rows where the data is *also*
 * broken would be the worst place to keep the habit.
 *
 * The consequence is deliberate and survivable: `drainDueEvents` marks the
 * arrival `failed`, rolls back everything the handler touched (IMPROVE-01), and
 * leaves the flight unsettled and visible on the admin console's System health
 * page. No cash moves, and the arrival can be drained again once the data is
 * fixed — which is not true of a wrong settlement, because `flight_result` is
 * unique per flight and immutable once written.
 */
export class UnknownAirframeError extends Error {
  constructor(
    readonly airframeId: string,
    readonly reason: 'missing' | 'unparseable',
  ) {
    super(
      reason === 'missing'
        ? `Cannot settle: no airframe ${airframeId}. The flight names an aircraft that is not in this world.`
        : `Cannot settle: airframe ${airframeId} has an effective spec this build cannot parse.`,
    );
    this.name = 'UnknownAirframeError';
  }
}

/**
 * Turn a stored effective spec into the three numbers the settlement bills on.
 *
 * ## Why the burn is divided by `tripFuelFraction`
 *
 * The catalogue publishes `fuelBurnKgPerHour`, which is a cruise fuel flow.
 * `cruiseBurnTPerNm` is a different quantity: `computeFuelBurn` documents it as
 * *fuel loaded ÷ published range*, and then multiplies by `tripFuelFraction`
 * (0.85) to take back the reserves a published range already respects.
 *
 * So converting a cruise flow into that figure means **inverting the haircut**.
 * With `phaseFactors.cruise` at 1, dividing by `tripFuelFraction` here is what
 * makes the cruise phase actually burn the flow the catalogue published. Feeding
 * the raw per-mile flow in would under-burn every sector by the reserve
 * fraction, which is a fuel bill that is wrong in the cheap direction — the one
 * nobody reports.
 *
 * `calibrateCruiseBurn` is the other way to reach this number, and it is the
 * right one for authoring a catalogue entry from a brochure range. It is the
 * wrong one here: it needs an assumed cabin weight and an assumed payload, and a
 * settlement must not depend on a load the flight did not carry.
 *
 * ## Sanity, since two hand-authored figures existed to check against
 *
 * The placeholder ATR came to 0.00303 t/nm and this derivation gives 0.00274;
 * the reference narrowbody was 0.0062 and the A320neo derives to 0.00553. Both
 * land about 10% below the hand figures, and that *consistency* is the useful
 * part — a unit or sign error would not be a uniform 10%. Settlement fuel costs
 * therefore drop slightly across the board, which is a known and deliberate
 * consequence of billing the published flow rather than a rounded guess.
 */
export function settlementAirframeOf(
  spec: AircraftSpec,
  burn: FuelBurnConfig = DEFAULT_FUEL_BURN,
): SettlementAirframe {
  const perNm = spec.fuelBurnKgPerHour / 1000 / spec.cruiseSpeedKt;
  return {
    maxTakeoffWeightT: spec.mtowTonnes,
    cruiseSpeedKt: spec.cruiseSpeedKt,
    cruiseBurnTPerNm: perNm / burn.tripFuelFraction,
  };
}

/**
 * The airframe a flight names, with its catalogue identity.
 *
 * Scoped by world as well as by id. The id alone is unique, so the extra
 * predicate cannot change which row comes back — what it does is make the
 * *absence* of a row mean something narrower: this aircraft does not belong to
 * this world, which after a reset (ADR-0005) is the case that matters.
 *
 * `null` rather than a throw, so the caller decides. `settleArrivedFlight`
 * raises {@link UnknownAirframeError}; a read-only projection may prefer to say
 * "unknown" and carry on.
 */
export async function loadFlightAirframe(
  db: Database,
  worldId: string,
  airframeId: string,
  burn?: FuelBurnConfig,
): Promise<FlightAirframeBasis | null> {
  const [row] = await db
    .select({
      catalogueVersion: airframe.catalogueVersion,
      typeDesignation: airframe.typeDesignation,
      buildOptionIds: airframe.buildOptionIds,
      effectiveSpec: airframe.effectiveSpec,
    })
    .from(airframe)
    .where(and(eq(airframe.id, airframeId), eq(airframe.worldId, worldId)))
    .limit(1);

  if (!row) return null;

  // Parsed through the schema rather than cast. A spec written by a build that
  // has since changed the shape must fail loudly here, not produce `NaN` fuel
  // three lines later and bill it.
  const parsed = AircraftSpec.safeParse(JSON.parse(row.effectiveSpec) as unknown);
  if (!parsed.success) throw new UnknownAirframeError(airframeId, 'unparseable');

  const optionIds: unknown = JSON.parse(row.buildOptionIds);

  return {
    airframeId,
    catalogueVersion: row.catalogueVersion,
    typeDesignation: row.typeDesignation,
    buildOptionIds: Array.isArray(optionIds)
      ? optionIds.filter((id) => typeof id === 'string')
      : [],
    performance: settlementAirframeOf(parsed.data, burn),
  };
}
