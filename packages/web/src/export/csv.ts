/**
 * CSV export (M8-14, §14.6).
 *
 * > **CSV export on everything.** Some players will build their own
 * > spreadsheets, and that's a compliment, not a threat.
 *
 * ## Why this is client-side, and not an endpoint
 *
 * M8-14's second acceptance criterion is that *"exported figures match the
 * on-screen values exactly"*, and that rules the server out rather than merely
 * making the client convenient.
 *
 * Every money value in the game is **USD integer minor units**, converted to the
 * player's chosen currency at the client's render boundary (M8-02,
 * `currency/display.ts`). The server has no idea which currency a given player is
 * looking at, or at which cached FX rate — so a server-rendered CSV would emit
 * USD while the screen showed EUR. It would fail the criterion by construction,
 * and no care on the server side could fix it.
 *
 * Building the file from the same rows the table already rendered makes the two
 * agree because they are the same numbers, not because two code paths were kept
 * in step by discipline.
 *
 * ## What a cell contains
 *
 * Numbers export as **plain numbers in the display currency**, with the currency
 * named in the header — `Revenue (EUR)` / `1234.56`, where the screen shows
 * `€1,234.56`. Exporting the formatted string instead would match the screen
 * glyph for glyph and be useless for the one purpose §14.6 gives this feature: a
 * spreadsheet cannot sum `€1,234.56`. Same figure, same rounding, without the
 * decoration.
 */

import { convertUsdMinor, currencyMeta, RATE_SCALE } from '@tailfin/shared';

import { activeCurrency, displayRateE6 } from '../currency/display';

/** One cell. `null` is an empty cell — not `0`, which would be a claim. */
export type CsvCell = string | number | null;

export interface CsvTable {
  /** Column headers, in order. Name the unit or currency here, not in every cell. */
  headers: readonly string[];
  rows: readonly (readonly CsvCell[])[];
}

/**
 * Cells a spreadsheet would execute rather than display.
 *
 * A leading `=`, `+`, `-`, `@`, tab or carriage return makes Excel, LibreOffice
 * and Sheets treat the cell as a formula. That matters here because **not every
 * string in an export is ours**: airline names, callsigns and route labels are
 * written by players, and a competitor named `=HYPERLINK("http://…","clickme")`
 * would land in a rival's downloaded file as a live formula.
 *
 * The mitigation is OWASP's: prefix the value with a single quote, which every
 * major spreadsheet reads as "this is text". The quote is not part of the value
 * and is not shown once the file is opened.
 */
const RISKY_LEADING = /^[=+\-@\t\r]/;

/** RFC 4180: quote when the value contains a comma, quote, or line break. */
function escapeCell(value: CsvCell): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    // A non-finite number has no CSV representation; an empty cell is the honest
    // one, and `NaN` in a spreadsheet column poisons every formula over it.
    return Number.isFinite(value) ? String(value) : '';
  }
  const guarded = RISKY_LEADING.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * Render a table as CSV text.
 *
 * CRLF line endings, per RFC 4180 — Excel on Windows is the single most likely
 * destination for this file and it is the one that cares.
 */
export function toCsv(table: CsvTable): string {
  const lines = [table.headers.map(escapeCell), ...table.rows.map((row) => row.map(escapeCell))];
  return lines.map((cells) => cells.join(',')).join('\r\n');
}

/**
 * A USD minor amount as a plain number in the display currency.
 *
 * Rounded to the currency's own decimal count, which is what the screen shows —
 * ¥ to zero decimals, $ to two. Exporting more precision than the player can see
 * would be a different number from the one they are reading.
 */
export function csvMoney(usdMinor: number | null): number | null {
  if (usdMinor === null) return null;
  const code = activeCurrency();
  const decimals = currencyMeta(code)?.decimals ?? 2;
  const major = convertUsdMinor(usdMinor, displayRateE6() ?? RATE_SCALE) / 100;
  return Number(major.toFixed(decimals));
}

/** The header suffix that says which currency a money column is in. */
export function csvMoneyHeader(label: string): string {
  return `${label} (${activeCurrency()})`;
}

/**
 * Hand the file to the browser.
 *
 * A Blob and an object URL rather than a `data:` URI: a data URI is capped
 * around 2 MB in some browsers and a full P&L export can exceed it, and the
 * object URL keeps the whole payload out of the address bar. Revoked on the next
 * frame — revoking synchronously races the download in WebKit.
 */
export function downloadCsv(filename: string, csv: string): void {
  // The BOM is what makes Excel read the file as UTF-8. Without it an airline
  // called "Vueling España" opens as "EspaÃ±a", which looks like our bug.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * `tailfin-<view>-<date>.csv`.
 *
 * Dated so a player exporting the same dashboard twice in a week gets two files
 * rather than `report (3).csv`. The date is the world's, not the wall clock's:
 * the figures are a statement about the game's calendar, and a file named for
 * today would be mislabelled the moment anybody looked at it a game month later.
 */
export function csvFilename(view: string, gameNow: string): string {
  const day = gameNow.slice(0, 10);
  return `tailfin-${view}-${day}.csv`;
}
