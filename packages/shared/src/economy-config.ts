import { z } from 'zod';

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
     */
    defaultStation: z
      .object({
        regionFactor: z.number().positive(),
        intoPlaneFeePerTonne: z.number().nonnegative(),
      })
      .strict(),
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

export const CostBalance = z
  .object({
    settlement: SettlementBalance,
    defaultAirportFees: AirportFeeBalance,
    disruption: DisruptionCostBalance,
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
// The payload
// ---------------------------------------------------------------------------

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
    defaultStation: { regionFactor: 1.03, intoPlaneFeePerTonne: 35 },
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
