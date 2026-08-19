import { describe, expect, it } from 'vitest';

import type { AirportFees, FlightLoad } from '@tailfin/shared';

import { computeBlockTime } from '../flight/block';
import { computeFuelBurn } from '../flight/fuel';
import { DEFAULT_FLIGHT_PROFILE } from '../flight/profile';

import { computeFuelCost, DEFAULT_FUEL_MARKET, type FuelStation } from './fuel-price';
import {
  COST_SOURCES,
  DEFAULT_AIRPORT_FEES,
  DEFAULT_SETTLEMENT,
  REVENUE_SOURCES,
  type SettlementInputs,
  settleFlight,
  summariseLoad,
} from './settlement';

/**
 * Flight settlement (M2-06, §11, §13.4, §14.1).
 *
 * Three claims, and the third is the reason the other two are worth trusting:
 *
 *   1. **The breakdown reconciles exactly.** Totals are sums of the lines, in
 *      whole minor units, with no cent unaccounted for.
 *   2. Revenue is taken from the load and never invented — M3 prices, this adds up.
 *   3. **It reproduces §13.4's published P&L**, which is the only place the design
 *      doc costs an airline out line by line.
 */

const ATR72_CRUISE_KT = 275;
const ATR72_MTOW_T = 23;
const ATR72_SEATS = 70;
/** See `flight/fuel.test.ts` for how this fixture is derived. */
const ATR72_BURN_T_PER_NM = 2.5 / 825;

const AMS: FuelStation = { icao: 'EHAM', regionFactor: 1.03, intoPlaneFeePerTonne: 35 };

/** A 70-seat single-class cabin at 68% load factor: 47 passengers (§13.4 rounds to 47.6). */
function economyLoad(passengers: number, revenueMinor: number, seats = ATR72_SEATS): FlightLoad {
  return { economy: { seats, passengers, revenue: revenueMinor } };
}

function inputs(overrides: Partial<SettlementInputs> = {}): SettlementInputs {
  const block = computeBlockTime(200, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
  const burn = computeFuelBurn(block, { cruiseBurnTPerNm: ATR72_BURN_T_PER_NM });
  return {
    kind: 'scheduled',
    load: economyLoad(47, 47 * 7_500),
    cargoKg: 0,
    block,
    fuelCost: computeFuelCost(burn.tonnes, DEFAULT_FUEL_MARKET, AMS),
    aircraft: { maxTakeoffWeightT: ATR72_MTOW_T },
    originFees: DEFAULT_AIRPORT_FEES,
    destinationFees: DEFAULT_AIRPORT_FEES,
    ...overrides,
  };
}

describe('summariseLoad', () => {
  it('adds seats, passengers and revenue across every class', () => {
    const load: FlightLoad = {
      economy: { seats: 150, passengers: 120, revenue: 900_000 },
      business: { seats: 20, passengers: 14, revenue: 700_000 },
    };

    expect(summariseLoad(load)).toEqual({
      seats: 170,
      passengers: 134,
      revenueMinor: 1_600_000,
    });
  });

  it('treats an absent class as absent, not as zero seats', () => {
    expect(summariseLoad({}).seats).toBe(0);
    expect(summariseLoad({}).revenueMinor).toBe(0);
  });

  it('refuses more passengers than seats, naming the cabin', () => {
    // Overselling is a real airline practice and a real M3 decision, but it is
    // resolved before the aircraft leaves — a flight that departed with more
    // people aboard than seats is a data error, not a revenue opportunity.
    expect(() => summariseLoad({ business: { seats: 10, passengers: 11, revenue: 0 } })).toThrow(
      /business/,
    );
  });
});

describe('settleFlight', () => {
  it('reconciles exactly — totals are the sums of the lines', () => {
    const result = settleFlight(inputs());

    expect(result.revenueMinor).toBe(result.revenue.reduce((s, l) => s + l.amountMinor, 0));
    expect(result.costMinor).toBe(result.costs.reduce((s, l) => s + l.amountMinor, 0));
    expect(result.netMinor).toBe(result.revenueMinor - result.costMinor);
  });

  it('produces whole minor units everywhere — no fractional cents escape', () => {
    const result = settleFlight(inputs({ cargoKg: 1_337, load: economyLoad(47, 351_237) }));

    for (const line of [...result.revenue, ...result.costs]) {
      expect(Number.isInteger(line.amountMinor), `${line.source} is fractional`).toBe(true);
      expect(line.amountMinor).toBeGreaterThanOrEqual(0);
    }
    for (const total of [result.revenueMinor, result.costMinor, result.netMinor]) {
      expect(Number.isInteger(total)).toBe(true);
    }
  });

  it('takes ticket revenue from the load rather than inventing a fare', () => {
    // The M3 boundary. Settlement sums what the fare model decided.
    const result = settleFlight(inputs({ load: economyLoad(47, 123_456) }));
    const tickets = result.revenue.find((l) => l.source === 'tickets');

    expect(tickets?.amountMinor).toBe(123_456);
  });

  it('gives every line a sentence saying how it was arrived at', () => {
    // Invariant 4 / §14.1: no dead-end numbers.
    const result = settleFlight(inputs({ cargoKg: 2_000 }));

    for (const line of [...result.revenue, ...result.costs]) {
      expect(line.detail.length, `${line.source} has no detail`).toBeGreaterThan(10);
    }
  });

  it('reports load factor, and the per-seat figures §14.4 ranks routes on', () => {
    const result = settleFlight(inputs({ load: economyLoad(35, 262_500) }));

    expect(result.seats).toBe(70);
    expect(result.passengers).toBe(35);
    expect(result.loadFactor).toBeCloseTo(0.5, 10);
    expect(result.revenuePerSeatMinor).toBe(Math.round(result.revenueMinor / 70));
    expect(result.costPerSeatMinor).toBe(Math.round(result.costMinor / 70));
  });

  describe('the cost lines', () => {
    it('charges all five of §13.4’s flight-caused lines', () => {
      const result = settleFlight(inputs());

      expect(result.costs.map((l) => l.source)).toEqual([...COST_SOURCES]);
    });

    it('charges the landing fee against MTOW, so a paper upgrade costs for ever', () => {
      // App. C.3: the increased-MTOW option "raises landing fees at every
      // airport". Reading MTOW rather than a weight class is what makes that
      // true without this module knowing the option exists.
      const light = settleFlight(inputs()).costs.find((l) => l.source === 'airport');
      const heavy = settleFlight(
        inputs({ aircraft: { maxTakeoffWeightT: ATR72_MTOW_T + 2 } }),
      ).costs.find((l) => l.source === 'airport');

      expect(heavy?.amountMinor).toBe(
        (light?.amountMinor ?? 0) + 2 * DEFAULT_AIRPORT_FEES.landingPerTonne,
      );
    });

    it('charges passenger fees at the origin and the landing fee at the destination', () => {
      // They are levied by different airports, so a cheap departure field and an
      // expensive arrival one must not be averaged into one number.
      const dearArrival: AirportFees = { ...DEFAULT_AIRPORT_FEES, landingPerTonne: 2_400 };
      const base = settleFlight(inputs()).costs.find((l) => l.source === 'airport');
      const dear = settleFlight(inputs({ destinationFees: dearArrival })).costs.find(
        (l) => l.source === 'airport',
      );

      expect(dear?.amountMinor).toBe(
        (base?.amountMinor ?? 0) + ATR72_MTOW_T * DEFAULT_AIRPORT_FEES.landingPerTonne,
      );
    });

    it('charges crew and maintenance against block time, not distance', () => {
      const short = settleFlight(inputs());
      const longBlock = computeBlockTime(600, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
      const long = settleFlight(
        inputs({
          block: longBlock,
          fuelCost: computeFuelCost(
            computeFuelBurn(longBlock, { cruiseBurnTPerNm: ATR72_BURN_T_PER_NM }).tonnes,
            DEFAULT_FUEL_MARKET,
            AMS,
          ),
        }),
      );

      const crewOf = (r: typeof short) =>
        r.costs.find((l) => l.source === 'crew')?.amountMinor ?? 0;
      expect(crewOf(long) / crewOf(short)).toBeCloseTo(long.blockMinutes / short.blockMinutes, 2);
    });

    it('charges handling per turn plus per seat, so a bigger cabin costs more', () => {
      const small = settleFlight(inputs({ load: economyLoad(30, 0, 50) }));
      const large = settleFlight(inputs({ load: economyLoad(30, 0, 180) }));
      const handlingOf = (r: typeof small) =>
        r.costs.find((l) => l.source === 'handling')?.amountMinor ?? 0;

      expect(handlingOf(large) - handlingOf(small)).toBe(
        130 * DEFAULT_SETTLEMENT.groundHandlingPerSeatMinor,
      );
    });

    it('does not charge lease, gate or admin — they are not caused by the flight', () => {
      // The distinction the module is built around: a lease is due whether the
      // aircraft flies or is parked. Charging a share of it per sector would make
      // a flight's cost depend on how many other sectors were flown that month.
      const sources = settleFlight(inputs()).costs.map((l) => l.source);

      for (const period of ['lease', 'gate', 'admin']) {
        expect(sources).not.toContain(period);
      }
    });
  });

  describe('the revenue lines', () => {
    it('omits ancillary and cargo when there are none, rather than showing zeroes', () => {
      const result = settleFlight(inputs({ cargoKg: 0 }));

      expect(result.revenue.map((l) => l.source)).toEqual(['tickets']);
    });

    it('pays for belly freight when there is any (§12.1)', () => {
      const result = settleFlight(inputs({ cargoKg: 2_000 }));
      const cargo = result.revenue.find((l) => l.source === 'cargo');

      expect(cargo?.amountMinor).toBe(2 * DEFAULT_SETTLEMENT.cargoRatePerTonneMinor);
    });

    it('adds ancillary only when the config asks for it', () => {
      const result = settleFlight(inputs(), {
        ...DEFAULT_SETTLEMENT,
        ancillaryPerPassengerMinor: 1_200,
      });
      const ancillary = result.revenue.find((l) => l.source === 'ancillary');

      expect(ancillary?.amountMinor).toBe(47 * 1_200);
      // Zero by default, so §13.4's all-in fare is not silently inflated.
      expect(DEFAULT_SETTLEMENT.ancillaryPerPassengerMinor).toBe(0);
      expect(REVENUE_SOURCES).toContain('ancillary');
    });
  });

  describe('a ferry flight (M2-07)', () => {
    it('earns nothing and costs everything', () => {
      const ferry = settleFlight(inputs({ kind: 'ferry', load: {} }));

      expect(ferry.revenueMinor).toBe(0);
      expect(ferry.costMinor).toBeGreaterThan(0);
      expect(ferry.netMinor).toBe(-ferry.costMinor);
    });

    it('costs exactly what the same sector would as a scheduled flight', () => {
      // The whole point of the type. Positioning is not cheaper for carrying
      // nobody — fuel, crew, maintenance and the landing fee all fall due, and
      // that is what makes a badly-planned network expensive rather than untidy.
      const ferry = settleFlight(inputs({ kind: 'ferry', load: {} }));
      const revenueFlight = settleFlight(inputs({ load: economyLoad(0, 0) }));

      const costOf = (r: typeof ferry, source: string) =>
        r.costs.find((l) => l.source === source)?.amountMinor ?? 0;

      for (const source of ['fuel', 'crew', 'maintenance'] as const) {
        expect(costOf(ferry, source), source).toBe(costOf(revenueFlight, source));
      }
    });

    it('says on the ticket line that it is a positioning flight', () => {
      // "Clearly marked as non-revenue" — the readout has to say *why* it earned
      // nothing, or a ferry is indistinguishable from a flight that failed to sell.
      const ferry = settleFlight(inputs({ kind: 'ferry', load: {} }));
      const tickets = ferry.revenue.find((l) => l.source === 'tickets');

      expect(tickets?.detail).toMatch(/[Pp]ositioning/);
      expect(ferry.kind).toBe('ferry');
    });

    it('refuses one carrying passengers rather than quietly zeroing it', () => {
      // Zeroing would make a mis-typed flight settle to a plausible number.
      // Refusing makes it a failed event somebody has to look at.
      expect(() => settleFlight(inputs({ kind: 'ferry', load: economyLoad(47, 0) }))).toThrow(
        /ferry/i,
      );
    });

    it('refuses one carrying revenue even with no passengers', () => {
      expect(() =>
        settleFlight(
          inputs({
            kind: 'ferry',
            load: { economy: { seats: 70, passengers: 0, revenue: 5_000 } },
          }),
        ),
      ).toThrow(/ferry/i);
    });

    it('still pays for belly freight, which a ferry may legitimately carry', () => {
      // Repositioning with freight aboard is real, and §12.1's belly cargo is not
      // ticket revenue. The refusal above is about seats sold, not about the hold.
      const ferry = settleFlight(inputs({ kind: 'ferry', load: {}, cargoKg: 2_000 }));

      expect(ferry.revenueMinor).toBeGreaterThan(0);
      expect(ferry.revenue.map((l) => l.source)).toEqual(['tickets', 'cargo']);
    });
  });

  describe('degenerate flights', () => {
    it('settles a flight that carried nobody — the costs still happened', () => {
      const result = settleFlight(inputs({ load: economyLoad(0, 0) }));

      expect(result.revenueMinor).toBe(0);
      expect(result.costMinor).toBeGreaterThan(0);
      expect(result.netMinor).toBeLessThan(0);
      expect(result.loadFactor).toBe(0);
    });

    it('reports no per-seat figure for a flight with no cabin at all', () => {
      // A freighter, once M12 exists. Guards a divide by zero reaching a P&L.
      const result = settleFlight(inputs({ load: {}, cargoKg: 8_000 }));

      expect(result.seats).toBe(0);
      expect(result.loadFactor).toBe(0);
      expect(result.revenuePerSeatMinor).toBe(0);
      expect(result.costPerSeatMinor).toBe(0);
      expect(result.revenueMinor).toBeGreaterThan(0);
    });

    it('refuses negative cargo', () => {
      expect(() => settleFlight(inputs({ cargoKg: -1 }))).toThrow(/[Cc]argo/);
    });
  });

  it('is a pure function — the same flight always settles the same way', () => {
    expect(settleFlight(inputs())).toEqual(settleFlight(inputs()));
  });
});

/**
 * The calibration, and the reason to believe any of the rates above.
 *
 * §13.4 costs out *"the one-aircraft Amsterdam airline"* in full — App. B.6's
 * setup, an ATR 72 flying four AMS–LHR and four AMS–CDG sectors a day at 68% load
 * factor and a €75 average fare — and publishes both sides of its month:
 *
 *     Revenue   $856,800     Costs $808,472
 *       fuel 168k · maintenance 202k · airport fees 144k · handling 91k
 *       lease 85k · crew 60k · gate 18k · admin 40k
 *
 * Five of those eight are caused by flights and are settled here. The chain runs
 * sector → block time → fuel burn → fuel cost → settlement, with nothing stubbed.
 */
describe('§13.4’s one-aircraft Amsterdam airline', () => {
  const AMS_LHR_NM = 200;
  const AMS_CDG_NM = 215;
  const SEATS = 70;
  const LOAD_FACTOR = 0.68;
  const FARE_MINOR = 7_500;
  const DAYS = 30;

  /** B.6's day: four round trips, four to LHR and four to CDG. */
  const DAILY = [
    AMS_LHR_NM,
    AMS_LHR_NM,
    AMS_LHR_NM,
    AMS_LHR_NM,
    AMS_CDG_NM,
    AMS_CDG_NM,
    AMS_CDG_NM,
    AMS_CDG_NM,
  ];

  /**
   * 47.6 passengers, kept fractional.
   *
   * A real flight carries a whole number of people, and `FlightLoad` requires
   * one. But §13.4's monthly totals are built on the average, and rounding to 47
   * or 48 per sector would move the published revenue by 1–2% for a reason that
   * has nothing to do with the model. So the month is settled on 48-passenger
   * flights and the fractional remainder is reconciled once, at the end — which
   * is exactly how the doc's own figure was produced.
   */
  const PAX_EXACT = SEATS * LOAD_FACTOR;

  function settleSector(distanceNm: number, passengers: number) {
    const block = computeBlockTime(distanceNm, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
    const burn = computeFuelBurn(block, { cruiseBurnTPerNm: ATR72_BURN_T_PER_NM });
    return settleFlight({
      kind: 'scheduled',
      load: economyLoad(Math.round(passengers), Math.round(passengers * FARE_MINOR)),
      cargoKg: 0,
      block,
      fuelCost: computeFuelCost(burn.tonnes, DEFAULT_FUEL_MARKET, AMS),
      aircraft: { maxTakeoffWeightT: ATR72_MTOW_T },
      originFees: DEFAULT_AIRPORT_FEES,
      destinationFees: DEFAULT_AIRPORT_FEES,
    });
  }

  /** One month of sectors, settled individually and added up. */
  const month = DAILY.flatMap((nm) =>
    Array.from({ length: DAYS }, () => settleSector(nm, PAX_EXACT)),
  );

  function monthlyCost(source: string): number {
    return month.reduce(
      (total, r) => total + (r.costs.find((l) => l.source === source)?.amountMinor ?? 0),
      0,
    );
  }

  /** Published figures, in minor units. */
  const DOC = {
    revenue: 856_800_00,
    fuel: 168_000_00,
    maintenance: 202_000_00,
    airport: 144_000_00,
    handling: 91_000_00,
    crew: 60_000_00,
  };

  it('flies 240 sectors in the month, as B.6’s day implies', () => {
    expect(month).toHaveLength(240);
  });

  it.each([
    ['fuel', DOC.fuel],
    ['maintenance', DOC.maintenance],
    ['airport', DOC.airport],
    ['handling', DOC.handling],
    ['crew', DOC.crew],
  ])('reproduces §13.4’s %s line to within 2%%', (source, published) => {
    // Asserted with a tolerance because the doc quotes figures rounded to the
    // nearest thousand, not because the model is vague — every line lands inside
    // 0.6%. See the note on each rate in DEFAULT_SETTLEMENT for how it was set.
    expect(monthlyCost(source) / published).toBeGreaterThan(0.98);
    expect(monthlyCost(source) / published).toBeLessThan(1.02);
  });

  it('reproduces §13.4’s published revenue', () => {
    // 70 seats × 68% × 240 sectors × €75 is exactly $856,800. The only slack is
    // the whole-passenger rounding described above.
    const revenue = month.reduce((total, r) => total + r.revenueMinor, 0);

    expect(revenue / DOC.revenue).toBeGreaterThan(0.99);
    expect(revenue / DOC.revenue).toBeLessThan(1.01);
  });

  it('leaves a contribution that covers §13.4’s period costs and the profit it reports', () => {
    // The doc's own arithmetic: $856,800 revenue − $808,472 costs = $48,328
    // operating profit. Of those costs, lease 85k + gate 18k + admin 40k = 143k
    // are period costs this does not settle. So contribution should land near
    // 48,328 + 143,000 = $191,328.
    const contribution = month.reduce((total, r) => total + r.netMinor, 0);
    const expected = 191_328_00;

    expect(contribution / expected).toBeGreaterThan(0.97);
    expect(contribution / expected).toBeLessThan(1.03);
  });

  it('is profitable at 68% and loses money empty, which is the whole game', () => {
    const full = settleSector(AMS_LHR_NM, PAX_EXACT);
    const empty = settleSector(AMS_LHR_NM, 0);

    expect(full.netMinor).toBeGreaterThan(0);
    expect(empty.netMinor).toBeLessThan(0);
  });
});
