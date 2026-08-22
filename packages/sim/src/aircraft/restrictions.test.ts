import { describe, expect, it } from 'vitest';

import { type AircraftEraDates, ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { computeFuelCost, DEFAULT_FUEL_MARKET } from '../economy/fuel-price';
import { DEFAULT_AIRPORT_FEES, DEFAULT_SETTLEMENT, settleFlight } from '../economy/settlement';
import { computeBlockTime } from '../flight/block';
import { DEFAULT_FLIGHT_PROFILE } from '../flight/profile';

import { DEFAULT_RESTRICTIONS, isOperable, restrictionCost } from './availability';

/**
 * What an era restriction costs (M4-02, §7.2b).
 *
 * The acceptance criterion this file exists for: *"Restrictions degrade
 * economics before the hard out-of-service date."* §7.2b puts it more plainly —
 * *"Your beloved fleet becomes uneconomic before it becomes illegal."*
 *
 * So the thing to prove is a **charge**, not a refusal: the aircraft still
 * flies, and it costs more.
 */

const era = (restrictions: AircraftEraDates['restrictionDates']): AircraftEraDates => ({
  firstFlight: '1995-01-01',
  entryIntoService: '1997-01-01',
  productionEnd: null,
  outOfService: '2045-01-01',
  restrictionDates: restrictions,
});

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('what a restriction costs', () => {
  it('costs nothing before it bites', () => {
    const dates = era([{ at: '2030-01-01', kind: 'noise_quota', note: 'Night quota exclusion.' }]);
    expect(restrictionCost(dates, day('2029-12-31'), 79).totalMinor).toBe(0);
  });

  it('charges a noise quota per departure, regardless of size', () => {
    // An airport that has run out of night quota counts movements, not tonnes.
    const dates = era([{ at: '2030-01-01', kind: 'noise_quota', note: 'Night quota exclusion.' }]);
    const small = restrictionCost(dates, day('2031-01-01'), 23);
    const large = restrictionCost(dates, day('2031-01-01'), 351);

    expect(small.totalMinor).toBe(DEFAULT_RESTRICTIONS.noiseQuotaPerDepartureMinor);
    expect(large.totalMinor).toBe(small.totalMinor);
  });

  it('charges emissions by the tonne, so a widebody pays more', () => {
    const dates = era([
      { at: '2030-01-01', kind: 'emissions_charge', note: 'Emissions surcharge.' },
    ]);
    const small = restrictionCost(dates, day('2031-01-01'), 23);
    const large = restrictionCost(dates, day('2031-01-01'), 351);

    // The reason both kinds exist: a per-movement charge alone would be a real
    // penalty on a turboprop and a rounding error on a 351-tonne aircraft.
    expect(large.totalMinor).toBeGreaterThan(small.totalMinor * 10);
  });

  it('accumulates as more restrictions arrive — the squeeze, not a cliff', () => {
    const dates = era([
      { at: '2028-01-01', kind: 'noise_quota', note: 'Night quota exclusion.' },
      { at: '2032-01-01', kind: 'emissions_charge', note: 'Emissions surcharge.' },
      { at: '2036-01-01', kind: 'curfew_exclusion', note: 'Excluded from the 23:00 curfew.' },
    ]);

    const costs = ['2027-01-01', '2029-01-01', '2033-01-01', '2037-01-01'].map(
      (at) => restrictionCost(dates, day(at), 79).totalMinor,
    );

    expect(costs[0]).toBe(0);
    expect(costs[1]).toBeGreaterThan(costs[0]!);
    expect(costs[2]).toBeGreaterThan(costs[1]!);
    expect(costs[3]).toBeGreaterThan(costs[2]!);
  });

  it('leaves the aircraft legal to fly the whole time', () => {
    // The distinction the whole mechanism rests on: restrictions make a type
    // expensive; only `out_of_service` makes it illegal.
    const dates = era([
      { at: '2028-01-01', kind: 'noise_quota', note: 'Night quota exclusion.' },
      { at: '2032-01-01', kind: 'emissions_charge', note: 'Emissions surcharge.' },
    ]);
    expect(isOperable(dates, day('2040-01-01'))).toBe(true);
    expect(restrictionCost(dates, day('2040-01-01'), 79).totalMinor).toBeGreaterThan(0);
    // And then it is not.
    expect(isOperable(dates, day('2046-01-01'))).toBe(false);
  });

  it('says which restriction produced each charge', () => {
    // A cost a player cannot attribute is one they will assume is a bug
    // (invariant 4).
    const dates = era([
      { at: '2028-01-01', kind: 'noise_quota', note: 'Night quota exclusion at EU hubs.' },
    ]);
    const cost = restrictionCost(dates, day('2029-01-01'), 79);

    expect(cost.charges).toHaveLength(1);
    expect(cost.charges[0]?.kind).toBe('noise_quota');
    expect(cost.charges[0]?.since).toBe('2028-01-01');
    expect(cost.charges[0]?.note).toBe('Night quota exclusion at EU hubs.');
    expect(cost.charges[0]?.amountMinor).toBe(cost.totalMinor);
  });

  it('takes its rates from the world’s economy config', () => {
    // The dates are the catalogue's and the rates are the economy's, so a world
    // can make old aircraft more expensive without re-issuing its catalogue.
    const dates = era([{ at: '2028-01-01', kind: 'noise_quota', note: 'Night quota.' }]);
    const dearer = {
      ...ECONOMY_CONFIG_V1.costs.restrictions,
      noiseQuotaPerDepartureMinor: 500_000,
    };
    expect(restrictionCost(dates, day('2029-01-01'), 79, dearer).totalMinor).toBe(500_000);
  });
});

describe('a restricted flight, settled', () => {
  const inputs = {
    kind: 'scheduled' as const,
    load: { economy: { seats: 180, passengers: 150, revenue: 1_500_000 } },
    cargoKg: 0,
    // The real block-time model rather than a hand-built shape: `settleFlight`
    // reads more of it than the four obvious fields.
    block: computeBlockTime(700, 447, DEFAULT_FLIGHT_PROFILE),
    fuelCost: computeFuelCost(6, DEFAULT_FUEL_MARKET, {
      icao: 'EHAM',
      regionFactor: 1.03,
      intoPlaneFeePerTonne: 35,
    }),
    aircraft: { maxTakeoffWeightT: 79 },
    originFees: DEFAULT_AIRPORT_FEES,
    destinationFees: DEFAULT_AIRPORT_FEES,
  };

  it('carries no restrictions line when there is nothing to charge', () => {
    // An unrestricted type should not carry a zero row telling a player about a
    // penalty they are not paying — which is every type in the shipped
    // catalogue today.
    const settled = settleFlight(inputs, DEFAULT_SETTLEMENT);
    expect(settled.costs.map((line) => line.source)).not.toContain('restrictions');
  });

  it('charges the surcharge as its own cost line', () => {
    const settled = settleFlight(
      { ...inputs, restrictionSurchargeMinor: 440_000 },
      DEFAULT_SETTLEMENT,
    );

    const line = settled.costs.find((cost) => cost.source === 'restrictions');
    expect(line?.amountMinor).toBe(440_000);
    // Its own line rather than folded into `airport`, because "why does this
    // aircraft cost more than it did last year?" is a question a player asks.
    expect(line?.detail).toMatch(/Era restrictions/);
  });

  it('makes the same flight measurably worse off', () => {
    const clean = settleFlight(inputs, DEFAULT_SETTLEMENT);
    const restricted = settleFlight(
      { ...inputs, restrictionSurchargeMinor: 440_000 },
      DEFAULT_SETTLEMENT,
    );

    // The acceptance criterion, as arithmetic: identical flight, identical
    // revenue, 440,000 minor units worse.
    expect(restricted.revenueMinor).toBe(clean.revenueMinor);
    expect(restricted.costMinor - clean.costMinor).toBe(440_000);
    expect(restricted.netMinor).toBe(clean.netMinor - 440_000);
  });

  it('keeps the breakdown reconciling exactly', () => {
    const settled = settleFlight(
      { ...inputs, restrictionSurchargeMinor: 440_000 },
      DEFAULT_SETTLEMENT,
    );
    const summed = settled.costs.reduce((total, line) => total + line.amountMinor, 0);
    expect(summed).toBe(settled.costMinor);
  });
});
