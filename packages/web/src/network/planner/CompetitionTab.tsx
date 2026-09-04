import { useEffect, useState } from 'react';

import type { RouteCompetitionResponse, RouteCompetitor } from '@tailfin/shared';

import { StateBlock } from '../../ui/StateBlock';
import { fetchCompetition } from '../api';

import { Chip, major, Meter } from './ui';

import type { ReactNode } from 'react';

/**
 * The Competition tab — who else flies the pair, how they price and how much of
 * the market they hold.
 *
 * Real now (M3-12): the same share model the fares preview runs, so the shares
 * here and the projection in Pricing agree. You are one line in the market, not
 * an implied self against "them"; the "why am I losing" decomposition against a
 * single rival still lives in Pricing, where the waterfall endpoint drives it.
 */

/** A coarse quality tier from A.3's 0–1 product composite, for the little bar. */
function productTier(productScore: number): { label: string; fill: number } {
  if (productScore >= 0.8) return { label: 'Premium', fill: 1 };
  if (productScore >= 0.5) return { label: 'Standard', fill: 0.66 };
  return { label: 'Basic', fill: 0.33 };
}

export function CompetitionTab({ routeId }: { routeId: string }): ReactNode {
  const [data, setData] = useState<RouteCompetitionResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    setData('loading');
    fetchCompetition(routeId)
      .then((response) => {
        if (live) setData(response);
      })
      .catch(() => {
        if (live) setData('error');
      });
    return () => {
      live = false;
    };
  }, [routeId]);

  if (data === 'loading') {
    return <StateBlock kind="loading">Loading the market…</StateBlock>;
  }
  if (data === 'error') {
    return <StateBlock kind="broken">Could not load this route’s competition.</StateBlock>;
  }

  const you = data.operators.find((operator) => operator.isYou);
  const rivals = data.operators.filter((operator) => !operator.isYou);

  if (rivals.length === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Competition</h2>
        </div>
        <StateBlock kind="empty">
          Nobody else is selling this market. You have the route to yourself — set the fare where
          the demand model pays you best.
        </StateBlock>
      </section>
    );
  }

  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Who you are up against</h2>
        <span className="net-panel__hint">
          {rivals.length} {rivals.length === 1 ? 'rival' : 'rivals'} on the pair
        </span>
      </div>

      <div className="net-share">
        {you && (
          <span
            className="net-share__seg net-share__seg--you"
            style={{ width: `${you.share * 100}%` }}
          >
            You {(you.share * 100).toFixed(0)}%
          </span>
        )}
        {rivals.map((rival, index) => (
          <span
            key={rival.airlineId}
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
          {rivals.map((rival) => (
            <CompetitorRow key={rival.airlineId} rival={rival} />
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

function CompetitorRow({ rival }: { rival: RouteCompetitor }): ReactNode {
  const tier = productTier(rival.productScore);
  return (
    <tr>
      <th scope="row">
        {rival.name}
        {rival.kind === 'npc' && (
          <>
            {' '}
            <Chip tone="neutral">AI</Chip>
          </>
        )}
      </th>
      <td className="figure">{rival.weeklyFrequency}×</td>
      <td className="figure">
        {rival.economyFareMinor === null ? '—' : major(rival.economyFareMinor)}
      </td>
      <td>
        <div className="net-comp-product">
          <Meter value={tier.fill} tone="accent" />
          <Chip tone="neutral">{tier.label}</Chip>
        </div>
      </td>
      <td className="figure">{(rival.share * 100).toFixed(0)}%</td>
    </tr>
  );
}
