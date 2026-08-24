import type { CrewResponse } from '@tailfin/shared';

import { commonalitySummary } from './crew-presentation';

import type { ReactNode } from 'react';

/**
 * Where the crew are, by family (§9.2).
 *
 * ## There is no commonality score
 *
 * The percentage is `largest family ÷ all available` and nothing else. It is a
 * description of where the crew are, not a rating of the fleet and not an input
 * to anything.
 *
 * That matters because §9.2's disadvantage is already real and needs no
 * coefficient: crew rated on one family are simply **not in another's pool**, so
 * an airline flying two needs two sets of captains to cover the same departures.
 * The shortfall falls out of the counting. A score on top would charge twice for
 * one effect, and would invite *"how do I avoid the penalty?"* when the honest
 * answer is "fly one family, or accept that you need more people".
 *
 * So this panel exists to make an existing consequence **visible**, which is the
 * whole of §9.2's complaint: a mixed fleet *"quietly wrecks your utilisation"*,
 * and quiet is the part an interface has to fix.
 *
 * ## Bars, not a chart
 *
 * CSS widths over a shared scale, the same technique `SegmentWaterfall` uses —
 * no library, no axis, no tooltip. UX-04 is the issue that will eventually agree
 * a vocabulary for charts; until it does, the least a panel can do is not invent
 * a sixth one. Every bar carries its number as text beside it, so the bar is an
 * aid to comparison and never the only way to read the value.
 */

export function FleetCommonality({ crew }: { crew: CrewResponse }): ReactNode {
  const summary = commonalitySummary(crew);

  return (
    <section className="crew-panel" aria-labelledby="crew-commonality-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-commonality-heading">
          Fleet commonality
        </h2>
        <p className="crew-panel__sub">How far one qualification goes</p>
      </div>

      {summary.totalAvailable === 0 || summary.ratio === null ? (
        <p className="crew__note">
          No available crew yet. Once you hire, this shows how much of your fleet a single
          qualification covers.
        </p>
      ) : (
        <>
          <p className="crew-commonality__figure">
            <span className="figure">{Math.round(summary.ratio * 100)}%</span>
            <span className="crew-commonality__caption">
              {summary.largestFamilyAvailable} of {summary.totalAvailable} available crew can
              operate your largest aircraft family.
            </span>
          </p>

          <ul className="crew-bars">
            {summary.bars.map((bar) => (
              <li className="crew-bars__row" key={bar.family}>
                <span className="crew-bars__label figure">{bar.family}</span>
                <span className="crew-bars__track">
                  {/*
                   * `aria-hidden`: the bar is a second rendering of the number
                   * beside it, and a screen reader reading both would say
                   * everything twice.
                   */}
                  <span
                    className="crew-bars__fill"
                    data-largest={bar.largest}
                    style={{ width: `${String(Math.round(bar.share * 100))}%` }}
                    aria-hidden="true"
                  />
                </span>
                <span className="crew-bars__value figure">{bar.available}</span>
              </li>
            ))}
          </ul>

          <p className="crew-commonality__verdict" data-verdict={summary.verdict}>
            {VERDICT[summary.verdict]}
          </p>

          <p className="crew__hint">
            {summary.strandedHeads === 0
              ? 'One family: every available crew member can fly every aeroplane you own.'
              : `${String(summary.strandedHeads)} available crew cannot fly your largest family. Not a penalty — they fly their own aeroplanes, and no others. Additional families need their own qualified pools.`}
          </p>
        </>
      )}
    </section>
  );
}

const VERDICT: Record<'single' | 'focused' | 'moderate' | 'fragmented' | 'none', string> = {
  single: 'Single family',
  focused: 'Mixed fleet: focused',
  moderate: 'Mixed fleet: moderate',
  fragmented: 'Mixed fleet: fragmented',
  none: 'No crew yet',
};
