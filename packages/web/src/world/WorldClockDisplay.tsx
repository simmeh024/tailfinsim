import type { ReactNode } from 'react';

/**
 * The world's own date and time, over the map (App. H.4).
 *
 * ## Why UTC, and why it says so
 *
 * The world has one clock, and it is not the reader's. Formatting in the
 * browser's timezone would put two players in different places on different
 * in-game dates while looking at the same world — and the terminator drawn under
 * this is computed in UTC, so a local-time label would sit above a day/night
 * boundary that disagreed with it. The suffix is there because a bare time is
 * read as local by default.
 *
 * ## Why the speed is shown next to it
 *
 * Without it the clock looks broken. A world at 2× advances a minute every thirty
 * seconds, which is fast enough to notice and unexplained otherwise; and the
 * number is the reason the date is years away from today's.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export interface WorldClockDisplayProps {
  /** `null` until the first sync, and for a player who has not founded yet. */
  inGameTime: Date | null;
  speedMultiplier: number | null;
}

/** `2` renders as `2×`, `1.5` as `1.5×`; a trailing `.0` would read as precision. */
function formatSpeed(multiplier: number): string {
  return `${String(Number(multiplier.toFixed(2)))}×`;
}

export function WorldClockDisplay({
  inGameTime,
  speedMultiplier,
}: WorldClockDisplayProps): ReactNode {
  // Nothing to show rather than a placeholder: the World page renders before a
  // player founds an airline, and a greyed-out clock would be a worse answer to
  // "what time is it here?" than no clock at all.
  if (inGameTime === null || speedMultiplier === null) return null;

  return (
    <div className="world-clock" role="status" aria-live="off">
      {/*
       * `aria-live="off"`: this changes every minute and a screen reader
       * announcing it over everything else would be intolerable. It stays a
       * `status` so it can still be found and read deliberately.
       */}
      <span className="world-clock__label">World time</span>
      <time className="world-clock__time figure" dateTime={inGameTime.toISOString()}>
        {TIME_FORMAT.format(inGameTime)}
        <span className="world-clock__zone"> UTC</span>
      </time>
      <span className="world-clock__date figure">{DATE_FORMAT.format(inGameTime)}</span>
      <span className="world-clock__speed figure">{formatSpeed(speedMultiplier)}</span>
    </div>
  );
}
