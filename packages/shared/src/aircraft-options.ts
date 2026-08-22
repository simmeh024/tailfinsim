import { z } from 'zod';

import { MinorUnits } from './primitives';

import type { AircraftClass, AircraftType, WingspanCode } from './aircraft';

/**
 * Factory options — the configurator (M4-03, App. C.3, C.6).
 *
 * App. C.3's rule is the whole feature, and it is a constraint on this file
 * rather than on the code that reads it:
 *
 * > *"Every option is paid for in money, weight, space, or time — **never none
 * > of them**."*
 *
 * So every row below debits at least one of seats, payload, range, burn,
 * comfort, cargo volume, maintenance cost, wingspan code or delivery date, and
 * `aircraft-options.test.ts` asserts it rather than trusting the author.
 *
 * ## Catalogue data, not economy data
 *
 * These live in the **aircraft catalogue version**, alongside the eighteen
 * types, and not in `ECONOMY_CONFIG_V1`. `CLAUDE.md` is explicit that a world
 * pins two versions and that they are not the same version: *"a fare change and
 * an aerodynamics change must not share a number, or a `flight_result` can no
 * longer say which of the two explained it."* An option's spec deltas are
 * aerodynamics, and its price is quoted by C.3 in the same table as its deltas —
 * the same way `listPrice` sits on the type rather than in the economy.
 *
 * ## Where each number comes from
 *
 * The same discipline `aircraft-catalogue.ts` applies to specifications, because
 * a reader cannot otherwise tell a quoted figure from an authored one.
 *
 * **From App. C.3, verbatim:** every gain and every cost the table states —
 * `+250 to +700 nm`, `−18% to −40%` belly volume, `+1.5–2.5 t` OEW, `+$4–9M`,
 * `+12% to +22%` certified seats, `−1.8 t`, `−3.5%` burn, `+$2.5M`, `+6%` burn,
 * `+18%` engine maintenance, `+$3–8M`, `+$2M`, `−22 seats`, `+2.1 t`, `+$11M`,
 * `−14 to −22 seats`, `+$4M`, `+0.9 t`, `−2%` burn, `−60%` low-visibility
 * cancellations.
 *
 * **Authored here:** where C.3 gives a range, the point inside it; lead times,
 * for which C.3 states only rule 2 (*"options extend delivery"*) and one
 * instance (*"longer delivery lead"*); and the prices C.3 omits entirely
 * (high-density exits, the lightweight cabin, the engine variant, crew rest and
 * the rough-field kit). Where a point inside a range is pinned by App. C.4's
 * worked example, the comment says so — those are the figures that must close.
 *
 * ## What this file deliberately does not decide
 *
 * **The comfort score.** C.3 charges comfort for two options and M6-09 owns the
 * scoring model that consumes those charges. `comfortDelta` is carried as the
 * input C.3 states and is not summed into a score here; see the note in
 * `aircraft-options.test.ts` about C.3 and C.4 disagreeing on the arithmetic.
 *
 * **Maintenance intervals.** C.3 charges maintenance on four options and §7.3
 * gives no schedule. `maintenanceCostFactor` is the multiplier M4-06 will read.
 *
 * **Research and crew.** `requiresResearch` names the §10.3 topic; M9 owns
 * whether an airline has it, and §9.2 owns rated crew.
 */

/**
 * One option's effect, as deltas over `AircraftSpec` plus the axes C.3 charges
 * that no specification field carries.
 *
 * Every field is optional and absent means no effect, because C.3's rule 1 is
 * that an option debits **at least one** axis rather than all of them.
 *
 * ## Additive or multiplicative, and why it matters
 *
 * Weights, seats, ranges and times **add**; burn, runway and volume factors
 * **multiply**. That is not cosmetic. Two options each cutting burn 3.5% should
 * compound to 6.9% rather than 7%, and two 2 t penalties are 4 t rather than
 * 4.08 t. `payload-range.ts` already folds its own subset this way and this
 * follows it deliberately.
 */
export const AircraftSpecDelta = z
  .object({
    /**
     * Multiplier on **maximum certified** seats — the high-density exit
     * configuration, which raises the ceiling rather than fitting seats. C.3:
     * *"+12% to +22% max certified seats"*. The cabin actually fitted is M6's.
     */
    maxSeatsFactor: z.number().positive().optional(),
    /**
     * Seats removed by something physically occupying the cabin — a main-deck
     * cargo door, a crew rest module. Applied to the certified ceiling **and**
     * to the two-class layout, because the floor space is gone either way.
     */
    seatsDelta: z.number().int().optional(),
    maxPayloadDeltaTonnes: z.number().optional(),
    /** Auxiliary centre tanks. C.3: *"+250 to +700 nm"*. */
    rangeDeltaNm: z.number().optional(),
    /** Tanks and doors add weight; a lightweight cabin package removes it. */
    oewDeltaTonnes: z.number().optional(),
    /** The paper MTOW upgrade. C.3 rule 4: it raises landing fees for ever. */
    mtowDeltaTonnes: z.number().optional(),
    /** A higher thrust rating buys short-field and hot-and-high performance. */
    runwayRequirementFactor: z.number().positive().optional(),
    /** Sharklets 0.965, a higher thrust rating 1.06, the efficiency package 0.98. */
    fuelBurnFactor: z.number().positive().optional(),
    /**
     * Steps along `A…F`. Sharklets `+1`; folding wingtips `−1`.
     *
     * C.3 rule 3 is the reason this is a spec field rather than a note:
     * *"A fuel-saving option that strands you at your own hub is exactly the
     * kind of mistake this system should let you make."* Clamped at the ends of
     * the scale by `computeEffectiveBuild`, so a code A aircraft cannot fold its
     * way below the smallest code.
     */
    wingspanCodeSteps: z.number().int().optional(),
    /** High-density exits cost five minutes on stand. */
    turnaroundDeltaMin: z.number().int().optional(),

    // --- charged by C.3, carried by no specification field -----------------

    /**
     * Multiplier on usable belly volume. C.3 charges auxiliary tanks
     * *"−18% to −40%"* and App. C.4's long-range build ends at 62%.
     *
     * Volume, not weight — §12's cargo system owns whether a consignment
     * physically fits, and `payload-range.ts` says so explicitly.
     */
    cargoVolumeFactor: z.number().positive().optional(),
    /** C.3's comfort charge. An **input to M6-09's score**, not a score. */
    comfortDelta: z.number().optional(),
    /** Multiplier on maintenance cost. M4-06 owns what it multiplies. */
    maintenanceCostFactor: z.number().positive().optional(),
    /** Certified single-engine diversion minutes. Feeds reachability's ETOPS check. */
    etopsMinutes: z.number().int().positive().optional(),
    /** Cat IIIb autoland. C.3: *"−60% low-visibility cancellations"*. */
    lowVisibilityCancellationFactor: z.number().positive().optional(),
    /**
     * Whether the airframe may legally fly an ultra-long-haul sector (§9.2).
     *
     * The crew rest module's entire gain, and C.3 states it as a capability
     * rather than a number: *"Legal for ULH sectors"*. It needs a field of its
     * own for the same reason `etopsMinutes` does — the option costs eighteen
     * seats and 1.2 t, and an option that only costs is not a choice.
     *
     * §9.2 owns duty limits and what counts as ULH; this is the airframe's half.
     */
    ulhCapable: z.boolean().optional(),
    /**
     * Whether the airframe may operate from unpaved and gravel strips.
     *
     * The rough-field kit's entire gain, stated by C.3 as a capability —
     * *"Unpaved and gravel strips"* — for the same reason `ulhCapable` is one.
     * An era world flying turboprops into unprepared fields is what it exists
     * for; App. B.4's surface check is where it will eventually be read.
     */
    unpavedCapable: z.boolean().optional(),
  })
  .strict();
export type AircraftSpecDelta = z.infer<typeof AircraftSpecDelta>;

/**
 * What kind of change an option is, which is also what decides whether it can be
 * fitted later.
 *
 * C.3 rule 5: *"Retrofit is possible but worse … and some (structural, engine
 * variant) can't be changed at all."* The category is the reason a given option
 * is or is not retrofittable, so they are declared together and a test asserts
 * they agree.
 */
export const AircraftOptionCategory = z.enum([
  'fuel',
  'structural',
  'cabin',
  'aerodynamic',
  'engine',
  'avionics',
  'cargo',
]);
export type AircraftOptionCategory = z.infer<typeof AircraftOptionCategory>;

/**
 * App. C.6's `Option`.
 *
 * ## One deviation from C.6's field list, deliberately
 *
 * C.6 writes the shape as
 * `{ id, spec_deltas{}, price, weight, lead_time_weeks, retrofittable, requires_research[], conflicts_with[] }`
 * — with `weight` beside `spec_deltas` rather than inside it.
 *
 * There is one weight, and it is a spec delta: what an option weighs *is* its
 * effect on operating empty weight, which is why C.3 quotes it as `+1.5–2.5 t
 * OEW` and `+2.1 t` in the same cells as the range and seat effects. Carrying it
 * twice would be two numbers for one fact and the second would eventually
 * disagree with the first, which is the dead end CONTRIBUTING invariant 4 exists
 * to prevent. So it lives in `specDeltas.oewDeltaTonnes` and nowhere else.
 */
export const AircraftOption = z
  .object({
    /** Stable within a catalogue version. Referenced by `Airframe.buildOptionIds`. */
    id: z.string().min(1),
    name: z.string().min(1),
    /** One sentence a player can decide from, in C.3's own terms. */
    summary: z.string().min(1),
    category: AircraftOptionCategory,

    specDeltas: AircraftSpecDelta,

    /** Added to the aircraft's list price. Zero is allowed; free is not. */
    priceMinor: MinorUnits.nonnegative(),
    /**
     * Weeks added to delivery. C.3 rule 2: *"A heavily customised aircraft is
     * delivered weeks later than a standard one. Ordering off-the-shelf is a
     * legitimate speed play."*
     */
    leadTimeWeeks: z.number().int().nonnegative(),

    /** C.3 rule 5. False for anything structural or engine-related. */
    retrofittable: z.boolean(),
    /** §10.3 research topics required before this can be ordered. */
    requiresResearch: z.array(z.string().min(1)).default([]),
    /**
     * Options that cannot be taken alongside this one.
     *
     * Declared on both sides and asserted symmetric by test, because a conflict
     * that holds in one direction only is a conflict that depends on the order
     * the player clicked.
     */
    conflictsWith: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AircraftOption = z.infer<typeof AircraftOption>;

const millions = (m: number): number => Math.round(m * 1_000_000 * 100);

/**
 * App. C.3's list.
 *
 * Auxiliary centre tanks are C.3's one quantified option — *"(1–3)"* — and are
 * modelled as three mutually exclusive rows rather than a count, because App.
 * C.4 orders *"+3 ACT"* as a single choice and a build is a set of option ids.
 */
export const AIRCRAFT_OPTIONS_V1: readonly AircraftOption[] = [
  // --- fuel ---------------------------------------------------------------
  {
    id: 'act-1',
    name: 'Auxiliary centre tank',
    summary: 'One belly tank. Adds range and takes cargo volume and weight.',
    category: 'fuel',
    specDeltas: {
      rangeDeltaNm: 250,
      oewDeltaTonnes: 1.5,
      cargoVolumeFactor: 0.82,
    },
    priceMinor: millions(4),
    leadTimeWeeks: 2,
    // Tanks are plumbed into the belly. C.3 rule 5 allows a hangar retrofit.
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: ['act-2', 'act-3'],
  },
  {
    id: 'act-2',
    name: 'Two auxiliary centre tanks',
    summary: 'Two belly tanks. More range again, and less hold to sell.',
    category: 'fuel',
    specDeltas: {
      rangeDeltaNm: 480,
      oewDeltaTonnes: 2.0,
      cargoVolumeFactor: 0.71,
    },
    priceMinor: millions(6.5),
    leadTimeWeeks: 3,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: ['act-1', 'act-3'],
  },
  {
    id: 'act-3',
    name: 'Three auxiliary centre tanks',
    summary: 'The full tank fit. Thin long-haul range, at the cost of the hold.',
    category: 'fuel',
    /**
     * The top of both of C.3's ranges, pinned by App. C.4: the long-range
     * A321neo reaches **4,700 nm** from a 4,000 nm base, and its belly volume
     * ends at **62%**. Both figures close exactly here.
     */
    specDeltas: {
      rangeDeltaNm: 700,
      oewDeltaTonnes: 2.5,
      cargoVolumeFactor: 0.62,
    },
    /** C.4 prices the long-range build at $146M against $129M base. See the test. */
    priceMinor: millions(9),
    leadTimeWeeks: 4,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: ['act-1', 'act-2'],
  },

  // --- structural ---------------------------------------------------------
  {
    id: 'mtow-increase',
    name: 'Increased MTOW',
    summary:
      'A paper upgrade: more payload or range on the same fuel — and a higher landing fee at every airport, for ever.',
    category: 'structural',
    /** C.4's long-range build is 101 t against a 97 t base. */
    specDeltas: {
      mtowDeltaTonnes: 4.0,
      maxPayloadDeltaTonnes: 2.0,
      maintenanceCostFactor: 1.04,
    },
    priceMinor: millions(5),
    leadTimeWeeks: 1,
    // The certificate changes, not the airframe — the one structural row that
    // genuinely can be bought later.
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: [],
  },
  {
    id: 'cargo-door',
    name: 'Main-deck cargo door',
    summary: 'Convertible to freight (§12). Costs twenty-two seats and two tonnes.',
    category: 'cargo',
    specDeltas: {
      seatsDelta: -22,
      oewDeltaTonnes: 2.1,
      maxPayloadDeltaTonnes: 1.0,
    },
    priceMinor: millions(11),
    leadTimeWeeks: 6,
    // A main-deck door is cut through the fuselage.
    retrofittable: false,
    requiresResearch: [],
    conflictsWith: ['high-density-exits'],
  },
  {
    id: 'folding-wingtips',
    name: 'Folding wingtips',
    summary: 'Folds a code F aircraft into a code E gate. Adds weight and cost.',
    category: 'structural',
    specDeltas: {
      wingspanCodeSteps: -1,
      oewDeltaTonnes: 0.9,
      maintenanceCostFactor: 1.03,
    },
    priceMinor: millions(4),
    leadTimeWeeks: 3,
    retrofittable: false,
    requiresResearch: [],
    conflictsWith: [],
  },

  // --- cabin --------------------------------------------------------------
  {
    id: 'high-density-exits',
    name: 'High-density exit configuration',
    summary:
      'Raises the certified seat ceiling by 22%. Costs galley and lavatory space, five minutes on stand, and comfort.',
    category: 'cabin',
    /**
     * The top of C.3's `+12% to +22%`, pinned by C.4: a one-class cabin of 200
     * becomes **244**, and 200 × 1.22 = 244 exactly. C.4's seat row is a fitted
     * cabin rather than the certified ceiling, so what closes here is the
     * multiplier; M6 fits the cabin.
     */
    specDeltas: {
      maxSeatsFactor: 1.22,
      turnaroundDeltaMin: 5,
      comfortDelta: -0.15,
      cargoVolumeFactor: 0.94,
    },
    /** C.4 prices the high-density build at $132M — $3M over base, with the lightweight cabin. */
    priceMinor: millions(2),
    leadTimeWeeks: 1,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: ['cargo-door', 'crew-rest'],
  },
  {
    id: 'lightweight-cabin',
    name: 'Lightweight cabin package',
    summary: 'Thinner seats: 1.8 t less to carry, so more range and less burn — and less comfort.',
    category: 'cabin',
    specDeltas: {
      oewDeltaTonnes: -1.8,
      comfortDelta: -0.1,
      // C.3: "higher wear cost".
      maintenanceCostFactor: 1.05,
    },
    priceMinor: millions(1),
    leadTimeWeeks: 1,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: [],
  },
  {
    id: 'crew-rest',
    name: 'Crew rest module',
    summary: 'Legal for ultra-long-haul sectors (§9.2). Costs eighteen seats.',
    category: 'cabin',
    specDeltas: {
      seatsDelta: -18,
      oewDeltaTonnes: 1.2,
      ulhCapable: true,
    },
    priceMinor: millions(3),
    leadTimeWeeks: 4,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: ['high-density-exits'],
  },

  // --- aerodynamic --------------------------------------------------------
  {
    id: 'sharklets',
    name: 'Sharklets',
    summary:
      'Wingtip devices: 3.5% less fuel — and a wider wingspan code, which your gates may refuse.',
    category: 'aerodynamic',
    specDeltas: {
      fuelBurnFactor: 0.965,
      wingspanCodeSteps: 1,
      oewDeltaTonnes: 0.3,
    },
    priceMinor: millions(2.5),
    leadTimeWeeks: 2,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: [],
  },
  {
    id: 'efficiency-package',
    name: 'Extra fuel-efficiency package',
    summary: 'A further 2% off burn, bought with money and delivery time.',
    category: 'aerodynamic',
    specDeltas: { fuelBurnFactor: 0.98 },
    priceMinor: millions(5),
    leadTimeWeeks: 5,
    retrofittable: false,
    requiresResearch: [],
    conflictsWith: [],
  },

  // --- engine -------------------------------------------------------------
  {
    id: 'thrust-rating-high',
    name: 'Higher engine thrust rating',
    summary: 'Hot-and-high and short-field capability, paid for in burn and engine maintenance.',
    category: 'engine',
    specDeltas: {
      runwayRequirementFactor: 0.88,
      fuelBurnFactor: 1.06,
      maintenanceCostFactor: 1.18,
    },
    priceMinor: millions(3),
    leadTimeWeeks: 2,
    retrofittable: false,
    requiresResearch: [],
    conflictsWith: [],
  },
  {
    id: 'engine-variant-alt',
    name: 'Alternative engine variant',
    summary:
      'A different burn, maintenance and reliability profile — and a second engineering pool to staff.',
    category: 'engine',
    /**
     * C.3 gives no figures, only *"different"* and a commonality penalty. A
     * small burn advantage against a maintenance penalty is the shape of the
     * real trade; the fleet-commonality cost is §9.2's and is not a spec delta.
     */
    specDeltas: {
      fuelBurnFactor: 0.985,
      maintenanceCostFactor: 1.09,
    },
    priceMinor: 0,
    leadTimeWeeks: 4,
    retrofittable: false,
    requiresResearch: [],
    conflictsWith: [],
  },

  // --- avionics -----------------------------------------------------------
  {
    id: 'etops-180',
    name: 'ETOPS 180 package',
    summary: 'Direct oceanic routings up to 180 minutes from a diversion field.',
    category: 'avionics',
    specDeltas: { etopsMinutes: 180, oewDeltaTonnes: 0.4 },
    /** C.4's long-range build takes ETOPS 180 inside its $17M and 7-week total. */
    priceMinor: millions(3),
    leadTimeWeeks: 2,
    retrofittable: true,
    requiresResearch: ['etops-180'],
    conflictsWith: ['etops-330'],
  },
  {
    id: 'etops-330',
    name: 'ETOPS 330 package',
    summary: 'Diversion times to 330 minutes — the polar and mid-Pacific routings.',
    category: 'avionics',
    specDeltas: { etopsMinutes: 330, oewDeltaTonnes: 0.7 },
    priceMinor: millions(8),
    leadTimeWeeks: 4,
    retrofittable: true,
    requiresResearch: ['etops-180', 'etops-330'],
    conflictsWith: ['etops-180'],
  },
  {
    id: 'cat-iiib',
    name: 'Cat IIIb autoland',
    summary: 'Sixty per cent fewer low-visibility cancellations. Needs trained crew.',
    category: 'avionics',
    specDeltas: { lowVisibilityCancellationFactor: 0.4, oewDeltaTonnes: 0.2 },
    priceMinor: millions(2),
    leadTimeWeeks: 2,
    retrofittable: true,
    requiresResearch: ['cat-iiib'],
    conflictsWith: [],
  },

  // --- era worlds ---------------------------------------------------------
  {
    id: 'rough-field-kit',
    name: 'Rough-field kit',
    summary: 'Unpaved and gravel strips, at the cost of burn and maintenance.',
    category: 'structural',
    specDeltas: {
      fuelBurnFactor: 1.03,
      maintenanceCostFactor: 1.12,
      oewDeltaTonnes: 0.5,
      unpavedCapable: true,
    },
    priceMinor: millions(1.5),
    leadTimeWeeks: 2,
    retrofittable: true,
    requiresResearch: [],
    conflictsWith: [],
  },
];

/** Every option in the shipped set, by id. */
export const AIRCRAFT_OPTIONS_V1_BY_ID: ReadonlyMap<string, AircraftOption> = new Map(
  AIRCRAFT_OPTIONS_V1.map((option) => [option.id, option]),
);

/**
 * Which options a type can be ordered with — C.6's `available_options[]`.
 *
 * A rule rather than eighteen hand-written lists, so a nineteenth type cannot be
 * added with an empty configurator by omission. The rule *is* the data: it is
 * evaluated once at module load and the result is what the catalogue ships.
 *
 * The two exceptions C.3 states outright are honoured literally: folding
 * wingtips are *"(777-9)"* and the rough-field kit is *"(era worlds)"* — the
 * second offered only to the turboprops, which are the types an era world flies.
 *
 * ## The one place base spec is read on purpose
 *
 * C.6's rule is that everything downstream reads `effective_spec`, and this
 * reads `baseSpec.rangeNm`. That is not a leak, it is the only possible input:
 * deciding *which options exist* cannot depend on a spec that has already had
 * options folded into it, or the question is circular. Availability is a fact
 * about the type; performance is a fact about the build.
 */
export function availableOptionsFor(type: {
  designation: string;
  class: AircraftClass;
  baseSpec: { rangeNm: number; wingspanCode: WingspanCode };
}): readonly string[] {
  const ids: string[] = [];
  const isFreighter = type.class === 'freighter';
  const isPassenger = !isFreighter;
  const jet = type.class !== 'turboprop_regional';

  // Tanks need somewhere to put them and a sector worth the range.
  if (jet && type.baseSpec.rangeNm >= 2_500) ids.push('act-1', 'act-2', 'act-3');

  // A paper upgrade is available on anything with a certificate.
  ids.push('mtow-increase');

  if (isPassenger) ids.push('high-density-exits', 'lightweight-cabin');
  // A crew rest module only earns its seats on a sector long enough to need one.
  if (isPassenger && type.baseSpec.rangeNm >= 6_000) ids.push('crew-rest');
  // A combi door is a passenger aircraft becoming convertible; a freighter is
  // already there.
  if (isPassenger && jet) ids.push('cargo-door');

  if (jet) ids.push('sharklets', 'efficiency-package');
  ids.push('thrust-rating-high', 'engine-variant-alt');

  // Oceanic routings, and the diversion times worth certifying for.
  if (jet && type.baseSpec.rangeNm >= 3_000) ids.push('etops-180');
  if (jet && type.baseSpec.rangeNm >= 6_000) ids.push('etops-330');
  ids.push('cat-iiib');

  // C.3 names the aircraft.
  if (type.designation === '777-9') ids.push('folding-wingtips');
  // C.3 marks this "(era worlds)"; the turboprops are what an era world flies.
  if (type.class === 'turboprop_regional') ids.push('rough-field-kit');

  return ids;
}

/**
 * `GET /api/fleet/catalogue` — one option, as the configurator sees it.
 *
 * The wire shape is the stored shape. There is nothing to hide and nothing to
 * derive: a player choosing between builds needs the deltas, the price and the
 * lead time, which is exactly what C.3 puts in front of them.
 */
export const CatalogueOption = AircraftOption;
export type CatalogueOption = z.infer<typeof CatalogueOption>;

/** Narrow a catalogue type to what {@link availableOptionsFor} needs. */
export function optionIdsForType(type: AircraftType): readonly string[] {
  return availableOptionsFor({
    designation: type.designation,
    class: type.class,
    baseSpec: type.baseSpec,
  });
}
