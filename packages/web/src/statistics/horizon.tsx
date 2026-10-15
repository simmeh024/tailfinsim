import { createContext, useContext } from 'react';

import type { ReactNode } from 'react';

/**
 * §14.2's trend window, chosen once per page (SURFACE-03, SURFACE-06).
 *
 * > | **Trend** | 7 / 30 / 90 in-game days — direction and rate of change |
 * > | **Forecast** | Next 7 / 30 / 90, with a confidence band widening with distance |
 *
 * A page has **one** period, not one per panel: SURFACE-03's point is that a
 * page where every panel carries its own selector is a page where nothing can
 * be compared with anything. So the choice lives in context, the page owns the
 * control, and everything under it — the P&L, the ranked chart, every metric's
 * drill-down — reads the same window.
 *
 * The three values are §14.2's own and the server's (`TREND_WINDOWS` in
 * `statistics/metrics.ts`): a metric's trends and forecasts are computed over
 * exactly these, and the breakdown refuses any other, so a window outside them
 * would explain a figure no tile can show.
 */
export type Horizon = 7 | 30 | 90;

export const HORIZONS: readonly Horizon[] = [7, 30, 90];

/** One game month — the window every headline `value` already covers. */
export const DEFAULT_HORIZON: Horizon = 30;

const HorizonContext = createContext<Horizon>(DEFAULT_HORIZON);

/** The page's period, for everything under it. */
export function HorizonProvider({
  value,
  children,
}: {
  value: Horizon;
  children: ReactNode;
}): ReactNode {
  return <HorizonContext.Provider value={value}>{children}</HorizonContext.Provider>;
}

/**
 * The period this surface is showing.
 *
 * A component outside any provider — the Executive dashboard has no period
 * control, because §2's check-in glance has no time to set one — reads the
 * headline window, which is what that page's figures already describe.
 */
export function useHorizon(): Horizon {
  return useContext(HorizonContext);
}

/** "the last 30 game days" — said the same way everywhere a window is named. */
export function horizonLabel(days: number): string {
  return `the last ${String(days)} game ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The page-level period control.
 *
 * A group of three pressed-state buttons rather than a `<select>`: three
 * options read at a glance, and the current one is visible without opening
 * anything. Labelled as a group so a screen reader hears what it governs.
 */
export function HorizonControl({
  value,
  onChange,
}: {
  value: Horizon;
  onChange: (next: Horizon) => void;
}): ReactNode {
  return (
    <div className="horizon" role="group" aria-label="Period, in game days">
      <span className="horizon__label" aria-hidden="true">
        Period
      </span>
      {HORIZONS.map((days) => (
        <button
          key={days}
          type="button"
          className="horizon__option"
          aria-pressed={value === days}
          onClick={() => {
            onChange(days);
          }}
        >
          {`${String(days)} days`}
        </button>
      ))}
    </div>
  );
}
