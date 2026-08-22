import { z } from 'zod';

import { AircraftSpec } from './aircraft';
import { AircraftOptionCategory } from './aircraft-options';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * The used aircraft market, as a player sees it (M4-05, App. C.5).
 *
 * ## Why the price arrives taken apart
 *
 * Every listing carries its own valuation: the anchor it started from, the age
 * and utilisation factors that reduced it, and one line per fitted option saying
 * what that option did to the number.
 *
 * That is not a convenience for the UI. C.5's whole claim is that *"an unusual
 * configuration is cheap to buy and hard to sell"* — a claim the player has to
 * be able to *see*, or the market is just a list of prices that vary for
 * unstated reasons. Invariant 4 is the general form of the same rule: a number a
 * player cannot attribute is one they will assume is a bug.
 *
 * ## What is deliberately not here
 *
 * No previous-operator names, no maintenance history, no reliability record.
 * Provenance disclosure is HIST-11 (#518), which is blocked on this issue and
 * says explicitly that *"M4 remains the only market/depreciation/price owner"*.
 * This contract stops at the facts the price is computed from, so HIST can add
 * biography later without either milestone having to renegotiate the other's
 * numbers.
 */

/** One fitted option's effect on the asking price. */
export const UsedMarketConfigurationDrag = z
  .object({
    optionId: z.string().min(1),
    category: AircraftOptionCategory,
    /** C.3 rule 5. False means the buyer is stuck with it, and the drag doubles down. */
    retrofittable: z.boolean(),
    /**
     * Subtracted from the configuration factor.
     *
     * Negative for an option the market wants — a wingtip device is not an
     * unusual configuration, it is a good one.
     */
    drag: z.number(),
  })
  .strict();
export type UsedMarketConfigurationDrag = z.infer<typeof UsedMarketConfigurationDrag>;

export const UsedMarketValuation = z
  .object({
    /** What one of these cost new, in this world's economy. */
    anchorMinor: MinorUnits.nonnegative(),
    /**
     * `capitalised_lease` for a type out of production, whose list price the
     * catalogue prints as "—" because there is no factory left to quote one.
     */
    anchorSource: z.enum(['list_price', 'capitalised_lease']),
    ageYears: z.number().nonnegative(),
    /**
     * `anchorMinor × ageFactor × utilisationFactor × configurationFactor` is the
     * asking price, exactly — nothing is clamped on top. The residual value of
     * an old airframe is a salvage term inside `ageFactor`, so the four numbers
     * a player is shown are the four numbers that were multiplied.
     */
    ageFactor: z.number().positive(),
    hours: z.number().nonnegative(),
    /** What an averagely-worked airframe of this age and class would show. */
    expectedHours: z.number().nonnegative(),
    utilisationFactor: z.number().positive(),
    configurationFactor: z.number().positive(),
    /** `0` for a plain airframe, `1` for the most unusual this market produces. */
    unusualness: z.number().min(0).max(1),
    /** One line per option fitted. Empty for a standard airframe. */
    configurationDrags: z.array(UsedMarketConfigurationDrag),
  })
  .strict();
export type UsedMarketValuation = z.infer<typeof UsedMarketValuation>;

export const UsedMarketListing = z
  .object({
    id: Uuid,
    typeDesignation: z.string().min(1),
    registration: z.string().min(1),
    /** The airport the aircraft is standing at, and where it would be delivered. */
    locationIcao: z.string().regex(/^[A-Z]{4}$/),
    buildOptionIds: z.array(z.string().min(1)),
    /** C.6: everything downstream reads this and nothing special-cases an option. */
    effectiveSpec: AircraftSpec,
    /** Game-time instant. Age is derived from it and the world clock. */
    builtAt: Timestamp,
    hours: z.number().nonnegative(),
    cycles: z.number().int().nonnegative(),
    askingPriceMinor: MinorUnits.nonnegative(),
    valuation: UsedMarketValuation,
    availableAt: Timestamp,
    /**
     * Game-time instant the listing is withdrawn.
     *
     * Null only for a hand-made listing predating M4-05, which the refresh does
     * not manage and therefore never expires.
     */
    expiresAt: Timestamp.nullable(),
  })
  .strict();
export type UsedMarketListing = z.infer<typeof UsedMarketListing>;

export const UsedMarketResponse = z
  .object({
    listings: z.array(UsedMarketListing),
    /**
     * The ceiling, so the page can say *"14 of 24 berths occupied"* rather than
     * leaving a short list looking like a failure.
     *
     * M4-05's acceptance criterion is that inventory *"does not become infinite
     * or exhausted"*, and this is the half of that promise a player can see.
     */
    slots: z.number().int().positive(),
  })
  .strict();
export type UsedMarketResponse = z.infer<typeof UsedMarketResponse>;
