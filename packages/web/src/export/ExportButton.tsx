import { csvFilename, downloadCsv, toCsv, type CsvTable } from './csv';

import type { ReactNode } from 'react';

/**
 * "Export CSV" on a panel (M8-14, §14.6).
 *
 * One button per **table**, not one per page. §14.6 asks to export *"the current
 * view's underlying rows"*, and a dashboard is several tables with different
 * shapes — folding a P&L, a route breakdown and a cabin-class split into one
 * file would produce a sheet whose columns mean different things on different
 * rows, which is exactly what somebody building a spreadsheet cannot use.
 *
 * The rows are built by the panel that renders them, from the same values it
 * just displayed. That is what makes M8-14's second criterion true by
 * construction rather than by two code paths agreeing.
 */
export function ExportButton({
  table,
  view,
  gameNow,
  label = 'Export CSV',
}: {
  /**
   * Built lazily. A dashboard may render several of these and only one will ever
   * be pressed; formatting every row of every table on every render to prepare
   * for a click that usually does not come is work nobody asked for.
   */
  table: () => CsvTable;
  /** The `<view>` in `tailfin-<view>-<date>.csv`. */
  view: string;
  /** The world clock the figures are from, so the filename dates the data. */
  gameNow: string;
  label?: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="export-button"
      onClick={() => {
        downloadCsv(csvFilename(view, gameNow), toCsv(table()));
      }}
    >
      <span aria-hidden="true">↓</span> {label}
    </button>
  );
}
