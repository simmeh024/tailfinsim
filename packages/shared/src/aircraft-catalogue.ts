import { z } from 'zod';

import { AircraftType, CatalogueEntry } from './aircraft';
import {
  AIRCRAFT_OPTIONS_V1,
  AircraftOption,
  availableOptionsFor,
  CatalogueOption,
} from './aircraft-options';
import { Timestamp } from './primitives';

/**
 * The aircraft catalogue, as shipped data (M4-01, App. C.1–C.2, §7.2b, §22.5).
 *
 * App. C.1 sets the standard and the reason for it:
 *
 * > *"Aircraft use **real designations and real published specifications**.
 * > Players who know aviation must find the numbers correct, because those
 * > players are the audience and they will check."*
 *
 * ## Where each number comes from
 *
 * This matters more here than anywhere else in the repository, because half the
 * figures are quoted by the design doc and half are not, and a reader has no
 * way to tell them apart by looking.
 *
 * **From App. C.2, verbatim:** seats, range, MTOW, runway requirement, list
 * price and entry into service. Where C.2 and reality disagree, C.2 wins and
 * the row says so — the repository rule is that the design doc wins.
 *
 * **From the public record, authored here:** OEW, cruise speed, fuel burn,
 * wingspan code, noise chapter, turnaround baseline, lease rate, first flight,
 * production end and out-of-service. C.2 has no column for any of them and the
 * schema needs all of them.
 *
 * Two of those are honestly approximations rather than published constants.
 * **Fuel burn** varies with weight, altitude and sector length, so a single
 * kilograms-per-hour figure is a cruise-average of the right order rather than
 * a specification — `flight/fuel.ts` already models burn properly from a
 * per-nautical-mile rate, and this figure exists for display and comparison.
 * **Lease rates** are commercially confidential; except where the design gives
 * a concrete onboarding term, these are drawn at a conventional monthly ~0.8%
 * of list price. Appendix B.4 is authoritative for the ATR 72: its two-month
 * deposit is $170k, hence $85k/month.
 *
 * Anything genuinely uncertain is better stated than smoothed over. A player who
 * checks and finds a figure wrong should be able to see which kind of figure it
 * was.
 *
 * ## Versioned, and pinned per world
 *
 * §22.5: *"Catalogue **versioning** — a world is pinned to a version, so
 * retuning aircraft doesn't retroactively break running worlds."* A world pins
 * `world.aircraft_catalogue_version`, exactly as it pins its economy.
 *
 * Deliberately a **separate** version from the economy config. M3-11 records the
 * reason: a fare change and an aerodynamics change must not share a version
 * number, or a `flight_result` can no longer say which of the two explained it.
 *
 * ## Trademarks
 *
 * C.1's practical note, followed literally: *"Ship type names and specs; don't
 * ship Boeing's or Airbus's marks."* Designations and manufacturer names are
 * factual; there is no logo, trade dress or house livery anywhere in this file.
 */

/** The catalogue version every world created from the shipped set pins. */
export const AIRCRAFT_CATALOGUE_V1_VERSION = 'v1' as const;

export const AircraftCatalogue = z
  .object({
    version: z.string().min(1),
    types: z.array(AircraftType).min(1),
    /**
     * The factory options this version offers (M4-03, App. C.3, C.6).
     *
     * In the catalogue version rather than the economy, because C.6 puts
     * `Option` alongside `AircraftType` and because a world must be able to be
     * retuned aerodynamically without moving its fares — see the note at the top
     * of `aircraft-options.ts`.
     *
     * Which options a *type* offers is `AircraftType.availableOptionIds`; this is
     * the set they are drawn from.
     */
    options: z.array(AircraftOption).min(1),
  })
  .strict();
export type AircraftCatalogue = z.infer<typeof AircraftCatalogue>;

/** Dollars to integer minor units. Every price in C.2 is quoted in whole millions. */
const millions = (m: number): number => Math.round(m * 1_000_000 * 100);
/** A conventional monthly lease at ~0.8% of list. See the provenance note above. */
const leaseFor = (listMillions: number): number =>
  Math.round(listMillions * 0.008 * 1_000_000 * 100);

/**
 * App. C.2's launch set — eighteen types.
 *
 * Ordered as C.2 orders them: smallest passenger aircraft upward, then the
 * freighters. That ordering is load-bearing for the tests, which walk the two
 * lists together.
 */
const V1_TYPES = [
  {
    designation: 'ATR 72-600',
    family: 'ATR 72',
    manufacturer: 'ATR',
    class: 'turboprop_regional',
    maintenanceProfile: 'turboprop',
    // C.2 calls this "the starting aircraft", and AIR-03's founding position
    // is sized around being able to afford one.
    baseSpec: {
      maxSeats: 78,
      seatsTwoClass: 70,
      maxPayloadTonnes: 7.5,
      rangeNm: 825,
      cruiseSpeedKt: 275,
      mtowTonnes: 23.0,
      oewTonnes: 13.5,
      runwayRequirementM: 1_315,
      fuelBurnKgPerHour: 640,
      wingspanCode: 'C',
      noiseChapter: 4,
      turnaroundBaselineMin: 25,
    },
    eraDates: {
      firstFlight: '2009-07-24',
      entryIntoService: '2011-08-01',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(26),
    // App. B.4: two months' deposit is $170k, therefore one month is $85k.
    monthlyLeaseRate: 8_500_000,
  },
  {
    designation: 'Dash 8-400',
    family: 'Dash 8',
    manufacturer: 'De Havilland Canada',
    class: 'turboprop_regional',
    maintenanceProfile: 'turboprop',
    baseSpec: {
      maxSeats: 90,
      seatsTwoClass: 78,
      maxPayloadTonnes: 8.6,
      rangeNm: 1_100,
      cruiseSpeedKt: 360,
      mtowTonnes: 29.3,
      oewTonnes: 17.8,
      runwayRequirementM: 1_290,
      fuelBurnKgPerHour: 800,
      wingspanCode: 'C',
      noiseChapter: 4,
      turnaroundBaselineMin: 25,
    },
    eraDates: {
      firstFlight: '1998-01-31',
      entryIntoService: '2000-02-01',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(32),
    monthlyLeaseRate: leaseFor(32),
  },
  {
    designation: 'E190-E2',
    family: 'E-Jet E2',
    manufacturer: 'Embraer',
    class: 'regional_jet',
    maintenanceProfile: 'regional_jet',
    baseSpec: {
      maxSeats: 114,
      seatsTwoClass: 97,
      maxPayloadTonnes: 13.4,
      rangeNm: 2_850,
      cruiseSpeedKt: 448,
      mtowTonnes: 56.4,
      oewTonnes: 33.0,
      runwayRequirementM: 1_450,
      fuelBurnKgPerHour: 1_500,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 30,
    },
    eraDates: {
      firstFlight: '2016-05-23',
      entryIntoService: '2018-04-01',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(61),
    monthlyLeaseRate: leaseFor(61),
  },
  {
    designation: 'A220-300',
    family: 'A220',
    manufacturer: 'Airbus',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    baseSpec: {
      maxSeats: 160,
      seatsTwoClass: 130,
      maxPayloadTonnes: 18.7,
      rangeNm: 3_350,
      cruiseSpeedKt: 447,
      mtowTonnes: 70.9,
      oewTonnes: 37.1,
      runwayRequirementM: 1_890,
      fuelBurnKgPerHour: 1_900,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 35,
    },
    eraDates: {
      // Flown and certified as the Bombardier CS300; the type became the
      // A220-300 in 2018. The dates are the aircraft's, not the name's.
      firstFlight: '2015-02-27',
      entryIntoService: '2016-12-14',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(91),
    monthlyLeaseRate: leaseFor(91),
  },
  {
    designation: '737-800',
    family: '737NG',
    manufacturer: 'Boeing',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    baseSpec: {
      maxSeats: 189,
      seatsTwoClass: 162,
      maxPayloadTonnes: 20.5,
      rangeNm: 2_935,
      cruiseSpeedKt: 453,
      mtowTonnes: 79.0,
      oewTonnes: 41.4,
      runwayRequirementM: 2_100,
      fuelBurnKgPerHour: 2_500,
      wingspanCode: 'C',
      noiseChapter: 4,
      turnaroundBaselineMin: 40,
    },
    eraDates: {
      firstFlight: '1997-07-31',
      entryIntoService: '1998-04-22',
      // C.2: "Used market only — out of production". The last passenger 737NG
      // was delivered in 2019 and the line closed the following year.
      productionEnd: '2020-01-01',
      outOfService: null,
      restrictionDates: [],
    },
    // C.2 shows "—" for a type that can only be bought used.
    listPrice: null,
    monthlyLeaseRate: leaseFor(50),
  },
  {
    designation: '737 MAX 8',
    family: '737 MAX',
    manufacturer: 'Boeing',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    baseSpec: {
      maxSeats: 178,
      seatsTwoClass: 162,
      maxPayloadTonnes: 20.9,
      rangeNm: 3_500,
      cruiseSpeedKt: 453,
      mtowTonnes: 82.2,
      oewTonnes: 45.1,
      runwayRequirementM: 2_300,
      fuelBurnKgPerHour: 2_200,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 40,
    },
    eraDates: {
      firstFlight: '2016-01-29',
      entryIntoService: '2017-05-22',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(121),
    monthlyLeaseRate: leaseFor(121),
  },
  {
    designation: 'A320neo',
    family: 'A320neo',
    manufacturer: 'Airbus',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    baseSpec: {
      maxSeats: 180,
      seatsTwoClass: 165,
      maxPayloadTonnes: 20.0,
      rangeNm: 3_500,
      cruiseSpeedKt: 447,
      mtowTonnes: 79.0,
      oewTonnes: 44.3,
      runwayRequirementM: 2_100,
      fuelBurnKgPerHour: 2_100,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 40,
    },
    eraDates: {
      firstFlight: '2014-09-25',
      entryIntoService: '2016-01-25',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(110),
    monthlyLeaseRate: leaseFor(110),
  },
  {
    designation: 'A321neo',
    family: 'A320neo',
    manufacturer: 'Airbus',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    // Same family as the A320neo, and that is the mechanic rather than a
    // detail: §9.2 rates crew per family, so the two share a pilot pool.
    baseSpec: {
      maxSeats: 220,
      seatsTwoClass: 180,
      maxPayloadTonnes: 25.5,
      rangeNm: 4_000,
      cruiseSpeedKt: 447,
      mtowTonnes: 97.0,
      oewTonnes: 50.1,
      runwayRequirementM: 2_200,
      fuelBurnKgPerHour: 2_400,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 45,
    },
    eraDates: {
      firstFlight: '2016-02-09',
      entryIntoService: '2017-04-01',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(129),
    monthlyLeaseRate: leaseFor(129),
  },
  {
    designation: 'A321XLR',
    family: 'A320neo',
    manufacturer: 'Airbus',
    class: 'narrowbody',
    maintenanceProfile: 'narrowbody',
    /**
     * The type the flagship epoch was chosen around.
     *
     * C.2: *"Arrives ~3 weeks into the flagship world"*, and §7.2b calls that
     * payoff out directly — a world starting 20 October 2024 watches a real,
     * dated, verifiable event reshape thin long-haul three weeks in. The EIS
     * below is what makes that true, and a test asserts the interval rather
     * than the date, so the claim cannot quietly stop holding.
     */
    baseSpec: {
      maxSeats: 220,
      seatsTwoClass: 180,
      maxPayloadTonnes: 25.5,
      rangeNm: 4_700,
      cruiseSpeedKt: 447,
      mtowTonnes: 101.0,
      oewTonnes: 52.0,
      runwayRequirementM: 2_500,
      fuelBurnKgPerHour: 2_500,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 45,
    },
    eraDates: {
      firstFlight: '2022-06-15',
      // C.2 gives "Nov 2024" without a day. The 11th is the real first
      // commercial service; the month is what the doc fixes.
      entryIntoService: '2024-11-11',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(142),
    monthlyLeaseRate: leaseFor(142),
  },
  {
    designation: '787-9',
    family: '787',
    manufacturer: 'Boeing',
    class: 'widebody',
    maintenanceProfile: 'widebody',
    baseSpec: {
      maxSeats: 296,
      seatsTwoClass: 290,
      maxPayloadTonnes: 52.6,
      rangeNm: 7_565,
      cruiseSpeedKt: 488,
      mtowTonnes: 254.0,
      oewTonnes: 128.9,
      runwayRequirementM: 2_800,
      fuelBurnKgPerHour: 5_400,
      wingspanCode: 'E',
      noiseChapter: 4,
      turnaroundBaselineMin: 90,
    },
    eraDates: {
      firstFlight: '2013-09-17',
      entryIntoService: '2014-08-07',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(292),
    monthlyLeaseRate: leaseFor(292),
  },
  {
    designation: 'A350-900',
    family: 'A350',
    manufacturer: 'Airbus',
    class: 'widebody_ulh',
    maintenanceProfile: 'widebody',
    baseSpec: {
      maxSeats: 350,
      seatsTwoClass: 300,
      maxPayloadTonnes: 53.3,
      rangeNm: 8_100,
      cruiseSpeedKt: 488,
      mtowTonnes: 283.0,
      oewTonnes: 142.4,
      runwayRequirementM: 2_600,
      fuelBurnKgPerHour: 5_800,
      wingspanCode: 'E',
      noiseChapter: 4,
      turnaroundBaselineMin: 90,
    },
    eraDates: {
      firstFlight: '2013-06-14',
      entryIntoService: '2015-01-15',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(317),
    monthlyLeaseRate: leaseFor(317),
  },
  {
    designation: 'A350-1000',
    family: 'A350',
    manufacturer: 'Airbus',
    class: 'widebody_ulh',
    maintenanceProfile: 'widebody',
    baseSpec: {
      maxSeats: 410,
      seatsTwoClass: 350,
      maxPayloadTonnes: 61.0,
      rangeNm: 8_700,
      cruiseSpeedKt: 488,
      mtowTonnes: 319.0,
      oewTonnes: 155.0,
      runwayRequirementM: 2_900,
      fuelBurnKgPerHour: 6_700,
      wingspanCode: 'E',
      noiseChapter: 14,
      turnaroundBaselineMin: 100,
    },
    eraDates: {
      firstFlight: '2016-11-24',
      entryIntoService: '2018-02-24',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(366),
    monthlyLeaseRate: leaseFor(366),
  },
  {
    designation: '777-300ER',
    family: '777',
    manufacturer: 'Boeing',
    class: 'widebody',
    maintenanceProfile: 'widebody',
    baseSpec: {
      maxSeats: 396,
      seatsTwoClass: 396,
      maxPayloadTonnes: 68.0,
      rangeNm: 7_370,
      cruiseSpeedKt: 490,
      mtowTonnes: 351.5,
      oewTonnes: 167.8,
      runwayRequirementM: 3_100,
      fuelBurnKgPerHour: 7_500,
      wingspanCode: 'E',
      noiseChapter: 4,
      turnaroundBaselineMin: 100,
    },
    eraDates: {
      firstFlight: '2003-02-24',
      entryIntoService: '2004-05-06',
      // C.2: "Production winding down". Passenger 777-300ER deliveries have
      // effectively ended as the line converts to the 777X.
      productionEnd: '2026-01-01',
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(375),
    monthlyLeaseRate: leaseFor(375),
  },
  {
    designation: '777-9',
    family: '777X',
    manufacturer: 'Boeing',
    class: 'widebody',
    maintenanceProfile: 'widebody',
    /**
     * C.2's prototype case, and M4-01's third acceptance criterion: *"present
     * with EIS pending, visible but not orderable"*.
     *
     * `entryIntoService: null` is what makes that true. It has flown — so it
     * exists and can be looked at — and it has no service date, so nothing can
     * order it. §7.2c's launch-customer gameplay lives in exactly this window
     * and is Post-MVP.
     *
     * Code F on the ground, which is the whole point of C.3's folding-wingtip
     * option: the wingtips fold it into a code E gate, and without them a
     * player's existing stands may not take it.
     */
    baseSpec: {
      maxSeats: 425,
      seatsTwoClass: 400,
      maxPayloadTonnes: 70.0,
      rangeNm: 7_285,
      cruiseSpeedKt: 490,
      mtowTonnes: 351.5,
      oewTonnes: 181.0,
      runwayRequirementM: 3_050,
      fuelBurnKgPerHour: 7_000,
      wingspanCode: 'F',
      noiseChapter: 14,
      turnaroundBaselineMin: 100,
    },
    eraDates: {
      firstFlight: '2020-01-25',
      entryIntoService: null,
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(442),
    monthlyLeaseRate: leaseFor(442),
  },
  {
    designation: 'A380-800',
    family: 'A380',
    manufacturer: 'Airbus',
    class: 'widebody_ulh',
    maintenanceProfile: 'widebody',
    baseSpec: {
      maxSeats: 853,
      seatsTwoClass: 525,
      maxPayloadTonnes: 84.0,
      rangeNm: 8_000,
      cruiseSpeedKt: 490,
      mtowTonnes: 575.0,
      oewTonnes: 277.0,
      runwayRequirementM: 3_000,
      fuelBurnKgPerHour: 11_500,
      wingspanCode: 'F',
      noiseChapter: 4,
      turnaroundBaselineMin: 120,
    },
    eraDates: {
      firstFlight: '2005-04-27',
      entryIntoService: '2007-10-25',
      // C.2: "Used only — production ended 2021".
      productionEnd: '2021-12-16',
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: null,
    monthlyLeaseRate: leaseFor(200),
  },
  {
    designation: '777F',
    family: '777',
    manufacturer: 'Boeing',
    class: 'freighter',
    maintenanceProfile: 'freighter',
    baseSpec: {
      maxSeats: 0,
      seatsTwoClass: 0,
      // C.2 puts the payload in the Seats column for a freighter: "102 t".
      maxPayloadTonnes: 102.0,
      rangeNm: 4_970,
      cruiseSpeedKt: 490,
      mtowTonnes: 347.8,
      oewTonnes: 144.4,
      runwayRequirementM: 2_800,
      fuelBurnKgPerHour: 7_300,
      wingspanCode: 'E',
      noiseChapter: 4,
      turnaroundBaselineMin: 180,
    },
    eraDates: {
      firstFlight: '2008-07-14',
      entryIntoService: '2009-02-19',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(352),
    monthlyLeaseRate: leaseFor(352),
  },
  {
    designation: '747-8F',
    family: '747',
    manufacturer: 'Boeing',
    class: 'freighter',
    maintenanceProfile: 'freighter',
    baseSpec: {
      maxSeats: 0,
      seatsTwoClass: 0,
      maxPayloadTonnes: 137.0,
      rangeNm: 4_120,
      cruiseSpeedKt: 495,
      mtowTonnes: 447.7,
      oewTonnes: 197.1,
      runwayRequirementM: 3_100,
      fuelBurnKgPerHour: 10_500,
      wingspanCode: 'F',
      noiseChapter: 4,
      turnaroundBaselineMin: 210,
    },
    eraDates: {
      firstFlight: '2010-02-08',
      entryIntoService: '2011-10-12',
      // C.2: "Used only — ended 2023". The final 747 was delivered in
      // January 2023 and the line closed with it.
      productionEnd: '2023-01-31',
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: null,
    monthlyLeaseRate: leaseFor(300),
  },
  {
    designation: 'ATR 72-600F',
    family: 'ATR 72',
    manufacturer: 'ATR',
    class: 'freighter',
    maintenanceProfile: 'freighter',
    // Same family as the passenger ATR, so a feeder freighter shares its
    // crew type rating (§9.2) — which is most of why an operator buys one.
    baseSpec: {
      maxSeats: 0,
      seatsTwoClass: 0,
      maxPayloadTonnes: 9.0,
      rangeNm: 900,
      cruiseSpeedKt: 275,
      mtowTonnes: 23.0,
      oewTonnes: 13.6,
      runwayRequirementM: 1_315,
      fuelBurnKgPerHour: 640,
      wingspanCode: 'C',
      noiseChapter: 14,
      turnaroundBaselineMin: 60,
    },
    eraDates: {
      firstFlight: '2020-01-01',
      entryIntoService: '2020-11-30',
      productionEnd: null,
      outOfService: null,
      restrictionDates: [],
    },
    listPrice: millions(28),
    monthlyLeaseRate: leaseFor(28),
  },
] as const;

export const AIRCRAFT_CATALOGUE_V1: AircraftCatalogue = AircraftCatalogue.parse({
  version: AIRCRAFT_CATALOGUE_V1_VERSION,
  options: AIRCRAFT_OPTIONS_V1,
  // C.6 puts `available_options[]` on the type; `availableOptionsFor` is the
  // rule that fills it, evaluated once here so the shipped data is explicit.
  types: V1_TYPES.map((type) => ({ ...type, availableOptionIds: availableOptionsFor(type) })),
});

/**
 * `GET /api/fleet/catalogue` — what this world can fly, on its own clock.
 *
 * Declared here rather than in `aircraft.ts` because it now carries the option
 * set, and `aircraft.ts` is upstream of `aircraft-options.ts`.
 */
export const FleetCatalogueResponse = z.object({
  /** The world's own date, so the client can say "as at" rather than guessing. */
  inGameDate: Timestamp,
  catalogueVersion: z.string().min(1),
  /**
   * Every type that exists in this world, in catalogue order.
   *
   * Types before their first flight are **absent**, not listed as locked:
   * §7.2b's rule is that an aircraft *does not exist* in a world whose clock has
   * not reached it, and a 1950s world showing a greyed-out A350 would be
   * telling the player about a future that world does not have.
   */
  types: z.array(CatalogueEntry),
  /**
   * The factory options this version offers, once (M4-03).
   *
   * Every type's `availableOptionIds` indexes into this. Sent whole rather than
   * per type because most options are offered on most types.
   */
  options: z.array(CatalogueOption),
});
export type FleetCatalogueResponse = z.infer<typeof FleetCatalogueResponse>;

/** Every designation in the shipped catalogue, in C.2's order. */
export const AIRCRAFT_CATALOGUE_V1_DESIGNATIONS: readonly string[] =
  AIRCRAFT_CATALOGUE_V1.types.map((type) => type.designation);
