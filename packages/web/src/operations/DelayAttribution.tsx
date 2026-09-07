import type { DelayCause, PunctualitySummary } from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * Delay minutes, attributed by M2-08's cause taxonomy (M8-12's first criterion).
 *
 * The chart reuses M8-11's `profit-chart` row-and-bar markup rather than
 * inventing a second bar, which is §14.6's *"consistent chart language"* being a
 * shared stylesheet rather than a shared intention. The one difference is that
 * every bar here grows one way — delay has no breakeven line to sit either side
 * of — so the track's centre rule is not used.
 *
 * ## `unattributed` is a row, not a rounding error
 *
 * A flight can arrive late with no disruption cause recorded against it: a slow
 * turn, a long taxi, weather en route that never became a disruption. Those
 * minutes are real, so they get a row.
 *
 * Dropping them would show a player *less* delay than they actually suffered,
 * and the sum of the causes would silently disagree with the total above it —
 * the one thing an attribution must never do. The row is labelled as not being
 * one of M2-08's causes so it cannot be mistaken for one.
 */

/** M2-08's causes in words. The taxonomy is the server's; these are the labels. */
const CAUSE_LABEL: Record<DelayCause, string> = {
  weather_origin: 'Weather at origin',
  weather_destination: 'Weather at destination',
  atc_flow: 'ATC flow',
  technical: 'Technical',
  crew_timeout: 'Crew out of hours',
  ground_vendor: 'Ground handler',
  airport_closure: 'Airport closed',
  unattributed: 'Not attributed',
};

export function DelayAttribution({ punctuality }: { punctuality: PunctualitySummary }): ReactNode {
  const rows = punctuality.byCause;
  if (rows.length === 0) {
    return (
      <StateBlock kind="empty">
        No delay to attribute. Every settled flight arrived on time or early.
      </StateBlock>
    );
  }

  const worst = rows.reduce((most, row) => Math.max(most, row.minutes), 0);
  // The attributed total must equal the headline. If it ever does not, the bug
  // is worth showing rather than hiding, so the figure is rendered either way.
  const attributed = rows.reduce((total, row) => total + row.minutes, 0);

  return (
    <div className="profit-chart">
      <p className="profit-chart__summary">
        {punctuality.totalDelayMinutes} delay minutes, attributed by cause.
        {attributed !== punctuality.totalDelayMinutes &&
          ` ${String(punctuality.totalDelayMinutes - attributed)} unaccounted for.`}
      </p>

      <ul className="profit-chart__rows" aria-label="Delay minutes by cause">
        {rows.map((row) => (
          <li key={row.cause} className="profit-chart__row">
            {/*
              A `div` rather than the profit chart's `button`: there is nothing
              to drill into behind a delay cause yet, and a control that does
              nothing is worse than a row that is plainly a row.
            */}
            <div className="profit-chart__button">
              <span className="profit-chart__label">{CAUSE_LABEL[row.cause]}</span>
              <span className="profit-chart__track">
                <span
                  className="profit-chart__bar"
                  style={{ width: `${worst === 0 ? 0 : ((row.minutes / worst) * 50).toFixed(3)}%` }}
                />
              </span>
              <span className="profit-chart__value figure">
                {row.minutes} min · {row.flights} {row.flights === 1 ? 'flight' : 'flights'}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {rows.some((row) => row.cause === 'unattributed') && (
        <p className="panel__note">
          &ldquo;Not attributed&rdquo; is not one of M2-08&rsquo;s causes — it is delay with no
          recorded disruption behind it. It is listed so the causes still add up to the total.
        </p>
      )}
    </div>
  );
}
