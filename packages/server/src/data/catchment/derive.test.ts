import { describe, expect, it } from 'vitest';

import {
  CATCHMENT_RADIUS_KM,
  deriveCatchment,
  distanceKm,
  INDEX_MAX,
  INDEX_MIN,
  median,
  normaliseIndex,
  TIER_WEIGHTS,
  type CatchmentAirport,
} from './derive';
import { type CountryIndicator, type GeoNamesCity } from './sources';

/**
 * The catchment derivation.
 *
 * Every number here is a judgement someone will want to argue with, so the tests
 * are written to make the arguments concrete: what happens to a metro with three
 * airports, what happens to a strip with no city near it, and what stops the
 * richest country on earth from multiplying demand by four hundred.
 */

function city(overrides: Partial<GeoNamesCity> = {}): GeoNamesCity {
  return {
    geonameId: 1,
    name: 'Testville',
    latitude: 52.37,
    longitude: 4.9,
    countryCode: 'NL',
    population: 1_000_000,
    featureCode: 'PPL',
    // Carried on the dump for M3-04a's benefit; the catchment derivation
    // ignores it entirely.
    timezone: 'Europe/Amsterdam',
    ...overrides,
  };
}

function airport(overrides: Partial<CatchmentAirport> = {}): CatchmentAirport {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    ident: 'EHAM',
    latitude: 52.31,
    longitude: 4.76,
    isoCountry: 'NL',
    tier: 'medium',
    ...overrides,
  };
}

function indicator(value: number, country = 'NL', year = 2024): CountryIndicator {
  return { country, value, year };
}

const NO_INDICATORS = new Map<string, CountryIndicator>();

function derive(airports: CatchmentAirport[], cities: GeoNamesCity[], overrides = {}) {
  return deriveCatchment({
    airports,
    cities,
    gdpPerCapita: NO_INDICATORS,
    touristArrivals: NO_INDICATORS,
    countryPopulation: NO_INDICATORS,
    ...overrides,
  });
}

describe('distanceKm', () => {
  it('is zero for a point against itself', () => {
    expect(distanceKm(52.3, 4.76, 52.3, 4.76)).toBe(0);
  });

  it('matches a known great-circle distance', () => {
    // AMS–LHR is about 370 km.
    expect(distanceKm(52.3086, 4.76389, 51.4706, -0.461941)).toBeCloseTo(370, -1);
  });

  it('handles antipodal-ish distances without NaN', () => {
    // The naive haversine goes NaN here when floating point pushes sqrt above 1.
    const km = distanceKm(0, 0, 0, 180);
    expect(Number.isFinite(km)).toBe(true);
    expect(km).toBeCloseTo(20_015, -2);
  });

  it('is symmetric', () => {
    expect(distanceKm(1, 2, 3, 4)).toBeCloseTo(distanceKm(3, 4, 1, 2), 9);
  });
});

describe('median', () => {
  it('takes the middle of an odd-length set', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair of an even-length set', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is zero for nothing', () => {
    expect(median([])).toBe(0);
  });
});

describe('normaliseIndex', () => {
  it('is 1.0 at the median, which is the whole point', () => {
    // A.2 multiplies these together, so the median has to be neutral or the
    // constant k stops meaning anything.
    expect(normaliseIndex(100, 100)).toBe(1);
  });

  it('compresses the spread with a square root', () => {
    // Four times the median is twice the index, not four times — A.2 already
    // raises the product to α, and compounding two exponents was not intended.
    expect(normaliseIndex(400, 100)).toBeCloseTo(2, 6);
  });

  it('clamps the extremes rather than letting a market round to nothing', () => {
    // Raw GDP per capita spans ~400x. Unclamped, the poorest markets would
    // multiply out to no demand at all, and B.3 wants thin markets to be
    // playable rather than absent.
    expect(normaliseIndex(1_000_000, 100)).toBe(INDEX_MAX);
    expect(normaliseIndex(0.0001, 100)).toBe(INDEX_MIN);
  });

  it('falls back to neutral on missing or nonsensical input', () => {
    expect(normaliseIndex(0, 100)).toBe(1);
    expect(normaliseIndex(100, 0)).toBe(1);
  });
});

describe('catchment population', () => {
  it('counts a city inside the radius', () => {
    const [result] = derive([airport()], [city({ population: 800_000 })]);
    expect(result?.population).toBe(800_000);
    expect(result?.basis.citiesInRange).toBe(1);
  });

  it('ignores a city beyond the radius', () => {
    // Roughly 400 km east — well outside 100 km.
    const [result] = derive([airport()], [city({ longitude: 10.7, population: 800_000 })]);
    expect(result?.basis.citiesInRange).toBe(0);
  });

  it('sums several cities in range', () => {
    const [result] = derive(
      [airport()],
      [city({ geonameId: 1, population: 800_000 }), city({ geonameId: 2, population: 200_000 })],
    );
    expect(result?.population).toBe(1_000_000);
  });

  it('floors a remote airport rather than leaving it at zero', () => {
    // Zero would multiply the whole city pair to nothing in A.2, and people do
    // fly to island strips. GeoNames' own floor is 15,000, so anything smaller
    // is invisible to us by construction.
    const [result] = derive([airport({ latitude: -54, longitude: -36 })], [city()]);
    expect(result?.population).toBeGreaterThan(0);
    expect(result?.basis.fallbacks.join()).toMatch(/no city within radius/);
  });
});

describe('multi-airport cities', () => {
  const london = city({ name: 'London', latitude: 51.5, longitude: -0.13, population: 8_000_000 });

  const lhr = airport({
    id: 'a-lhr',
    ident: 'EGLL',
    latitude: 51.47,
    longitude: -0.46,
    tier: 'flagship',
  });
  const lgw = airport({
    id: 'a-lgw',
    ident: 'EGKK',
    latitude: 51.15,
    longitude: -0.19,
    tier: 'large',
  });
  const ltn = airport({
    id: 'a-ltn',
    ident: 'EGGW',
    latitude: 51.87,
    longitude: -0.37,
    tier: 'small',
  });

  it('splits a metro instead of counting it three times', () => {
    // The acceptance criterion. Without the split, London would appear to hold
    // 24 million people.
    const results = derive([lhr, lgw, ltn], [london]);
    const total = results.reduce((sum, r) => sum + r.population, 0);
    expect(total).toBeCloseTo(london.population, -1);
  });

  it('gives the flagship the largest share, not an equal one', () => {
    // An equal split would tell the demand model that Luton and Heathrow are the
    // same size of market.
    const results = derive([lhr, lgw, ltn], [london]);
    const [heathrow, gatwick, luton] = results;
    expect(heathrow!.population).toBeGreaterThan(gatwick!.population);
    expect(gatwick!.population).toBeGreaterThan(luton!.population);
  });

  it('splits in proportion to the tier weights', () => {
    const results = derive([lhr, lgw, ltn], [london]);
    const totalWeight = TIER_WEIGHTS.flagship + TIER_WEIGHTS.large + TIER_WEIGHTS.small;
    expect(results[0]!.population).toBeCloseTo(
      (london.population * TIER_WEIGHTS.flagship) / totalWeight,
      -1,
    );
  });

  it('records the share and the competitor count for audit', () => {
    const results = derive([lhr, lgw, ltn], [london]);
    expect(results[0]!.basis.competingAirports).toBe(2);
    expect(results[0]!.basis.shareOfMetro).toBeLessThan(1);
    expect(results[2]!.basis.shareOfMetro).toBeLessThan(results[0]!.basis.shareOfMetro);
  });

  it('leaves a solitary airport with the whole city and a share of 1', () => {
    const results = derive([lhr], [london]);
    expect(results[0]!.population).toBe(london.population);
    expect(results[0]!.basis.shareOfMetro).toBe(1);
    expect(results[0]!.basis.competingAirports).toBe(0);
  });
});

describe('indices', () => {
  it('is neutral where the country has no data at all', () => {
    const [result] = derive([airport()], [city()]);
    expect(result?.wealthIndex).toBe(1);
    expect(result?.tourismIndex).toBe(1);
    expect(result?.basis.fallbacks.length).toBeGreaterThan(0);
  });

  it('lifts wealth above 1 for a country richer than the median', () => {
    const [result] = derive([airport()], [city()], {
      gdpPerCapita: new Map([
        ['NL', indicator(60_000)],
        ['XX', indicator(15_000, 'XX')],
        ['YY', indicator(5_000, 'YY')],
      ]),
    });
    expect(result!.wealthIndex).toBeGreaterThan(1);
  });

  it('drops wealth below 1 for a country poorer than the median', () => {
    const [result] = derive([airport()], [city()], {
      gdpPerCapita: new Map([
        ['NL', indicator(1_000)],
        ['XX', indicator(15_000, 'XX')],
        ['YY', indicator(60_000, 'YY')],
      ]),
    });
    expect(result!.wealthIndex).toBeLessThan(1);
  });

  it('turns tourist arrivals into a per-resident rate before comparing', () => {
    // Absolute arrivals would make every large country look touristic. Croatia
    // beating the United States is the outcome that says the rate is working.
    const [big] = derive([airport({ isoCountry: 'BG' })], [city({ countryCode: 'BG' })], {
      touristArrivals: new Map([
        ['BG', indicator(10_000_000, 'BG')],
        ['SM', indicator(2_000_000, 'SM')],
      ]),
      countryPopulation: new Map([
        ['BG', indicator(100_000_000, 'BG')],
        ['SM', indicator(1_000_000, 'SM')],
      ]),
    });
    const [small] = derive([airport({ isoCountry: 'SM' })], [city({ countryCode: 'SM' })], {
      touristArrivals: new Map([
        ['BG', indicator(10_000_000, 'BG')],
        ['SM', indicator(2_000_000, 'SM')],
      ]),
      countryPopulation: new Map([
        ['BG', indicator(100_000_000, 'BG')],
        ['SM', indicator(1_000_000, 'SM')],
      ]),
    });
    expect(small!.tourismIndex).toBeGreaterThan(big!.tourismIndex);
  });

  it('gives a capital a business premium over an ordinary town', () => {
    // A.2's Affinity term has to be able to tell AMS–LHR from AMS–PMI, and
    // country wealth alone cannot.
    const gdp = { gdpPerCapita: new Map([['NL', indicator(50_000)]]) };
    const [capital] = derive([airport()], [city({ featureCode: 'PPLC' })], gdp);
    const [town] = derive([airport()], [city({ featureCode: 'PPL' })], gdp);
    expect(capital!.businessIndex).toBeGreaterThan(town!.businessIndex);
    expect(capital!.basis.capitalInRange).toBe(true);
  });

  it('keeps every index inside the clamp', () => {
    const [result] = derive([airport()], [city({ featureCode: 'PPLC' })], {
      gdpPerCapita: new Map([
        ['NL', indicator(500_000)],
        ['XX', indicator(1, 'XX')],
      ]),
    });
    for (const index of [result!.wealthIndex, result!.tourismIndex, result!.businessIndex]) {
      expect(index).toBeGreaterThanOrEqual(INDEX_MIN);
      expect(index).toBeLessThanOrEqual(INDEX_MAX);
    }
  });

  it('never produces a zero, which would annihilate a city pair', () => {
    const [result] = derive([airport()], [city()], {
      gdpPerCapita: new Map([['NL', indicator(0.000001)]]),
    });
    expect(result!.wealthIndex).toBeGreaterThan(0);
    expect(result!.businessIndex).toBeGreaterThan(0);
  });
});

describe('audit trail', () => {
  it('records the radius, the inputs and any fallback used', () => {
    const [result] = derive([airport()], [city({ name: 'Amsterdam', population: 900_000 })], {
      gdpPerCapita: new Map([['NL', indicator(58_000, 'NL', 2023)]]),
    });
    expect(result!.basis).toMatchObject({
      radiusKm: CATCHMENT_RADIUS_KM,
      citiesInRange: 1,
      largestCity: 'Amsterdam',
      gdpPerCapita: 58_000,
      gdpYear: 2023,
    });
  });

  it('names the largest city, not merely the first', () => {
    const [result] = derive(
      [airport()],
      [
        city({ geonameId: 1, name: 'Haarlem', population: 160_000 }),
        city({ geonameId: 2, name: 'Amsterdam', population: 900_000 }),
      ],
    );
    expect(result!.basis.largestCity).toBe('Amsterdam');
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    // "Derivation script committed and re-runnable" is only meaningful if a
    // rerun is the same run.
    const airports = [airport({ id: 'a' }), airport({ id: 'b', tier: 'small' })];
    const cities = [city(), city({ geonameId: 2, population: 400_000 })];
    expect(derive(airports, cities)).toEqual(derive(airports, cities));
  });
});
