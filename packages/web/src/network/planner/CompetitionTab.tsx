import { Chip, major, Meter } from './ui';

import type { Competitor, RoutePlan } from './types';
import type { ReactNode } from 'react';

/**
 * The Competition tab — who else flies the pair, how they price and how much of
 * the market they hold. Mock (`planner/mock.ts`) until an NPC-competition read
 * exists; the "why am I losing" decomposition against a rival lives in Pricing,
 * where the real waterfall endpoint drives it.
 */

const PRODUCT_LABEL: Record<Competitor['product'], string> = {
  basic: 'Basic',
  standard: 'Standard',
  premium: 'Premium',
};

const PRODUCT_FILL: Record<Competitor['product'], number> = {
  basic: 0.33,
  standard: 0.66,
  premium: 1,
};

export function CompetitionTab({ plan }: { plan: RoutePlan }): ReactNode {
  const { competitors } = plan;
  const yourShare = Math.max(0, 1 - competitors.reduce((sum, r) => sum + r.share, 0));

  if (competitors.length === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Competition</h2>
        </div>
        <p className="admin__note">
          Nobody else is selling {plan.route.originIcao} → {plan.route.destinationIcao}. You have
          the route to yourself — set the fare where the demand model pays you best.
        </p>
      </section>
    );
  }

  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Who you are up against</h2>
        <span className="net-panel__hint">{competitors.length} rivals on the pair</span>
      </div>

      <div className="net-share">
        <span
          className="net-share__seg net-share__seg--you"
          style={{ width: `${yourShare * 100}%` }}
        >
          You {(yourShare * 100).toFixed(0)}%
        </span>
        {competitors.map((rival, index) => (
          <span
            key={rival.id}
            className={`net-share__seg net-share__seg--r${String(index % 3)}`}
            style={{ width: `${rival.share * 100}%` }}
            title={`${rival.name} ${(rival.share * 100).toFixed(0)}%`}
          />
        ))}
      </div>

      <table className="admin__table net-comp-table">
        <thead>
          <tr>
            <th scope="col">Carrier</th>
            <th scope="col">Weekly</th>
            <th scope="col">Economy fare</th>
            <th scope="col">Product</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((rival) => (
            <tr key={rival.id}>
              <th scope="row">{rival.name}</th>
              <td className="figure">{rival.weeklyFrequency}×</td>
              <td className="figure">{major(rival.economyFareMinor)}</td>
              <td>
                <div className="net-comp-product">
                  <Meter value={PRODUCT_FILL[rival.product]} tone="accent" />
                  <Chip tone="neutral">{PRODUCT_LABEL[rival.product]}</Chip>
                </div>
              </td>
              <td className="figure">{(rival.share * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="net-panel__foot">
        To see <em>why</em> a rival is winning a cabin, open{' '}
        <strong>Pricing → Why am I losing?</strong> — that runs the real market decomposition.
      </p>
    </section>
  );
}
