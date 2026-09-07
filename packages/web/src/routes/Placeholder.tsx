import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * Page placeholders.
 *
 * M0-09 puts the shell in place; actual page content is explicitly out of scope.
 * Each one names the milestone that fills it, so the shell doubles as a map of
 * what is still to come rather than a set of identical "coming soon" panes.
 */

export function Placeholder({ title, note }: { title: string; note: string }): ReactNode {
  return (
    <section className="page">
      <h1 className="page__title">{title}</h1>
      <StateBlock kind="empty">{note}</StateBlock>
    </section>
  );
}

// WorldPage is no longer a placeholder and no longer lives here — it is the
// world renderer at full size, in `world/WorldPage.tsx`.

// FleetPage is no longer a placeholder — M4-02 filled it with the era-gated
// aircraft catalogue and M4-07 added the airframe list above it, with the
// aircraft detail and its effective-spec decomposition.

// NetworkPage is no longer a placeholder — M3-09 filled it. Schedules and the
// seven reachability checks are still M2-01's, and land on the same page.

// FinancePage is no longer a placeholder — M8-10 filled it with §14.3's
// Financial dashboard: the P&L and its four dimensional rollups, the unit
// economics, and the debt with its DSCR and interest drain. §14.4's ranked
// profit-by-route chart with the breakeven line is still M8-11's.

export const CrewPage = (): ReactNode => (
  <Placeholder
    title="Crew"
    note="Bases, pools, ranks and type ratings, plus duty and fatigue exposure. M5-01, M5-02."
  />
);

export const BoardPage = (): ReactNode => (
  <Placeholder
    title="Board"
    note="Public airline profiles, leaderboards and the community livery board. M12-02."
  />
);
