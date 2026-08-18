import { describe, expect, it } from 'vitest';

import { parseCsv, splitCsvRows } from './csv';

/**
 * The parser reads 12 MB of third-party data on every import, so it is tested
 * against the awkward cases rather than the happy path — a parser that is
 * subtly wrong about quoting silently shifts every field in a row, and the
 * result looks like an airport with a runway for a name.
 */

describe('splitCsvRows', () => {
  it('splits plain fields', () => {
    expect(splitCsvRows('a,b,c')).toEqual([['a', 'b', 'c']]);
  });

  it('keeps empty fields rather than dropping them', () => {
    expect(splitCsvRows('a,,c')).toEqual([['a', '', 'c']]);
    expect(splitCsvRows(',,')).toEqual([['', '', '']]);
  });

  it('handles a comma inside quotes', () => {
    expect(splitCsvRows('"Lawrence, Kansas",X')).toEqual([['Lawrence, Kansas', 'X']]);
  });

  it('handles a doubled quote as an escaped quote', () => {
    expect(splitCsvRows('"He said ""hi""",X')).toEqual([['He said "hi"', 'X']]);
  });

  it('handles a newline inside quotes', () => {
    expect(splitCsvRows('"two\nlines",X')).toEqual([['two\nlines', 'X']]);
  });

  it('handles CRLF line endings', () => {
    expect(splitCsvRows('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not invent a trailing row after a final newline', () => {
    expect(splitCsvRows('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a final row with no trailing newline', () => {
    expect(splitCsvRows('a,b\nc,d')).toHaveLength(2);
  });

  it('keeps a trailing empty field at end of line', () => {
    expect(splitCsvRows('a,b,\nc,d,')).toEqual([
      ['a', 'b', ''],
      ['c', 'd', ''],
    ]);
  });

  it('treats an empty quoted field as empty, not missing', () => {
    expect(splitCsvRows('"",b')).toEqual([['', 'b']]);
  });

  it('returns nothing for empty input', () => {
    expect(splitCsvRows('')).toEqual([]);
  });
});

describe('parseCsv', () => {
  it('keys fields by the header', () => {
    expect(parseCsv('id,name\n1,Schiphol')).toEqual([{ id: '1', name: 'Schiphol' }]);
  });

  it('handles the quoted header OurAirports actually ships', () => {
    const text = '"id","ident","name"\n1,"EHAM","Amsterdam Airport Schiphol"';
    expect(parseCsv(text)).toEqual([
      { id: '1', ident: 'EHAM', name: 'Amsterdam Airport Schiphol' },
    ]);
  });

  it('fills short rows with empty strings so absent and blank read alike', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('throws on a row with more fields than the header', () => {
    // Not tolerated: it means the file is not the shape we think it is, and
    // dropping the extras would hide a schema change upstream.
    expect(() => parseCsv('a,b\n1,2,3')).toThrow(/3 fields, header has 2/);
  });

  it('names the offending line so it can be found in a 86,000-row file', () => {
    expect(() => parseCsv('a,b\n1,2\n3,4\n5,6,7')).toThrow(/row 4/);
  });

  it('throws on input with no header', () => {
    expect(() => parseCsv('')).toThrow(/no header row/);
  });

  it('round-trips a realistic airports row', () => {
    const header =
      '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code"';
    const row =
      '2513,"EHAM","large_airport","Amsterdam Airport Schiphol",52.3086,4.76389,-11,"EU","NL","NL-NH","Amsterdam","yes","EHAM","AMS"';
    const [parsed] = parseCsv(`${header}\n${row}`);

    expect(parsed).toMatchObject({
      ident: 'EHAM',
      name: 'Amsterdam Airport Schiphol',
      elevation_ft: '-11',
      iata_code: 'AMS',
      scheduled_service: 'yes',
    });
  });
});
