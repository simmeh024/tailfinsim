import { z } from 'zod';

import { FUEL_REGIONS, type FuelRegion } from './fuel';
import { MinorUnits, Month } from './primitives';

/**
 * The economy, as data (M3-11, §22.3, App. A).
 *
 * A.3 says it outright about the six β coefficients, and CONTRIBUTING makes it
 * invariant 3 for everything of the kind:
 *
 * > *"**These six numbers are the entire game balance.** They belong in a config
 * > file that can be tuned live, never hard-coded."*
 *
 * So this file is the schema for that config, and `ECONOMY_CONFIG_V1` below is
 * the shipped payload — **the seed, not the source of truth.** What actually
 * runs is a row in `economy_config`, loaded by version, which is what makes
 * §22.3's live retune possible without a deploy.
 *
 * ## Why the numbers live in `shared` rather than in `sim`
 *
 * They have to live *somewhere* in the repository: a fresh database needs a v1
 * row, and `packages/server/src/economy/seed.ts` inserts this one. The same
 * argument `world-config.ts` already makes for `FLAGSHIP_CONFIG` applies — a
 * migration runs once, and a seed has to run again every time a database is
 * created from scratch.
 *
 * `shared` rather than `sim` because this is the **contract**, not the model:
 * the same object is validated on the way into the database, on the way out of
 * it, and against a payload an admin submits. `packages/sim` owns the maths and
 * takes the numbers as parameters, which is why it now holds no balance literal
 * at all — every `DEFAULT_*` there is a slice of this object.
 *
 * ## What is deliberately *not* here
 *
 * §22.3 lists what the economy console owns, and this schema is that list.
 * Three neighbouring things are pointedly outside it:
 *
 *   - **Aircraft performance** — payload/range, fuel burn curves, flight
 *     profiles. That is physics and the §22.5 catalogue, versioned separately
 *     by `world.aircraft_catalogue_version`.
 *   - **Disruption probability** — how often weather bites is §15 and the
 *     world's seed. What a disruption *costs* is economy, and is here.
 *   - **Scheduling and world mechanics** — materialisation horizon, rotation
 *     rules, reachability. Operational limits, not balance.
 *
 * Each of those has its own versioning story. Folding them in here would mean a
 * fare change and an aerodynamics change shared a version number, and a
 * `flight_result` could no longer say which of the two explained it.
 */

/** The economy version pinned by every world created from the shipped config. */
export const ECONOMY_CONFIG_V1_VERSION = 'v1' as const;

/**
 * A version name, as it appears in `world.economy_config_version`.
 *
 * Constrained so a version can be a URL segment and a filename without
 * escaping, and so `v2` and `v2 ` are never two versions. No opinion on the
 * *scheme* beyond that: `v2`, `2026-08-autumn-retune` and `canary-3` are all
 * fine, and §22.3's sandbox → canary → production promotion needs the freedom.
 */
export const EconomyConfigVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dot, dash and underscore only');
export type EconomyConfigVersion = z.infer<typeof EconomyConfigVersion>;

/** Every field of this shape is per passenger segment (App. A.2). */
function bySegment<T extends z.ZodType>(value: T) {
  return z.object({ business: value, leisure: value, vfr: value }).strict();
}

// ---------------------------------------------------------------------------
// Demand — App. A.2 to A.15
// ---------------------------------------------------------------------------

/** A.2's gravity model: `k · (Pop·Wealth)^α · f(distance) · Affinity`. */
export const GravityBalance = z
  .object({
    /** The scale factor: turns the dimensionless product into daily passengers. */
    k: z.number().positive(),
    /** A.2's α ≈ 0.4. Sub-linear, so megacity pairs do not dwarf everything. */
    alpha: z.number().positive(),

    /** Below this the train wins and there is no air market to speak of. */
    surfaceCompetitionNm: z.number().nonnegative(),
    /** How quickly the market builds once surface transport stops competing. */
    riseConstantNm: z.number().positive(),
    /** Where the distance curve peaks — medium haul, in A.2's words. */
    peakDistanceNm: z.number().positive(),
    /** How slowly the curve decays beyond the peak. Larger is slower. */
    longHaulDecayNm: z.number().positive(),

    tourismWeight: z.number().nonnegative(),
    businessWeight: z.number().nonnegative(),
    languageAffinity: z.number().nonnegative(),
    domesticAffinity: z.number().nonnegative(),
  })
  .strict();

/** A.2's segment bands, and the rules that move a city pair between them. */
export const SegmentBalance = z
  .object({
    base: bySegment(z.number().min(0).max(1)),
    businessSwing: z.number().nonnegative(),
    tourismSwing: z.number().nonnegative(),
    vfrSwing: z.number().nonnegative(),
    /** A.2's bands, as `[floor, ceiling]`. The result is clamped into them. */
    bounds: bySegment(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])),
  })
  .strict();

const SeasonBalance = z
  .object({
    /** Positive peaks in summer, negative troughs in it. Business counter-cycles. */
    summerAmplitude: z.number(),
    /** Added during the December holidays, in both hemispheres. */
    holidayBoost: z.number(),
  })
  .strict();

/** A.2's live modulation: `Season · DayOfWeek · Economy · InducedDemand`. */
export const ModulationBalance = z
  .object({
    season: bySegment(SeasonBalance),
    /**
     * Multiplier per weekday, Monday through Sunday.
     *
     * Seven numbers rather than a formula: business peaks twice a week and
     * leisure does very nearly the opposite, and no smooth curve says that as
     * clearly.
     */
    dayOfWeek: bySegment(z.array(z.number().nonnegative()).length(7)),
    /** A.2's ε — business 0.35, leisure 0.9, VFR 0.7. The ordering is the mechanic. */
    elasticity: bySegment(z.number().nonnegative()),
    /** The fare the base pool was sized at. Induced demand is a ratio against it. */
    referenceFareMinor: MinorUnits.positive(),
    /** The months counted as the December holidays. */
    holidayMonths: z.array(Month),
  })
  .strict();

/**
 * A.3's coefficients for one segment — *"the entire game balance"*.
 *
 * The ordering across the row is the whole model: leisure weights price nearly
 * three times as heavily as business does, and business weights product nearly
 * three times as heavily as leisure. Nobody wins everywhere, and that falls out
 * of these numbers rather than out of a rule.
 */
export const SegmentBetas = z
  .object({
    /** How much a fare premium hurts. The master dial (A.11). */
    price: z.number().nonnegative(),
    product: z.number().nonnegative(),
    /** Applied to `ln(frequency)`, so the fifth daily departure buys less than the fourth. */
    frequency: z.number().nonnegative(),
    schedule: z.number().nonnegative(),
    reputation: z.number().nonnegative(),
    /** Frequent-flyer stickiness (App. E.5). Post-MVP, so zero — but a dial, not an absence. */
    loyalty: z.number().nonnegative(),
  })
  .strict();
export type SegmentBetas = z.infer<typeof SegmentBetas>;

export const LogitBalance = z.object({ beta: bySegment(SegmentBetas) }).strict();

/** M3-04's schedule fit: whether you fly at a time the passenger wants. */
export const SchedFitBalance = z
  .object({
    /** One value per hour of the day, 24 long, 0–1. */
    curve: bySegment(z.array(z.number().min(0).max(1)).length(24)),
    /** How much a pile of mediocre departures can substitute for a good one. */
    bankExponent: z.number().positive(),
  })
  .strict();

/** A.6's per-segment cabin propensity. Each segment's row sums to 1. */
export const ClassMixBalance = z
  .object({
    propensity: bySegment(
      z
        .object({
          first: z.number().min(0).max(1),
          business: z.number().min(0).max(1),
          premium_economy: z.number().min(0).max(1),
          economy: z.number().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();

/** One stretch of A.15's booking horizon, and how it leans. */
export const BookingBandBalance = z
  .object({
    /** Inclusive, counting down: 14 is the far end of the horizon. */
    fromDaysOut: z.number().int().positive(),
    toDaysOut: z.number().int().positive(),
    /** This band's share of total demand, before the segment tilt. */
    share: z.number().min(0).max(1),
    /** Over- or under-booking by segment, relative to its own average. Ratios only. */
    tilt: bySegment(z.number().nonnegative()),
  })
  .strict();

export const BookingCurveBalance = z.object({ bands: z.array(BookingBandBalance).min(1) }).strict();

/** A.14's one-stop penalties and the limits on what counts as a connection. */
export const ItineraryBalance = z
  .object({
    /** A.14's `base(segment)`, verbatim: business 0.9, leisure 0.35, VFR 0.3. */
    basePenalty: bySegment(z.number().nonnegative()),
    /** A.14's λ: extra penalty per hour of connection beyond the minimum. */
    lambdaPerHour: z.number().nonnegative(),
    terminalChangePenalty: z.number().nonnegative(),
    /** A.14: connection time ≤ 6 h. */
    maxConnectMinutes: z.number().int().positive(),
    /** A.14: total detour ≤ 1.35 × great circle. */
    maxDetourRatio: z.number().min(1),
    /** A.14: candidate hubs are where the operator bases aircraft, ≤ 10. */
    maxHubs: z.number().int().positive(),
    defaultMctMinutes: z.number().int().positive(),
  })
  .strict();

export const DemandBalance = z
  .object({
    gravity: GravityBalance,
    segments: SegmentBalance,
    modulation: ModulationBalance,
    logit: LogitBalance,
    schedFit: SchedFitBalance,
    classMix: ClassMixBalance,
    bookingCurve: BookingCurveBalance,
    itinerary: ItineraryBalance,
    /**
     * The floor below which a city pair is not worth storing at all.
     *
     * A balance number like any other: raise it and the world gets smaller and
     * cheaper to compute, lower it and thin regional markets become playable.
     */
    viableDailyPassengers: z.number().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Fuel, costs, pricing, boosts — §22.3's remaining headings
// ---------------------------------------------------------------------------

/**
 * §9.3's regional fuel prices, and the into-plane fee that goes with each.
 *
 * `regionFactor` is a multiplier on the world curve, so a shock moves all six
 * together and their **ordering survives it** — which is the property tankering
 * needs. The fee is flat against the curve because it buys a bowser, a driver
 * and a hose rather than a commodity.
 *
 * `europe` is not a guess: 1.03 and $35/t are the two numbers §13.4's worked
 * example was solved through to land the $1,000/t world reference, so the one
 * region the design doc anchors keeps the anchor exactly. The other five are
 * ordered by refinery and pipeline access — at the well, own crude, pipeline-fed,
 * imported, imported and short of refining, trucked a long way — which is the
 * ordering a player can reason about rather than one they must memorise.
 *
 * Defaulted, for the reason `SHIPPED_NPC_BALANCE` records at length.
 */
export const SHIPPED_FUEL_REGIONS = {
  europe: { regionFactor: 1.03, intoPlaneFeePerTonne: 35 },
  north_america: { regionFactor: 0.92, intoPlaneFeePerTonne: 30 },
  middle_east: { regionFactor: 0.78, intoPlaneFeePerTonne: 20 },
  asia_pacific: { regionFactor: 1.08, intoPlaneFeePerTonne: 32 },
  latin_america: { regionFactor: 1.15, intoPlaneFeePerTonne: 42 },
  africa: { regionFactor: 1.22, intoPlaneFeePerTonne: 55 },
} as const satisfies Record<FuelRegion, { regionFactor: number; intoPlaneFeePerTonne: number }>;

/**
 * How the into-plane fee scales with the tier of the station.
 *
 * Centred on `medium`, which is where §13.4's ATR 72 operator actually flies — it
 * runs eight 200 nm sectors a day out of a regional network, not out of a
 * flagship hub — so the $35/t the world reference was solved from stays the fee
 * at the tier the example lives at.
 *
 * The spread is a factor of nearly two from a hydrant stand to a trucked-in
 * bowser, and it is deliberately the largest single station-level effect in the
 * model: it is why a thin route out of a small field is dearer per tonne than
 * its region's headline price, and it is a cost a player can escape by moving
 * the uplift rather than one they simply pay.
 */
export const SHIPPED_FUEL_TIER_FEE_FACTOR = {
  flagship: 0.85,
  large: 0.95,
  medium: 1,
  small: 1.25,
  regional: 1.6,
} as const;

/**
 * The world curve's shape (§11).
 *
 * Two cycles, because one would be a sine wave a player could set a calendar
 * reminder against. The long one is the commodity cycle — five years, the span
 * crude actually turns over in — and the short one is the northern-hemisphere
 * heating and driving season at a year. Their amplitudes add to ±24%, which puts
 * the level between roughly $760/t and $1,240/t around the $1,000/t reference:
 * historically unremarkable for Jet A-1, and the range §20's oil shock has to
 * move *within* rather than *to*.
 *
 * The clamp is wider than the cycles reach on purpose. §20 puts an oil shock on
 * the events table; when it lands it needs somewhere above the cycle envelope to
 * push the level to, and $1,450/t is roughly where Jet A-1 actually peaked in
 * 2022. Nothing writes to the clamp yet — like `quality` on a handler grade, it
 * is defined and carried ahead of its consumer.
 */
export const SHIPPED_FUEL_CURVE: z.input<typeof FuelCurveBalance> = {
  // Not `as const`: zod's `.default()` will not take a readonly array, the same
  // trap `factorBounds` above records.
  cycles: [
    { amplitudeFraction: 0.18, periodDays: 1826 },
    { amplitudeFraction: 0.06, periodDays: 365 },
  ],
  minFactor: 0.65,
  maxFactor: 1.45,
};

/** What one station charges: a multiplier on the world curve, plus a flat service fee. */
export const StationFuelRates = z
  .object({
    regionFactor: z.number().positive(),
    intoPlaneFeePerTonne: z.number().nonnegative(),
  })
  .strict();
export type StationFuelRates = z.infer<typeof StationFuelRates>;

/**
 * The world fuel curve (§11: *"fuel price fluctuates on a world curve"*).
 *
 * A **sum of sinusoids on the world's own calendar**, with the phases drawn from
 * the world seed so two worlds founded the same day do not move in lockstep. Not
 * a random walk, and that is the decision worth recording: a walk would mean the
 * price at a given in-game instant depended on how many times anything had asked
 * for it, and a `flight_result` from October could never be re-derived. A closed
 * form is a pure function of the instant, so a replay bills the same fuel twice
 * (CONTRIBUTING invariant 2).
 */
export const FuelCurveBalance = z
  .object({
    /**
     * The cycles summed to make the curve. Each contributes
     * `amplitudeFraction × sin(2π · (days/periodDays + phase))` to a multiplier
     * around 1, so amplitudes add: two at 0.18 and 0.06 give a ±24% swing.
     */
    cycles: z
      .array(
        z
          .object({
            amplitudeFraction: z.number().min(0).max(1),
            periodDays: z.number().positive(),
          })
          .strict(),
      )
      .min(1),
    /**
     * The floor and ceiling on the multiplier, which is where §20's oil shock
     * gets its headroom: the cycles alone stay well inside these, so an event
     * pushing the level has somewhere to push it to before the clamp bites.
     */
    minFactor: z.number().positive(),
    maxFactor: z.number().positive(),
  })
  .strict();
export type FuelCurveBalance = z.infer<typeof FuelCurveBalance>;

/** §22.3's *"fuel price curve and volatility"*. */
export const FuelBalance = z
  .object({
    /** Jet A-1, dollars per tonne, at the world reference. */
    basePricePerTonne: z.number().positive(),
    /**
     * What a station charges when the airport row has nothing of its own.
     *
     * §9.3's vendor rates. `regionFactor` scales with the world curve; the
     * into-plane fee is a service charge and does not, which is why an oil shock
     * moves one and leaves the other where it is.
     *
     * Before M5-07 this was every airport in the world. It is now the answer for
     * an airport whose geography the dataset does not record — a real case, not a
     * theoretical one — and keeping it is what lets `fuelRegionOf` return *no
     * region* instead of guessing one.
     */
    defaultStation: StationFuelRates,
    /**
     * §9.3's *"prices vary by region"*, priced.
     *
     * Defaulted rather than required, for the reason CLAUDE.md gives: rows in
     * `economy_config` are immutable and parsed on the way out against today's
     * schema, so a required new section makes every payload written before it
     * unparseable — and a world pinned to that version could then not price a
     * flight at all.
     */
    regions: z
      .object(
        // Built from `FUEL_REGIONS` rather than written out, so a seventh region
        // cannot be added to the enum and left unpriced here.
        Object.fromEntries(FUEL_REGIONS.map((region) => [region, StationFuelRates])) as Record<
          FuelRegion,
          typeof StationFuelRates
        >,
      )
      .strict()
      .default(SHIPPED_FUEL_REGIONS),
    /**
     * What the into-plane fee is multiplied by at each tier.
     *
     * The fee is a **service** charge — a bowser, a driver and a hose — so it
     * scales with how hard the station is to fuel rather than with the commodity.
     * A flagship has a hydrant system under the stand and fuels an A320 from a
     * pipeline; a regional strip has fuel trucked in and charges accordingly. That
     * ordering is the reason a thin route out of a small field is dearer per tonne
     * than the headline regional price suggests.
     */
    tierFeeFactor: z
      .object({
        flagship: z.number().positive(),
        large: z.number().positive(),
        medium: z.number().positive(),
        small: z.number().positive(),
        regional: z.number().positive(),
      })
      .strict()
      .default(SHIPPED_FUEL_TIER_FEE_FACTOR),
    /**
     * How far one station's price may sit from its region's, as a fraction.
     *
     * Local supply luck: which terminal serves the field, who holds the
     * concession, how far the product travelled. Drawn per station from the world
     * seed, so it is a fixed fact about that airport in that world rather than
     * noise on every quote — a player can learn that their second base is dear
     * and act on it.
     */
    stationSpread: z.number().min(0).max(1).default(0.04),
    /** Defaulted for the same reason as `regions` (M5-07). */
    curve: FuelCurveBalance.default(SHIPPED_FUEL_CURVE),
  })
  .strict();

/** §22.3's *"cost tables"* — what a sector actually costs to operate. */
export const SettlementBalance = z
  .object({
    ancillaryPerPassengerMinor: MinorUnits.nonnegative(),
    cargoRatePerTonneMinor: MinorUnits.nonnegative(),
    /** Flight and cabin crew, per block hour. Block time is what crew are paid for. */
    crewCostPerBlockHourMinor: MinorUnits.nonnegative(),
    /** An accrual against heavy checks, not a bill — which is how airlines cost it. */
    maintenanceCostPerBlockHourMinor: MinorUnits.nonnegative(),
    groundHandlingPerTurnMinor: MinorUnits.nonnegative(),
    groundHandlingPerSeatMinor: MinorUnits.nonnegative(),
  })
  .strict();

/** What a delay, cancellation or diversion costs (§15, EU261-shaped). */
export const DisruptionCostBalance = z
  .object({
    rebookingPerPassengerMinor: MinorUnits.nonnegative(),
    compensationPerPassengerMinor: MinorUnits.nonnegative(),
    /** The cliff: 179 minutes costs nothing and 181 costs the full amount. */
    compensationDelayThresholdMinutes: z.number().int().nonnegative(),
    carePerPassengerPerHourMinor: MinorUnits.nonnegative(),
    recoveryPerPassengerMinor: MinorUnits.nonnegative(),
    /** Where duty of care starts — EU261's two hours for short haul. */
    careDelayThresholdMinutes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Airport charges used where the airport row carries none of its own.
 *
 * Deliberately a *fallback* rather than the schedule: App. B.2 gives every
 * airport its own `fees` block and M4 fills it. This is what a station charges
 * until then, and it is economy config because somebody has to be able to move
 * it while a world is running.
 */
export const AirportFeeBalance = z
  .object({
    landingPerTonne: MinorUnits.nonnegative(),
    paxFee: MinorUnits.nonnegative(),
    parkingPerHour: MinorUnits.nonnegative(),
    gateLeaseAnnual: MinorUnits.nonnegative(),
  })
  .strict();

/**
 * What an era restriction costs to fly through (M4-02, §7.2b).
 *
 * §7.2b's slow squeeze, priced: *"noise regulations, emissions rules, and fuel
 * price shocks progressively strangle old types rather than deleting them. Your
 * beloved fleet becomes uneconomic before it becomes illegal."*
 *
 * The **dates** are the aircraft catalogue's — a restriction is a property of a
 * type, versioned with it (§22.5). The **rates** are economy config, because
 * they are money and §22.3 owns money. That split is the same one M3-11 drew
 * between an aerodynamics change and a fare change, and it is what lets a world
 * make old aircraft more expensive without re-issuing its catalogue.
 */
export const RestrictionBalance = z
  .object({
    /**
     * Charged per departure at a noise-quota airport.
     *
     * Per departure rather than per tonne, because a noise quota counts
     * movements — an airport that has run out of night quota does not care how
     * heavy the aeroplane is, only that it made a noise.
     */
    noiseQuotaPerDepartureMinor: MinorUnits.nonnegative(),
    /** Charged per tonne of MTOW per departure. Emissions scale with size. */
    emissionsChargePerTonneMinor: MinorUnits.nonnegative(),
    /**
     * Charged per departure by a type excluded from a curfew.
     *
     * A curfew exclusion is really an operational restriction rather than a
     * charge — the aircraft may not fly at night at all. Until §8.2's curfew
     * enforcement can refuse the departure, it is priced as the cost of the
     * disruption it causes, which is the honest interim: it degrades the
     * economics in the right direction and by a defensible amount, and the
     * comment says why it is not yet a refusal.
     */
    curfewExclusionPerDepartureMinor: MinorUnits.nonnegative(),
  })
  .strict();

export const CostBalance = z
  .object({
    settlement: SettlementBalance,
    defaultAirportFees: AirportFeeBalance,
    disruption: DisruptionCostBalance,
    /**
     * Defaulted for the same reason `npc` is, and the rule generalises one level
     * down: a payload written before this field existed must still parse, or
     * every world pinned to it stops being able to price a flight. A new
     * *field* inside an existing section is as much an expand-shaped change as a
     * new section is.
     */
    restrictions: RestrictionBalance.default({
      noiseQuotaPerDepartureMinor: 180_000,
      emissionsChargePerTonneMinor: 900,
      curfewExclusionPerDepartureMinor: 260_000,
    }),
  })
  .strict();

/** §10.4's efficiency ceilings: the most any stack of boosts can ever buy. */
export const BoostBalance = z
  .object({
    ceilings: z
      .object({
        fuelBurn: z.number().min(0).max(1),
        turnaroundTime: z.number().min(0).max(1),
        blockTime: z.number().min(0).max(1),
        maintenanceCost: z.number().min(0).max(1),
        incidentRate: z.number().min(0).max(1),
        serviceCost: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

export const PricingBalance = z
  .object({
    /** A.10's threshold: a fare may not fall below this share of variable cost. */
    fareFloorRatio: z.number().min(0).max(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// NPC carriers — §24's MVP-blocking gap, M3-12
// ---------------------------------------------------------------------------

/** Every field of this shape is per NPC archetype. */
function byArchetype<T extends z.ZodType>(value: T) {
  return z.object({ flag: value, lcc: value, regional: value, charter: value }).strict();
}

/**
 * What one archetype flies, charges and looks like to a passenger.
 *
 * These are balance numbers in the fullest sense: they decide whether a player
 * entering a market meets a soft incumbent or a wall, and App. A.12's
 * *"new entrant viability"* test is measured against them.
 */
export const NpcArchetypeBalance = z
  .object({
    /**
     * Fare as a multiple of per-seat variable cost.
     *
     * Drawn against cost rather than against a fixed price so an NPC's fares
     * scale with distance exactly as a player's economics do — and so A.10's
     * floor, which is also a share of variable cost, is never breached by
     * construction. Below `1` the airline is selling at a loss, which is a
     * legitimate short-term strategy for nobody and is refused by the schema.
     */
    fareMarkup: z.number().min(1),
    /** A.3's 0–1 product composite. A dense charter cabin is genuinely worse. */
    productScore: z.number().min(0).max(1),
    /** §15's compound reputation. NPCs sit around the world median of 0.50. */
    reputation: z.number().min(0).max(1),
    /** Seats offered per cabin. An LCC selling no business cabin is the mechanic. */
    seatsByCabin: z
      .object({
        first: z.number().int().nonnegative(),
        business: z.number().int().nonnegative(),
        premium_economy: z.number().int().nonnegative(),
        economy: z.number().int().nonnegative(),
      })
      .strict(),
    /** The share of a market this archetype sizes its frequency for. */
    targetShare: z.number().min(0).max(1),
    /** Frequency is capped, because slots are finite (§8.1) even before they are modelled. */
    maxFrequency: z.number().int().positive(),
    /** Markets thinner than this are not worth this archetype's time. */
    minDailyPassengers: z.number().nonnegative(),
    /** Sectors longer than this are outside the archetype's reach. */
    maxRangeNm: z.number().positive(),
    /**
     * How much the archetype prefers a leisure-heavy market.
     *
     * 0 is indifferent. A charter operator is strongly positive; a flag carrier
     * mildly negative, because its network is built around business demand.
     */
    leisureAffinity: z.number(),
  })
  .strict();

export const NpcBalance = z
  .object({
    archetypes: byArchetype(NpcArchetypeBalance),
    seeding: z
      .object({
        /** How many NPC carriers a world is seeded with, at most. */
        maxCarriers: z.number().int().nonnegative(),
        /** Routes each carrier opens at seeding. */
        routesPerCarrier: z.number().int().positive(),
        /** Markets below this are ignored when placing an initial network. */
        minDailyPassengers: z.number().nonnegative(),
        /**
         * How many countries get their own carriers.
         *
         * Bounded because IATA codes are scarce — §24 counts roughly 1,300
         * usable two-letter codes against an unbounded player count, and NPCs
         * spending them freely would be a real cost to players later.
         */
        maxCountries: z.number().int().positive(),
      })
      .strict(),
    behaviour: z
      .object({
        /** Game days between one carrier's reviews of its network. */
        reviewIntervalDays: z.number().positive(),
        /**
         * Contribution margin above which a market is worth entering.
         *
         * A.10's monopoly guard made concrete: *"fat margins on an uncontested
         * route visibly attract AI entrants."* Measured over **variable** cost
         * only — there is no ownership or overhead in the cost model yet — so
         * the figure is a contribution margin rather than an operating one, and
         * single digits is the right order.
         *
         * Raise it and monopolies last longer; lower it and players are crowded
         * out of markets before they can establish themselves.
         */
        entryMarginThreshold: z.number(),
        /**
         * How much each incumbent cuts the share a newcomer can expect.
         *
         * The mechanism by which a contested market is less attractive than an
         * empty one: it lowers the load factor the entrant can plan for, which
         * is what actually decides whether a route pays. Bounded below by the
         * clamp in `decideEntry` — an infinite number of incumbents drives the
         * achievable share toward zero, never negative.
         */
        incumbentShareDrag: z.number().nonnegative(),
        /** Candidate markets one carrier considers per review. Bounds the work. */
        entryCandidates: z.number().int().positive(),
        /** Routes one carrier may open per review. Stops a step-change in a world. */
        maxEntriesPerReview: z.number().int().nonnegative(),
        /** Consecutive review cycles of estimated loss before a route is dropped. */
        exitLossReviews: z.number().int().positive(),
        /**
         * How far a fare moves toward the market average per review, 0–1.
         *
         * Deliberately partial. An NPC that jumped straight to the market mean
         * would make every market converge on one fare within a review cycle,
         * which is neither realistic nor interesting to price against.
         */
        fareAdjustmentRate: z.number().min(0).max(1),
        /** A fare within this fraction of target is left alone, so the log stays readable. */
        fareDeadband: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

/**
 * The NPC balance as shipped, named so the schema can default to it.
 *
 * ## Why a new section needs a default
 *
 * `economy_config` rows are immutable and the loader parses them **on the way
 * out**, against today's schema. That is deliberate — a payload that validated
 * against last year's schema is not proof that it validates against this one.
 * It also means that adding a *required* section makes every payload written
 * before it unparseable, and the failure is total rather than partial: a world
 * pinned to that version cannot price a flight, found an airline or draw a fare
 * floor.
 *
 * M3-12 did exactly that, and dev found out. The stored `v1` had been written
 * by the build before `npc` existed, so the first economy read after the deploy
 * threw.
 *
 * The rule that follows, and it is the same one the database already lives by:
 * **a new section is an expand-shaped change and must arrive with a default.**
 * `ADD COLUMN … DEFAULT` for a config payload. A section that genuinely cannot
 * have a sensible default is not an expand — it is a new *version*, created
 * through the admin API and pinned deliberately.
 *
 * Nothing is reverted by this. A default only fills a section that is absent,
 * and a section nobody could have retuned yet is exactly the safe case.
 */
export const SHIPPED_NPC_BALANCE = {
  archetypes: {
    /**
     * The incumbent a player meets on a major city pair. Expensive, comfortable,
     * frequent, and the only archetype selling a front cabin — which is what
     * makes a premium player's first route a fight rather than a walkover.
     */
    flag: {
      fareMarkup: 1.55,
      productScore: 0.74,
      reputation: 0.58,
      seatsByCabin: { first: 0, business: 20, premium_economy: 21, economy: 140 },
      targetShare: 0.32,
      maxFrequency: 8,
      minDailyPassengers: 220,
      maxRangeNm: 4_200,
      // Mildly negative: a flag carrier's network is built around business
      // demand, so a holiday market is not where it wants to be.
      leisureAffinity: -0.15,
    },
    /**
     * Economy only, dense, cheap and frequent. A.2's *"leisure cares about
     * price, price, price"* is what this archetype exists to exploit, and the
     * absence of a business cabin is why a flag carrier still beats it there.
     */
    lcc: {
      fareMarkup: 1.16,
      productScore: 0.34,
      reputation: 0.47,
      seatsByCabin: { first: 0, business: 0, premium_economy: 0, economy: 186 },
      targetShare: 0.34,
      maxFrequency: 10,
      minDailyPassengers: 150,
      maxRangeNm: 2_000,
      leisureAffinity: 0.35,
    },
    /**
     * Thin short-haul markets nobody else wants. Small aircraft, modest
     * frequency, fares that reflect having the market to itself.
     */
    regional: {
      fareMarkup: 1.48,
      productScore: 0.44,
      reputation: 0.5,
      seatsByCabin: { first: 0, business: 0, premium_economy: 0, economy: 72 },
      targetShare: 0.4,
      maxFrequency: 5,
      minDailyPassengers: 45,
      maxRangeNm: 900,
      leisureAffinity: 0.05,
    },
    /**
     * Leisure markets, very dense, very cheap, low frequency. The archetype
     * that makes a Mediterranean route feel contested in August.
     */
    charter: {
      fareMarkup: 1.12,
      productScore: 0.27,
      reputation: 0.42,
      seatsByCabin: { first: 0, business: 0, premium_economy: 0, economy: 220 },
      targetShare: 0.22,
      maxFrequency: 3,
      minDailyPassengers: 180,
      maxRangeNm: 3_000,
      leisureAffinity: 0.75,
    },
  },
  seeding: {
    /**
     * Sixty carriers, not six hundred.
     *
     * The binding constraint is not compute — it is that every NPC spends a
     * two-letter IATA code, and §24 counts roughly 1,300 usable ones against
     * an unbounded player count. Sixty populates the major markets while
     * leaving the namespace overwhelmingly to players.
     */
    maxCarriers: 60,
    routesPerCarrier: 14,
    minDailyPassengers: 120,
    maxCountries: 24,
  },
  behaviour: {
    /** Weekly in game time — often enough to react, rare enough to read. */
    reviewIntervalDays: 7,
    /**
     * 8% contribution over variable cost.
     *
     * Calibrated against what the archetypes can actually earn rather than
     * picked: an LCC at a 1.16 markup contributes at most 13.8% even at a
     * full aircraft, so a threshold in the twenties would mean no low-cost
     * carrier ever entered anything — which is how this number was first got
     * wrong. At 8% a fat uncontested market clears comfortably for every
     * archetype and a contested or badly-suited one does not, which is what
     * makes entry a market judgement rather than a restatement of the markup.
     */
    entryMarginThreshold: 0.08,
    /** Six incumbents roughly halve the share a newcomer can plan for. */
    incumbentShareDrag: 0.15,
    entryCandidates: 40,
    /**
     * Two routes per carrier per review.
     *
     * Uncapped, a review would let one carrier open its entire remaining
     * network at once and turn a world's competitive landscape over in a
     * single tick — a step change no player could price against.
     */
    maxEntriesPerReview: 2,
    /** Four consecutive weekly reviews in the red before a route is dropped. */
    exitLossReviews: 4,
    /** A third of the way toward the market average per review. */
    fareAdjustmentRate: 0.33,
    /** Within 3% of target is close enough; moving it would only fill the log. */
    fareDeadband: 0.03,
  },
};

// ---------------------------------------------------------------------------
// Used market — App. C.5 (M4-05)
// ---------------------------------------------------------------------------

/** Every field of this shape is per factory-option category (App. C.3). */
function byOptionCategory<T extends z.ZodType>(value: T) {
  return z
    .object({
      fuel: value,
      structural: value,
      cabin: value,
      aerodynamic: value,
      engine: value,
      avionics: value,
      cargo: value,
    })
    .strict();
}

/** Every field of this shape is per aircraft class (App. C.2). */
function byAircraftClass<T extends z.ZodType>(value: T) {
  return z
    .object({
      turboprop_regional: value,
      regional_jet: value,
      narrowbody: value,
      widebody: value,
      widebody_ulh: value,
      freighter: value,
    })
    .strict();
}

/**
 * What the world offers second-hand, and how much of it.
 *
 * The market is a fixed number of **berths**, not a growing list. That is the
 * shape M4-05's acceptance criterion asks for — *"inventory does not become
 * infinite or exhausted"* — and a count is the only way to promise both halves:
 * `slots` is the ceiling, and a berth that empties is refilled at the next
 * generation, so it cannot run dry either.
 */
export const UsedMarketInventoryBalance = z
  .object({
    /** Berths. The hard ceiling on how many aircraft are for sale at once. */
    slots: z.number().int().positive(),
    /**
     * Game days between generations.
     *
     * A berth that is empty at a generation boundary is refilled; a berth that
     * is occupied is left alone. So this is the rate at which the market can
     * *renew*, not a churn interval — an aircraft nobody buys is not swept away
     * on a schedule, it ages out of its own listing lifetime below.
     */
    refreshIntervalDays: z.number().int().positive(),
    /** Game days an ordinary listing stays on the market before it is withdrawn. */
    baseListingLifetimeDays: z.number().int().positive(),
    /**
     * Extra game days a maximally unusual listing lingers, scaled linearly by
     * how unusual it is.
     *
     * This is C.5's *"a common configuration sells fast … an unusual one is
     * cheap to buy **and hard to sell**"*, from the buyer's side of the glass.
     * There is no second buyer in MVP — NPCs do not shop — so "somebody else
     * bought it" is modelled as the listing disappearing sooner. A player who
     * keeps seeing the same odd A350 for seven game weeks is being told
     * something true about what they would be taking on.
     */
    unusualLingerDays: z.number().int().nonnegative(),
    /** The youngest and oldest an airframe on the market may be, in years. */
    minAgeYears: z.number().nonnegative(),
    maxAgeYears: z.number().positive(),
    /**
     * Relative likelihood that a berth is filled by each class.
     *
     * Without this the draw is uniform, and a uniform draw over C.2's eighteen
     * types puts as many A380s on the market as A320s — which is wrong about the
     * world in a way a player would notice immediately. Weights rather than
     * probabilities, so a class can be retuned without renormalising the rest.
     */
    classSupplyWeight: byAircraftClass(z.number().nonnegative()),
  })
  .strict()
  .refine((v) => v.maxAgeYears > v.minAgeYears, {
    message: 'maxAgeYears must be greater than minAgeYears',
  });

/**
 * The depreciation curve.
 *
 * **§24 lists "used-aircraft supply and depreciation model" as unresolved —
 * *needed before launch, not before MVP*.** App. C.5 is four qualitative
 * bullets: it gives no curve, no rate and no residual. So these are authored
 * numbers rather than quoted ones, and that is exactly why they belong here and
 * not in `packages/sim` — retuning them is one `INSERT` and a deliberate
 * re-pin, and no listing a world has already priced changes underneath it.
 *
 * One declining-balance rate cannot fit both a twelve-year-old A321neo and a
 * twenty-year-old 737-800 to the real market at once; that is a property of the
 * one-parameter form, not a mistuning. The three properties that matter for
 * play are all structural rather than fitted: older is always cheaper, nothing
 * is ever free, and configuration moves the price.
 */
export const UsedMarketDepreciationBalance = z
  .object({
    /** Rate the *depreciable* share decays per year. `0.86` is ~14%/yr. */
    annualRetentionRate: z.number().gt(0).lt(1),
    /**
     * The residual, as a share of the type's new-equivalent value.
     *
     * Not zero, and not decoration: an airframe too old to earn is still worth
     * its engines and its spares, and a curve that ran to nothing would make a
     * very old aircraft the cheapest route to a fleet in the game.
     *
     * **It is a salvage term, not a clamp**, and that distinction was worth a
     * bug. Clamping `max(floor, retention ** age)` makes the curve *flat* past
     * the age where it crosses the floor — with a floor of 0.10 that is about
     * year 26 — and everything in the flat zone prices identically, so
     * configuration and hours stop mattering exactly where the market is
     * cheapest and most interesting. `floor + (1 - floor) * retention ** age`
     * approaches the same residual and never reaches it, so an unusual
     * twenty-four-year-old is still cheaper than a plain one.
     */
    residualFloorRatio: z.number().gt(0).lt(1),
    /** Block hours a year an averagely-used airframe of this class flies. */
    expectedAnnualHours: byAircraftClass(z.number().positive()),
    /** Average block hours per cycle, so cycles follow from hours and class. */
    averageBlockHoursPerCycle: byAircraftClass(z.number().positive()),
    /**
     * How hard hours bite, per unit of excess over what the airframe's age
     * predicts.
     *
     * Relative to expected hours rather than absolute, because age and hours are
     * strongly correlated and an absolute term would charge twice for one fact.
     * What is left after the age curve has taken its share is the genuinely new
     * information: *this* airframe was worked harder, or less hard, than its age
     * suggests.
     */
    utilisationSensitivity: z.number().nonnegative(),
    /** Bounds on the utilisation factor. Low time is a premium, but a bounded one. */
    utilisationFactorBounds: z.tuple([z.number().positive(), z.number().positive()]),
  })
  .strict()
  .refine((v) => v.utilisationFactorBounds[0] <= v.utilisationFactorBounds[1], {
    message: 'utilisation factor bounds must be ordered',
  });

/**
 * What the market makes of somebody else's configuration.
 *
 * **This is the mechanism App. C.5 exists for**: *"buying used means buying
 * someone else's decisions, including their cabin, their engine variant and
 * their MTOW rating"*. A drag is subtracted from `1` for each option fitted, so
 * a plain airframe prices at its depreciated value and a specialised one prices
 * below it.
 *
 * ## Why a category and not the option itself
 *
 * The obvious home for a resale coefficient is beside the option, in the
 * catalogue. It cannot go there. `aircraft_option` rows are immutable by trigger
 * for the same reason `aircraft_type` rows are — an airframe's build is folded
 * into every `flight_result` it ever settled — so a column added now could never
 * be filled in for the v1 options already seeded, and the only repair would be
 * re-authoring the catalogue as v2.
 *
 * It also belongs here on the merits. How much the market dislikes a
 * high-density cabin is a *market* fact, and M4 owns market pricing. Putting it
 * in the catalogue would mean a resale retune renumbered the aerodynamics, and a
 * `flight_result` could no longer say which of the two explained it.
 */
export const UsedMarketConfigurationBalance = z
  .object({
    /**
     * Subtracted from the configuration factor, once per option fitted.
     *
     * **Negative is allowed, and is used.** An option that makes the aeroplane
     * better for *everybody* — a wingtip device, an efficiency package — is not
     * an unusual configuration, it is a good one, and the market pays for it.
     * Treating every option as a penalty would make the configurator a trap and
     * C.5's *"a bargain if it fits your network"* meaningless.
     */
    categoryDrag: byOptionCategory(z.number().min(-1).max(1)),
    /**
     * Multiplier on the drag of an option that cannot be undone.
     *
     * C.3 rule 5 makes anything structural or engine-related non-retrofittable.
     * A buyer who does not want a folding wingtip is stuck with it for the life
     * of the airframe, and the market prices exactly that.
     */
    nonRetrofittableMultiplier: z.number().positive(),
    /** Bounds on the configuration factor. The floor also defines "maximally unusual". */
    factorBounds: z.tuple([z.number().positive(), z.number().positive()]),
  })
  .strict()
  .refine((v) => v.factorBounds[0] < v.factorBounds[1], {
    message: 'configuration factor bounds must be ordered and distinct',
  });

export const UsedMarketBalance = z
  .object({
    /**
     * Months of lease that stand in for a list price the catalogue does not give.
     *
     * App. C.2 shows *"—"* for a type out of production, and `list_price_minor`
     * is genuinely null for it: there is no factory left to quote one. The used
     * market still has to value it, and the lease rate is the only figure the
     * catalogue states — so it is capitalised at this many months.
     *
     * `125` is not arbitrary: the catalogue's own `leaseFor` helper is 0.8% of
     * list per month, and `1 / 0.008` is 125, so the fallback recovers the
     * notional new price that lease rate was authored from — exactly, for all
     * three v1 types that need it (737-800 → $50M, A380-800 → $200M,
     * 747-8F → $300M).
     *
     * It is a fallback and not a general law. The ATR 72-600's rate is App.
     * B.4's authored $85k rather than a percentage of anything, so inverting it
     * would give the wrong answer — and it does not have to, because that type
     * has a list price and the fallback never runs for it.
     */
    leaseCapitalisationMonths: z.number().positive(),
    inventory: UsedMarketInventoryBalance,
    depreciation: UsedMarketDepreciationBalance,
    configuration: UsedMarketConfigurationBalance,
  })
  .strict();
export type UsedMarketBalance = z.infer<typeof UsedMarketBalance>;

/**
 * The shipped used-market balance, and the default for a payload written before
 * this section existed.
 *
 * Defaulted for the reason `SHIPPED_NPC_BALANCE` records at length: rows in
 * `economy_config` are immutable and are parsed on the way *out*, so a required
 * new section makes every older payload unparseable and a world pinned to one
 * cannot price a flight. A new section arrives with a default, or it is a new
 * version.
 */
export const SHIPPED_USED_MARKET_BALANCE = {
  leaseCapitalisationMonths: 125,

  inventory: {
    /**
     * Twenty-four berths.
     *
     * Enough that a player opening the market sees a real choice across classes;
     * small enough that the aircraft they want is not guaranteed to be there,
     * which is what makes waiting — or ordering new — a decision.
     */
    slots: 24,
    /** A game week, the same cadence the NPC review runs on. */
    refreshIntervalDays: 7,
    baseListingLifetimeDays: 21,
    unusualLingerDays: 28,
    /**
     * Two years, because an airframe younger than that has not had a previous
     * owner in any meaningful sense — and inheriting one is C.5's whole subject.
     */
    minAgeYears: 2,
    maxAgeYears: 25,
    /**
     * Narrowbodies dominate, because they do: they are the type most operators
     * fly and therefore the type most often for sale. A ULH widebody is the
     * rarest, and a berth holding one should feel like an opportunity.
     */
    classSupplyWeight: {
      turboprop_regional: 3,
      regional_jet: 3,
      narrowbody: 8,
      widebody: 2,
      widebody_ulh: 1,
      freighter: 2,
    },
  },

  depreciation: {
    /*
     * Fitted by eye against a handful of real transactions, using the salvage
     * form documented above:
     *
     *   A321neo (anchor $129M)   2 yr → $99M    8 yr → $48M   12 yr → $32M
     *   737-800 (anchor $50M)   25 yr → $6.0M
     *
     * which is close to what those airframes actually change hands for. Nothing
     * here claims more precision than that: one exponential cannot fit the
     * whole life of an airframe, and §24 owns the model that eventually will.
     */
    annualRetentionRate: 0.86,
    residualFloorRatio: 0.1,
    /**
     * Block hours a year. A short-haul narrowbody near 2,600 and a widebody near
     * 4,200 is roughly what utilisation looks like; a turboprop flies fewer hours
     * across far more sectors, which the cycles figure below picks up.
     */
    expectedAnnualHours: {
      turboprop_regional: 2_200,
      regional_jet: 2_400,
      narrowbody: 2_600,
      widebody: 4_200,
      widebody_ulh: 4_600,
      freighter: 3_000,
    },
    /**
     * Hours per cycle — the sector length that turns hours into landings.
     *
     * This is where a turboprop and an A350 stop resembling each other. Both may
     * be twelve years old; one has tens of thousands of landings and the other a
     * few thousand, and cycles are what a maintenance programme actually counts
     * (M4-06).
     */
    averageBlockHoursPerCycle: {
      turboprop_regional: 1.1,
      regional_jet: 1.5,
      narrowbody: 2.2,
      widebody: 7.0,
      widebody_ulh: 11.0,
      freighter: 5.0,
    },
    utilisationSensitivity: 0.25,
    utilisationFactorBounds: [0.7, 1.1] as [number, number],
  },

  configuration: {
    /**
     * Ordered from what everybody wants to what nobody else does.
     *
     * `aerodynamic` is negative on purpose — sharklets and an efficiency package
     * lower fuel burn for whoever ends up with the aeroplane, so the market pays
     * a little more rather than less.
     *
     * `cargo` is the largest because a main-deck cargo door is the most drastic
     * and least reversible thing in C.3's list: it commits the airframe to a
     * role. `engine` and `cabin` come next, and they are the two C.5 names by
     * hand — *"their cabin, their engine variant"* — because an alternative
     * engine variant fragments a maintenance programme and a cabin is the most
     * operator-specific thing on the aircraft.
     */
    categoryDrag: {
      aerodynamic: -0.02,
      avionics: 0.01,
      structural: 0.02,
      fuel: 0.04,
      engine: 0.07,
      cabin: 0.08,
      cargo: 0.12,
    },
    nonRetrofittableMultiplier: 1.5,
    // Not `as const`: zod's `.default()` will not take a readonly tuple, and
    // `SHIPPED_NPC_BALANCE` above is written the same way for the same reason.
    factorBounds: [0.55, 1.05] as [number, number],
  },
};

// ---------------------------------------------------------------------------
// Maintenance — §7.3 (M4-06)
// ---------------------------------------------------------------------------

/** Every field of this shape is per maintenance programme (§7.3). */
function byMaintenanceProfile<T extends z.ZodType>(value: T) {
  return z
    .object({
      turboprop: value,
      regional_jet: value,
      narrowbody: value,
      widebody: value,
      freighter: value,
    })
    .strict();
}

/**
 * One check tier.
 *
 * **Two intervals, and whichever arrives first wins.** That is not detail for
 * its own sake — it is what makes a turboprop and a widebody different aircraft
 * to own. A regional turboprop flying eight short sectors a day reaches its cycle
 * limit long before its hour limit; a ULH widebody does the opposite. One
 * interval would have made every type the same shape of problem.
 */
export const CheckTierBalance = z
  .object({
    /** Block hours between checks. */
    intervalHours: z.number().positive(),
    /** Cycles between checks. A cycle is one flight. */
    intervalCycles: z.number().int().positive(),
    /** Game days the airframe is out of service while the check runs. */
    downtimeDays: z.number().positive(),
    /** What the check costs, whether in-house or bought in. */
    costMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type CheckTierBalance = z.infer<typeof CheckTierBalance>;

/** A programme's three tiers, lightest first. */
export const MaintenanceProgrammeBalance = z
  .object({
    /** Light line maintenance — overnight, cheap, frequent. */
    a: CheckTierBalance,
    /** Heavy check — days to weeks, and the one §22.8's alert warns about. */
    c: CheckTierBalance,
    /** The heaviest — weeks, and a real capital decision on an older airframe. */
    d: CheckTierBalance,
  })
  .strict()
  .refine((v) => v.a.intervalHours < v.c.intervalHours && v.c.intervalHours < v.d.intervalHours, {
    message: 'check intervals must escalate from A through C to D',
  })
  .refine((v) => v.a.downtimeDays < v.c.downtimeDays && v.c.downtimeDays < v.d.downtimeDays, {
    message: 'check downtime must escalate from A through C to D',
  })
  .refine((v) => v.a.costMinor < v.c.costMinor && v.c.costMinor < v.d.costMinor, {
    message: 'check cost must escalate from A through C to D',
  });

/**
 * What deferring a check does to the aeroplane.
 *
 * §7.3's second bullet, and the whole of it: *"Skipped maintenance → reliability
 * decay → delays and cancellations → reputation damage."* It feeds
 * `DisruptionRisk.technical`, which M2-08 reserved for exactly this and
 * documented as *"the inverse of condition … M4-06 owns what moves it."*
 */
export const MaintenanceReliabilityBalance = z
  .object({
    /**
     * The technical risk of a perfectly maintained airframe, per flight.
     *
     * Not zero. An aeroplane in the best condition money can buy still breaks
     * occasionally, and a floor of zero would make a well-run fleet feel
     * unnaturally clean — and would make the deferral penalty the *only* source
     * of technical faults, which would read as a punishment mechanic rather than
     * as operations.
     */
    baselineRisk: z.number().min(0).max(1),
    /**
     * Risk added by each tier once it is fully overdue.
     *
     * Escalating for the obvious reason: a deferred A-check is a nuisance and a
     * deferred D-check is a serious aeroplane problem.
     */
    overdueRisk: z
      .object({
        a: z.number().min(0).max(1),
        c: z.number().min(0).max(1),
        d: z.number().min(0).max(1),
      })
      .strict(),
    /**
     * Block hours over which the overdue penalty ramps in.
     *
     * A ramp rather than a step, so deferral degrades an airframe visibly and
     * progressively — which is what M4-06's first acceptance criterion asks for
     * (*"measurably raises disruption rate within a few game weeks"*) and what a
     * player can actually notice and act on. A step would make a deferred check
     * either free or catastrophic with nothing in between.
     */
    overdueRampHours: z.number().positive(),
    /**
     * The ceiling on technical risk, however neglected.
     *
     * §7.2b's philosophy applied to maintenance: *"Your beloved fleet becomes
     * uneconomic before it becomes illegal."* A neglected airframe should be
     * expensive and unreliable, not unusable — the grounding below is what makes
     * it unusable, and that is a state a player can see and fix rather than a
     * probability that silently approaches 1.
     */
    maxRisk: z.number().min(0).max(1),
  })
  .strict()
  .refine((v) => v.maxRisk >= v.baselineRisk, {
    message: 'maxRisk must be at least the baseline',
  });

export const MaintenanceBalance = z
  .object({
    programmes: byMaintenanceProfile(MaintenanceProgrammeBalance),
    reliability: MaintenanceReliabilityBalance,
    /**
     * How far past a check's interval an airframe may fly before it is grounded.
     *
     * `1.5` means half again the interval. Expressed as a multiple rather than a
     * fixed number of hours so it scales with the tier — an A-check's grace is
     * days and a D-check's is months, which is right.
     *
     * **This is the only thing that grounds an aircraft in M4-06, and that is a
     * deliberate boundary.** Real AOG is mostly unscheduled — a bird strike, a
     * failed part — and §24 lists *"Safety, incidents & insurance"* as its own
     * unaddressed area, with no incident definition or severity ladder. Inventing
     * one here would be inventing that milestone's answer. So an aircraft is
     * grounded because its owner deferred maintenance past the limit, which is a
     * decision the player made and can reverse.
     */
    groundingOverdueMultiple: z.number().gt(1),
  })
  .strict();
export type MaintenanceBalance = z.infer<typeof MaintenanceBalance>;

/**
 * The shipped maintenance programmes.
 *
 * §24 lists **maintenance** as MVP-blocking with *"§7.3 is two bullets"* against
 * it, so — as with the used market — every number here is authored rather than
 * quoted. They are anchored on real-world practice: an A-check every few hundred
 * hours and roughly overnight, a C-check in the thousands of hours and one to
 * three weeks, a D-check in the tens of thousands and over a month. Costs scale
 * with the airframe, which is what the per-profile split is for.
 *
 * Defaulted, for the reason `SHIPPED_NPC_BALANCE` records: a required new section
 * makes every earlier payload unparseable and a world pinned to one cannot price
 * a flight.
 */
export const SHIPPED_MAINTENANCE_BALANCE = {
  programmes: {
    // Cycle-limited in practice: eight short sectors a day reaches 400 cycles
    // long before 500 hours.
    turboprop: {
      a: { intervalHours: 500, intervalCycles: 400, downtimeDays: 1, costMinor: 800_000 },
      c: { intervalHours: 6_000, intervalCycles: 5_000, downtimeDays: 10, costMinor: 18_000_000 },
      d: { intervalHours: 24_000, intervalCycles: 20_000, downtimeDays: 25, costMinor: 70_000_000 },
    },
    regional_jet: {
      a: { intervalHours: 600, intervalCycles: 500, downtimeDays: 1, costMinor: 1_200_000 },
      c: { intervalHours: 7_000, intervalCycles: 5_500, downtimeDays: 12, costMinor: 26_000_000 },
      d: {
        intervalHours: 28_000,
        intervalCycles: 22_000,
        downtimeDays: 28,
        costMinor: 110_000_000,
      },
    },
    narrowbody: {
      a: { intervalHours: 750, intervalCycles: 500, downtimeDays: 1, costMinor: 1_800_000 },
      c: { intervalHours: 7_500, intervalCycles: 5_000, downtimeDays: 14, costMinor: 42_000_000 },
      d: {
        intervalHours: 30_000,
        intervalCycles: 20_000,
        downtimeDays: 35,
        costMinor: 200_000_000,
      },
    },
    // Hour-limited: long sectors reach 900 hours well before 400 cycles.
    widebody: {
      a: { intervalHours: 900, intervalCycles: 400, downtimeDays: 2, costMinor: 3_500_000 },
      c: { intervalHours: 9_000, intervalCycles: 3_500, downtimeDays: 21, costMinor: 90_000_000 },
      d: {
        intervalHours: 36_000,
        intervalCycles: 14_000,
        downtimeDays: 45,
        costMinor: 550_000_000,
      },
    },
    freighter: {
      a: { intervalHours: 800, intervalCycles: 400, downtimeDays: 2, costMinor: 2_800_000 },
      c: { intervalHours: 8_000, intervalCycles: 3_500, downtimeDays: 18, costMinor: 70_000_000 },
      d: {
        intervalHours: 32_000,
        intervalCycles: 14_000,
        downtimeDays: 40,
        costMinor: 400_000_000,
      },
    },
  },

  reliability: {
    baselineRisk: 0.004,
    overdueRisk: { a: 0.02, c: 0.08, d: 0.2 },
    /**
     * 300 block hours.
     *
     * A narrowbody at the ~8 block hours a day a busy operator flies covers that
     * in a bit over a game month, so a deferred check is visibly worse within a
     * few game weeks and fully penalised in about six. That is the window
     * M4-06's first acceptance criterion names, and the ramp is what makes the
     * degradation observable rather than a cliff.
     */
    overdueRampHours: 300,
    /**
     * `0.3`, and it binds — which took a test to get right.
     *
     * The first value here was `0.35`, and the sum of the baseline and all three
     * fully-overdue penalties is `0.004 + 0.02 + 0.08 + 0.2 = 0.304`. So the
     * ceiling could never be reached and was dead configuration: a number that
     * looked like a safety limit and was in fact decoration, which is exactly
     * the dead end invariant 4 exists to prevent.
     *
     * At `0.3` it is a real limit at the extreme, and `maintenance.test.ts`
     * asserts it is reachable so it cannot quietly become decoration again after
     * a retune of the tier penalties.
     */
    maxRisk: 0.3,
  },

  groundingOverdueMultiple: 1.5,
};

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Crew - section 9.2
// ---------------------------------------------------------------------------

/** The flight-deck ladder, in promotion order (section 9.2). */
export const FlightDeckRank = z.enum([
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
]);
export type FlightDeckRank = z.infer<typeof FlightDeckRank>;

/** The cabin ladder, in promotion order (section 9.2). */
export const CabinRank = z.enum([
  'cabin_crew',
  'senior_cabin_crew',
  'purser',
  'cabin_service_manager',
]);
export type CabinRank = z.infer<typeof CabinRank>;

export const CrewRank = z.enum([...FlightDeckRank.options, ...CabinRank.options]);
export type CrewRank = z.infer<typeof CrewRank>;

function byFlightDeckRank<T extends z.ZodType>(value: T) {
  return z
    .object({
      cadet: value,
      first_officer: value,
      senior_first_officer: value,
      captain: value,
      training_captain: value,
    })
    .strict();
}

function byCabinRank<T extends z.ZodType>(value: T) {
  return z
    .object({
      cabin_crew: value,
      senior_cabin_crew: value,
      purser: value,
      cabin_service_manager: value,
    })
    .strict();
}

/**
 * The regulation that decides a legal complement (section 9.2).
 *
 * Separate from pay and hiring because it is the one part a player cannot buy
 * their way around: cabin crew scale with **seats fitted**, not with seats sold,
 * so densifying a cabin costs crew as well as earning fares.
 */
export const CrewRegulationBalance = z
  .object({
    /**
     * Seats per required cabin crew member.
     *
     * `50` is the real rule - ICAO Annex 6 and EASA CAT.OP.MPA.170 both require
     * one attendant per fifty passenger seats installed - and it is quoted rather
     * than authored because section 9.2 says cabin crew are "scaled to seat count
     * by regulation", and this is the regulation.
     */
    seatsPerCabinCrew: z.number().int().positive(),
    /** Nobody flies a passenger aircraft with an empty cabin, however few seats. */
    minimumCabinCrew: z.number().int().positive(),
    /**
     * At or above this many seats the cabin must be led by a Purser.
     *
     * Below it the senior crew member leads without the rank, which keeps a
     * nineteen-seat turboprop from needing a management structure.
     */
    purserFromSeats: z.number().int().positive(),
    /** Section 9.2 puts a Cabin Service Manager on widebody/premium. Seats are the proxy. */
    cabinServiceManagerFromSeats: z.number().int().positive(),

    /** Captain plus First Officer. Two, and the number is not really negotiable. */
    flightDeckPerFlight: z.number().int().positive(),
    /**
     * Block minutes beyond which the flight deck needs relief crew (section 9.2's ULH).
     *
     * A second full flight deck, not one extra pilot: relief crew have to be able
     * to operate the aeroplane while the operating crew rest.
     */
    reliefCrewFromBlockMinutes: z.number().int().positive(),
  })
  .strict();
export type CrewRegulationBalance = z.infer<typeof CrewRegulationBalance>;

/** What a crew base costs to open and run (section 9.2). */
export const CrewBaseBalance = z
  .object({
    /** One-off, charged when the base opens. */
    openingCostMinor: MinorUnits.positive(),
    /** Charged per game month regardless of how many crew are posted there. */
    monthlyOverheadMinor: MinorUnits.nonnegative(),
    /**
     * How many crew a base can hire per game week.
     *
     * A cap rather than a cost curve, because section 9.2's point is that you
     * cannot buy a Captain instantly - the constraint has to be time, or money
     * would simply buy past it.
     */
    weeklyHiringCapacity: z.number().int().positive(),
  })
  .strict();
export type CrewBaseBalance = z.infer<typeof CrewBaseBalance>;

/** Type-rating conversion - section 9.2's mechanical teeth behind fleet commonality. */
export const CrewConversionBalance = z
  .object({
    /** Per crew member converted, per family. */
    costPerHeadMinor: MinorUnits.positive(),
    /**
     * Game days a conversion takes, during which the crew are unavailable.
     *
     * The unavailability is the mechanic, not the money. A fleet decision that
     * costs cash is a line in the accounts; one that removes crew from the roster
     * for a fortnight is felt in the schedule.
     */
    durationDays: z.number().int().positive(),
  })
  .strict();
export type CrewConversionBalance = z.infer<typeof CrewConversionBalance>;

/**
 * Duty, rest and fatigue - section 9.2's flagship crew mechanic (M5-02).
 *
 * ## Why these numbers are quoted rather than authored
 *
 * The same reason `seatsPerCabinCrew` is 50. Flight time limitations are one of
 * the few parts of an airline a designer does not have to invent: EASA
 * ORO.FTL.205 and its tables are public, they are what every European operator
 * actually rosters against, and a player who knows the real rule should find the
 * game agrees with them. Authoring a prettier set would make the mechanic
 * arbitrary at exactly the point section 9.2 wants it to bite.
 *
 * The one liberty taken is **shape**: the real maximum-FDP table is a grid of
 * start time against sector count, and this is that grid expressed as a base,
 * a per-sector reduction and a floor. The parameterisation reproduces the
 * 06:00-13:29 row exactly (13:00 for two sectors, falling 30 minutes a sector to
 * 9:00) and approximates the early-start rows through one reduction rather than
 * six. A world that wants the full grid can add rows later; nothing here reads
 * the numbers as anything but a maximum.
 *
 * ## Why it is a balance section and not a constant
 *
 * Because it is the dial. Duty limits are the difference between a schedule that
 * is tight and one that is impossible, and a world tuning itself towards a more
 * forgiving or a more punishing operation changes these and nothing else. It is
 * also why the FTL numbers are not a `packages/sim` literal: M3-11's rule has no
 * exception for numbers that happen to come from a regulator.
 */
export const CrewDutyBalance = z
  .object({
    /**
     * Minutes on duty before the first departure of a duty period.
     *
     * Report time is duty time, which is why a rotation's duty always exceeds
     * the sum of its block times - and why a player who plans to the block hour
     * and not to the duty hour is the one who discovers this mechanic the hard
     * way.
     */
    reportBeforeDepartureMinutes: z.number().int().nonnegative(),
    /** Minutes still on duty after the last arrival: shutdown, paperwork, debrief. */
    offDutyAfterArrivalMinutes: z.number().int().nonnegative(),

    /**
     * Maximum flight duty period for a favourable start and up to
     * {@link sectorsBeforeReduction} sectors. EASA's 13:00.
     */
    maxFlightDutyMinutes: z.number().int().positive(),
    /** Sectors that cost nothing. Beyond this each one shortens the day. */
    sectorsBeforeReduction: z.number().int().positive(),
    /** How much each additional sector takes off the maximum. EASA's 30 minutes. */
    sectorReductionMinutes: z.number().int().nonnegative(),
    /**
     * The floor however many sectors are flown. EASA's 9:00.
     *
     * Without it a ten-sector day would compute to a negative maximum, and the
     * regulation does not work that way: past a point more sectors stop
     * shortening the day because the day is already as short as it goes.
     */
    minimumFlightDutyMinutes: z.number().int().positive(),

    /**
     * The window of circadian low, in **local** hours at the reporting airport.
     *
     * `[2, 6)` - the real WOCL, and the reason a 03:00 report is a shorter legal
     * day than an 09:00 one for the same flying. Local rather than UTC because
     * the body clock is local; the airport's `utc_offset_minutes` is what makes
     * that answerable.
     */
    woclStartHour: z.number().int().min(0).max(23),
    woclEndHour: z.number().int().min(1).max(24),
    /** How much a duty period that starts inside the WOCL loses. */
    woclReductionMinutes: z.number().int().nonnegative(),

    /** Minimum rest at a crew base. EASA's 12 hours. */
    minimumRestAtBaseMinutes: z.number().int().positive(),
    /**
     * Minimum rest away from base. EASA's 10 hours, and lower on purpose.
     *
     * It has to be, or nobody could ever night-stop - but it is the shorter rest
     * that accumulates fatigue, and it comes with a hotel bill.
     */
    minimumRestAwayMinutes: z.number().int().positive(),

    /**
     * Cumulative duty ceilings over rolling windows. EASA's 60/110/190 hours.
     *
     * Rolling, not calendar: the question is *"how much duty in any seven
     * consecutive days"*, which a week-boundary reset would let a player game by
     * stacking a heavy Sunday against a heavy Monday.
     */
    maxDutyMinutesPer7Days: z.number().int().positive(),
    maxDutyMinutesPer14Days: z.number().int().positive(),
    maxDutyMinutesPer28Days: z.number().int().positive(),
    /** The famous one: 100 block hours in 28 days. */
    maxBlockMinutesPer28Days: z.number().int().positive(),

    /**
     * How close to the limit counts as *approaching* it.
     *
     * Section 9.2 draws the distinction and it is the whole mechanic: exceeding
     * a limit is refused outright, but *running close* to one is what produces a
     * crew timeout when the day slips. A rotation inside this margin is legal,
     * flyable, and one weather delay from not being.
     */
    timeoutWarningMarginMinutes: z.number().int().nonnegative(),

    /**
     * How long a timed-out flight may wait for its crew before it is cancelled
     * instead.
     *
     * Section 9.2 says a timeout *"cancels or delays until legal rest is
     * served"* and does not say which, because the answer depends on how long
     * the rest is. A crew that needs twenty more minutes is a delay; one that
     * needs eleven hours is a cancellation with extra steps, and holding the
     * aeroplane for it would strand the passengers overnight *and* lose the rest
     * of the day's rotation. This is where the line falls.
     */
    crewTimeoutMaxDelayMinutes: z.number().int().nonnegative(),

    /** Per head, per night, when a duty period ends away from a crew base. */
    hotelCostPerHeadPerNightMinor: MinorUnits.nonnegative(),
    /**
     * Per head, to fly crew somewhere as passengers.
     *
     * Deadheading is duty but not flight duty, which is the rule that makes it
     * useful: it repositions crew without spending their flight duty period, at
     * the price of a seat and some of their day.
     */
    deadheadCostPerHeadMinor: MinorUnits.nonnegative(),
    /** The fraction of a deadhead sector's block time that counts as duty. */
    deadheadDutyFraction: z.number().min(0).max(1),
  })
  .strict();
export type CrewDutyBalance = z.infer<typeof CrewDutyBalance>;

/**
 * EASA ORO.FTL.205 and Subpart FTL, as shipped.
 *
 * Real numbers, in the same spirit as `seatsPerCabinCrew: 50`. The two that are
 * this game's rather than the regulator's are marked.
 */
export const SHIPPED_CREW_DUTY_BALANCE = {
  // An hour to report, half an hour to shut down. Both are typical rather than
  // regulated: the rule says duty *includes* them, not how long they take.
  reportBeforeDepartureMinutes: 60,
  offDutyAfterArrivalMinutes: 30,

  // ORO.FTL.205 Table 2, row 06:00-13:29: 13:00 for one or two sectors, falling
  // 30 minutes a sector to a floor of 9:00.
  maxFlightDutyMinutes: 780,
  sectorsBeforeReduction: 2,
  sectorReductionMinutes: 30,
  minimumFlightDutyMinutes: 540,

  // The WOCL, and the reduction that makes an 03:00 report a shorter day.
  woclStartHour: 2,
  woclEndHour: 6,
  woclReductionMinutes: 120,

  // ORO.FTL.235.
  minimumRestAtBaseMinutes: 720,
  minimumRestAwayMinutes: 600,

  // ORO.FTL.210: 60 hours in 7 days, 110 in 14, 190 in 28; 100 block hours in 28.
  maxDutyMinutesPer7Days: 3_600,
  maxDutyMinutesPer14Days: 6_600,
  maxDutyMinutesPer28Days: 11_400,
  maxBlockMinutesPer28Days: 6_000,

  // This game's, not the regulator's. An hour of slack is roughly one weather
  // delay: enough that a rotation planned to it is genuinely at risk, and not so
  // much that every schedule is permanently warned about.
  timeoutWarningMarginMinutes: 60,

  // Three hours. Long enough that a short rest is worth waiting out, short
  // enough that it is never the cheap answer to a crew that needs a night.
  crewTimeoutMaxDelayMinutes: 180,

  // Also this game's. A hotel night sits near a cabin crew member's weekly pay,
  // so night-stopping a wide cabin away from base is a real line in the accounts
  // rather than a rounding error; a deadhead seat costs more, because it is one.
  hotelCostPerHeadPerNightMinor: 15_000,
  deadheadCostPerHeadMinor: 25_000,
  // Deadheading is duty but not flight duty (ORO.FTL.205(e)). Half is the
  // conventional rostering treatment.
  deadheadDutyFraction: 0.5,
} as const satisfies z.input<typeof CrewDutyBalance>;

/**
 * Morale, pay bands and attrition (section 9.2, M5-03).
 *
 * ## What section 9.2 actually promises
 *
 * *"Pay band, roster stability, hotel quality, and rest ratio feed a morale
 * score per base. Low morale leads to sickness, attrition, worse service scores
 * ... Cost-cutting on crew is a viable strategy with a delayed, visible bill."*
 *
 * Every word of that is load-bearing. **Viable** means paying badly has to be a
 * real option that saves real money, not a trap with a warning sign on it.
 * **Delayed** means the saving arrives before the cost, or there is no decision
 * to make. **Visible** means that when the bill comes the player can see what it
 * was for - which is why {@link moraleTarget} itemises rather than returning a
 * number.
 *
 * ## Bands, not a slider
 *
 * A continuous pay multiplier invites the player to hunt for the exact figure
 * that buys the most morale per unit of cash, which is arithmetic homework
 * rather than a decision. Three bands is a choice: pay under the odds, pay the
 * rate, or pay up. The same reasoning applies to hotels.
 */
export const PayBand = z.enum(['lean', 'market', 'generous']);
export type PayBand = z.infer<typeof PayBand>;

export const HotelTier = z.enum(['budget', 'standard', 'premium']);
export type HotelTier = z.infer<typeof HotelTier>;

const BandEffect = z
  .object({
    /** Multiplies the book rate. `1` is the rate in `flightDeckSalaryMinor`. */
    costMultiplier: z.number().positive(),
    /** What this band contributes to morale, 0-1, before weighting. */
    moraleFactor: z.number().min(0).max(1),
  })
  .strict();

export const CrewMoraleBalance = z
  .object({
    payBands: z.object({ lean: BandEffect, market: BandEffect, generous: BandEffect }).strict(),
    hotelTiers: z
      .object({ budget: BandEffect, standard: BandEffect, premium: BandEffect })
      .strict(),

    /**
     * How much each input matters. Summed and normalised, so they need not
     * total 1 - but they do, because a set of weights that does not is a set
     * nobody can read.
     */
    weights: z
      .object({
        pay: z.number().min(0),
        rosterStability: z.number().min(0),
        hotel: z.number().min(0),
        rest: z.number().min(0),
      })
      .strict(),

    /**
     * Where a newly opened base starts.
     *
     * Not 1. A crew who have just arrived are neither delighted nor mutinous,
     * and starting at the top would mean the only direction morale can move is
     * down - which reads as a punishment mechanic rather than a dial.
     */
    startingMorale: z.number().min(0).max(1),

    /**
     * The fraction of the remaining gap morale closes each game week.
     *
     * **This is the "delayed" in section 9.2's delayed bill**, and it is the
     * single most important number here. Too fast and cutting pay hurts
     * immediately, so nobody ever does it and the strategy is not viable. Too
     * slow and the consequence arrives so long after the decision that the
     * player cannot connect the two, which is worse than no consequence at all.
     */
    driftPerWeek: z.number().min(0).max(1),

    /** Heads per week who call in sick, at zero and at full morale. */
    sicknessAtZero: z.number().min(0).max(1),
    sicknessAtFull: z.number().min(0).max(1),
    /** Game days a sick crew member is unavailable. */
    sicknessDays: z.number().int().positive(),

    /**
     * Rest-to-duty ratios at which crew are content, and at which they are not.
     *
     * The rest *ratio* is rest hours against duty hours across recent duty
     * periods - not rest served against rest required, which is structurally 1
     * because the dispatcher refuses to grant short rest in the first place. An
     * input that can only ever read 1 is not an input.
     *
     * What this measures is whether the crew are being *worked hard*: a base
     * flying thirteen-hour days on twelve-hour rests scores badly even though
     * every one of those rests was legal, and that is exactly section 9.2's
     * complaint.
     */
    restToDutyForFull: z.number().positive(),
    restToDutyForZero: z.number().nonnegative(),

    /** Fraction of a pool who resign per week, at zero and at full morale. */
    attritionAtZero: z.number().min(0).max(1),
    attritionAtFull: z.number().min(0).max(1),

    /**
     * What morale does to service execution, as a multiplier (App. D.1, M8-04).
     *
     * Exposed and **not consumed here**. M8-04 assembles the product score and
     * owns how the inputs combine - App. D.1 says *"the weakest input
     * dominates"*, which is a decision about all four inputs and cannot be taken
     * by the one that happens to be built first. This is the M2-08 seam again:
     * supply the number, let the owner use it.
     */
    serviceExecutionAtZero: z.number().min(0).max(1),
    serviceExecutionAtFull: z.number().min(0).max(1),
  })
  .strict();
export type CrewMoraleBalance = z.infer<typeof CrewMoraleBalance>;

/**
 * The shipped morale balance.
 *
 * ## How the pay bands are scaled
 *
 * Against the one anchor that exists: a Captain's book rate is 1,000,000 a month
 * and a narrowbody A-check is 1,800,000. Lean saves 15%, generous costs 20%.
 * On a small airline that is a few hundred thousand a month either way - enough
 * to matter against a check, not enough to decide the game in a quarter.
 *
 * ## Why lean is 0.25 rather than 0
 *
 * Paying under the rate is unpopular, not abusive. A base on lean pay with good
 * rosters, decent hotels and proper rest still lands around 0.6 morale, which is
 * liveable - and that is the point of section 9.2's *"viable strategy"*. A pay
 * band that alone floored morale would make the other three inputs decorative.
 *
 * ## The drift number
 *
 * `0.12` a week closes half the gap in **5.4 game weeks** and 85% of it in
 * fifteen. On the flagship world's 2x clock that is under three real weeks to
 * feel a pay cut properly - long enough to bank the saving and stop thinking
 * about it, which is exactly the trap section 9.2 describes, and short enough
 * that the player is still recognisably the person who made the decision.
 */
export const SHIPPED_CREW_MORALE_BALANCE = {
  payBands: {
    lean: { costMultiplier: 0.85, moraleFactor: 0.25 },
    market: { costMultiplier: 1, moraleFactor: 0.65 },
    generous: { costMultiplier: 1.2, moraleFactor: 1 },
  },
  hotelTiers: {
    budget: { costMultiplier: 0.6, moraleFactor: 0.2 },
    standard: { costMultiplier: 1, moraleFactor: 0.65 },
    premium: { costMultiplier: 1.8, moraleFactor: 1 },
  },

  // Pay is the largest single input and still under half: an airline cannot buy
  // its way out of running its crew into the ground.
  weights: { pay: 0.4, rosterStability: 0.2, hotel: 0.15, rest: 0.25 },

  startingMorale: 0.65,
  driftPerWeek: 0.12,

  // About one head in twelve out sick at rock bottom, one in a hundred at the
  // top. Three days, so it disrupts a rotation without emptying a base.
  sicknessAtZero: 0.08,
  sicknessAtFull: 0.01,
  sicknessDays: 3,

  // Equal rest and duty is comfortable; two hours of rest for every three of
  // duty is where it stops being. Both are legal -- ORO.FTL's floors are lower
  // than either -- which is the point: this measures wear, not compliance.
  restToDutyForFull: 1,
  restToDutyForZero: 0.66,

  // 4% a week at zero morale empties a pool in roughly half a game year -- slow
  // enough to be a bill rather than a collapse, fast enough to notice.
  attritionAtZero: 0.04,
  attritionAtFull: 0.002,

  // App. D.1: execution never jumps a band, it decides where you sit inside one.
  // So even a mutinous crew delivers most of what was paid for -- 0.7 of it.
  serviceExecutionAtZero: 0.7,
  serviceExecutionAtFull: 1,
} as const satisfies z.input<typeof CrewMoraleBalance>;

export const CrewBalance = z
  .object({
    regulation: CrewRegulationBalance,
    base: CrewBaseBalance,
    conversion: CrewConversionBalance,
    /**
     * Defaulted, and it has to be. `crew` itself is defaulted for the reason
     * `SHIPPED_NPC_BALANCE` records; a *required* new field inside it would
     * reintroduce exactly that failure one level down, making every payload
     * written before M5-02 unparseable on the first read after the deploy.
     */
    duty: CrewDutyBalance.default(SHIPPED_CREW_DUTY_BALANCE),
    /** Defaulted, for the reason `duty` is. */
    morale: CrewMoraleBalance.default(SHIPPED_CREW_MORALE_BALANCE),
    /**
     * Monthly salary per head, by rank.
     *
     * The **book rate**. What an airline actually pays is this multiplied by
     * its base's pay band (M5-03), so this is the middle of the scale rather
     * than a floor - a lean base pays less than these figures.
     */
    flightDeckSalaryMinor: byFlightDeckRank(MinorUnits.positive()),
    cabinSalaryMinor: byCabinRank(MinorUnits.positive()),
    /** One-off recruitment cost per head, by ladder. */
    hiringCostMinor: z
      .object({ flightDeck: MinorUnits.positive(), cabin: MinorUnits.positive() })
      .strict(),
  })
  .strict();
export type CrewBalance = z.infer<typeof CrewBalance>;

/**
 * The shipped crew balance.
 *
 * The regulation numbers are real; everything else is authored, because section
 * 9.2 is prose and App. A has no crew table.
 *
 * ## What they are scaled against
 *
 * Two anchors already in this file, because a crew price invented in isolation
 * is a number nobody can argue with:
 *
 *   - **`airlineStartingPosition.openingCashMinor` is 50,000,000.** A crew base
 *     is a *precondition for flying at all* - no base, no pools, no legal
 *     complement - so it has to be affordable on day one. The first draft
 *     charged 250,000,000 for one, five times everything a new airline owns,
 *     and the database tests could not open a base at all. It now costs 6% of
 *     the opening balance.
 *   - **A narrowbody A-check is 1,800,000** and comes round often. A Captain's
 *     month sits a little under that, which puts the crew for one narrowbody in
 *     the same order as keeping it airworthy rather than an order above it.
 *
 * The shape of the mechanic is kept: a Captain costs several times a new cabin
 * crew member, a conversion costs a fortnight of availability, and the monthly
 * overhead punishes opening a base per destination.
 *
 * Salaries are not charged anywhere yet - payroll is not M5-01 - but they are
 * tuned as though they were, so that whichever milestone starts billing them
 * does not inherit numbers chosen when nothing read them.
 *
 * Defaulted, for the reason `SHIPPED_NPC_BALANCE` records: a required new section
 * makes every earlier payload unparseable, and a world pinned to one cannot price
 * a flight, found an airline or draw a fare floor.
 */
export const SHIPPED_CREW_BALANCE = {
  regulation: {
    // ICAO Annex 6 / EASA CAT.OP.MPA.170.
    seatsPerCabinCrew: 50,
    minimumCabinCrew: 1,
    // Around the regional-jet/narrowbody boundary: a 100-seater is led, a
    // 70-seat turboprop is not.
    purserFromSeats: 100,
    // Widebody territory in this catalogue, which is what section 9.2 asks for.
    cabinServiceManagerFromSeats: 250,
    flightDeckPerFlight: 2,
    // Twelve hours block. Beyond it one flight deck cannot legally operate, which
    // is what makes ULH a crew decision as well as a fleet one.
    reliefCrewFromBlockMinutes: 720,
  },
  base: {
    // 6% of a founding airline's cash. A real commitment, and payable on day one.
    openingCostMinor: 3_000_000,
    monthlyOverheadMinor: 500_000,
    weeklyHiringCapacity: 12,
  },
  conversion: {
    // About a fortnight of a Captain's pay per head, on top of the fortnight of
    // lost availability -- which remains the part that actually hurts.
    costPerHeadMinor: 200_000,
    durationDays: 14,
  },
  flightDeckSalaryMinor: {
    cadet: 300_000,
    first_officer: 500_000,
    senior_first_officer: 700_000,
    captain: 1_000_000,
    training_captain: 1_250_000,
  },
  cabinSalaryMinor: {
    cabin_crew: 200_000,
    senior_cabin_crew: 260_000,
    purser: 350_000,
    cabin_service_manager: 450_000,
  },
  // One-off recruitment: about four months of pay for a pilot, six weeks for
  // cabin crew. Time, not money, is the constraint section 9.2 cares about, and
  // that lives in `weeklyHiringCapacity`.
  hiringCostMinor: { flightDeck: 400_000, cabin: 100_000 },
  duty: SHIPPED_CREW_DUTY_BALANCE,
  morale: SHIPPED_CREW_MORALE_BALANCE,
} as const satisfies z.input<typeof CrewBalance>;

/**
 * What a hired social media specialist is worth (M5-04 follow-up, §9.1, §15).
 *
 * The market offers one of two specialists per world (`SOCIAL_MEDIA_SPECIALISTS`
 * in `office.ts`), and an airline may hire one. Their effect is a balance lever
 * rather than a hard-coded figure, for CONTRIBUTING invariant 3's reason: what a
 * marketing hire is worth is precisely the kind of number a world should be able
 * to retune without a deploy.
 *
 *   - `reputationPerMonth` — the reputation specialist's slow drip. Added to
 *     `airline.reputation` once per game month while she is on staff, clamped at
 *     §15's 1.00 ceiling. Deliberately tiny: reputation is a compound the whole
 *     demand model reads, so this is a nudge over seasons, not a shortcut.
 *   - `attractivenessUtility` — the attractiveness specialist's edge, added
 *     directly to the airline's A.3 utility (like the alliance bonus, not through
 *     a beta) in every market where it competes, but **only once it flies more
 *     than one route**. A one-route airline has no network to market; the second
 *     route is what the specialist has something to say about.
 */
export const SocialMediaBalance = z
  .object({
    reputationPerMonth: z.number().min(0).max(1),
    attractivenessUtility: z.number().nonnegative(),
  })
  .strict();
export type SocialMediaBalance = z.infer<typeof SocialMediaBalance>;

export const SHIPPED_SOCIAL_MEDIA_BALANCE = {
  // §15's reputation runs 0.00–1.00; 0.05 a month is roughly a point a season,
  // so a specialist kept on for a year lifts a median airline by a tier without
  // ever being the reason it wins a route on her own.
  reputationPerMonth: 0.05,
  // A small additive utility. The leisure reputation beta is ~1.4, so 0.1 is
  // worth about seven reputation points' worth of pull — a thumb on the scale in
  // a close market, not a dominant strategy (A.1's third requirement).
  attractivenessUtility: 0.1,
} as const satisfies z.input<typeof SocialMediaBalance>;

/**
 * The hub purchase curve (M7-04, App. B.5).
 *
 * `HubCost = tierBaseMinor[tier] × costGrowth^(hubs_owned − 1)`, and the multiplier
 * counts **hubs owned, not hubs of that tier** — so every cheap hub bought early
 * makes every future flagship dearer. The first hub is free at any tier; that
 * waiver is `airlineStartingPosition.freeHubAllowance`, not a number here.
 *
 * Fees and facilities are deliberately absent: App. B.5 gives the purchase table
 * exactly but only says facility fees "scale with tier" without figures, so those
 * arrive with the annual-fee/facility milestone rather than as invented balance.
 */
export const HubTier = z.enum(['small', 'medium', 'large', 'flagship']);
export type HubTier = z.infer<typeof HubTier>;

export const HubBalance = z
  .object({
    /** Tier base price, minor units — the `TierBase` in the App. B.5 formula. */
    tierBaseMinor: z
      .object({
        small: MinorUnits.positive(),
        medium: MinorUnits.positive(),
        large: MinorUnits.positive(),
        flagship: MinorUnits.positive(),
      })
      .strict(),
    /** The exponential base: each hub already owned multiplies the next one's cost. */
    costGrowth: z.number().finite().gt(1),
  })
  .strict();
export type HubBalance = z.infer<typeof HubBalance>;

export const SHIPPED_HUB_BALANCE = {
  // App. B.5's tier bases: $2M / $5M / $10M / $25M, in minor units at the same
  // 100-per-unit scale as `openingCashMinor` ($500K → 50,000,000).
  tierBaseMinor: {
    small: 200_000_000,
    medium: 500_000_000,
    large: 1_000_000_000,
    flagship: 2_500_000_000,
  },
  // "doubling with every hub you already own" — App. B.5. The strategic tension the
  // issue is about lives entirely in this being 2 and counting all hubs owned.
  costGrowth: 2,
} as const satisfies z.input<typeof HubBalance>;

export const EconomyConfig = z
  .object({
    version: EconomyConfigVersion,
    airlineStartingPosition: z
      .object({
        /** Integer minor units of the world's still-unnamed currency (M8-02). */
        openingCashMinor: MinorUnits.nonnegative(),
        /** Number of hub purchases waived when the airline is founded. */
        freeHubAllowance: z.number().int().nonnegative(),
      })
      .strict(),
    airlineIdentity: z
      .object({
        /** Paid §15 rebrand event; currency remains deliberately unnamed until M8-02. */
        rebrandCostMinor: MinorUnits.positive(),
      })
      .strict(),
    demand: DemandBalance,
    fuel: FuelBalance,
    costs: CostBalance,
    pricing: PricingBalance,
    boosts: BoostBalance,
    // Defaulted, not required — see `SHIPPED_NPC_BALANCE` for why a new
    // section must be, and what to do when it cannot be.
    npc: NpcBalance.default(SHIPPED_NPC_BALANCE),
    // Defaulted for the same reason. Every `v1` row written before M4-05 is
    // still parseable, and reads back the shipped used market.
    usedMarket: UsedMarketBalance.default(SHIPPED_USED_MARKET_BALANCE),
    // Defaulted for the same reason again (M4-06).
    maintenance: MaintenanceBalance.default(SHIPPED_MAINTENANCE_BALANCE),
    // And again (M5-01).
    crew: CrewBalance.default(SHIPPED_CREW_BALANCE),
    // Defaulted for the same reason once more (M5-04 follow-up). Every `v1` row
    // written before the social media specialist reads back the shipped values.
    socialMedia: SocialMediaBalance.default(SHIPPED_SOCIAL_MEDIA_BALANCE),
    // Defaulted for the same reason once more (M7-04): the hub purchase curve. Every
    // `v1` row written before it reads back the shipped App. B.5 prices.
    hubs: HubBalance.default(SHIPPED_HUB_BALANCE),
  })
  .strict();
export type EconomyConfig = z.infer<typeof EconomyConfig>;

/**
 * The shipped payload, and the seed for a fresh database.
 *
 * Parsed at module load rather than cast, so a typo here fails the first import
 * rather than the first settlement. Every provenance note for an individual
 * number stays beside it — these are the only places in the repository where
 * "why this number" is recorded.
 */
export const ECONOMY_CONFIG_V1: EconomyConfig = EconomyConfig.parse({
  version: ECONOMY_CONFIG_V1_VERSION,

  airlineStartingPosition: {
    /**
     * The design writes "$500K", but §24 leaves the accounting currency open and
     * M8-02 owns that decision. 50,000,000 integer minor units of the world's
     * deliberately unnamed currency, not an assumption of dollars.
     */
    openingCashMinor: 50_000_000,
    freeHubAllowance: 1,
  },
  airlineIdentity: {
    /** 25,000 major units: meaningful beside the opening position without being punitive. */
    rebrandCostMinor: 2_500_000,
  },

  demand: {
    gravity: {
      /**
       * Calibrated to one anchor: **Amsterdam–London at about 10,000 passengers
       * a day**, both directions, all carriers — roughly 3.6 million a year,
       * the right order for one of Europe's densest city pairs.
       *
       * One anchor rather than several because the rest of the curve is shape,
       * and shape is what the distance and affinity terms are for.
       */
      k: 0.026,
      alpha: 0.4,
      surfaceCompetitionNm: 100,
      riseConstantNm: 120,
      peakDistanceNm: 700,
      longHaulDecayNm: 2_200,
      tourismWeight: 0.6,
      businessWeight: 0.5,
      languageAffinity: 0.25,
      domesticAffinity: 0.35,
    },
    segments: {
      base: { business: 0.2, leisure: 0.55, vfr: 0.25 },
      businessSwing: 0.35,
      tourismSwing: 0.4,
      vfrSwing: 0.2,
      bounds: { business: [0.1, 0.35], leisure: [0.4, 0.7], vfr: [0.15, 0.3] },
    },
    modulation: {
      season: {
        // Summer holidays and Christmas both, and strongly. This is the segment
        // that makes a Mediterranean route worth three times as much in August.
        leisure: { summerAmplitude: 0.45, holidayBoost: 0.2 },
        // Counter-cyclical, and less violently so: business travel falls away in
        // August and over Christmas but never stops.
        business: { summerAmplitude: -0.2, holidayBoost: -0.25 },
        // The Christmas segment. People fly home for it far more than they fly
        // anywhere for the summer.
        vfr: { summerAmplitude: 0.15, holidayBoost: 0.5 },
      },
      dayOfWeek: {
        //         Mon   Tue   Wed   Thu   Fri  Sat  Sun
        business: [1.35, 1.15, 1.05, 1.25, 1.2, 0.4, 0.6],
        leisure: [0.8, 0.75, 0.8, 0.95, 1.3, 1.25, 1.15],
        vfr: [0.85, 0.8, 0.85, 1.0, 1.35, 1.15, 1.0],
      },
      elasticity: { business: 0.35, leisure: 0.9, vfr: 0.7 },
      /** §13.4's worked example sells at €75, which is what makes it the reference. */
      referenceFareMinor: 7_500,
      holidayMonths: [12],
    },
    logit: {
      beta: {
        //        price  product  freq  sched  rep   loyalty
        business: {
          price: 1.1,
          product: 2.2,
          frequency: 1.6,
          schedule: 1.0,
          reputation: 1.4,
          loyalty: 0,
        },
        leisure: {
          price: 3.0,
          product: 0.8,
          frequency: 0.9,
          schedule: 0.4,
          reputation: 0.5,
          loyalty: 0,
        },
        vfr: {
          price: 2.4,
          product: 0.6,
          frequency: 0.8,
          schedule: 0.4,
          reputation: 0.7,
          loyalty: 0,
        },
      },
    },
    schedFit: {
      curve: {
        /**
         * Two peaks and a hole. 07:00 is the best hour of the day, 18:00 nearly
         * as good, and the middle of the afternoon is worth less than a third of
         * either. Overnight is close to worthless: a 03:00 departure is not a
         * business proposition at any price.
         */
        //         00    01    02    03    04    05    06    07   08    09   10    11
        business: [
          0.02, 0.02, 0.02, 0.02, 0.05, 0.35, 0.85, 1.0, 0.95, 0.7, 0.45, 0.35,
          //   12   13    14    15    16    17    18    19   20   21   22    23
          0.3, 0.3, 0.35, 0.45, 0.65, 0.85, 0.95, 0.85, 0.6, 0.3, 0.1, 0.04,
        ],
        /**
         * Broad and mid-day tolerant, exactly as A.3 says. What leisure dislikes
         * is the small hours, and even then less than business does.
         */
        leisure: [
          0.12, 0.1, 0.1, 0.1, 0.15, 0.45, 0.72, 0.88, 0.94, 0.97, 1.0, 1.0, 1.0, 0.98, 0.96, 0.94,
          0.92, 0.9, 0.85, 0.76, 0.64, 0.48, 0.3, 0.18,
        ],
        /**
         * Near-flat. Someone flying home to see family will take whatever is
         * going; the full range is about a third, against nearly the whole scale
         * for business — that gap *is* the mechanic.
         */
        vfr: [
          0.7, 0.66, 0.64, 0.64, 0.7, 0.8, 0.88, 0.93, 0.96, 0.98, 1.0, 1.0, 1.0, 1.0, 0.99, 0.98,
          0.97, 0.96, 0.95, 0.93, 0.9, 0.85, 0.8, 0.74,
        ],
      },
      bankExponent: 2,
    },
    classMix: {
      propensity: {
        /**
         * The segment that buys the front of the aircraft — and still mostly
         * does not. The 18% in business class is what makes a premium cabin
         * viable at all, and it is concentrated on exactly the routes where the
         * business *segment* is deep.
         */
        business: { first: 0.02, business: 0.18, premium_economy: 0.2, economy: 0.6 },
        /** A.2: leisure *"cares about price, price, price"*. */
        leisure: { first: 0.001, business: 0.019, premium_economy: 0.06, economy: 0.92 },
        /** Even more economy-bound than leisure. Nobody flies first to visit their mother. */
        vfr: { first: 0, business: 0.01, premium_economy: 0.04, economy: 0.95 },
      },
    },
    bookingCurve: {
      bands: [
        {
          // "early leisure, price-led" — the holidaymaker who booked in March.
          fromDaysOut: 14,
          toDaysOut: 8,
          share: 0.15,
          tilt: { business: 0.35, leisure: 1.35, vfr: 1.25 },
        },
        {
          fromDaysOut: 7,
          toDaysOut: 3,
          share: 0.45,
          tilt: { business: 0.9, leisure: 1.05, vfr: 1.05 },
        },
        {
          // "late business, price-tolerant" — the trip that was arranged on
          // Tuesday for Thursday, and which is why a full-fare cabin can be
          // worth holding seats back for.
          fromDaysOut: 2,
          toDaysOut: 1,
          share: 0.4,
          tilt: { business: 2.0, leisure: 0.6, vfr: 0.7 },
        },
      ],
    },
    itinerary: {
      // The three numbers A.14 publishes, and the whole mechanic.
      basePenalty: { business: 0.9, leisure: 0.35, vfr: 0.3 },
      /**
       * Not a published figure — A.14 names the term and leaves the coefficient
       * open. At 0.25 a three-hour connection over a 45-minute MCT costs a
       * business traveller about 1.46, roughly half again what the connection
       * itself costs, which keeps a long layover clearly worse than a tight one
       * without swamping the base.
       */
      lambdaPerHour: 0.25,
      terminalChangePenalty: 0.3,
      /** A.14's six hours. */
      maxConnectMinutes: 360,
      maxDetourRatio: 1.35,
      maxHubs: 10,
      defaultMctMinutes: 45,
    },
    /**
     * With ~4,400 scheduled-service airports there are 9.7 million unordered
     * pairs, and the gravity model has no natural floor — so one is chosen.
     */
    viableDailyPassengers: 25,
  },

  fuel: {
    /**
     * $1,000/t is not picked off a spot chart. It is **solved from §13.4's
     * worked example**: eight ~200 nm ATR 72 sectors a day at *"fuel 168k"* a
     * month is $700 a sector, which at the 0.655 t `computeFuelBurn` gives is
     * about $1,065/t all-in. Take off a NW-European into-plane fee of $35/t and
     * a regional premium of 3%, and the world reference is $1,000/t.
     */
    basePricePerTonne: 1_000,
    /**
     * The world reference itself, for an airport whose geography the dataset does
     * not record. Identical to `europe` rather than to an average of the six: the
     * numbers the design doc anchors are the least wrong thing to charge when the
     * answer is genuinely unknown.
     */
    defaultStation: { regionFactor: 1.03, intoPlaneFeePerTonne: 35 },
    regions: SHIPPED_FUEL_REGIONS,
    tierFeeFactor: SHIPPED_FUEL_TIER_FEE_FACTOR,
    stationSpread: 0.04,
    curve: SHIPPED_FUEL_CURVE,
  },

  costs: {
    settlement: {
      ancillaryPerPassengerMinor: 0,
      cargoRatePerTonneMinor: 30_000,
      crewCostPerBlockHourMinor: 19_500,
      maintenanceCostPerBlockHourMinor: 65_000,
      groundHandlingPerTurnMinor: 15_000,
      groundHandlingPerSeatMinor: 325,
    },
    /**
     * A mid-tier European airport, calibrated so that landing plus passenger
     * charges reproduce §13.4's *"airport fees 144k"*.
     */
    defaultAirportFees: {
      landingPerTonne: 1_200,
      paxFee: 680,
      parkingPerHour: 4_500,
      gateLeaseAnnual: 22_000_000,
    },
    /**
     * A noise-quota movement at €1,800 and an emissions charge of €9 a tonne.
     *
     * Sized against what a sector already costs rather than picked: §13.4's
     * worked example puts airport fees at about €1,440 per ATR sector, so a
     * noise charge of €1,800 is a real penalty on a small aircraft and a
     * rounding error on a widebody — which is backwards, and is why the
     * emissions charge is per tonne. Together they make an old 350-tonne
     * aircraft cost about €4,950 more per departure than a new one, on a sector
     * whose fees are otherwise a few thousand. Enough to change a decision,
     * not enough to ground a fleet overnight.
     */
    restrictions: {
      noiseQuotaPerDepartureMinor: 180_000,
      emissionsChargePerTonneMinor: 900,
      curfewExclusionPerDepartureMinor: 260_000,
    },
    disruption: {
      rebookingPerPassengerMinor: 12_000,
      compensationPerPassengerMinor: 25_000,
      compensationDelayThresholdMinutes: 180,
      carePerPassengerPerHourMinor: 1_500,
      recoveryPerPassengerMinor: 8_000,
      careDelayThresholdMinutes: 120,
    },
  },

  pricing: { fareFloorRatio: 0.6 },

  boosts: {
    /** §10.4, verbatim: −8%, −20%, −4%, −12%, −30%, −15%. */
    ceilings: {
      fuelBurn: 0.08,
      turnaroundTime: 0.2,
      blockTime: 0.04,
      maintenanceCost: 0.12,
      incidentRate: 0.3,
      serviceCost: 0.15,
    },
  },

  npc: SHIPPED_NPC_BALANCE,
  usedMarket: SHIPPED_USED_MARKET_BALANCE,
  maintenance: SHIPPED_MAINTENANCE_BALANCE,
  crew: SHIPPED_CREW_BALANCE,
  socialMedia: SHIPPED_SOCIAL_MEDIA_BALANCE,
  hubs: SHIPPED_HUB_BALANCE,
});

// ---------------------------------------------------------------------------
// Comparing two versions
// ---------------------------------------------------------------------------

/**
 * One field that differs between two payloads.
 *
 * `path` is dotted, with array indices in brackets:
 * `demand.logit.beta.leisure.price`, `demand.bookingCurve.bands[0].share`. It is
 * a display path rather than a lookup expression — nothing parses it back.
 */
export interface EconomyConfigChange {
  path: string;
  /** `undefined` when the field is new in `after`. */
  before: unknown;
  /** `undefined` when the field is gone in `after`. */
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(before: unknown, after: unknown, path: string, into: EconomyConfigChange[]): void {
  if (Object.is(before, after)) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      walk(before[i], after[i], `${path}[${String(i)}]`, into);
    }
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    // The union of both sides' keys, so a field added or removed by a
    // hand-written payload shows up as a change rather than being skipped.
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walk(before[key], after[key], path === '' ? key : `${path}.${key}`, into);
    }
    return;
  }

  into.push({ path, before, after });
}

/**
 * Every field that changed between two versions (M3-11's third criterion).
 *
 * Leaves only: a changed β is one row, not one row per enclosing object. Order
 * follows the payload's own structure, so a retune reads top to bottom in the
 * order the schema declares — which is roughly Appendix A's.
 *
 * Deliberately structural rather than textual. A reordered JSON file is not a
 * balance change, and a diff that said it was would be one nobody trusted.
 */
export function diffEconomyConfig(
  before: EconomyConfig,
  after: EconomyConfig,
): EconomyConfigChange[] {
  const changes: EconomyConfigChange[] = [];
  walk(before, after, '', changes);
  return changes;
}

/**
 * The payload as JSON with keys in a fixed order, so two equal payloads produce
 * one byte sequence.
 *
 * The checksum stored beside each version is taken over this. Without it a
 * payload that round-tripped through a different key order would look like a
 * different config, and "does the database still match what we shipped?" would
 * cry wolf on every deploy.
 */
export function canonicalEconomyJson(config: EconomyConfig): string {
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order);
    if (isPlainObject(value)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) sorted[key] = order(value[key]);
      return sorted;
    }
    return value;
  };
  return JSON.stringify(order(config));
}
