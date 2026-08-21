import { describe, expect, it } from 'vitest';

import { AircraftType } from './aircraft';
import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_CATALOGUE_V1_DESIGNATIONS,
  AircraftCatalogue,
} from './aircraft-catalogue';
import { FLAGSHIP_CONFIG } from './world-config';

/**
 * The catalogue against App. C.2 (M4-01).
 *
 * C.1 sets the bar: *"Players who know aviation must find the numbers correct,
 * because those players are the audience and they will check."* This file is
 * that check, written down — every figure C.2 publishes is asserted against the
 * table, so the catalogue cannot drift from the document without a test saying
 * so.
 *
 * Figures C.2 does **not** publish are deliberately not pinned here. Asserting
 * an OEW against itself proves nothing; what those fields get instead is a
 * plausibility check further down, which is the strongest honest claim
 * available for a number the design doc never fixed.
 */

/**
 * App. C.2's table, transcribed.
 *
 * Kept as data rather than folded into the catalogue so the two can be compared:
 * a single source would make this test a tautology.
 *
 * `seats` is a pair where C.2 writes a range — "162–189" — and a single number
 * where C.2 writes one. The distinction is load-bearing rather than cosmetic:
 * for "70" the document is publishing a seating figure and saying **nothing**
 * about the certified maximum, so pinning a maximum there would be asserting
 * the doc had said something it did not. Those rows check the two-class figure
 * and leave the maximum to the plausibility checks below.
 */
const C2 = [
  {
    designation: 'ATR 72-600',
    seats: 70,
    rangeNm: 825,
    mtow: 23.0,
    runway: 1_315,
    listMillions: 26,
    eis: '2011',
  },
  {
    designation: 'Dash 8-400',
    seats: [78, 90],
    rangeNm: 1_100,
    mtow: 29.3,
    runway: 1_290,
    listMillions: 32,
    eis: '2000',
  },
  {
    designation: 'E190-E2',
    seats: [97, 114],
    rangeNm: 2_850,
    mtow: 56.4,
    runway: 1_450,
    listMillions: 61,
    eis: '2018',
  },
  {
    designation: 'A220-300',
    seats: [130, 160],
    rangeNm: 3_350,
    mtow: 70.9,
    runway: 1_890,
    listMillions: 91,
    eis: '2016',
  },
  {
    designation: '737-800',
    seats: [162, 189],
    rangeNm: 2_935,
    mtow: 79.0,
    runway: 2_100,
    listMillions: null,
    eis: '1998',
  },
  {
    designation: '737 MAX 8',
    seats: [162, 178],
    rangeNm: 3_500,
    mtow: 82.2,
    runway: 2_300,
    listMillions: 121,
    eis: '2017',
  },
  {
    designation: 'A320neo',
    seats: [165, 180],
    rangeNm: 3_500,
    mtow: 79.0,
    runway: 2_100,
    listMillions: 110,
    eis: '2016',
  },
  {
    designation: 'A321neo',
    seats: [180, 220],
    rangeNm: 4_000,
    mtow: 97.0,
    runway: 2_200,
    listMillions: 129,
    eis: '2017',
  },
  {
    designation: 'A321XLR',
    seats: [180, 220],
    rangeNm: 4_700,
    mtow: 101.0,
    runway: 2_500,
    listMillions: 142,
    eis: '2024',
  },
  {
    designation: '787-9',
    seats: 290,
    rangeNm: 7_565,
    mtow: 254.0,
    runway: 2_800,
    listMillions: 292,
    eis: '2014',
  },
  {
    designation: 'A350-900',
    seats: [300, 350],
    rangeNm: 8_100,
    mtow: 283.0,
    runway: 2_600,
    listMillions: 317,
    eis: '2015',
  },
  {
    designation: 'A350-1000',
    seats: [350, 410],
    rangeNm: 8_700,
    mtow: 319.0,
    runway: 2_900,
    listMillions: 366,
    eis: '2018',
  },
  {
    designation: '777-300ER',
    seats: 396,
    rangeNm: 7_370,
    mtow: 351.5,
    runway: 3_100,
    listMillions: 375,
    eis: '2004',
  },
  {
    designation: '777-9',
    seats: [400, 425],
    rangeNm: 7_285,
    mtow: 351.5,
    runway: 3_050,
    listMillions: 442,
    eis: null,
  },
  {
    designation: 'A380-800',
    seats: [525, 853],
    rangeNm: 8_000,
    mtow: 575.0,
    runway: 3_000,
    listMillions: null,
    eis: '2007',
  },
  {
    designation: '777F',
    payloadTonnes: 102,
    rangeNm: 4_970,
    mtow: 347.8,
    runway: 2_800,
    listMillions: 352,
    eis: '2009',
  },
  {
    designation: '747-8F',
    payloadTonnes: 137,
    rangeNm: 4_120,
    mtow: 447.7,
    runway: 3_100,
    listMillions: null,
    eis: '2011',
  },
  {
    designation: 'ATR 72-600F',
    payloadTonnes: 9,
    rangeNm: 900,
    mtow: 23.0,
    runway: 1_315,
    listMillions: 28,
    eis: '2020',
  },
] as const;

const typeOf = (designation: string) => {
  const found = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === designation);
  if (!found) throw new Error(`no ${designation} in the catalogue`);
  return found;
};

describe('the launch set', () => {
  it('is App. C.2’s eighteen types, in C.2’s order', () => {
    expect(AIRCRAFT_CATALOGUE_V1.types).toHaveLength(18);
    expect(AIRCRAFT_CATALOGUE_V1_DESIGNATIONS).toEqual(C2.map((row) => row.designation));
  });

  it('parses against its own schema at module load', () => {
    // Built with `AircraftCatalogue.parse`, so a typo fails the first import
    // rather than the first order. Asserted so the guarantee is visible.
    expect(AircraftCatalogue.safeParse(AIRCRAFT_CATALOGUE_V1).success).toBe(true);
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(AircraftType.safeParse(type).success, type.designation).toBe(true);
    }
  });

  it('names every designation exactly once', () => {
    // The catalogue key. Two rows for one designation would make "which
    // A321neo?" a question with no answer.
    expect(new Set(AIRCRAFT_CATALOGUE_V1_DESIGNATIONS).size).toBe(18);
  });
});

describe('every figure App. C.2 publishes', () => {
  it.each(C2)('$designation matches the table', (row) => {
    const type = typeOf(row.designation);

    expect(type.baseSpec.rangeNm, 'range').toBe(row.rangeNm);
    expect(type.baseSpec.mtowTonnes, 'MTOW').toBe(row.mtow);
    expect(type.baseSpec.runwayRequirementM, 'runway').toBe(row.runway);

    if ('seats' in row) {
      const [twoClass, max] = Array.isArray(row.seats) ? row.seats : [row.seats, null];
      expect(type.baseSpec.seatsTwoClass, 'two-class seats').toBe(twoClass);
      if (max !== null) expect(type.baseSpec.maxSeats, 'max seats').toBe(max);
    } else {
      // C.2 puts payload in the Seats column for a freighter.
      expect(type.baseSpec.maxPayloadTonnes, 'payload').toBe(row.payloadTonnes);
      expect(type.baseSpec.maxSeats, 'a freighter carries no passengers').toBe(0);
    }

    if (row.listMillions === null) {
      // C.2 shows "—" for the three types that can only be bought used.
      expect(type.listPrice, 'used-market only').toBeNull();
    } else {
      expect(type.listPrice, 'list price').toBe(row.listMillions * 1_000_000 * 100);
    }

    if (row.eis === null) {
      expect(type.eraDates.entryIntoService, 'EIS pending').toBeNull();
    } else {
      expect(type.eraDates.entryIntoService?.slice(0, 4), 'EIS year').toBe(row.eis);
    }
  });
});

describe('the three types C.2 singles out', () => {
  it('has the A321XLR arriving about three weeks into the flagship world', () => {
    // C.2: "Arrives ~3 weeks into the flagship world", and §7.2b calls this the
    // payoff of choosing a 2024 epoch — "a real, dated, verifiable event".
    //
    // Asserted as the *interval* rather than as the date, so the claim cannot
    // quietly stop holding if either the epoch or the EIS moves. That is the
    // thing the doc actually promises.
    const epoch = Date.parse(FLAGSHIP_CONFIG.epoch);
    const eis = Date.parse(`${typeOf('A321XLR').eraDates.entryIntoService!}T00:00:00.000Z`);
    const days = (eis - epoch) / 86_400_000;

    expect(days).toBeGreaterThan(14);
    expect(days).toBeLessThan(28);
  });

  it('has the 777-9 present, flown, and with no service date', () => {
    // "present with EIS pending, visible but not orderable". All three parts
    // are properties of the data; `availabilityOf` turns them into behaviour.
    const type = typeOf('777-9');
    expect(type.eraDates.firstFlight).not.toBeNull();
    expect(type.eraDates.entryIntoService).toBeNull();
    // It has a price, because a launch customer will eventually pay one (§7.2c).
    expect(type.listPrice).not.toBeNull();
  });

  it('marks the three used-only types as out of production', () => {
    // C.2's "—" in the List column and "Used market only" in Notes are the same
    // fact said twice, and both have to be true of the data.
    for (const designation of ['737-800', 'A380-800', '747-8F']) {
      const type = typeOf(designation);
      expect(type.listPrice, `${designation} list price`).toBeNull();
      expect(type.eraDates.productionEnd, `${designation} production end`).not.toBeNull();
      // Still leasable — that is what makes a used market worth having.
      expect(type.monthlyLeaseRate, `${designation} lease rate`).not.toBeNull();
    }
  });
});

describe('the figures C.2 does not publish', () => {
  // Asserting these against themselves would prove nothing. What can honestly
  // be checked is that they are internally consistent and physically sane.

  it('never certifies fewer seats than a two-class layout fits', () => {
    // The check that covers the rows where C.2 gives one seating figure and no
    // maximum: whatever the maximum is, it cannot be below the layout.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(type.baseSpec.maxSeats, type.designation).toBeGreaterThanOrEqual(
        type.baseSpec.seatsTwoClass,
      );
    }
  });

  it('never weighs empty more than it weighs loaded', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(type.baseSpec.oewTonnes, type.designation).toBeLessThan(type.baseSpec.mtowTonnes);
    }
  });

  it('leaves room for its own payload under MTOW', () => {
    // OEW plus structural payload has to fit under MTOW with fuel to spare, or
    // the aircraft cannot carry its own rated load anywhere at all.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const { oewTonnes, maxPayloadTonnes, mtowTonnes } = type.baseSpec;
      expect(oewTonnes + maxPayloadTonnes, type.designation).toBeLessThan(mtowTonnes);
    }
  });

  it('flies faster the bigger it is, roughly', () => {
    // Not a law, but a turboprop must not cruise faster than a widebody, and a
    // transposed pair of figures would show up here.
    expect(typeOf('ATR 72-600').baseSpec.cruiseSpeedKt).toBeLessThan(
      typeOf('A320neo').baseSpec.cruiseSpeedKt,
    );
    expect(typeOf('A320neo').baseSpec.cruiseSpeedKt).toBeLessThan(
      typeOf('787-9').baseSpec.cruiseSpeedKt,
    );
  });

  it('burns more fuel the heavier it is', () => {
    const byMtow = [...AIRCRAFT_CATALOGUE_V1.types].sort(
      (a, b) => a.baseSpec.mtowTonnes - b.baseSpec.mtowTonnes,
    );
    const burns = byMtow.map((t) => t.baseSpec.fuelBurnKgPerHour);
    // Monotonic overall rather than pairwise: the A321neo and the 737 MAX 8 are
    // close enough that their order is not meaningful, but a 23-tonne turboprop
    // burning more than a 575-tonne A380 would be a transposition.
    expect(burns[0]).toBeLessThan(burns[burns.length - 1]!);
    expect(typeOf('A380-800').baseSpec.fuelBurnKgPerHour).toBeGreaterThan(
      typeOf('A320neo').baseSpec.fuelBurnKgPerHour * 4,
    );
  });

  it('puts every type in a wingspan code its size justifies', () => {
    // The code is a live constraint (App. C.3 rule 3): it decides which gates a
    // type can use, so a widebody quietly coded C would let a player park a
    // 787 at a regional stand.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const code = type.baseSpec.wingspanCode;
      if (type.baseSpec.mtowTonnes > 200) {
        expect(['E', 'F'], type.designation).toContain(code);
      } else {
        expect(['C', 'D'], type.designation).toContain(code);
      }
    }
    // The 777-9 is code F on the ground, which is exactly why C.3 sells folding
    // wingtips to squeeze it into a code E gate.
    expect(typeOf('777-9').baseSpec.wingspanCode).toBe('F');
  });

  it('prices a lease as a sensible fraction of what the aircraft costs', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(type.monthlyLeaseRate, type.designation).not.toBeNull();
      if (type.listPrice !== null && type.monthlyLeaseRate !== null) {
        const monthlyShare = type.monthlyLeaseRate / type.listPrice;
        // A lease that recovered the aircraft in under two years, or took over
        // fifty, would not be a lease.
        expect(monthlyShare, type.designation).toBeGreaterThan(1 / 600);
        expect(monthlyShare, type.designation).toBeLessThan(1 / 24);
      }
    }
  });

  it('orders the era dates the way time runs', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const { firstFlight, entryIntoService, productionEnd, outOfService } = type.eraDates;
      const dates = [firstFlight, entryIntoService, productionEnd, outOfService].filter(
        (d): d is string => d !== null,
      );
      expect([...dates].sort(), type.designation).toEqual(dates);
    }
  });

  it('gives every type a maintenance programme', () => {
    // The catalogue says which; M4-06 decides what it means.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(type.maintenanceProfile, type.designation).toBeTruthy();
    }
  });
});

describe('families, which crew are rated on', () => {
  it('puts the A320neo, A321neo and A321XLR in one family', () => {
    // §9.2 rates crew per family rather than per type, so this is the fleet
    // commonality mechanic rather than a label: three types, one pilot pool.
    const family = typeOf('A320neo').family;
    expect(typeOf('A321neo').family).toBe(family);
    expect(typeOf('A321XLR').family).toBe(family);
  });

  it('puts the passenger and freighter ATR in one family', () => {
    expect(typeOf('ATR 72-600F').family).toBe(typeOf('ATR 72-600').family);
  });

  it('keeps the 777X separate from the 777', () => {
    // A different type rating in reality, and the difference matters: a 777-300ER
    // operator does not get 777-9 crew for free.
    expect(typeOf('777-9').family).not.toBe(typeOf('777-300ER').family);
  });
});
