import { useMemo } from 'react';

import type { MetricBreakdownRow } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * §14.4's chart: profit by route, ranked, with a breakeven line (M8-11).
 *
 * > **Profit by route, ranked, with a breakeven line.** It's the chart that
 * > turns a confused player into an airline manager. Loss-making routes sit
 * > below the line in red and the drill-down tells you whether it's yield, cost,
 * > load factor or a competitor.
 *
 * ## Why it is DOM and not a chart library
 *
 * The whole chart is a ranked list of rows with a rule down the middle. In DOM
 * that is a flexbox and a percentage width; every colour is a theme token, every
 * row is real text a screen reader can read, and the "breakeven line" is a
 * border rather than a drawn path. A charting dependency would buy nothing here
 * and would bring its own colour palette, which is exactly what §14.6's *"colour
 * never the sole carrier of meaning"* has to survive.
 *
 * ## Three hundred routes
 *
 * M8-11's second criterion is that it works with five routes and with three
 * hundred. Both fall out of the same layout rather than needing a mode:
 *
 * - **Rows are a fixed height and the list scrolls.** Three hundred rows is 300
 *   divs, which is nothing to render; what does not work is 300 rows of 40px
 *   pushing the page to 12,000px, so the list has its own scroll box.
 * - **Ranking is what makes it readable at scale.** The extremes are at the two
 *   ends, so the routes a player must act on are the first and last thing they
 *   see however many there are — no filter, no paging, no "top 10" that hides
 *   the airline's worst route on page 31.
 *
 * ## Colour is never alone (AC3)
 *
 * A loss-making bar gets three signals: the loss colour, a **hatched fill**, and
 * a `▼` glyph beside a value that is already signed. Any one of them survives
 * greyscale, colour blindness, or a screen reader reading only the text.
 */

export interface RouteProfitChartProps {
  rows: readonly MetricBreakdownRow[];
  /** The route whose diagnosis is open, so the row can show as selected. */
  selectedKey: string | null;
  onSelect: (row: MetricBreakdownRow) => void;
}

/** The widest bar, so every other is a share of it. Zero when nothing flew. */
function widest(rows: readonly MetricBreakdownRow[]): number {
  return rows.reduce((most, row) => Math.max(most, Math.abs(row.value ?? 0)), 0);
}

export function RouteProfitChart({
  rows,
  selectedKey,
  onSelect,
}: RouteProfitChartProps): ReactNode {
  /*
   * Ranked most profitable first, so the breakeven line falls somewhere in the
   * middle and both extremes are at an end. The server already sorts by
   * magnitude — biggest contributor first, whichever direction — which is the
   * wrong order for this chart: it interleaves the best and worst routes.
   */
  const ranked = useMemo(() => [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)), [rows]);
  const scale = useMemo(() => widest(ranked), [ranked]);

  if (ranked.length === 0) {
    return (
      <StateBlock kind="empty">
        No route has settled a flight yet. Only the worker settles a flight, so on a node without
        one this chart stays empty however much is scheduled.
      </StateBlock>
    );
  }

  const losses = ranked.filter((row) => (row.value ?? 0) < 0).length;

  return (
    <div className="profit-chart">
      <p className="profit-chart__summary">
        {ranked.length} {ranked.length === 1 ? 'route' : 'routes'}, ranked.{' '}
        {losses === 0
          ? 'None is below the breakeven line.'
          : `${String(losses)} below the breakeven line.`}
      </p>

      {/*
        The list is the chart. A `ul` rather than a `figure` because every row is
        readable text and a control — a player using a screen reader gets the
        ranking, the figures and the drill-down, not "chart, image".
      */}
      <ul className="profit-chart__rows" aria-label="Profit by route, ranked">
        {ranked.map((row) => {
          const value = row.value ?? 0;
          const loss = value < 0;
          // Half the track each way, so the rule down the middle is breakeven.
          const width = scale === 0 ? 0 : (Math.abs(value) / scale) * 50;
          const selected = row.key === selectedKey;

          return (
            <li key={row.key} className="profit-chart__row">
              <button
                type="button"
                className={
                  selected
                    ? 'profit-chart__button profit-chart__button--selected'
                    : 'profit-chart__button'
                }
                aria-pressed={selected}
                onClick={() => onSelect(row)}
              >
                <span className="profit-chart__label">{row.label}</span>
                <span className="profit-chart__track">
                  <span
                    className={
                      loss ? 'profit-chart__bar profit-chart__bar--loss' : 'profit-chart__bar'
                    }
                    style={{ width: `${width.toFixed(3)}%` }}
                  />
                </span>
                <span
                  className={
                    loss
                      ? 'profit-chart__value figure profit-chart__value--loss'
                      : 'profit-chart__value figure'
                  }
                >
                  {/* Signal two: a glyph. Signal three: the signed figure itself. */}
                  <span aria-hidden="true">{loss ? '▼' : '▲'}</span> {formatUsdMinor(value)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="profit-chart__legend">
        <span className="profit-chart__key">
          <span className="profit-chart__swatch" aria-hidden="true" /> above breakeven
        </span>
        <span className="profit-chart__key">
          <span className="profit-chart__swatch profit-chart__swatch--loss" aria-hidden="true" />{' '}
          below it — hatched, not only red
        </span>
      </p>
    </div>
  );
}
