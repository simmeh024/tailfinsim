import { compactMoney, major, Sparkline, StatTile } from './ui';

import type { RoutePlan } from './types';
import type { ReactNode } from 'react';

/**
 * The Performance tab — how the route is actually doing: the load-factor trend,
 * yield and unit economics, and the revenue/cost split. Mock trend and unit
 * figures (`planner/mock.ts`) until the flight-result rollups feed it; the shape
 * matches what a per-route performance read would return.
 */
export function PerformanceTab({ plan }: { plan: RoutePlan }): ReactNode {
  const { economics: e, loadTrend } = plan;
  const latest = loadTrend[loadTrend.length - 1] ?? 0;
  const previous = loadTrend[loadTrend.length - 2] ?? latest;
  const trendUp = latest >= previous;
  const weeklyProfit = e.weeklyRevenueMinor - e.weeklyCostMinor;
  const marginPct = e.weeklyRevenueMinor === 0 ? 0 : (weeklyProfit / e.weeklyRevenueMinor) * 100;

  return (
    <div className="net-performance">
      <div className="net-tiles">
        <StatTile
          label="Load factor"
          value={`${(latest * 100).toFixed(0)}%`}
          tone={latest >= 0.7 ? 'positive' : 'warn'}
          sub={
            <span className={trendUp ? 'net-trend net-trend--up' : 'net-trend net-trend--down'}>
              {trendUp ? '▲' : '▼'} {(Math.abs(latest - previous) * 100).toFixed(1)} pts
            </span>
          }
        />
        <StatTile
          label="Margin"
          value={`${marginPct.toFixed(0)}%`}
          tone={marginPct >= 0 ? 'positive' : 'negative'}
          sub="on weekly revenue"
        />
        <StatTile label="RASK" value={major(e.raskMinor)} sub="revenue / seat-km" />
        <StatTile label="CASK" value={major(e.caskMinor)} sub="cost / seat-km" />
      </div>

      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Load factor — last 12 weeks</h3>
          <span className="net-panel__hint">{(latest * 100).toFixed(0)}% now</span>
        </div>
        <div className="net-trendchart">
          <Sparkline points={loadTrend} />
          <div className="net-trendchart__scale figure">
            <span>{(Math.max(...loadTrend) * 100).toFixed(0)}%</span>
            <span>{(Math.min(...loadTrend) * 100).toFixed(0)}%</span>
          </div>
        </div>
      </section>

      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Weekly revenue vs cost</h3>
        </div>
        <div className="net-revcost">
          <div className="net-revcost__row">
            <span className="net-revcost__label">Revenue</span>
            <span className="net-revcost__bar net-revcost__bar--rev" style={{ width: '100%' }} />
            <span className="net-revcost__value figure">{compactMoney(e.weeklyRevenueMinor)}</span>
          </div>
          <div className="net-revcost__row">
            <span className="net-revcost__label">Cost</span>
            <span
              className="net-revcost__bar net-revcost__bar--cost"
              style={{
                width: `${
                  e.weeklyRevenueMinor === 0
                    ? 0
                    : Math.min(100, (e.weeklyCostMinor / e.weeklyRevenueMinor) * 100)
                }%`,
              }}
            />
            <span className="net-revcost__value figure">{compactMoney(e.weeklyCostMinor)}</span>
          </div>
          <div className="net-revcost__row net-revcost__row--net">
            <span className="net-revcost__label">Profit</span>
            <span className="net-revcost__value figure">{compactMoney(weeklyProfit)}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
