import type { ReactNode } from 'react';

/**
 * Whether the crew can fly the fleet, as a ring and a sentence.
 *
 * ## The sentence is the answer; the ring is the glance
 *
 * A dial alone is decoration — it says "some proportion of something" and leaves
 * the reader to work out which. So the verdict is written underneath in words,
 * and the ring exists to make it findable from across the page.
 *
 * ## Why it is an SVG and not a chart library
 *
 * One ring, two arcs, no axes, no interaction. A charting dependency for this
 * would be more bytes than the whole Crew page and would still need styling
 * against the theme tokens. `stroke-dasharray` on two circles is the entire
 * implementation.
 *
 * Not `aria-hidden`: the figure carries the number, so it gets a `role="img"`
 * and a label that says the same thing the ring shows. The colour is never the
 * only signal — App. H.7 asks for that, and a red ring on its own would fail it.
 */

export interface CrewReadinessProps {
  available: number;
  inTraining: number;
  /** The floor: one departure per aeroplane owned. */
  required: number;
  /**
   * How much of `required` can actually be fielded, rank by rank.
   *
   * Not `available` against `required`: crew are not fungible, so a surplus of
   * A320neo cabin crew must not fill in for a shortage of 737 MAX captains. The
   * first version divided the totals and showed *100% covered* immediately above
   * the words "not enough crew to launch your whole fleet".
   */
  met: number;
  covered: boolean;
}

const CIRCUMFERENCE = 2 * Math.PI * 52;

export function CrewReadiness({
  available,
  inTraining,
  required,
  met,
  covered,
}: CrewReadinessProps): ReactNode {
  /*
   * Cover, not headcount. With nothing required the airline is trivially covered
   * and the ring is full — an empty airline is not 0% ready, it has nothing to
   * be ready for, and showing zero would read as an alarm.
   */
  const ratio = required === 0 ? 1 : Math.min(1, met / required);
  const percent = Math.round(ratio * 100);
  const label = required === 0 ? 'Nothing to cover yet' : `${String(percent)}% covered`;

  return (
    <div className="crew-readiness">
      <svg
        className="crew-readiness__ring"
        viewBox="0 0 120 120"
        role="img"
        aria-label={`Crew cover: ${label}`}
      >
        <circle className="crew-readiness__track" cx="60" cy="60" r="52" />
        <circle
          className="crew-readiness__arc"
          data-cover={covered ? 'ok' : 'short'}
          cx="60"
          cy="60"
          r="52"
          strokeDasharray={`${String(CIRCUMFERENCE * ratio)} ${String(CIRCUMFERENCE)}`}
        />
        <text className="crew-readiness__figure" x="60" y="58">
          {required === 0 ? '—' : `${String(percent)}%`}
        </text>
        <text className="crew-readiness__caption" x="60" y="76">
          covered
        </text>
      </svg>

      <dl className="crew-readiness__legend">
        <div>
          <dt>Available</dt>
          <dd className="figure">{available}</dd>
        </div>
        <div>
          <dt>In training</dt>
          <dd className="figure">{inTraining}</dd>
        </div>
        <div>
          <dt>Required</dt>
          <dd className="figure">{required}</dd>
        </div>
      </dl>

      {/* The verdict in words. Colour is never the only signal (App. H.7). */}
      <p className="crew-readiness__verdict" data-cover={covered ? 'ok' : 'short'}>
        {required === 0
          ? 'No aircraft to crew yet.'
          : covered
            ? 'Your crew can cover one departure on every aeroplane you own.'
            : 'Not enough crew to launch your whole fleet. See the shortages above.'}
      </p>
    </div>
  );
}
