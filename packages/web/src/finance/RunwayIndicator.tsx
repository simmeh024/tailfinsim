import type { CashRunwayResponse } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

import type { ReactNode } from 'react';

/**
 * §13.6's cash runway, in the status strip (M8-08).
 *
 * > The dashboard shows a **cash runway in in-game days** at all times, and it
 * > is the single most prominent number when it drops below 30.
 *
 * Two sentences, two requirements, and the second is the harder one. *"The
 * single most prominent number"* cannot be met by colouring one of six
 * identical small figures red, so below the threshold this stops being a strip
 * item: it takes an alert ground, jumps to the strip's display size, and the
 * shell moves it to the front of the row. Above the threshold it is deliberately
 * quiet — a permanent warning is a warning nobody reads.
 *
 * The threshold is the **server's** (`critical`), never recomputed here. A page
 * that decided for itself when an airline was in trouble would eventually
 * disagree with the alert that told it.
 *
 * Colour never carries it alone (H.4, H.7): the critical state adds a glyph and
 * the word "left", and announces itself politely so a screen reader hears the
 * crossing rather than having to go looking for it.
 */

/** How the runway reads when the projection ran out of horizon, or never ran. */
function label(runway: CashRunwayResponse | null): string {
  if (runway === null) return '—';
  if (runway.days === null) return `${String(runway.horizonDays)}+ days`;
  if (runway.days === 1) return '1 day';
  return `${String(runway.days)} days`;
}

/**
 * What the runway is made of, as a tooltip.
 *
 * §14.1 forbids a figure a player cannot interrogate, and a strip has no room
 * for a drill-down. The title is the smallest honest version of one: the burn,
 * what is committed, and the bill that ends it.
 */
function explain(runway: CashRunwayResponse): string {
  const rate = runway.dailyOperatingMinor;
  const direction = rate < 0 ? 'burning' : 'earning';
  const parts = [
    `${direction} ${formatUsdMinor(Math.abs(rate))} a game day over the last ${String(runway.rateWindowDays)}`,
  ];
  if (runway.committedMinor > 0) {
    parts.push(`${formatUsdMinor(runway.committedMinor)} already committed`);
  }
  if (runway.owedNowMinor > 0) {
    parts.push(`${formatUsdMinor(runway.owedNowMinor)} owed now`);
  }
  if (runway.tippedBy !== null) {
    parts.push(`ends on ${runway.tippedBy.label.toLowerCase()}`);
  }
  return parts.join(' · ');
}

export function RunwayIndicator({ runway }: { runway: CashRunwayResponse | null }): ReactNode {
  const critical = runway?.critical === true;
  return (
    <div
      className={critical ? 'strip__item strip__item--critical' : 'strip__item'}
      // Polite rather than assertive: crossing thirty days is urgent for the
      // airline and not urgent enough to interrupt whatever is being read.
      role={critical ? 'status' : undefined}
      aria-live={critical ? 'polite' : undefined}
      title={runway === null ? undefined : explain(runway)}
    >
      <span className="strip__label">Runway</span>
      <span
        className={
          critical ? 'strip__value figure status status--cancelled' : 'strip__value figure'
        }
      >
        {label(runway)}
        {critical ? ' left' : ''}
      </span>
    </div>
  );
}
