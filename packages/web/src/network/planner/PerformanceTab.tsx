import { useEffect, useState } from 'react';

import type { RoutePerformanceResponse } from '@tailfin/shared';

import { fetchPerformance } from '../api';

import { compactMoney, Sparkline, StatTile } from './ui';

import type { ReactNode } from 'react';

/**
 * The Performance tab — how the route is actually doing.
 *
 * Real now (M2-06): its own settled flights, rolled up over the trailing twelve
 * weeks of the world's clock — load factor and its trend, on-time, unit economics
 * and the revenue/cost split. Only the worker settles a flight, so a route that
 * has flown nothing reads as *idle* rather than broken — the same boundary the
 * fleet page carries.
 */
export function PerformanceTab({ routeId }: { routeId: string }): ReactNode {
  const [data, setData] = useState<RoutePerformanceResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    setData('loading');
    fetchPerformance(routeId)
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
    return <p className="admin__note">Loading performance…</p>;
  }
  if (data === 'error') {
    return (
      <p className="page__note" role="alert">
        Could not load this route’s performance.
      </p>
    );
  }

  if (data.flights === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Performance</h2>
        </div>
        <p className="admin__note">
          This route hasn’t flown yet. Once its schedule produces flights and they arrive, their
          load factor, punctuality and economics roll up here over the last twelve weeks.
        </p>
      </section>
    );
  }

  const loadPct = data.loadFactor === null ? null : data.loadFactor * 100;
  const onTimePct = data.onTimePct === null ? null : data.onTimePct * 100;
  const marginPct = data.revenueMinor === 0 ? null : (data.netMinor / data.revenueMinor) * 100;
  const trendPoints = data.trend.map((week) => week.loadFactor ?? 0);
  const flown = data.trend.filter((week) => week.loadFactor !== null);
  const latest = flown.at(-1)?.loadFactor ?? null;
  const previous = flown.at(-2)?.loadFactor ?? latest;
  const trendUp = latest !== null && previous !== null && latest >= previous;

  return (
    <div className="net-performance">
      <div className="net-tiles">
        <StatTile
          label="Load factor"
          value={loadPct === null ? '—' : `${loadPct.toFixed(0)}%`}
          tone={loadPct !== null && loadPct >= 70 ? 'positive' : 'warn'}
          sub={
            latest !== null && previous !== null ? (
              <span className={trendUp ? 'net-trend net-trend--up' : 'net-trend net-trend--down'}>
                {trendUp ? '▲' : '▼'} {(Math.abs(latest - previous) * 100).toFixed(1)} pts
              </span>
            ) : (
              `${String(data.flights)} flights flown`
            )
          }
        />
        <StatTile
          label="On time"
          value={onTimePct === null ? '—' : `${onTimePct.toFixed(0)}%`}
          tone={onTimePct !== null && onTimePct >= 80 ? 'positive' : 'warn'}
          sub="within 15 min"
        />
        <StatTile
          label="Margin"
          value={marginPct === null ? '—' : `${marginPct.toFixed(0)}%`}
          tone={marginPct !== null && marginPct >= 0 ? 'positive' : 'negative'}
          sub="contribution / revenue"
        />
        <StatTile
          label="RASK"
          value={data.raskMinor === null ? '—' : data.raskMinor.toFixed(2)}
          sub="minor / seat-km"
        />
        <StatTile
          label="CASK"
          value={data.caskMinor === null ? '—' : data.caskMinor.toFixed(2)}
          sub="minor / seat-km"
        />
      </div>

      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Load factor — last 12 weeks</h3>
          <span className="net-panel__hint">
            {loadPct === null ? '—' : `${loadPct.toFixed(0)}% overall`}
          </span>
        </div>
        <div className="net-trendchart">
          <Sparkline points={trendPoints} />
          <div className="net-trendchart__scale figure">
            <span>{(Math.max(...trendPoints) * 100).toFixed(0)}%</span>
            <span>{(Math.min(...trendPoints) * 100).toFixed(0)}%</span>
          </div>
        </div>
      </section>

      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Revenue vs cost — last 12 weeks</h3>
          <span className="net-panel__hint">{String(data.flights)} flights</span>
        </div>
        <div className="net-revcost">
          <div className="net-revcost__row">
            <span className="net-revcost__label">Revenue</span>
            <span className="net-revcost__bar net-revcost__bar--rev" style={{ width: '100%' }} />
            <span className="net-revcost__value figure">{compactMoney(data.revenueMinor)}</span>
          </div>
          <div className="net-revcost__row">
            <span className="net-revcost__label">Cost</span>
            <span
              className="net-revcost__bar net-revcost__bar--cost"
              style={{
                width: `${
                  data.revenueMinor === 0
                    ? 0
                    : Math.min(100, (data.costMinor / data.revenueMinor) * 100)
                }%`,
              }}
            />
            <span className="net-revcost__value figure">{compactMoney(data.costMinor)}</span>
          </div>
          <div className="net-revcost__row net-revcost__row--net">
            <span className="net-revcost__label">Contribution</span>
            <span className="net-revcost__value figure">{compactMoney(data.netMinor)}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
