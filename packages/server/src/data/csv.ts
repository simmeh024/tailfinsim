/**
 * A minimal RFC 4180 CSV reader.
 *
 * Written rather than taken from npm because the requirement is small and
 * completely specified, and because this parses a 12 MB file of third-party data
 * on every import — a dependency here is a supply-chain surface for something
 * that fits on one screen and can be tested exhaustively.
 *
 * Handles what the OurAirports files actually contain: quoted fields, commas and
 * newlines inside quotes, doubled quotes as an escape, CRLF, and a trailing
 * newline. It does not handle a byte-order mark or alternative delimiters,
 * because those would be a change in the source worth failing on rather than
 * absorbing silently.
 */

export type CsvRow = Record<string, string>;

/**
 * Splits CSV text into rows of raw fields.
 *
 * Exported separately from `parseCsv` so the header handling can be tested apart
 * from the field splitting.
 */
export function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      sawAnyChar = true;
      continue;
    }

    if (char === '"') {
      quoted = true;
      sawAnyChar = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
      sawAnyChar = true;
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
    } else if (char !== '\r') {
      field += char;
      sawAnyChar = true;
    }
  }

  // A trailing newline leaves nothing pending; anything else is a final row.
  if (sawAnyChar || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Parses CSV text into objects keyed by the header row.
 *
 * Short rows yield empty strings rather than `undefined`, so callers can treat
 * "absent" and "blank" identically — which is what the source means by them.
 * A row with *more* fields than the header is an error: it means the file is not
 * what we think it is, and quietly dropping the extras would hide that.
 */
export function parseCsv(text: string): CsvRow[] {
  const rows = splitCsvRows(text);
  const header = rows.shift();

  if (!header || header.length === 0 || (header.length === 1 && header[0] === '')) {
    throw new Error('CSV has no header row');
  }

  return rows.map((fields, index) => {
    if (fields.length > header.length) {
      throw new Error(
        `CSV row ${String(index + 2)} has ${String(fields.length)} fields, header has ${String(header.length)}`,
      );
    }
    const record: CsvRow = {};
    header.forEach((name, column) => {
      record[name] = fields[column] ?? '';
    });
    return record;
  });
}
