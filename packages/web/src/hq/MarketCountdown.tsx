import { useEffect, useRef, useState } from 'react';

import { formatCountdown, msUntilRefresh, rosterDayIndex } from './csuite-rotation';

import type { ReactNode } from 'react';

/**
 * The market's 24-hour refresh clock (ideas #9, #10).
 *
 * ## Why it is a component at all
 *
 * It used to be a `setInterval` inside {@link HeadquartersPage}, ticking a
 * `now` in the page's own state once a second. That re-rendered the entire
 * page — six seat sections, twenty-four candidate cards and their portraits —
 * every second, for a clock nothing else on the page read. The interval lives
 * here now, so a tick re-renders eight characters.
 *
 * ## The boundary is an event, not a render
 *
 * The page used to derive `rosterDayIndex(now)` from that same ticking value,
 * which meant the shortlist silently changed under the player's cursor the
 * instant the window turned over: four candidates per seat replaced mid-read,
 * possibly mid-click, with nothing said. So the day index is *not* returned on
 * every tick — {@link MarketCountdownProps.onBoundary} fires once, when the
 * window actually turns, and the page decides what to do about it. Today it
 * offers the new shortlist rather than imposing it.
 */

/** How long before the turnover the clock starts warning — five minutes. */
export const REFRESH_WARNING_MS = 5 * 60 * 1000;

export interface MarketCountdownProps {
  /** How many candidates a seat's shortlist holds, for the note under the clock. */
  marketSize: number;
  /**
   * Fired once each time the 24-hour window turns over, with the new day index.
   * Not called on mount — the page already knows which window it opened in.
   */
  onBoundary: (dayIndex: number) => void;
}

export function MarketCountdown({ marketSize, onBoundary }: MarketCountdownProps): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  // `onBoundary` is typically an inline arrow, so depending on it directly would
  // tear the interval down and rebuild it on every parent render. The ref keeps
  // one interval for the life of the component and always calls the latest one.
  const notify = useRef(onBoundary);
  notify.current = onBoundary;
  const day = useRef(rosterDayIndex());

  useEffect(() => {
    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      const today = rosterDayIndex(tick);
      if (today !== day.current) {
        day.current = today;
        notify.current(today);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = msUntilRefresh(now);
  const closing = remaining <= REFRESH_WARNING_MS;

  return (
    <div
      className="csuite-refresh"
      data-closing={closing}
      role="timer"
      aria-label="Time until the market refreshes"
    >
      <span className="csuite-refresh__label">Market refreshes in</span>
      <span className="csuite-refresh__clock">{formatCountdown(remaining)}</span>
      <span className="csuite-refresh__note">
        {closing
          ? 'Today’s shortlists are about to be replaced'
          : `A fresh shortlist of ${String(marketSize)} candidates per seat every 24 hours`}
      </span>
    </div>
  );
}
