import type { CrewResponse } from '@tailfin/shared';

import { coverageSummary, headcountSummary } from './crew-presentation';

import type { ReactNode } from 'react';

/**
 * The six figures the page opens with.
 *
 * ## Status, then problem
 *
 * Coverage first because it is the only one that is a verdict; shortages next
 * because it is the only one that is a **call to act**, and it is the card
 * allowed to shout. The rest are inventory and stay quiet — an airline with
 * eight crew and no shortage does not need "8" emphasised.
 *
 * ## The wording is load-bearing
 *
 * Not *"all flights covered today"*. The requirement is one departure per
 * aeroplane owned — a floor — and the game cannot yet say anything about a day's
 * flights, because rostering does not exist. Every label here is written so that
 * it stays true when duty-aware rostering arrives and says something stronger.
 *
 * ## No card shows a number it does not have
 *
 * A new airline requires nothing, and "0% covered" would be a lie about an
 * airline that has nothing to cover. `coverageSummary` returns `null` for that
 * case and this shows a dash and says why.
 */

/**
 * One glyph per card, and it names the **metric** rather than the state.
 *
 * A character, not an icon font — the same choice `NAV_ITEMS` and the admin
 * console's `TONE_GLYPH` make, for the same reasons: no external request, it
 * scales with the text, and it inherits colour without a fill attribute.
 *
 * Static per card on purpose. A glyph that changed with the numbers would be a
 * second signal encoding the same state as the tone and the sentence, and the
 * first thing a reader would have to learn is which of the three to trust. It
 * would also quietly become colour's accomplice rather than its replacement —
 * App. H.7 wants the *words* to carry meaning without hue, and they do.
 *
 * All `aria-hidden`: the label beside each one already says what the card is, so
 * a screen reader that also announced "three-quarter circle" would be worse off.
 */
const KPI_GLYPH = {
  coverage: '◕',
  shortages: '△',
  available: '✔',
  training: '◷',
  bases: '⌂',
  cost: '↻',
} as const;

interface KpiProps {
  label: string;
  value: string;
  detail: string;
  glyph: string;
  /** `alert` is the loud one. Only shortages may use it, and only when > 0. */
  tone?: 'neutral' | 'good' | 'alert';
  /** Rendered smaller — for money, which is long and not a headline figure. */
  compact?: boolean;
}

function Kpi({
  label,
  value,
  detail,
  glyph,
  tone = 'neutral',
  compact = false,
}: KpiProps): ReactNode {
  return (
    <div className="crew-kpi" data-tone={tone}>
      <span className="crew-kpi__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="crew-kpi__label">{label}</span>
      <span
        className={
          compact ? 'crew-kpi__value crew-kpi__value--compact figure' : 'crew-kpi__value figure'
        }
      >
        {value}
      </span>
      <span className="crew-kpi__detail">{detail}</span>
    </div>
  );
}

export function CrewKpiStrip({ crew }: { crew: CrewResponse }): ReactNode {
  const coverage = coverageSummary(crew);
  const heads = headcountSummary(crew);

  return (
    <div className="crew-kpis" role="group" aria-label="Crew summary">
      <Kpi
        label="Crew coverage"
        glyph={KPI_GLYPH.coverage}
        value={coverage.percent === null ? '—' : `${String(coverage.percent)}%`}
        detail={
          coverage.percent === null
            ? 'Nothing to cover yet'
            : coverage.covered
              ? 'Minimum requirement covered'
              : 'Below minimum requirement'
        }
        tone={coverage.percent === null ? 'neutral' : coverage.covered ? 'good' : 'alert'}
      />

      <Kpi
        label="Shortages"
        glyph={KPI_GLYPH.shortages}
        value={String(coverage.shortages)}
        detail={
          coverage.shortages === 0
            ? 'No gaps in minimum staffing'
            : coverage.shortages === 1
              ? '1 rank below its minimum'
              : `${String(coverage.shortages)} ranks below minimum`
        }
        // The one card that is allowed to shout, and only when there is
        // something to shout about.
        tone={coverage.shortages > 0 ? 'alert' : 'neutral'}
      />

      <Kpi
        label="Available"
        glyph={KPI_GLYPH.available}
        value={String(heads.available)}
        detail={
          heads.onStrength === 0 ? 'Nobody hired yet' : `of ${String(heads.onStrength)} on strength`
        }
      />

      <Kpi
        label="In training"
        glyph={KPI_GLYPH.training}
        value={String(heads.inTraining)}
        detail={heads.inTraining === 0 ? 'No conversions running' : 'Back when their course ends'}
      />

      <Kpi
        label="Crew bases"
        glyph={KPI_GLYPH.bases}
        value={String(heads.openBases)}
        detail={heads.openBases === 0 ? 'Open one to hire' : 'Where crew are hired and held'}
      />

      <Kpi
        label="Monthly crew cost"
        glyph={KPI_GLYPH.cost}
        value={formatCash(crew.costs.monthlyPayrollMinor)}
        detail="Salaries and base overhead"
        compact
      />
    </div>
  );
}

/**
 * Integer minor units, and **no currency symbol**.
 *
 * The currency is deliberately unnamed until M8-02 and every other surface shows
 * cash bare. A `$` here would be inventing the answer to an open question.
 */
function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
