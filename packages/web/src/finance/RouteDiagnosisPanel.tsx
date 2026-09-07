import type { RouteAction, RouteCause, RouteDiagnosisResponse } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * §14.4's drill-down, in words (M8-11).
 *
 * > …the drill-down tells you whether it's yield, cost, load factor or a
 * > competitor — and therefore whether to **reprice**, **re-gauge**,
 * > **re-time**, or **kill it**.
 *
 * One sentence naming the cause, one naming the action, and then the working.
 * The order matters: a panel that opened with three bars and a table would be
 * the generic breakdown M8-11's first criterion rules out, and a player would
 * have to do the diagnosis themselves — which is what they came here to avoid.
 */

/** The sentence for each cause. The server decides which; this only says it. */
const CAUSE_SENTENCE: Record<RouteCause, string> = {
  none: 'This route is above the breakeven line. Nothing here needs fixing.',
  yield: 'You are selling this route too cheaply for what it costs to fly.',
  cost: 'This route costs more per seat offered than the network average, and no load factor fixes that.',
  load_factor: 'The route could pay at a normal load factor. It is flying too empty.',
  competitor: 'A rival holds most of this market, which is why it will not fill.',
};

/** The action for each cause, and what it means concretely. */
const ACTION_SENTENCE: Record<RouteAction, string> = {
  keep: 'Keep it as it is.',
  reprice: 'Reprice it — raise the fare and accept a little spill.',
  're-gauge': 'Re-gauge it — a smaller or cheaper aeroplane on this sector.',
  're-time': 'Re-time it — move the departure to where the demand actually is.',
  cut: 'Cut it — the traffic belongs to somebody else and buying it back costs more than it earns.',
};

const ACTION_LABEL: Record<RouteAction, string> = {
  keep: 'Keep',
  reprice: 'Reprice',
  're-gauge': 'Re-gauge',
  're-time': 'Re-time',
  cut: 'Cut',
};

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** One quantified lever, so a player can argue with the recommendation. */
function GapRow({
  name,
  gap,
  unit,
}: {
  name: string;
  gap: RouteDiagnosisResponse['gaps']['yield'];
  unit: 'money-per-km' | 'ratio';
}): ReactNode {
  const show = (value: number | null): string =>
    value === null ? '—' : unit === 'ratio' ? percent(value) : `${value.toFixed(3)}¢/km`;
  return (
    <tr>
      <th scope="row">{name}</th>
      <td className="data-table__num figure">{show(gap.own)}</td>
      <td className="data-table__num figure">{show(gap.peer)}</td>
      <td className="data-table__num figure">
        {gap.worthMinor === 0 ? '—' : formatUsdMinor(gap.worthMinor)}
      </td>
    </tr>
  );
}

export function RouteDiagnosisPanel({
  diagnosis,
  loading,
}: {
  diagnosis: RouteDiagnosisResponse | null;
  loading: boolean;
}): ReactNode {
  if (loading) {
    return (
      <section className="panel" aria-label="Route diagnosis">
        <h2 className="panel__title">Why</h2>
        <StateBlock kind="loading">Reading the route.</StateBlock>
      </section>
    );
  }

  if (diagnosis === null) {
    return (
      <section className="panel" aria-label="Route diagnosis">
        <h2 className="panel__title">Why</h2>
        <StateBlock kind="empty">
          Pick a route from the chart and this says what is wrong with it — and what to do.
        </StateBlock>
      </section>
    );
  }

  if (diagnosis.flights === 0) {
    return (
      <section className="panel" aria-label="Route diagnosis">
        <h2 className="panel__title">Why: {diagnosis.label}</h2>
        {/*
          No settled flights is not a diagnosis. Naming a cause from an empty
          window would be the invented finding §14.1 warns about.
        */}
        <StateBlock kind="empty">
          Nothing has flown this route in the last {diagnosis.windowDays} game days, so there is
          nothing to diagnose yet.
        </StateBlock>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Route diagnosis">
      <h2 className="panel__title">Why: {diagnosis.label}</h2>

      {/* The answer, before any of the working. */}
      <p className="diagnosis__cause">{CAUSE_SENTENCE[diagnosis.cause]}</p>
      <p className="diagnosis__action">
        <span className={`chip chip--action chip--action-${diagnosis.action}`}>
          {ACTION_LABEL[diagnosis.action]}
        </span>{' '}
        {ACTION_SENTENCE[diagnosis.action]}
      </p>

      <dl className="figures">
        <div className="figures__row">
          <dt>Contribution</dt>
          <dd
            className={`figure ${diagnosis.contributionMinor < 0 ? 'figure--loss' : 'figure--profit'}`}
          >
            <span aria-hidden="true">{diagnosis.contributionMinor < 0 ? '▼' : '▲'}</span>{' '}
            {formatUsdMinor(diagnosis.contributionMinor)}
          </dd>
        </div>
        <div className="figures__row">
          <dt>Load factor</dt>
          <dd className="figure">
            {percent(diagnosis.loadFactor)} against {percent(diagnosis.breakevenLoadFactor)} needed
            {/*
              The one figure that says whether filling the aeroplane can work at
              all — which is why the breakeven load factor is deliberately never
              clamped to 1.
            */}
            {diagnosis.unfillable && <span className="chip chip--warn">no load factor pays</span>}
          </dd>
        </div>
        {diagnosis.rivalShare !== null && (
          <div className="figures__row">
            <dt>Rivals hold</dt>
            <dd className="figure">
              {percent(diagnosis.rivalShare)}
              {diagnosis.rivalShare >= diagnosis.rivalShareThreshold && (
                <span className="chip chip--warn">their market</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Lever</th>
              <th scope="col" className="data-table__num">
                This route
              </th>
              <th scope="col" className="data-table__num">
                Your median
              </th>
              <th scope="col" className="data-table__num">
                Worth
              </th>
            </tr>
          </thead>
          <tbody>
            <GapRow name="Yield" gap={diagnosis.gaps.yield} unit="money-per-km" />
            <GapRow name="Cost per seat-km" gap={diagnosis.gaps.cost} unit="money-per-km" />
            <GapRow name="Load factor" gap={diagnosis.gaps.load} unit="ratio" />
          </tbody>
        </table>
      </div>

      <p className="panel__note">
        {diagnosis.peerRoutes === 0
          ? 'You have no other flown routes to compare this against, so the levers have no benchmark — the diagnosis is from this route’s own breakeven alone.'
          : `Measured against the median of your other ${String(diagnosis.peerRoutes)} flown ${diagnosis.peerRoutes === 1 ? 'route' : 'routes'}, over ${String(diagnosis.windowDays)} game days. A world median for your fleet size is §14.6’s and is not built.`}
      </p>
    </section>
  );
}
