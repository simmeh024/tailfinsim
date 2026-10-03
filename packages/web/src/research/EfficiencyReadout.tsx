import { EFFICIENCY_QUANTITY_LABELS, type EfficiencyQuantityReadout } from '@tailfin/shared';

import {
  ceilingFill,
  formatReduction,
  quantitySummary,
  sourceShares,
} from './efficiency-presentation';

import type { ReactNode } from 'react';

import './efficiency.css';

/**
 * §10.4's six efficiency quantities, against their ceilings (M9-06).
 *
 * > *"Boosts are **operational efficiency**, never demand or money directly.
 * > They make you cheaper and faster, not more popular."*
 *
 * One row per quantity: what the airline's skills, Training Captains and
 * doctrine remove together, drawn against the ceiling the world allows, with
 * each source's share of the bar. The ceilings are the page's whole argument —
 * a year-one player must never face a wall of stacked veteran bonuses — so the
 * row says in words when one has been reached, rather than leaving a full bar to
 * be read as *"keep going"*.
 *
 * Every figure is the server's: the resolver decided it, and this only draws it.
 *
 * `note` is a line under the six rows for what belongs beside them without
 * being one of them — the research page puts the Crew Development doctrine's
 * crew XP bonus there, which is not a §10.4 quantity but shares a cap the same
 * way.
 */
export function EfficiencyReadout({
  quantities,
  note,
}: {
  quantities: readonly EfficiencyQuantityReadout[];
  note?: ReactNode;
}): ReactNode {
  return (
    <section className="efficiency" aria-labelledby="efficiency-heading">
      <header className="efficiency__header">
        <h2 id="efficiency-heading">Operational efficiency</h2>
        <p className="efficiency__lede">
          What your crew skills, Training Captains and doctrine take off each cost, together and
          capped. Efficiency makes you cheaper and faster — never more popular.
        </p>
      </header>
      <ul className="efficiency__list">
        {quantities.map((readout) => (
          <EfficiencyRow key={readout.quantity} readout={readout} />
        ))}
      </ul>
      {note !== undefined && <div className="efficiency__note">{note}</div>}
    </section>
  );
}

function EfficiencyRow({ readout }: { readout: EfficiencyQuantityReadout }): ReactNode {
  const label = EFFICIENCY_QUANTITY_LABELS[readout.quantity];
  const shares = sourceShares(readout).filter((share) => share.applied > 0);
  const fill = ceilingFill(readout);

  return (
    <li className="efficiency__row" data-capped={readout.capped ? 'true' : 'false'}>
      <div className="efficiency__heading">
        <span className="efficiency__label">{label}</span>
        <span className="efficiency__figure">{formatReduction(readout.fraction)}</span>
      </div>
      <div
        className="efficiency__bar"
        role="meter"
        aria-label={`${label} reduction against its ceiling`}
        aria-valuemin={0}
        aria-valuemax={Math.round(readout.ceiling * 1000) / 10}
        aria-valuenow={Math.round(readout.fraction * 1000) / 10}
        aria-valuetext={quantitySummary(readout)}
      >
        <div className="efficiency__fill" style={{ width: `${String(fill * 100)}%` }}>
          {shares.map((share) => (
            <span
              key={share.source}
              className="efficiency__segment"
              data-source={share.source}
              style={{ flexGrow: share.applied }}
            />
          ))}
        </div>
      </div>
      <p className="efficiency__summary">{quantitySummary(readout)}</p>
      {shares.length > 0 ? (
        <ul className="efficiency__sources" aria-label={`${label} by source`}>
          {shares.map((share) => (
            <li key={share.source} data-source={share.source}>
              <span className="efficiency__swatch" data-source={share.source} aria-hidden="true" />
              {share.label} {formatReduction(share.alone)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
