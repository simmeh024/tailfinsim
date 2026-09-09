import { useEffect, useState } from 'react';

import type { BellyLimit, RouteBellyCapacity, RouteCargoResponse } from '@tailfin/shared';

import { StateBlock } from '../../ui/StateBlock';
import { fetchRouteCargo } from '../api';

import { Chip, major, Meter, StatTile, Tip } from './ui';

import type { ReactNode } from 'react';

/**
 * The Cargo tab — what this route's hold is worth, and what is stopping it.
 *
 * §12.1 asks for exactly one thing beyond the arithmetic: *"This is the quiet
 * economic reason widebody long-haul works at all… the game should make that
 * discoverable rather than stated."* So this panel does not explain the
 * mechanism. It shows the three limits side by side with the binding one marked,
 * and lets a player notice that their full narrowbody has no belly to sell while
 * a widebody on the same sector has twenty tonnes.
 *
 * ## Both legs, always
 *
 * §12.2 calls pricing a cargo lane per leg *"the single most common real-world
 * mistake"*. A tab that showed only the direction being planned would build that
 * mistake into the interface, so the round trip is a first-class row rather than
 * something to go and look up.
 */

const LIMIT_LABEL: Record<BellyLimit, string> = {
  weight: 'Takeoff weight',
  structural: 'Structural payload',
  volume: 'Hold volume',
};

/** What each limit is, in one line, for the tooltip. */
const LIMIT_TIP: Record<BellyLimit, string> = {
  weight: 'MTOW less the empty aircraft, its fuel, its passengers and their bags.',
  structural: 'What the floor and frames carry, whatever the aircraft weighs today.',
  volume: 'What the hold has room for once the passengers’ bags are in it.',
};

export function CargoTab({ routeId }: { routeId: string }): ReactNode {
  const [data, setData] = useState<RouteCargoResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    setData('loading');
    fetchRouteCargo(routeId)
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
    return <StateBlock kind="loading">Weighing the hold…</StateBlock>;
  }
  if (data === 'error') {
    return <StateBlock kind="broken">Could not load this route’s cargo figures.</StateBlock>;
  }

  return (
    <>
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">The lane</h2>
          <span className="net-panel__hint">
            {data.originIcao} → {data.destinationIcao} · {data.distanceNm.toFixed(0)} nm
          </span>
        </div>

        <div className="net-tiles">
          <StatTile
            label="Direction"
            value={
              data.direction === 'balanced' ? (
                <Chip tone="neutral">Balanced</Chip>
              ) : data.direction === 'headhaul' ? (
                <Chip tone="positive">Headhaul</Chip>
              ) : (
                <Chip tone="warn">Backhaul</Chip>
              )
            }
            sub={
              data.direction === 'balanced'
                ? 'Even both ways'
                : `${data.imbalance.toFixed(1)}× imbalance`
            }
            tip="Freight follows trade, not passengers: manufacturing at one end, consumption at the other."
          />
          <StatTile
            label="This leg"
            value={major(data.ratePerTonneMinor)}
            sub="a tonne"
            tone={data.direction === 'backhaul' ? 'warn' : 'positive'}
          />
          <StatTile
            label="Flying back"
            value={major(data.reverseRatePerTonneMinor)}
            sub="a tonne"
            tone={data.direction === 'headhaul' ? 'warn' : 'neutral'}
            tip="A cargo lane is priced as a round trip. The backhaul is the leg that catches people out."
          />
          <StatTile
            label="Freight offered"
            value={`${data.offeredTonnes.toFixed(1)} t`}
            sub={`${data.reverseOfferedTonnes.toFixed(1)} t coming back`}
            tip="What this lane has moving on it per flight, before asking what fits."
          />
        </div>

        <p className="net-panel__foot">{data.laneDetail}</p>
      </section>

      {data.belly === null ? (
        <section className="net-panel">
          <div className="net-panel__head">
            <h2 className="net-panel__title">Your hold</h2>
          </div>
          <StateBlock kind="empty">
            You have no aircraft in service to measure. The rates above are what the market pays;
            what you can actually lift depends on the aeroplane you put on the route.
          </StateBlock>
        </section>
      ) : (
        <BellyPanel belly={data.belly} />
      )}
    </>
  );
}

function BellyPanel({ belly }: { belly: RouteBellyCapacity }): ReactNode {
  // The scale every bar is drawn against: the largest allowance, so the binding
  // one reads as the short bar it is. Negative weight — an aircraft already over
  // MTOW — floors at zero for the bar and is still stated in the figure.
  const widest = Math.max(
    belly.allowances.weight,
    belly.allowances.structural,
    belly.allowances.volume,
    1,
  );

  const rows: { limit: BellyLimit; tonnes: number }[] = [
    { limit: 'weight', tonnes: belly.allowances.weight },
    { limit: 'structural', tonnes: belly.allowances.structural },
    { limit: 'volume', tonnes: belly.allowances.volume },
  ];

  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Your hold</h2>
        <span className="net-panel__hint">
          {belly.registration} · {belly.typeDesignation} · {belly.plannedPassengers} seats
        </span>
      </div>

      <div className="net-tiles">
        <StatTile
          label="Belly capacity"
          value={`${belly.availableTonnes.toFixed(1)} t`}
          sub={`limited by ${LIMIT_LABEL[belly.limit].toLowerCase()}`}
          tone={belly.availableTonnes > 0 ? 'accent' : 'negative'}
        />
        <StatTile
          label="Carried"
          value={`${belly.carriedTonnes.toFixed(1)} t`}
          // Three states, not two. "Hold is full" would be a lie about an
          // aeroplane with no belly to sell at all, which is exactly §12.1's full
          // cabin on a long sector — the case this panel exists to make legible.
          sub={
            belly.availableTonnes <= 0
              ? 'nothing fits on this sector'
              : belly.carriedTonnes < belly.availableTonnes
                ? 'lane has no more freight'
                : 'hold is full'
          }
        />
        <StatTile
          label="This leg earns"
          value={major(belly.revenueMinor)}
          sub={`${major(belly.reverseRevenueMinor)} coming back`}
          tone="positive"
        />
        <StatTile
          label="Fuel aboard"
          value={`${belly.fuelTonnes.toFixed(1)} t`}
          sub="competes with the hold"
          tip="Every tonne of fuel for a longer sector is a tonne of freight you cannot carry."
        />
      </div>

      <table className="admin__table net-cargo-table">
        <thead>
          <tr>
            <th scope="col">Limit</th>
            <th scope="col">Allows</th>
            <th scope="col" aria-label="Relative allowance" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.limit} data-binding={row.limit === belly.limit ? 'yes' : undefined}>
              <th scope="row">
                {LIMIT_LABEL[row.limit]}
                <Tip text={LIMIT_TIP[row.limit]} />
                {row.limit === belly.limit && (
                  <>
                    {' '}
                    <Chip tone="warn">Binding</Chip>
                  </>
                )}
              </th>
              <td className="figure">{row.tonnes.toFixed(1)} t</td>
              <td>
                <Meter
                  value={Math.max(0, row.tonnes) / widest}
                  tone={row.limit === belly.limit ? 'warn' : 'neutral'}
                  label={`${LIMIT_LABEL[row.limit]} allows ${row.tonnes.toFixed(1)} tonnes`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="net-panel__foot">{belly.detail}</p>

      <p className="net-panel__foot">
        Hold: {belly.volume.usableM3.toFixed(0)} m³ usable
        {belly.cargoVolumeFactor < 1 && (
          <>
            {' '}
            ({(belly.cargoVolumeFactor * 100).toFixed(0)}% of standard — this build gave hold space
            up for range)
          </>
        )}
        , of which {belly.volume.baggageM3.toFixed(0)} m³ is passenger baggage, leaving{' '}
        {belly.volume.freightM3.toFixed(0)} m³ for freight.
      </p>
    </section>
  );
}
