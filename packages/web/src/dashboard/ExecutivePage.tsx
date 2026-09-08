import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { ExecutiveDashboardResponse, RouteMover } from '@tailfin/shared';

import { formatUsdMinor, activeCurrency } from '../currency/display';
import { csvMoney, csvMoneyHeader } from '../export/csv';
import { ExportButton } from '../export/ExportButton';
import { StateBlock } from '../ui/StateBlock';

import { fetchExecutiveDashboard } from './api';
import { MetricTile } from './MetricTile';

import type { ReactNode } from 'react';

import './dashboard.css';

/**
 * §14.3's Executive dashboard (M8-10).
 *
 * > **Executive** — cash, **cash runway in days**, net worth, MTD profit vs.
 * > forecast, load factor, OTP, reputation, credit rating, top gainers and
 * > losers this week
 *
 * Nine figures, in that order, each a tile carrying its level, its movement and
 * its drill-down. The server assembles them: three of the nine exist nowhere
 * else, and a page that derived them would own numbers the server could not
 * explain.
 *
 * ## Why this is not the P&L
 *
 * §14.3 gives the Executive and Financial dashboards different jobs, and the
 * split is worth keeping. This one answers *"is the airline all right?"* in one
 * glance — the check-in session §2 describes. The Financial page answers *"where
 * did the money go?"*, which takes a table. Merging them would produce a screen
 * that does neither.
 */

/** The month-to-date panel: actual against the band that was forecast. */
function MonthToDatePanel({ data }: { data: ExecutiveDashboardResponse }): ReactNode {
  const mtd = data.monthToDate;
  const variance = mtd.varianceMinor;

  return (
    <section className="panel" aria-label="Month to date">
      <h2 className="panel__title">Profit against forecast</h2>
      <p className="panel__note">
        {mtd.daysElapsed === 0
          ? 'The game month has just turned; there is nothing in it yet.'
          : `${String(mtd.daysElapsed)} game ${mtd.daysElapsed === 1 ? 'day' : 'days'} into the month.`}
      </p>
      <dl className="figures">
        <div className="figures__row">
          <dt>Actual</dt>
          <dd className="figure">{formatUsdMinor(mtd.actualMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Forecast</dt>
          <dd className="figure">
            {mtd.forecastMinor === null ? '—' : formatUsdMinor(mtd.forecastMinor)}
          </dd>
        </div>
        <div className="figures__row">
          <dt>Band</dt>
          <dd className="figure">
            {mtd.forecastLowMinor === null || mtd.forecastHighMinor === null
              ? 'not enough history'
              : `${formatUsdMinor(mtd.forecastLowMinor)} – ${formatUsdMinor(mtd.forecastHighMinor)}`}
          </dd>
        </div>
        <div className="figures__row">
          <dt>Variance</dt>
          <dd className="figure">
            {variance === null ? '—' : formatUsdMinor(variance)}
            {/*
              A forecast is a band, so being off its middle is not news. This is
              the flag that stops the panel raising an alarm every month — the
              projection is never exactly right, and saying "within the band"
              is the difference between a variance and a problem.
            */}
            {variance !== null && (
              <span className={mtd.withinBand ? 'chip chip--calm' : 'chip chip--warn'}>
                {mtd.withinBand ? 'within band' : 'outside band'}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** The week's biggest movers, ranked on the change rather than the level. */
function MoverList({
  title,
  movers,
  emptyNote,
  view,
  gameNow,
}: {
  title: string;
  movers: readonly RouteMover[];
  emptyNote: string;
  view: string;
  gameNow: string;
}): ReactNode {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {movers.length > 0 && (
          <ExportButton
            view={view}
            gameNow={gameNow}
            table={() => ({
              headers: ['Route', csvMoneyHeader('Change'), csvMoneyHeader('This week')],
              /*
               * The signed change, not the absolute one the screen shows beside
               * an arrow. On screen the arrow carries the direction; a CSV has no
               * arrow, and a column of positive numbers under "Change" in the
               * losers file would be actively misleading.
               */
              rows: movers.map((mover) => [
                mover.label,
                csvMoney(mover.changeMinor),
                csvMoney(mover.valueMinor),
              ]),
            })}
          />
        )}
      </div>
      {movers.length === 0 ? (
        <StateBlock kind="empty">{emptyNote}</StateBlock>
      ) : (
        <ul className="movers">
          {movers.map((mover) => (
            <li key={mover.routeId ?? mover.label} className="movers__item">
              <span className="movers__route">
                {mover.routeId === null ? (
                  mover.label
                ) : (
                  <Link to={`/network?route=${mover.routeId}`}>{mover.label}</Link>
                )}
              </span>
              <span
                className={`movers__change figure ${mover.changeMinor >= 0 ? 'movers__change--up' : 'movers__change--down'}`}
              >
                <span aria-hidden="true">{mover.changeMinor >= 0 ? '▲' : '▼'}</span>{' '}
                {formatUsdMinor(Math.abs(mover.changeMinor))}
              </span>
              <span className="movers__level figure">
                {formatUsdMinor(mover.valueMinor)} this week
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ExecutivePage(): ReactNode {
  const [data, setData] = useState<ExecutiveDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setData(await fetchExecutiveDashboard());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page">
      <h1 className="page__title">Dashboard</h1>

      {loading ? (
        <StateBlock kind="loading">Reading your airline.</StateBlock>
      ) : data === null ? (
        <StateBlock kind="broken">
          The dashboard could not be read. Nothing is wrong with your airline — this panel is.
        </StateBlock>
      ) : (
        <>
          {/*
            The three figures §14.3 opens with, emphasised. Cash and the runway
            are the check-in glance §2 describes; net worth is the one that
            answers "am I building anything?" rather than "am I surviving?".
          */}
          <div className="panel__head panel__head--bare">
            <h2 className="visually-hidden">Headline figures</h2>
            <ExportButton
              view="executive-headlines"
              gameNow={data.gameNow}
              label="Export headlines"
              table={() => ({
                headers: ['Metric', 'Value', 'Unit', 'Change vs prior period', 'Period (days)'],
                /*
                 * The raw value and its unit rather than the formatted string.
                 * A tile mixes currencies, ratios and per-kilometre fractions in
                 * one list, so a single "Value" column can only be numeric if the
                 * unit travels beside it — and a spreadsheet can then convert or
                 * chart it. `text` headlines (the credit tier) have no number and
                 * carry their words instead.
                 */
                rows: data.headlines.map((headline) => [
                  headline.label,
                  headline.unit === 'minor' ? csvMoney(headline.value) : headline.value,
                  headline.unit === 'minor' ? activeCurrency() : headline.unit,
                  headline.trend.changePct,
                  headline.trend.days,
                ]),
              })}
            />
          </div>
          <div className="tiles" aria-label="Headline figures">
            {data.headlines.map((headline) => (
              <MetricTile
                key={headline.id}
                label={headline.label}
                value={headline.value}
                text={headline.text}
                unit={headline.unit}
                polarity={headline.polarity}
                trend={headline.trend}
                drillDown={headline.drillDown}
                featured={
                  headline.id === 'cash' ||
                  headline.id === 'cash_runway' ||
                  headline.id === 'net_worth'
                }
              />
            ))}
          </div>

          <MonthToDatePanel data={data} />

          <div className="panel-pair">
            <MoverList
              title="Gained this week"
              view="executive-gainers"
              gameNow={data.gameNow}
              movers={data.gainers}
              emptyNote="No route improved on last week. On a node with no worker nothing settles at all, so this is empty everywhere until flights fly."
            />
            <MoverList
              title="Lost this week"
              view="executive-losers"
              gameNow={data.gameNow}
              movers={data.losers}
              emptyNote="No route did worse than last week."
            />
          </div>
        </>
      )}
    </section>
  );
}
