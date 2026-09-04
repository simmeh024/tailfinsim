import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, FUEL_REGIONS } from '@tailfin/shared';

import {
  computeFuelCost,
  DEFAULT_FUEL_CURVE,
  DEFAULT_FUEL_STATION_CONFIG,
  type FuelStationInputs,
  fuelRegionOf,
  stationFuelPricing,
  stationPricePerTonne,
  worldFuelMarket,
  worldFuelPrice,
} from './fuel-price';

/**
 * Per-station fuel pricing and the world curve (M5-07, §9.3, §11).
 *
 * The issue's two acceptance criteria are the two things worth proving here:
 * *"fuel cost differs measurably between stations on the same route"* and *"the
 * world fuel curve is config-driven"*. Everything else in this file exists to
 * pin the properties that make those two safe — determinism above all, because a
 * station price that moved between two reads would make a `flight_result`
 * inexplicable and a fare floor a lie.
 */

const SEED = 'world-seed-m5-07';

function station(icao: string, over: Partial<FuelStationInputs> = {}): FuelStationInputs {
  return { icao, continent: 'EU', isoCountry: 'NL', tier: 'medium', ...over };
}

describe('fuelRegionOf', () => {
  it('reads the continent when nothing overrides it', () => {
    expect(fuelRegionOf('EU', 'NL')).toBe('europe');
    expect(fuelRegionOf('NA', 'US')).toBe('north_america');
    expect(fuelRegionOf('AF', 'KE')).toBe('africa');
    expect(fuelRegionOf('SA', 'BR')).toBe('latin_america');
    expect(fuelRegionOf('AS', 'JP')).toBe('asia_pacific');
  });

  it('folds Oceania into Asia-Pacific rather than inventing a seventh region', () => {
    expect(fuelRegionOf('OC', 'AU')).toBe('asia_pacific');
    expect(fuelRegionOf('OC', 'FJ')).toBe('asia_pacific');
  });

  it('prices the Gulf at the well, not as an Asian importer', () => {
    // The whole reason the override list exists: OurAirports files Dubai under
    // `AS`, which would charge it Singapore's import price.
    expect(fuelRegionOf('AS', 'AE')).toBe('middle_east');
    expect(fuelRegionOf('AS', 'SA')).toBe('middle_east');
    expect(fuelRegionOf('AS', 'IL')).toBe('middle_east');
  });

  it('prices Mexico and the Caribbean as importers, not as North America', () => {
    expect(fuelRegionOf('NA', 'MX')).toBe('latin_america');
    expect(fuelRegionOf('NA', 'JM')).toBe('latin_america');
    expect(fuelRegionOf('NA', 'CR')).toBe('latin_america');
  });

  it('leaves US Caribbean territories on the US supply they actually use', () => {
    // Puerto Rico is fed from the US Gulf Coast on US terms, so the continent is
    // right about it and it is deliberately not in the override list.
    expect(fuelRegionOf('NA', 'PR')).toBe('north_america');
    expect(fuelRegionOf('NA', 'VI')).toBe('north_america');
  });

  it('is case-insensitive about both codes', () => {
    expect(fuelRegionOf('eu', 'nl')).toBe('europe');
    expect(fuelRegionOf('as', 'ae')).toBe('middle_east');
  });

  it('answers "no region" rather than guessing when the geography is unknown', () => {
    // A real case in the source data — the caller falls back to `defaultStation`.
    expect(fuelRegionOf(null, null)).toBeNull();
    expect(fuelRegionOf(null, 'XX')).toBeNull();
    expect(fuelRegionOf('AN', 'AQ')).toBeNull();
  });

  it('classifies every region the config prices, and prices every one it returns', () => {
    // The two tables cannot drift: a region with no rates would throw at pricing
    // time, and rates for a region nothing returns would be dead balance.
    const classified = new Set(
      [
        ['EU', 'NL'],
        ['NA', 'US'],
        ['AS', 'AE'],
        ['AS', 'JP'],
        ['SA', 'BR'],
        ['AF', 'KE'],
      ].map(([continent, country]) => fuelRegionOf(continent ?? null, country ?? null)),
    );
    expect([...classified].sort()).toEqual([...FUEL_REGIONS].sort());
    for (const region of FUEL_REGIONS) {
      expect(ECONOMY_CONFIG_V1.fuel.regions[region].regionFactor).toBeGreaterThan(0);
    }
  });
});

describe('stationFuelPricing', () => {
  it('keeps the §13.4 anchor: a mid-tier European station is 1.03 and $35/t', () => {
    // The two numbers the $1,000/t world reference was solved through. The spread
    // moves the factor a few percent either way, so the fee is the exact check
    // and the factor is the bounded one.
    const eham = stationFuelPricing(SEED, station('EHAM'));
    expect(eham.intoPlaneFeePerTonne).toBeCloseTo(35, 10);
    expect(eham.regionFactor).toBeGreaterThan(1.03 * 0.96);
    expect(eham.regionFactor).toBeLessThan(1.03 * 1.04);
  });

  it('makes the Gulf cheaper than Europe and Africa dearer', () => {
    const gulf = stationFuelPricing(SEED, station('OMDB', { continent: 'AS', isoCountry: 'AE' }));
    const europe = stationFuelPricing(SEED, station('EHAM'));
    const africa = stationFuelPricing(SEED, station('HKJK', { continent: 'AF', isoCountry: 'KE' }));

    const market = { basePricePerTonne: 1_000 };
    expect(stationPricePerTonne(market, gulf)).toBeLessThan(stationPricePerTonne(market, europe));
    expect(stationPricePerTonne(market, europe)).toBeLessThan(stationPricePerTonne(market, africa));
  });

  it('charges more per tonne to put fuel aboard at a small field than at a flagship', () => {
    // A hydrant stand is not a bowser trucked in, and the fee is the service
    // rather than the commodity — so it is the fee that moves with the tier.
    const flagship = stationFuelPricing(SEED, station('EHAM', { tier: 'flagship' }));
    const regional = stationFuelPricing(SEED, station('EHAM', { tier: 'regional' }));
    expect(regional.intoPlaneFeePerTonne).toBeGreaterThan(flagship.intoPlaneFeePerTonne);
    // Same station, same region: the commodity factor is untouched by the tier.
    expect(regional.regionFactor).toBeCloseTo(flagship.regionFactor, 10);
  });

  it('charges the medium fee at a field with no tier rather than refusing to price it', () => {
    const untiered = stationFuelPricing(SEED, station('EHAM', { tier: null }));
    const medium = stationFuelPricing(SEED, station('EHAM', { tier: 'medium' }));
    expect(untiered.intoPlaneFeePerTonne).toBeCloseTo(medium.intoPlaneFeePerTonne, 10);
  });

  it('falls back to the default rates for an airport with no geography', () => {
    const unknown = stationFuelPricing(
      SEED,
      station('ZZZZ', { continent: null, isoCountry: null }),
    );
    const { defaultStation, tierFeeFactor } = DEFAULT_FUEL_STATION_CONFIG;
    expect(unknown.intoPlaneFeePerTonne).toBeCloseTo(
      defaultStation.intoPlaneFeePerTonne * tierFeeFactor.medium,
      10,
    );
  });

  it('gives two stations in the same region different prices', () => {
    // The per-station spread. Without it "per airport" would be a lie: every
    // European medium field would quote to the cent.
    const a = stationFuelPricing(SEED, station('EHAM'));
    const b = stationFuelPricing(SEED, station('EDDF'));
    expect(a.regionFactor).not.toBeCloseTo(b.regionFactor, 6);
  });

  it('is a fixed fact about a station in a world, not noise on the quote', () => {
    expect(stationFuelPricing(SEED, station('EHAM'))).toEqual(
      stationFuelPricing(SEED, station('EHAM')),
    );
  });

  it('gives the same station a different spread in a different world', () => {
    const here = stationFuelPricing(SEED, station('EHAM'));
    const elsewhere = stationFuelPricing('another-world', station('EHAM'));
    expect(here.regionFactor).not.toBeCloseTo(elsewhere.regionFactor, 6);
  });

  it('takes its numbers from the config it is handed', () => {
    const retuned = stationFuelPricing(SEED, station('EHAM'), {
      ...DEFAULT_FUEL_STATION_CONFIG,
      regions: {
        ...DEFAULT_FUEL_STATION_CONFIG.regions,
        europe: { regionFactor: 2, intoPlaneFeePerTonne: 100 },
      },
      // No spread, so the retune is the only thing moving the answer.
      stationSpread: 0,
    });
    expect(retuned.regionFactor).toBeCloseTo(2, 10);
    expect(retuned.intoPlaneFeePerTonne).toBeCloseTo(100, 10);
  });
});

describe('fuel cost between two stations on the same route', () => {
  /**
   * M5-07's first acceptance criterion, stated as the player would meet it:
   * the *same uplift* on the *same sector* costs measurably different money
   * depending on which end of it you bought the fuel at. Before M5-07 these two
   * numbers were identical, which is exactly what the criterion is about.
   */
  it('differs measurably', () => {
    const market = worldFuelMarket({
      basePricePerTonne: ECONOMY_CONFIG_V1.fuel.basePricePerTonne,
      worldSeed: SEED,
      epoch: new Date('1960-01-01T00:00:00Z'),
      gameNow: new Date('1960-06-01T00:00:00Z'),
    });

    const dubai = computeFuelCost(
      8,
      market,
      stationFuelPricing(
        SEED,
        station('OMDB', { continent: 'AS', isoCountry: 'AE', tier: 'flagship' }),
      ),
    );
    const nairobi = computeFuelCost(
      8,
      market,
      stationFuelPricing(
        SEED,
        station('HKJK', { continent: 'AF', isoCountry: 'KE', tier: 'large' }),
      ),
    );

    // Not "different in the tenth decimal place": the Gulf end is more than a
    // third cheaper than the African one for the same eight tonnes.
    expect(dubai.totalCost).toBeLessThan(nairobi.totalCost * 0.75);
    expect(dubai.icao).toBe('OMDB');
    expect(nairobi.icao).toBe('HKJK');
  });
});

describe('worldFuelPrice', () => {
  const epoch = new Date('1960-01-01T00:00:00Z');
  const base = { basePricePerTonne: 1_000, worldSeed: SEED, epoch };

  it('moves over the world calendar', () => {
    // §11: "fuel price fluctuates on a world curve". Before M5-07 it did not
    // fluctuate at all — it sat at its opening level for the life of the world.
    const opening = worldFuelPrice({ ...base, gameNow: epoch });
    const laterOn = worldFuelPrice({
      ...base,
      gameNow: new Date('1962-07-01T00:00:00Z'),
    });
    expect(laterOn).not.toBeCloseTo(opening, 2);
  });

  it('stays inside a plausible band for Jet A-1 across a decade', () => {
    for (let day = 0; day < 3_650; day += 7) {
      const price = worldFuelPrice({
        ...base,
        gameNow: new Date(epoch.getTime() + day * 86_400_000),
      });
      // The cycles sum to ±24%, so the level never reaches the clamp on its own —
      // which is the headroom §20's oil shock needs.
      expect(price).toBeGreaterThan(1_000 * 0.75);
      expect(price).toBeLessThan(1_000 * 1.25);
    }
  });

  it('is a pure function of the instant, so a replay bills the same fuel twice', () => {
    const at = new Date('1963-03-14T09:26:00Z');
    expect(worldFuelPrice({ ...base, gameNow: at })).toBe(worldFuelPrice({ ...base, gameNow: at }));
  });

  it('gives two worlds different curves from the same calendar', () => {
    const at = new Date('1961-04-01T00:00:00Z');
    expect(worldFuelPrice({ ...base, gameNow: at })).not.toBeCloseTo(
      worldFuelPrice({ ...base, worldSeed: 'other-world', gameNow: at }),
      2,
    );
  });

  it('runs backwards through the epoch without going negative', () => {
    // A world can be reset to an earlier epoch (ADR-0005), and a catch-up world
    // authored from real history may ask about a date before day zero.
    const before = worldFuelPrice({
      ...base,
      gameNow: new Date('1955-01-01T00:00:00Z'),
    });
    expect(before).toBeGreaterThan(0);
  });

  it('is config-driven — a flat curve never moves', () => {
    // M5-07's second acceptance criterion. The curve is an `EconomyConfig`
    // section, so an admin creating a new version with no amplitude gets a world
    // whose fuel price is a constant, and one with a big amplitude gets a
    // volatile one. Neither is a code change.
    const flat = {
      cycles: [{ amplitudeFraction: 0, periodDays: 365 }],
      minFactor: 0.5,
      maxFactor: 2,
    };
    const at = new Date('1964-08-09T00:00:00Z');
    expect(worldFuelPrice({ ...base, gameNow: at }, flat)).toBeCloseTo(1_000, 10);

    const wild = {
      cycles: [{ amplitudeFraction: 0.9, periodDays: 100 }],
      minFactor: 0.5,
      maxFactor: 2,
    };
    const levels = [0, 25, 50, 75].map((day) =>
      worldFuelPrice({ ...base, gameNow: new Date(epoch.getTime() + day * 86_400_000) }, wild),
    );
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(500);
  });

  it('honours the clamp the config sets', () => {
    const clamped = {
      cycles: [{ amplitudeFraction: 0.9, periodDays: 100 }],
      minFactor: 0.98,
      maxFactor: 1.02,
    };
    for (let day = 0; day < 200; day += 5) {
      const price = worldFuelPrice(
        { ...base, gameNow: new Date(epoch.getTime() + day * 86_400_000) },
        clamped,
      );
      expect(price).toBeGreaterThanOrEqual(980 - 1e-9);
      expect(price).toBeLessThanOrEqual(1_020 + 1e-9);
    }
  });

  it('refuses a base price of nothing', () => {
    expect(() => worldFuelPrice({ ...base, basePricePerTonne: 0, gameNow: epoch })).toThrow(
      /[Bb]ase fuel price/,
    );
  });

  it('ships the curve as a slice of the economy payload, not a copy of it', () => {
    expect(DEFAULT_FUEL_CURVE).toBe(ECONOMY_CONFIG_V1.fuel.curve);
    expect(DEFAULT_FUEL_STATION_CONFIG.regions).toBe(ECONOMY_CONFIG_V1.fuel.regions);
    expect(DEFAULT_FUEL_STATION_CONFIG.tierFeeFactor).toBe(ECONOMY_CONFIG_V1.fuel.tierFeeFactor);
  });
});
