import type { ReactNode } from 'react';

/**
 * A crew table's own horizontal scroll (UX pass, UX-09).
 *
 * The Crew page's tables are five and six columns wide. At 390px they ran off
 * the right edge of their panel and were clipped there — the coverage table lost
 * its Balance column and the end of its caption, with no way to scroll to them.
 * A table now scrolls inside its own box instead, the way the dashboards'
 * `.table-scroll` does; the box is a labelled, focusable region so a keyboard can
 * scroll it as well as a finger.
 */
export function TableScroll({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="crew__table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
