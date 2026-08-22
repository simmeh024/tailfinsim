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
    // Defaulted, not required — see `SHIPPED_NPC_BALANCE` for why a new
    // section must be, and what to do when it cannot be.
    npc: NpcBalance.default(SHIPPED_NPC_BALANCE),
    // Defaulted for the same reason. Every `v1` row written before M4-05 is
    // still parseable, and reads back the shipped used market.
    usedMarket: UsedMarketBalance.default(SHIPPED_USED_MARKET_BALANCE),
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
