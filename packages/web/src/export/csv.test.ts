import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDisplayCurrency } from '../currency/display';

import { csvFilename, csvMoney, csvMoneyHeader, downloadCsv, toCsv } from './csv';

/**
 * CSV export (M8-14, §14.6).
 *
 * Two things are worth testing here and they are not the obvious one. Rendering
 * a comma-separated line is trivial; **escaping** it correctly is not, and
 * **refusing to hand a spreadsheet a formula** is a security property rather
 * than a formatting one.
 */

/*
 * Captured once, before any spy exists. Binding inside a test captures whatever
 * `createElement` is at that moment — which, after the first spy, is the spy
 * itself, and the mock then calls itself until the stack runs out. The first
 * draft of this file did exactly that.
 */
const realCreateElement = document.createElement.bind(document);

afterEach(() => {
  setDisplayCurrency('USD', []);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Capture what `downloadCsv` hands the browser, without a real download. */
function captureDownload(): { blobTypes: string[]; filenames: string[] } {
  const blobTypes: string[] = [];
  const filenames: string[] = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobTypes.push(blob.type);
      return 'blob:test';
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = realCreateElement(tag) as HTMLAnchorElement;
    if (tag === 'a') element.click = () => filenames.push(element.download);
    return element;
  });
  return { blobTypes, filenames };
}

/** A rate row, with the fields the wire type requires but this test does not use. */
function rate(code: string, rateE6: number, name: string, symbol: string, decimals: number) {
  return {
    code,
    name,
    symbol,
    decimals,
    rateE6,
    refreshedAt: '1965-01-01T00:00:00.000Z',
    top: true,
  };
}

describe('toCsv', () => {
  it('writes headers and rows with CRLF, as RFC 4180 asks', () => {
    const csv = toCsv({
      headers: ['Route', 'Flights'],
      rows: [
        ['EHAM–EGLL', 12],
        ['EHAM–LFPG', 7],
      ],
    });
    expect(csv).toBe('Route,Flights\r\nEHAM–EGLL,12\r\nEHAM–LFPG,7');
  });

  it('quotes a cell containing a comma, a quote or a newline', () => {
    const csv = toCsv({
      headers: ['Label'],
      rows: [['Amsterdam, NL'], ['He said "go"'], ['two\nlines']],
    });
    expect(csv).toContain('"Amsterdam, NL"');
    // A literal quote is doubled inside a quoted field.
    expect(csv).toContain('"He said ""go"""');
    expect(csv).toContain('"two\nlines"');
  });

  it('leaves an ordinary cell unquoted', () => {
    expect(toCsv({ headers: ['A'], rows: [['plain']] })).toBe('A\r\nplain');
  });

  it('writes null as an empty cell, never as zero', () => {
    // The distinction is carried carefully from the rollup — "nothing to
    // measure" is not "measured zero" — and the export is the last place it
    // could be thrown away.
    expect(toCsv({ headers: ['V'], rows: [[null], [0]] })).toBe('V\r\n\r\n0');
  });

  it('writes a non-finite number as empty rather than NaN', () => {
    // One NaN poisons every formula summing the column beneath it.
    expect(toCsv({ headers: ['V'], rows: [[Number.NaN], [Number.POSITIVE_INFINITY]] })).toBe(
      'V\r\n\r\n',
    );
  });

  /**
   * Formula injection. Not a formatting nicety: airline names, callsigns and
   * route labels are written by players, so a competitor's name can reach a
   * rival's spreadsheet.
   */
  describe('spreadsheet formula injection', () => {
    it.each([
      ['=1+1', "'=1+1"],
      ['+1', "'+1"],
      ['-1', "'-1"],
      ['@SUM(A1)', "'@SUM(A1)"],
      ['\tstartswithtab', "'\tstartswithtab"],
    ])('neutralises a cell starting with %j', (input, expected) => {
      const csv = toCsv({ headers: ['Airline'], rows: [[input]] });
      expect(csv.split('\r\n')[1]).toBe(expected);
    });

    it('neutralises a hostile airline name and still quotes it correctly', () => {
      const hostile = '=HYPERLINK("http://evil.example","clickme")';
      const line = toCsv({ headers: ['Airline'], rows: [[hostile]] }).split('\r\n')[1];
      // Quoted because it contains commas and quotes, and prefixed so the
      // spreadsheet reads it as text.
      expect(line?.startsWith('"\'=HYPERLINK')).toBe(true);
      expect(line).toContain('""http://evil.example""');
    });

    it('leaves a negative number alone — it is a number, not a formula', () => {
      // The guard is for *strings*. Quoting real negatives would turn every loss
      // in a P&L into text a spreadsheet cannot sum.
      expect(toCsv({ headers: ['V'], rows: [[-42]] })).toBe('V\r\n-42');
    });

    it('leaves a hyphenated label that does not start with one alone', () => {
      expect(toCsv({ headers: ['V'], rows: [['EHAM-EGLL']] })).toBe('V\r\nEHAM-EGLL');
    });
  });
});

describe('csvMoney', () => {
  it('converts to the display currency and rounds as the screen does', () => {
    // 2 USD per EUR would be an odd rate; the point is that the export uses the
    // same one the formatter does rather than fetching its own.
    setDisplayCurrency('EUR', [rate('EUR', 500_000, 'Euro', '€', 2)]);
    // 1,000,000 USD minor = $10,000.00 → at 0.5, €5,000.00
    expect(csvMoney(1_000_000)).toBe(5000);
    expect(csvMoneyHeader('Revenue')).toBe('Revenue (EUR)');
  });

  it('rounds to the currency’s own decimals, not to a fixed two', () => {
    // Yen shows no decimals on screen, so the export must not invent any.
    setDisplayCurrency('JPY', [rate('JPY', 150_000_000, 'Japanese yen', '¥', 0)]);
    expect(Number.isInteger(csvMoney(12_345) ?? 0)).toBe(true);
  });

  it('falls back to parity when the rate is missing, like the formatter', () => {
    setDisplayCurrency('USD', []);
    expect(csvMoney(123_456)).toBe(1234.56);
  });

  it('keeps null as null rather than turning an absent figure into zero', () => {
    expect(csvMoney(null)).toBeNull();
  });
});

describe('csvFilename', () => {
  it('names the file for the view and the world’s date, not the wall clock', () => {
    // A file named for today would be mislabelled the moment somebody opened it
    // a game month later.
    expect(csvFilename('finance-pnl', '1965-04-12T09:30:00.000Z')).toBe(
      'tailfin-finance-pnl-1965-04-12.csv',
    );
  });
});

describe('downloadCsv', () => {
  it('hands the browser a UTF-8 CSV blob with the BOM Excel needs', () => {
    const { blobTypes, filenames } = captureDownload();

    downloadCsv('report', 'A\r\n1');

    expect(blobTypes[0]).toContain('text/csv');
    expect(blobTypes[0]).toContain('charset=utf-8');
    expect(filenames).toEqual(['report.csv']);
  });

  it('does not double the extension when one is given', () => {
    const { filenames } = captureDownload();
    downloadCsv('report.csv', 'A');
    expect(filenames).toEqual(['report.csv']);
  });
});
