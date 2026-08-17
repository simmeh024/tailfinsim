import { describe, expect, it } from 'vitest';

import { type CsvRow } from '../csv';

import { normaliseAirports, normaliseRunways, normaliseSurface } from './normalise';

/**
 * The cleaning rules.
 *
 * Every one of these currently rejects **nothing** in the real dataset — it is
 * clean today. That is exactly why they are tested against constructed bad rows:
 * a guard nobody has ever seen fire is a guard nobody knows works, and the
 * upstream file is community-edited and republished weekly.
 */

const GOOD_AIRPORT: CsvRow = {
  id: '2513',
  ident: 'EHAM',
  type: 'large_airport',
  name: 'Amsterdam Airport Schiphol',
  latitude_deg: '52.3086',
  longitude_deg: '4.76389',
  elevation_ft: '-11',
  continent: 'EU',
  iso_country: 'NL',
  iso_region: 'NL-NH',
  municipality: 'Amsterdam',
  scheduled_service: 'yes',
  icao_code: 'EHAM',
  iata_code: 'AMS',
};

function airportRow(overrides: Record<string, string>): CsvRow {
  return { ...GOOD_AIRPORT, ...overrides };
}

describe('normaliseAirports — the happy path', () => {
  it('carries a good row through intact', () => {
    const { rows, rejected } = normaliseAirports([GOOD_AIRPORT]);
    expect(rejected).toEqual([]);
    expect(rows[0]).toEqual({
      sourceId: 2513,
      ident: 'EHAM',
      icaoCode: 'EHAM',
      iataCode: 'AMS',
      name: 'Amsterdam Airport Schiphol',
      municipality: 'Amsterdam',
      isoCountry: 'NL',
      isoRegion: 'NL-NH',
      continent: 'EU',
      kind: 'large_airport',
      latitude: 52.3086,
      longitude: 4.76389,
      elevationFt: -11,
      scheduledService: true,
    });
  });

  it('keeps a below-sea-level elevation rather than treating it as bad data', () => {
    // Schiphol is at -11 ft. A non-negative check here would reject one of the
    // busiest airports in Europe.
    expect(normaliseAirports([GOOD_AIRPORT]).rows[0]?.elevationFt).toBe(-11);
  });

  it('upper-cases identifiers and codes', () => {
    const { rows } = normaliseAirports([
      airportRow({ ident: 'eham', icao_code: 'eham', iata_code: 'ams', iso_country: 'nl' }),
    ]);
    expect(rows[0]).toMatchObject({
      ident: 'EHAM',
      icaoCode: 'EHAM',
      iataCode: 'AMS',
      isoCountry: 'NL',
    });
  });

  it('treats blank optional text as null, not as an empty string', () => {
    const { rows } = normaliseAirports([
      airportRow({ municipality: '', iso_region: '', continent: '', icao_code: '', iata_code: '' }),
    ]);
    expect(rows[0]).toMatchObject({
      municipality: null,
      isoRegion: null,
      continent: null,
      icaoCode: null,
      iataCode: null,
    });
  });

  it('reads scheduled_service as a boolean, defaulting to false', () => {
    expect(
      normaliseAirports([airportRow({ scheduled_service: 'yes' })]).rows[0]?.scheduledService,
    ).toBe(true);
    expect(
      normaliseAirports([airportRow({ scheduled_service: 'no' })]).rows[0]?.scheduledService,
    ).toBe(false);
    expect(
      normaliseAirports([airportRow({ scheduled_service: '' })]).rows[0]?.scheduledService,
    ).toBe(false);
  });
});

describe('normaliseAirports — rows that must be rejected', () => {
  it.each([
    ['blank ident', { ident: '' }, /blank ident/],
    ['missing latitude', { latitude_deg: '' }, /missing coordinates/],
    ['missing longitude', { longitude_deg: '' }, /missing coordinates/],
    ['non-numeric latitude', { latitude_deg: 'north' }, /missing coordinates/],
    ['latitude beyond the pole', { latitude_deg: '91' }, /out of range/],
    ['longitude beyond the meridian', { longitude_deg: '-181' }, /out of range/],
    ['null island', { latitude_deg: '0', longitude_deg: '0' }, /null island/],
    ['blank name', { name: '' }, /blank name/],
    ['three-letter country', { iso_country: 'NLD' }, /ISO 3166-1/],
    ['blank country', { iso_country: '' }, /ISO 3166-1/],
    ['unknown type', { type: 'spaceport' }, /unknown airport type/],
    ['missing source id', { id: '' }, /missing source id/],
  ])('rejects %s', (_label, overrides, reason) => {
    const { rows, rejected } = normaliseAirports([airportRow(overrides)]);
    expect(rows).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(reason);
  });

  it('rejects a duplicate ident, keeping the first', () => {
    const { rows, rejected } = normaliseAirports([
      airportRow({ id: '1', ident: 'EHAM', name: 'First' }),
      airportRow({ id: '2', ident: 'EHAM', name: 'Second' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('First');
    expect(rejected[0]?.reason).toMatch(/duplicate ident/);
  });

  it('rejects one bad row without losing the good ones around it', () => {
    // The whole reason nothing here throws: one malformed row must not cost
    // 85,000 good ones.
    const { rows, rejected } = normaliseAirports([
      airportRow({ id: '1', ident: 'EHAM' }),
      airportRow({ id: '2', ident: 'BROKEN', latitude_deg: '' }),
      airportRow({ id: '3', ident: 'EGLL' }),
    ]);
    expect(rows.map((r) => r.ident)).toEqual(['EHAM', 'EGLL']);
    expect(rejected).toHaveLength(1);
  });

  it('names the rejected row so it can be found in the source', () => {
    const { rejected } = normaliseAirports([airportRow({ ident: 'KJFK', latitude_deg: '' })]);
    expect(rejected[0]?.key).toBe('KJFK');
  });
});

describe('normaliseAirports — codes are dropped, not whole rows', () => {
  it('keeps the airport but drops a malformed IATA code', () => {
    // An airport with a broken code is still an airport, and still geography.
    const { rows, rejected } = normaliseAirports([airportRow({ iata_code: 'AMST' })]);
    expect(rejected).toEqual([]);
    expect(rows[0]).toMatchObject({ ident: 'EHAM', iataCode: null });
  });

  it('keeps the airport but drops a malformed ICAO code', () => {
    const { rows } = normaliseAirports([airportRow({ icao_code: 'EH' })]);
    expect(rows[0]).toMatchObject({ ident: 'EHAM', icaoCode: null });
  });

  it('drops a duplicate IATA code from the later row only', () => {
    const { rows } = normaliseAirports([
      airportRow({ id: '1', ident: 'EHAM', iata_code: 'AMS', icao_code: 'EHAM' }),
      airportRow({ id: '2', ident: 'EHRD', iata_code: 'AMS', icao_code: 'EHRD' }),
    ]);
    expect(rows.map((r) => r.iataCode)).toEqual(['AMS', null]);
    // The second airport survives — it just loses the contested code.
    expect(rows).toHaveLength(2);
  });

  it('drops an implausible elevation without dropping the airport', () => {
    const { rows } = normaliseAirports([airportRow({ elevation_ft: '99999' })]);
    expect(rows[0]).toMatchObject({ ident: 'EHAM', elevationFt: null });
  });

  it('reads a blank elevation as unknown rather than as sea level', () => {
    // 14,905 rows are in this case, and sea level is a plausible-looking lie
    // that would feed straight into the takeoff-length check in B.4.
    expect(normaliseAirports([airportRow({ elevation_ft: '' })]).rows[0]?.elevationFt).toBeNull();
  });

  it('does not turn junk into a number', () => {
    // Number('') is 0 and parseInt('12abc') is 12; either would be a lie.
    expect(
      normaliseAirports([airportRow({ elevation_ft: '12ft' })]).rows[0]?.elevationFt,
    ).toBeNull();
  });
});

describe('normaliseSurface', () => {
  it.each([
    ['ASP', 'asphalt'],
    ['ASPH', 'asphalt'],
    ['Asphalt', 'asphalt'],
    ['ASPH-G', 'asphalt'],
    ['BIT', 'asphalt'],
    ['CON', 'concrete'],
    ['CONC', 'concrete'],
    ['Concrete', 'concrete'],
    ['GRS', 'grass'],
    ['GRE', 'grass'],
    ['TURF', 'grass'],
    ['Turf', 'grass'],
    ['TURF-G', 'grass'],
    ['Grass', 'grass'],
    ['GVL', 'gravel'],
    ['GRVL', 'gravel'],
    ['Gravel', 'gravel'],
    ['CORAL', 'gravel'],
    ['WATER', 'water'],
    ['Earth', 'other'],
    ['', 'other'],
    ['SNOW', 'other'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normaliseSurface(raw)).toBe(expected);
  });

  it('resolves a composite surface to the harder one', () => {
    // Conservative direction for a runway-suitability check: claiming asphalt
    // where there is also concrete is safe; the reverse is not.
    expect(normaliseSurface('ASP-CONC')).toBe('concrete');
  });

  it('never throws on an unrecognised value', () => {
    expect(normaliseSurface('¯\\_(ツ)_/¯')).toBe('other');
  });
});

describe('normaliseRunways', () => {
  const known = new Set(['EHAM']);
  const GOOD_RUNWAY: CsvRow = {
    id: '9000',
    airport_ident: 'EHAM',
    length_ft: '12467',
    width_ft: '197',
    surface: 'ASP',
    lighted: '1',
    closed: '0',
    le_ident: '18R',
    he_ident: '36L',
  };

  function runwayRow(overrides: Record<string, string>): CsvRow {
    return { ...GOOD_RUNWAY, ...overrides };
  }

  it('carries a good runway through intact', () => {
    const { rows, rejected } = normaliseRunways([GOOD_RUNWAY], known);
    expect(rejected).toEqual([]);
    expect(rows[0]).toEqual({
      sourceId: 9000,
      airportIdent: 'EHAM',
      identifier: '18R/36L',
      lengthFt: 12467,
      widthFt: 197,
      surfaceRaw: 'ASP',
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
  });

  it('keeps the raw surface text alongside the normalised value', () => {
    // 664 distinct spellings upstream means the mapping is certainly incomplete;
    // keeping the original lets a better mapping be applied without re-importing.
    const { rows } = normaliseRunways([runwayRow({ surface: 'PEM-ASPH' })], known);
    expect(rows[0]?.surfaceRaw).toBe('PEM-ASPH');
  });

  it('reads a missing length as unknown, not as zero', () => {
    expect(normaliseRunways([runwayRow({ length_ft: '' })], known).rows[0]?.lengthFt).toBeNull();
  });

  it('reads a zero or negative length as unknown', () => {
    // 6 such rows exist. A length of 0 would read as a real, unusably short
    // runway rather than as missing information.
    expect(normaliseRunways([runwayRow({ length_ft: '0' })], known).rows[0]?.lengthFt).toBeNull();
    expect(normaliseRunways([runwayRow({ length_ft: '-1' })], known).rows[0]?.lengthFt).toBeNull();
  });

  it('joins both runway ends into one identifier', () => {
    expect(
      normaliseRunways([runwayRow({ le_ident: '09', he_ident: '27' })], known).rows[0]?.identifier,
    ).toBe('09/27');
  });

  it('accepts a runway with only one end named', () => {
    expect(normaliseRunways([runwayRow({ he_ident: '' })], known).rows[0]?.identifier).toBe('18R');
  });

  it('rejects a runway with no end named at all', () => {
    const { rows, rejected } = normaliseRunways([runwayRow({ le_ident: '', he_ident: '' })], known);
    expect(rows).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/no runway end identifier/);
  });

  it('rejects a runway whose airport was not imported', () => {
    // The foreign key would refuse it anyway; rejecting here makes it countable.
    const { rows, rejected } = normaliseRunways([runwayRow({ airport_ident: 'ZZZZ' })], known);
    expect(rows).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/not in the imported set/);
  });

  it('keeps closed runways, flagged', () => {
    // A closed runway is still geography — it just cannot be planned onto.
    const { rows } = normaliseRunways([runwayRow({ closed: '1' })], known);
    expect(rows[0]?.closed).toBe(true);
  });

  it('rejects a duplicate source id', () => {
    const { rows, rejected } = normaliseRunways(
      [GOOD_RUNWAY, runwayRow({ le_ident: '06' })],
      known,
    );
    expect(rows).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/duplicate source id/);
  });
});
