import { describe, expect, it } from 'vitest';

import {
  dominantZoneByCountry,
  NEAREST_CITY_RADIUS_KM,
  resolveTimezones,
  summarise,
  type TimezoneAirport,
} from './resolve';

import type { GeoNamesCity } from '../catchment/sources';

/**
 * Airport → timezone (M3-04a).
 *
 * The cases below are the ones longitude ÷ 15 gets wrong, which is the entire
 * reason this exists. Each is a real place with a published answer.
 */

let nextId = 0;
function city(
  over: Partial<GeoNamesCity> & Pick<GeoNamesCity, 'latitude' | 'longitude'>,
): GeoNamesCity {
  nextId += 1;
  return {
    geonameId: nextId,
    name: `city-${String(nextId)}`,
    countryCode: 'NL',
    population: 100_000,
    featureCode: 'PPL',
    timezone: 'Europe/Amsterdam',
    ...over,
  };
}

function airport(
  over: Partial<TimezoneAirport> & Pick<TimezoneAirport, 'latitude' | 'longitude'>,
): TimezoneAirport {
  nextId += 1;
  return { id: `airport-${String(nextId)}`, isoCountry: 'NL', ...over };
}

describe('resolveTimezones', () => {
  it('takes the nearest city’s zone', () => {
    const amsterdam = city({ latitude: 52.374, longitude: 4.89, timezone: 'Europe/Amsterdam' });
    const schiphol = airport({ latitude: 52.3086, longitude: 4.7639 });

    const [resolved] = resolveTimezones([schiphol], [amsterdam]);

    expect(resolved?.timezone).toBe('Europe/Amsterdam');
    expect(resolved?.utcOffsetMinutes).toBe(60);
    expect(resolved?.basis).toBe('nearest-city');
    // The whole point, stated as a number: longitude ÷ 15 gives 19 minutes.
    expect(resolved?.utcOffsetMinutes).not.toBe(19);
  });

  it('separates mainland Spain from the Canaries', () => {
    // Both Spain, both west of Greenwich, an hour apart. No band of longitude
    // can do this, and the nearest city does it without a special case.
    const cities = [
      city({ latitude: 40.42, longitude: -3.7, countryCode: 'ES', timezone: 'Europe/Madrid' }),
      city({
        latitude: 28.46,
        longitude: -16.25,
        countryCode: 'ES',
        timezone: 'Atlantic/Canary',
      }),
    ];
    const airports = [
      airport({ id: 'MAD', latitude: 40.4719, longitude: -3.5626, isoCountry: 'ES' }),
      airport({ id: 'TFN', latitude: 28.4827, longitude: -16.3415, isoCountry: 'ES' }),
    ];

    const resolved = resolveTimezones(airports, cities);

    expect(resolved.find((r) => r.airportId === 'MAD')?.utcOffsetMinutes).toBe(60);
    expect(resolved.find((r) => r.airportId === 'TFN')?.utcOffsetMinutes).toBe(0);
  });

  it('puts western China on Beijing time', () => {
    // China spans five geometric zones and observes one. Longitude would put
    // Kashgar three hours out.
    const kashgar = city({
      latitude: 39.47,
      longitude: 75.99,
      countryCode: 'CN',
      timezone: 'Asia/Shanghai',
    });
    const kashgarAirport = airport({ latitude: 39.5429, longitude: 76.02, isoCountry: 'CN' });

    const [resolved] = resolveTimezones([kashgarAirport], [kashgar]);

    expect(resolved?.utcOffsetMinutes).toBe(480);
  });

  it('gets India’s half-hour offset', () => {
    const delhi = city({
      latitude: 28.65,
      longitude: 77.22,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
    });
    const [resolved] = resolveTimezones(
      [airport({ latitude: 28.5665, longitude: 77.1031, isoCountry: 'IN' })],
      [delhi],
    );

    expect(resolved?.utcOffsetMinutes).toBe(330);
  });

  it('picks the closer of two cities in different zones', () => {
    const near = city({
      latitude: 40.0,
      longitude: -3.0,
      countryCode: 'ES',
      timezone: 'Europe/Madrid',
    });
    const far = city({
      latitude: 41.0,
      longitude: -3.0,
      countryCode: 'ES',
      timezone: 'Atlantic/Canary',
    });
    const [resolved] = resolveTimezones(
      [airport({ latitude: 40.05, longitude: -3.0, isoCountry: 'ES' })],
      [far, near],
    );

    expect(resolved?.timezone).toBe('Europe/Madrid');
  });

  it('falls back to the country’s dominant zone when no city is near', () => {
    const remote = airport({ latitude: -75, longitude: 0, isoCountry: 'NL' });
    const [resolved] = resolveTimezones(
      [remote],
      [city({ latitude: 52.374, longitude: 4.89, timezone: 'Europe/Amsterdam' })],
    );

    expect(resolved?.basis).toBe('country');
    expect(resolved?.timezone).toBe('Europe/Amsterdam');
    expect(resolved?.distanceKm).toBeNull();
  });

  it('falls back to longitude when the country is unknown too', () => {
    const nowhere = airport({ latitude: -75, longitude: 30, isoCountry: 'ZZ' });
    const [resolved] = resolveTimezones([nowhere], []);

    expect(resolved?.basis).toBe('longitude');
    expect(resolved?.timezone).toBeNull();
    expect(resolved?.utcOffsetMinutes).toBe(120);
  });

  it('always produces an offset, whatever happened', () => {
    const airports = [
      airport({ latitude: 52.3, longitude: 4.7 }),
      airport({ latitude: -75, longitude: 0, isoCountry: 'NL' }),
      airport({ latitude: -75, longitude: 30, isoCountry: 'ZZ' }),
    ];
    const resolved = resolveTimezones(airports, [
      city({ latitude: 52.374, longitude: 4.89, timezone: 'Europe/Amsterdam' }),
    ]);

    expect(resolved).toHaveLength(3);
    for (const row of resolved) {
      expect(Number.isFinite(row.utcOffsetMinutes)).toBe(true);
      expect(row.utcOffsetMinutes).toBeGreaterThanOrEqual(-720);
      expect(row.utcOffsetMinutes).toBeLessThanOrEqual(840);
    }
  });

  it('ignores a city whose zone ICU does not recognise', () => {
    // GeoNames is third-party data. A stale or renamed zone must fall through
    // rather than stop the import.
    const stale = city({ latitude: 52.374, longitude: 4.89, timezone: 'Europe/Atlantis' });
    const [resolved] = resolveTimezones(
      [airport({ latitude: 52.3086, longitude: 4.7639 })],
      [stale],
    );

    expect(resolved?.basis).not.toBe('nearest-city');
  });

  it('ignores cities with no zone at all', () => {
    const blank = city({ latitude: 52.374, longitude: 4.89, timezone: '' });
    const [resolved] = resolveTimezones(
      [airport({ latitude: 52.3086, longitude: 4.7639 })],
      [blank],
    );

    expect(resolved?.basis).not.toBe('nearest-city');
  });

  it('does not reach past its radius', () => {
    // A city just beyond the radius must not decide an airport. Roughly 111 km
    // to the degree of latitude, so this sits comfortably outside.
    const tooFar = city({
      latitude: 52.3086 + (NEAREST_CITY_RADIUS_KM + 200) / 111,
      longitude: 4.7639,
    });
    const [resolved] = resolveTimezones(
      [airport({ latitude: 52.3086, longitude: 4.7639 })],
      [tooFar],
    );

    expect(resolved?.basis).toBe('country');
  });

  it('is deterministic — the same inputs always resolve the same way', () => {
    const cities = [
      city({ latitude: 40.0, longitude: -3.0, countryCode: 'ES', timezone: 'Europe/Madrid' }),
      city({ latitude: 40.0, longitude: -3.0, countryCode: 'ES', timezone: 'Atlantic/Canary' }),
    ];
    const one = airport({ latitude: 40.0, longitude: -3.0, isoCountry: 'ES' });

    // Two cities at exactly the same point in different zones is the tie that
    // would otherwise resolve by file order. Reversing the input must not
    // change the answer.
    const forwards = resolveTimezones([one], cities);
    const backwards = resolveTimezones([one], [...cities].reverse());

    expect(forwards[0]?.timezone).toBe(backwards[0]?.timezone);
  });

  it('records how far away the deciding city was', () => {
    const [resolved] = resolveTimezones(
      [airport({ latitude: 52.3086, longitude: 4.7639 })],
      [city({ latitude: 52.374, longitude: 4.89 })],
    );

    expect(resolved?.distanceKm).toBeGreaterThan(0);
    expect(resolved?.distanceKm).toBeLessThan(20);
  });
});

describe('dominantZoneByCountry', () => {
  it('weights by population, not by number of towns', () => {
    // Nearly everyone in Indonesia lives in the western zone; counting towns
    // would give the eastern one more weight than it deserves.
    const cities = [
      city({
        latitude: -6.2,
        longitude: 106.8,
        countryCode: 'ID',
        timezone: 'Asia/Jakarta',
        population: 10_000_000,
      }),
      city({
        latitude: -2.5,
        longitude: 140.7,
        countryCode: 'ID',
        timezone: 'Asia/Jayapura',
        population: 200_000,
      }),
      city({
        latitude: -0.5,
        longitude: 137.0,
        countryCode: 'ID',
        timezone: 'Asia/Jayapura',
        population: 150_000,
      }),
      city({
        latitude: -1.0,
        longitude: 136.0,
        countryCode: 'ID',
        timezone: 'Asia/Jayapura',
        population: 100_000,
      }),
    ];

    expect(dominantZoneByCountry(cities).get('ID')).toBe('Asia/Jakarta');
  });

  it('skips zones ICU does not know', () => {
    const cities = [
      city({
        latitude: 0,
        longitude: 0,
        countryCode: 'XX',
        timezone: 'Bad/Zone',
        population: 9_000_000,
      }),
      city({ latitude: 0, longitude: 0, countryCode: 'XX', timezone: 'UTC', population: 1_000 }),
    ];

    expect(dominantZoneByCountry(cities).get('XX')).toBe('UTC');
  });

  it('has nothing to say about a country with no cities', () => {
    expect(dominantZoneByCountry([]).get('NL')).toBeUndefined();
  });
});

describe('summarise', () => {
  it('counts each basis and the furthest deciding city', () => {
    const summary = summarise([
      {
        airportId: 'a',
        timezone: 'UTC',
        utcOffsetMinutes: 0,
        basis: 'nearest-city',
        distanceKm: 12,
      },
      {
        airportId: 'b',
        timezone: 'UTC',
        utcOffsetMinutes: 0,
        basis: 'nearest-city',
        distanceKm: 88,
      },
      { airportId: 'c', timezone: 'UTC', utcOffsetMinutes: 0, basis: 'country', distanceKm: null },
      {
        airportId: 'd',
        timezone: null,
        utcOffsetMinutes: 60,
        basis: 'longitude',
        distanceKm: null,
      },
    ]);

    expect(summary.total).toBe(4);
    expect(summary.byBasis['nearest-city']).toBe(2);
    expect(summary.byBasis.country).toBe(1);
    expect(summary.byBasis.longitude).toBe(1);
    expect(summary.furthestCityKm).toBe(88);
  });
});
