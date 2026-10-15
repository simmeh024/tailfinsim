import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * The one page still waiting for its milestone (SURFACE-08).
 *
 * M0-09 put the shell in place with a placeholder per page, each naming the
 * milestone that would fill it, so the shell doubled as a map of what was still
 * to come. That map is now one entry long: World (`world/WorldPage.tsx`), Fleet
 * (`fleet/`, M4-02 and M4-07), Network (`network/`, M3-09 and M2-01), Crew
 * (`crew/`, M5-01 onwards) and Finance (`finance/FinancePage.tsx`, M8-10, M8-11
 * and SURFACE-03) are all real pages, and their placeholders are gone rather
 * than left behind as exports naming closed issues.
 *
 * ## Why the generic component survives
 *
 * Only because `BoardPage` below still uses it. It goes when M12-02 lands —
 * SURFACE-08 prefers deleting an unused placeholder to keeping one easy to
 * reach for, because an unused component that is easy to reach for is how the
 * next stale placeholder gets written. The pattern is in git history if a
 * future page genuinely needs one.
 *
 * ## Each note is a claim
 *
 * A placeholder naming the wrong milestone is worse than a generic one, because
 * it is confidently wrong — CLAUDE.md's point about documented commands, applied
 * to the shell. So a note says what will actually be there and who builds it,
 * and is kept true as those issues move.
 */

export function Placeholder({ title, note }: { title: string; note: string }): ReactNode {
  return (
    <section className="page">
      <h1 className="page__title">{title}</h1>
      <StateBlock kind="empty">{note}</StateBlock>
    </section>
  );
}

/**
 * `/board` — §16's public face of the world.
 *
 * M12-02 (#110) owns it: public airline profiles (fleet, network, liveries,
 * career history, named crew), the living leaderboards and the community livery
 * board. HISTORY-08 (#1082) adds all-time boards beside the living ones, through
 * the same engine, with ceased airlines kept and marked as former.
 */
export const BoardPage = (): ReactNode => (
  <Placeholder
    title="Board"
    note="Public airline profiles, the living leaderboards and the community livery board are M12-02; all-time leaderboards that keep ceased airlines are HISTORY-08, on the same boards."
  />
);
