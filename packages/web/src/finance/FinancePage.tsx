import { useCallback, useEffect, useState } from 'react';

import type {
  CreditStandingResponse,
  FinancePnlResponse,
  Metric,
  MetricBreakdownResponse,
  MetricId,
  PnlDimensionRow,
  PnlLine,
  RouteDiagnosisResponse,
  StatisticsResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import {
  fetchBreakdown,
  fetchCreditStanding,
  fetchProfitAndLoss,
  fetchRouteDiagnosis,
  fetchStatistics,
} from '../dashboard/api';
import { MetricTile } from '../dashboard/MetricTile';
import { csvMoney, csvMoneyHeader } from '../export/csv';
import { ExportButton } from '../export/ExportButton';
import {
  DEFAULT_HORIZON,
  HorizonControl,
  HorizonProvider,
  horizonLabel,
  type Horizon,
} from '../statistics/horizon';
import { StateBlock } from '../ui/StateBlock';

import { BorrowingPanel } from './BorrowingPanel';
import { RouteDiagnosisPanel } from './RouteDiagnosisPanel';
import { RouteProfitChart } from './RouteProfitChart';

import type { ReactNode } from 'react';

import '../dashboard/dashboard.css';

/**
 * The Finance page: what belongs on it, and in what order (SURFACE-03).
 *
 * §14 is unusually prescriptive about this page, and this file is its
 * container: the regions, their order, the one period control, and a stated
 * home for every issue that puts something here. The panels are other issues'.
 *
 * ## The regions, in order
 *
 * A player opening Finance is asking §14.1's three questions — *am I making
 * money, where, and what is it costing me?* — so the page answers them in that
 * order, under **one** §14.2 period chosen at the top.
 *
 * | Region | Answers | Built by |
 * | --- | --- | --- |
 * | **Profit by route** | where — §14.4's *"single most important chart"*, first on purpose | M8-11 (#83) |
 * | **Headline figures** | am I making money, and how efficiently | M8-10 (#82); drill-down SURFACE-06 (#1129) |
 * | **Profit and loss** | what it is costing, line by line, interest as its own line | M8-01 (#73), M8-10 |
 * | **By route, aircraft, hub and cabin** | where each line was earned or spent | M8-10 |
 * | **Borrowing** | what I may borrow, why not more, and what debt costs | SURFACE-02 (#1125) |
 * | **Not on this page yet** | the honest gaps, each with its owner | — |
 *
 * ## Where everything else lives
 *
 * - **Cash runway** is M8-08 (#80)'s `RunwayIndicator` in the status strip, on
 *   every page, and the loudest thing there below 30 days (§13.6). This page
 *   does **not** repeat it: a second runway would be a second place to disagree.
 * - **CSV export** (M8-14, #86) is on every table, as the export buttons.
 * - **Operational dashboards** (M8-12, #84) are `/operations`; **alerts and the
 *   digest** (M8-13, #85) are `/alerts`. Neither is finance, and neither moves here.
 * - **The default ladder's surface** is LEGACY-11 (#1036). Borrowing states the
 *   stage and links no further.
 * - **App-level placement** of the page is UX-01 (#462)'s; this owns its inside.
 *
 * ## One period for the page
 *
 * §14.2's trend window is chosen once, in the header, and provided to
 * everything below: the P&L and its rollups, the ranked chart and every
 * metric's drill-down read the same 7, 30 or 90 game days. A page with a
 * period selector per panel is a page where nothing can be compared — the
 * reason the issue makes this page-level. Borrowing is the exception, and says
 * so: §13.1 measures capacity over twelve trailing months by definition.
 *
 * ## Each panel fails on its own
 *
 * Every read is separate and every panel renders its own loading, empty,
 * refused and broken state, because a page-level spinner would let one slow
 * endpoint hide four good answers — and an unreadable P&L must not take the
 * borrowing panel down with it.
 *
 * ## Debt against UX's shared components
 *
 * UX-03 (#464)'s metric component, UX-04 (#465)'s visualisation vocabulary,
 * UX-06 (#467)'s tables and UX-07 (#468)'s designed states are not built. So
 * `dashboard/MetricTile` stands in for UX-03, the `.data-table` markup for
 * UX-06 and `RouteProfitChart` for UX-04; only `ui/StateBlock` and `ui/Button`
 * are shared components today. Named here so each is replaced, not copied.
 */

type Load<T> = { state: 'loading' } | { state: 'broken' } | { state: 'ready'; value: T };

function loaded<T>(value: T | null): Load<T> {
  return value === null ? { state: 'broken' } : { state: 'ready', value };
}

/** The unit economics §14.3 names for this dashboard, by the server's own ids. */
const UNIT_ECONOMICS: readonly MetricId[] = ['rask', 'cask', 'yield', 'breakeven_load_factor'];
/** The money the flights made and cost. Payroll and interest sit in the P&L below. */
const MONEY: readonly MetricId[] = ['revenue', 'cost', 'operating_profit'];

/** One of the P&L's four dimensional rollups. */
function DimensionTable({
  title,
  rows,
  note,
  view,
  gameNow,
}: {
  title: string;
  rows: readonly PnlDimensionRow[];
  note: string;
  view: string;
  gameNow: string;
}): ReactNode {
  return (
    <section className="panel" aria-label={title}>
      <div className="panel__head">
        <h3 className="panel__title">{title}</h3>
        {rows.length > 0 && (
          <ExportButton
            view={view}
            gameNow={gameNow}
            table={() => ({
              headers: [
                title,
                csvMoneyHeader('Revenue'),
                csvMoneyHeader('Cost'),
                csvMoneyHeader('Contribution'),
              ],
              // The same rows the table renders, through the same conversion —
              // which is what makes the file agree with the screen (M8-14).
              rows: rows.map((row) => [
                row.key ?? 'Unattributed',
                csvMoney(row.revenueMinor),
                csvMoney(row.costMinor),
                csvMoney(row.operatingProfitMinor),
              ]),
            })}
          />
        )}
      </div>
      {rows.length === 0 ? (
        <StateBlock kind="empty">{note}</StateBlock>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{title}</th>
                <th scope="col" className="data-table__num">
                  Revenue
                </th>
                <th scope="col" className="data-table__num">
                  Cost
                </th>
                <th scope="col" className="data-table__num">
                  Contribution
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key ?? 'unattributed'}>
                  {/*
                    A null key is a real row: the P&L attributes what it can and
                    leaves the rest unattributed rather than dropping it, so the
                    column totals still add up to the statement above.
                  */}
                  <th scope="row">{row.key ?? 'Unattributed'}</th>
                  <td className="data-table__num figure">{formatUsdMinor(row.revenueMinor)}</td>
                  <td className="data-table__num figure">{formatUsdMinor(row.costMinor)}</td>
                  <td
                    className={`data-table__num figure ${row.operatingProfitMinor < 0 ? 'figure--loss' : 'figure--profit'}`}
                  >
                    {/* Colour is paired with a sign glyph, never alone (H.4, H.7). */}
                    <span aria-hidden="true">{row.operatingProfitMinor < 0 ? '▼' : '▲'}</span>{' '}
                    {formatUsdMinor(row.operatingProfitMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A run of metric tiles, each opening through the shared drill-down (SURFACE-06). */
function MetricTiles({
  label,
  ids,
  stats,
  horizon,
}: {
  label: string;
  ids: readonly MetricId[];
  stats: Load<StatisticsResponse>;
  horizon: Horizon;
}): ReactNode {
  if (stats.state === 'loading') {
    return <StateBlock kind="loading">Reading the metrics.</StateBlock>;
  }
  if (stats.state === 'broken') {
    return <StateBlock kind="broken">The metrics could not be read.</StateBlock>;
  }
  const byId = new Map<MetricId, Metric>(stats.value.metrics.map((metric) => [metric.id, metric]));
  const shown = ids.flatMap((id) => {
    const metric = byId.get(id);
    return metric === undefined ? [] : [metric];
  });
  return (
    <div className="tiles" aria-label={label}>
      {shown.map((metric) => (
        <MetricTile
          key={metric.id}
          label={metric.label}
          description={metric.description}
          value={metric.value}
          unit={metric.unit}
          polarity={metric.polarity}
          // The movement over the page's period, so every tile is comparable.
          trend={
            metric.trends.find((trend) => trend.days === horizon) ??
            metric.trends[0] ?? {
              days: horizon,
              value: null,
              previousValue: null,
              changePct: null,
              changeAbsolute: null,
              direction: 'unknown',
            }
          }
          drillDown={metric.drillDown}
          metricId={metric.id}
          metric={metric}
        />
      ))}
    </div>
  );
}

/**
 * The statement's lines, with §13.4's interest **always** present.
 *
 * > Interest accrues per in-game day and appears in the daily P&L as its own
 * > line. It is never hidden in a summary.
 *
 * The P&L only returns categories that had entries in the period, so an
 * airline with no debt would get no interest line at all — and "no line" is
 * exactly how a cost hides. So a zero line is put in its place, and the line is
 * set apart (`data-line="interest"`) wherever it appears.
 */
function statementLines(pnl: FinancePnlResponse): PnlLine[] {
  if (pnl.lines.some((line) => line.category === 'interest')) return pnl.lines;
  return [...pnl.lines, { category: 'interest', amountMinor: 0, entryCount: 0 }];
}

function lineLabel(line: PnlLine): string {
  if (line.category === 'interest') return 'interest';
  // Borrowing is neither revenue nor cost; the server keeps it out of both totals.
  if (line.category === 'debt_draw') return 'borrowed (outside the totals)';
  /*
   * OTHER-01's monthly aircraft lease rent is the first thing ever written to
   * `lease_finance`; its category name alone would not tell a player it is the
   * rent on their leased aeroplanes.
   */
  if (line.category === 'lease_finance') return 'lease finance (aircraft rent)';
  return line.category.replace(/_/g, ' ');
}

function ProfitAndLoss({
  pnl,
  horizon,
}: {
  pnl: Load<FinancePnlResponse>;
  horizon: Horizon;
}): ReactNode {
  return (
    <section className="panel" aria-label="Profit and loss" id="profit-and-loss">
      <div className="panel__head">
        <h3 className="panel__title">Profit and loss</h3>
        {pnl.state === 'ready' && pnl.value.lines.length > 0 && (
          <ExportButton
            view="pnl"
            gameNow={pnl.value.to}
            table={() => ({
              headers: ['Category', csvMoneyHeader('Amount'), 'Entries'],
              rows: [
                ...statementLines(pnl.value).map((line) => [
                  lineLabel(line),
                  csvMoney(line.amountMinor),
                  line.entryCount,
                ]),
                /*
                 * The three totals the screen shows above the table, as rows
                 * rather than a separate file. A statement whose export omits
                 * its own bottom line would send the player back to the screen
                 * to read it, which is the opposite of the point.
                 */
                ['Revenue', csvMoney(pnl.value.revenueMinor), null],
                ['Cost', csvMoney(pnl.value.costMinor), null],
                ['Operating profit', csvMoney(pnl.value.operatingProfitMinor), null],
              ],
            })}
          />
        )}
      </div>
      {pnl.state === 'loading' ? (
        <StateBlock kind="loading">Reading the ledger.</StateBlock>
      ) : pnl.state === 'broken' ? (
        <StateBlock kind="broken">The P&amp;L could not be read.</StateBlock>
      ) : pnl.value.lines.length === 0 ? (
        <StateBlock kind="empty">
          Nothing has been booked in {horizonLabel(horizon)}. Only the worker settles a flight, so
          on a node without one every line here stays empty.
        </StateBlock>
      ) : (
        <>
          <dl className="figures">
            <div className="figures__row">
              <dt>Revenue</dt>
              <dd className="figure">{formatUsdMinor(pnl.value.revenueMinor)}</dd>
            </div>
            <div className="figures__row">
              <dt>Cost</dt>
              <dd className="figure">{formatUsdMinor(pnl.value.costMinor)}</dd>
            </div>
            <div className="figures__row">
              <dt>Operating profit</dt>
              <dd
                className={`figure ${pnl.value.operatingProfitMinor < 0 ? 'figure--loss' : 'figure--profit'}`}
              >
                <span aria-hidden="true">{pnl.value.operatingProfitMinor < 0 ? '▼' : '▲'}</span>{' '}
                {formatUsdMinor(pnl.value.operatingProfitMinor)}
              </dd>
            </div>
          </dl>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="data-table__num">
                    Amount
                  </th>
                  <th scope="col" className="data-table__num">
                    Entries
                  </th>
                </tr>
              </thead>
              <tbody>
                {statementLines(pnl.value).map((line) => (
                  <tr key={line.category} data-line={line.category}>
                    <th scope="row">{lineLabel(line)}</th>
                    <td className="data-table__num figure">{formatUsdMinor(line.amountMinor)}</td>
                    <td className="data-table__num figure">{line.entryCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/*
            §14.1: every number drills to its cause, or says who will make it.
            The totals drill by dimension, just below. A single line into its
            individual ledger entries has no player surface yet — the entries
            are only in the admin console's airline record — and no issue owns
            one; SURFACE-03 records that gap rather than inventing a route.
          */}
          <p className="panel__note">
            {`The game days ${pnl.value.from.slice(0, 10)} to ${pnl.value.to.slice(0, 10)}. Each total breaks down by route, aircraft, hub and cabin below; a line's individual ledger entries have no page yet.`}
          </p>
        </>
      )}
    </section>
  );
}

export function FinancePage(): ReactNode {
  const [horizon, setHorizon] = useState<Horizon>(DEFAULT_HORIZON);
  const [stats, setStats] = useState<Load<StatisticsResponse>>({ state: 'loading' });
  const [credit, setCredit] = useState<Load<CreditStandingResponse>>({ state: 'loading' });
  const [pnl, setPnl] = useState<Load<FinancePnlResponse>>({ state: 'loading' });
  const [profitByRoute, setProfitByRoute] = useState<Load<MetricBreakdownResponse>>({
    state: 'loading',
  });
  /*
   * §14.4's drill-down is fetched per route on a click, never for the whole
   * chart: the competitor cause needs App. A's share model, and three hundred of
   * those on one page load would make this the slowest screen in the game.
   */
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<RouteDiagnosisResponse | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  // Independent of the period: the metrics carry all three horizons, and
  // borrowing is measured over §13.1's twelve months by definition.
  useEffect(() => {
    let live = true;
    void fetchStatistics().then((value) => {
      if (live) setStats(loaded(value));
    });
    void fetchCreditStanding().then((value) => {
      if (live) setCredit(loaded(value));
    });
    return () => {
      live = false;
    };
  }, []);

  // The period's own reads, refetched when the page's period changes.
  useEffect(() => {
    let live = true;
    setPnl({ state: 'loading' });
    setProfitByRoute({ state: 'loading' });
    void fetchProfitAndLoss(horizon).then((value) => {
      if (live) setPnl(loaded(value));
    });
    void fetchBreakdown('operating_profit', horizon).then((value) => {
      if (live) setProfitByRoute(loaded(value));
    });
    return () => {
      live = false;
    };
  }, [horizon]);

  const diagnose = useCallback(async (routeId: string) => {
    setSelectedRoute(routeId);
    setDiagnosing(true);
    setDiagnosis(await fetchRouteDiagnosis(routeId));
    setDiagnosing(false);
  }, []);

  return (
    <HorizonProvider value={horizon}>
      {/*
        `dash-page`: the UX pass's dashboard layout (claude/ux-visual-pass). The
        shell's bare `.page` centres a short note, which pushes a tall page's top
        above the scroll origin, and `.panel` would otherwise inherit the context
        panel's width and blur. Opting in, rather than a second layout here.
      */}
      <section className="page dash-page">
        <div className="finance-head">
          <h1 className="page__title">Finance</h1>
          <HorizonControl value={horizon} onChange={setHorizon} />
        </div>
        <p className="finance-region__lead">
          Am I making money, where, and what is it costing me — over {horizonLabel(horizon)}. Your
          cash runway is in the status strip at the top of every page, and is the loudest number
          there once it drops below 30 days.
        </p>

        {/*
          §14.4 first. It is the chart the design doc says players learn the game
          through, and a player who opens this page to find out why they are
          losing money should not have to scroll past four tables to reach it.
        */}
        <section className="finance-region" aria-labelledby="finance-where">
          <h2 className="finance-region__title" id="finance-where">
            Where the money is made
          </h2>
          <section className="panel" aria-label="Profit by route">
            <h3 className="panel__title">Profit by route</h3>
            {profitByRoute.state === 'loading' ? (
              <StateBlock kind="loading">Ranking your routes.</StateBlock>
            ) : profitByRoute.state === 'broken' ? (
              <StateBlock kind="broken">Profit by route could not be read.</StateBlock>
            ) : (
              <RouteProfitChart
                rows={profitByRoute.value.rows}
                selectedKey={selectedRoute}
                onSelect={(row) => {
                  // A row whose route has been deleted has nothing to diagnose;
                  // `drillDown` is null for exactly that case.
                  if (row.drillDown !== null) void diagnose(row.key);
                }}
              />
            )}
          </section>
          <RouteDiagnosisPanel diagnosis={diagnosis} loading={diagnosing} />
        </section>

        <section className="finance-region" aria-labelledby="finance-headline">
          <h2 className="finance-region__title" id="finance-headline">
            Headline figures
          </h2>
          <section className="panel" aria-label="Money">
            <h3 className="panel__title">Money</h3>
            <MetricTiles label="Money figures" ids={MONEY} stats={stats} horizon={horizon} />
          </section>
          <section className="panel" aria-label="Unit economics">
            <h3 className="panel__title">Unit economics</h3>
            <MetricTiles
              label="Unit economics figures"
              ids={UNIT_ECONOMICS}
              stats={stats}
              horizon={horizon}
            />
          </section>
        </section>

        <section className="finance-region" aria-labelledby="finance-costing">
          <h2 className="finance-region__title" id="finance-costing">
            What it is costing
          </h2>
          <ProfitAndLoss pnl={pnl} horizon={horizon} />

          {pnl.state === 'ready' && (
            <>
              <DimensionTable
                title="By route"
                view="pnl-by-route"
                gameNow={pnl.value.to}
                rows={pnl.value.byRoute}
                note={`No route has settled a flight in ${horizonLabel(horizon)}.`}
              />
              <DimensionTable
                title="By aircraft"
                view="pnl-by-aircraft"
                gameNow={pnl.value.to}
                rows={pnl.value.byAircraft}
                note={`No airframe has settled a flight in ${horizonLabel(horizon)}.`}
              />
              <DimensionTable
                title="By hub"
                view="pnl-by-hub"
                gameNow={pnl.value.to}
                rows={pnl.value.byHub}
                note={`Nothing is attributed to a hub in ${horizonLabel(horizon)}.`}
              />
              <DimensionTable
                title="By cabin class"
                view="pnl-by-cabin-class"
                gameNow={pnl.value.to}
                rows={pnl.value.byCabinClass}
                note={`No cabin-class split has been recorded in ${horizonLabel(horizon)}.`}
              />
            </>
          )}
        </section>

        <section className="finance-region" aria-labelledby="finance-borrowing">
          <h2 className="finance-region__title" id="finance-borrowing">
            Borrowing
          </h2>
          <p className="finance-region__lead">
            Measured over the last twelve game months whatever the period above: §13.1’s capacity is
            a function of a year’s demonstrated profit.
          </p>
          {credit.state === 'loading' ? (
            <StateBlock kind="loading">Reading your credit standing.</StateBlock>
          ) : credit.state === 'broken' ? (
            <StateBlock kind="broken">Your credit standing could not be read.</StateBlock>
          ) : (
            <BorrowingPanel
              credit={credit.value}
              onChange={(next) => {
                setCredit({ state: 'ready', value: next });
              }}
            />
          )}
        </section>

        <section className="finance-region" aria-labelledby="finance-gaps">
          <h2 className="finance-region__title" id="finance-gaps">
            Not on this page yet
          </h2>
          <p className="page__note">
            Profitability by <strong>cargo</strong> is in §14.3&rsquo;s list and is not here:
            settlement splits no revenue between passengers and freight, so a cargo column would be
            an invented number in the middle of a real table.
          </p>
          <ul className="finance-region__lead">
            <li>
              A cash-flow statement, world-median benchmarks (§14.6) and loan repayment have no
              issue yet.
            </li>
            <li>
              Where you stand on the default ladder, and what clears it, gets its own surface in
              LEGACY-11; borrowing above says only the stage.
            </li>
          </ul>
        </section>
      </section>
    </HorizonProvider>
  );
}
