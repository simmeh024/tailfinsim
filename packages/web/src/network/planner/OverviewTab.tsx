import { Chip, compactMoney, major, Meter, StatTile } from './ui';

import type { RoutePlan } from './types';
import type { ReactNode } from 'react';

/**
 * The Overview tab — the route at a glance: economics, utilisation, weekly
 * frequency, demand and who else is in the market. Every figure below the fare
 * data is mock (`planner/mock.ts`) until the schedule and competition endpoints
 * exist; the fare-derived pieces come from the real route.
 */
export function OverviewTab({ plan }: { plan: RoutePlan }): ReactNode {
  const { economics: e, demand, competitors } = plan;
  const weeklyProfit = e.weeklyRevenueMinor - e.weeklyCostMinor;
  const totalDemand = demand.business + demand.leisure + demand.vfr;
  const marginTone = weeklyProfit >= 0 ? 'positive' : 'negative';

  return (
    <div className="net-overview">
      <div className="net-tiles">
        <StatTile
          label="Weekly frequency"
          value={`${String(e.weeklyFrequency)}×`}
          sub="departures / week"
          tip="How many times you fly this route in a week — more frequency wins schedule-sensitive demand but adds cost."
        />
        <StatTile
          label="Load factor"
          value={`${(e.loadFactor * 100).toFixed(0)}%`}
          tone={e.loadFactor >= 0.7 ? 'positive' : 'warn'}
          sub={<Meter value={e.loadFactor} tone={e.loadFactor >= 0.7 ? 'positive' : 'warn'} />}
          tip="Share of your seats that sell. Add frequency and it falls unless demand grows to match."
        />
        <StatTile
          label="Weekly revenue"
          value={compactMoney(e.weeklyRevenueMinor)}
          tone="accent"
          sub={`RASK ${major(e.raskMinor)}`}
          tip="Revenue per available seat-kilometre — the fares you take per seat you fly, per km."
        />
        <StatTile
          label="Weekly profit"
          value={compactMoney(weeklyProfit)}
          tone={marginTone}
          sub={`CASK ${major(e.caskMinor)}`}
          tip="Revenue minus cost. Cost per available seat-km (CASK) is what a seat costs to fly."
        />
        <StatTile
          label="Utilisation"
          value={`${e.utilisationHoursPerDay.toFixed(1)} h`}
          sub="block hours / day"
        />
        <StatTile
          label="Distance"
          value={`${plan.route.greatCircleNm.toFixed(0)} nm`}
          sub="great circle"
        />
      </div>

      <div className="net-overview__cols">
        <section className="net-panel">
          <div className="net-panel__head">
            <h3 className="net-panel__title">Daily demand</h3>
            <span className="net-panel__hint">{totalDemand} pax / day</span>
          </div>
          <ul className="net-demand">
            {(
              [
                ['Business', demand.business, 'accent'],
                ['Leisure', demand.leisure, 'positive'],
                ['VFR', demand.vfr, 'warn'],
              ] as const
            ).map(([label, value, tone]) => (
              <li key={label} className="net-demand__row">
                <span className="net-demand__label">{label}</span>
                <Meter
                  value={value / totalDemand}
                  tone={tone}
                  label={`${label} ${String(value)}`}
                />
                <span className="net-demand__value figure">{value}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="net-panel">
          <div className="net-panel__head">
            <h3 className="net-panel__title">Competition</h3>
            <span className="net-panel__hint">
              {competitors.length === 0
                ? 'route to yourself'
                : `${String(competitors.length)} rival${competitors.length > 1 ? 's' : ''}`}
            </span>
          </div>
          {competitors.length === 0 ? (
            <p className="admin__note">You have this market to yourself — no rivals selling it.</p>
          ) : (
            <ul className="net-rivals">
              {competitors.map((rival) => (
                <li key={rival.id} className="net-rivals__row">
                  <span className="net-rivals__name">{rival.name}</span>
                  <Chip tone="neutral">{rival.weeklyFrequency}× / wk</Chip>
                  <span className="net-rivals__fare figure">{major(rival.economyFareMinor)}</span>
                  <span className="net-rivals__share figure">
                    {(rival.share * 100).toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
