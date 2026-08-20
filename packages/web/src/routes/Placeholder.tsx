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
      <p className="page__note">{note}</p>
    </section>
  );
}

export const WorldPage = (): ReactNode => (
  <Placeholder
    title="World"
    note="The live map — flat and globe projections over one renderer, aircraft on great-circle paths. M7-01."
  />
);

export const FleetPage = (): ReactNode => (
  <Placeholder
    title="Fleet"
    note="Aircraft list and airframe detail: hours, cycles, config, maintenance state. M4-07."
  />
);

// NetworkPage is no longer a placeholder — M3-09 filled it. Schedules and the
// seven reachability checks are still M2-01's, and land on the same page.

export const FinancePage = (): ReactNode => (
  <Placeholder
    title="Finance"
    note="P&L, unit economics, and profit by route with a breakeven line — the chart players learn the game through. M8-11."
  />
);

export const CrewPage = (): ReactNode => (
  <Placeholder
    title="Crew"
    note="Bases, pools, ranks and type ratings, plus duty and fatigue exposure. M5-01, M5-02."
  />
);

export const DesignPage = (): ReactNode => (
  <Placeholder
    title="Design"
    note="The livery and cabin builders — the signature surfaces. M6-03 through M6-08."
  />
);

export const BoardPage = (): ReactNode => (
  <Placeholder
    title="Board"
    note="Public airline profiles, leaderboards and the community livery board. M12-02."
  />
);
