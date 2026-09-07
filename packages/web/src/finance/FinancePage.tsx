import { useCallback, useEffect, useState } from 'react';

import type {
  CreditStandingResponse,
  FinancePnlResponse,
  PnlDimensionRow,
  StatisticsResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { fetchCreditStanding, fetchProfitAndLoss, fetchStatistics } from '../dashboard/api';
import { MetricTile } from '../dashboard/MetricTile';
import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

import '../dashboard/dashboard.css';

/**
 * §14.3's Financial dashboard (M8-10).
 *
 * > **Financial** — full P&L; profitability by **route / aircraft / hub / cabin
 * > class / cargo**; cost breakdown; unit economics: **RASK, CASK, yield,
 * > breakeven load factor**; cash flow and runway; debt schedule, DSCR, interest
 * > drain
 *
 * Where the Executive page answers *"is the airline all right?"*, this one
 * answers *"where did the money go?"* — which is a table, not a tile, so most of
 * it is tables. The unit economics are tiles because §14.6 wants a level and a
 * movement on every headline and these four are headlines.
 *
 * ## What is deliberately absent
 *
 * **Cargo** is in §14.3's list and is not here: `flight_result` records
 * `cargo_kg` but settlement splits no revenue between passengers and freight, so
 * a cargo column would be a made-up number in the middle of a real table. RTK
 * appears on the traffic side, where the tonnage is genuine.
 *
 * **The debt schedule** is a list of loans, not an amortisation table, because
 * nothing amortises yet — M8-07 charges interest and no principal is ever
 * repaid. A schedule would be a promise about payments the game does not make.
 *
 * **§14.4's ranked profit-by-route chart** is M8-11's, deliberately: it is the
 * one chart the design doc says players learn the game through, and it gets its
 * own issue rather than being a panel here.
 */

/** One of the P&L's four dimensional rollups. */
function DimensionTable({
  title,
  rows,
  note,
}: {
  title: string;
  rows: readonly PnlDimensionRow[];
  note: string;
}): ReactNode {
  return (
    <section className="panel" aria-label={title}>
      <h2 className="panel__title">{title}</h2>
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

/** §14.3's "debt schedule, DSCR, interest drain" — what §13 can honestly answer. */
function DebtPanel({ credit }: { credit: CreditStandingResponse }): ReactNode {
  const dailyDrain = credit.standing.dailyInterestMinor;
  return (
    <section className="panel" aria-label="Debt and interest">
      <h2 className="panel__title">Debt</h2>
      <dl className="figures">
        <div className="figures__row">
          <dt>Rating</dt>
          <dd className="figure">{credit.tier}</dd>
        </div>
        <div className="figures__row">
          <dt>Outstanding</dt>
          <dd className="figure">{formatUsdMinor(credit.outstandingDebtMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Headroom</dt>
          <dd className="figure">{formatUsdMinor(credit.headroomMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>DSCR</dt>
          <dd className="figure">
            {credit.dscr === null ? 'no debt' : credit.dscr.toFixed(2)}
            {credit.dscr !== null && credit.dscr < credit.minimumDscr && (
              <span className="chip chip--warn">below {credit.minimumDscr.toFixed(2)} floor</span>
            )}
          </dd>
        </div>
        <div className="figures__row">
          {/* §13.4's drain, per in-game day, which is how it is actually charged. */}
          <dt>Interest drain</dt>
          <dd className="figure">{formatUsdMinor(dailyDrain)} / game day</dd>
        </div>
        {credit.standing.arrearsMinor > 0 && (
          <div className="figures__row">
            <dt>Arrears</dt>
            <dd className="figure">
              {formatUsdMinor(credit.standing.arrearsMinor)}
              <span className="chip chip--warn">{credit.standing.stage.replace('_', ' ')}</span>
            </dd>
          </div>
        )}
      </dl>

      {credit.loans.length === 0 ? (
        <StateBlock kind="empty">Nothing borrowed.</StateBlock>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col" className="data-table__num">
                  Outstanding
                </th>
                <th scope="col" className="data-table__num">
                  Rate
                </th>
                <th scope="col" className="data-table__num">
                  Per day
                </th>
              </tr>
            </thead>
            <tbody>
              {credit.loans.map((loan) => (
                <tr key={loan.id}>
                  <th scope="row">{loan.instrument.replace('_', ' ')}</th>
                  <td className="data-table__num figure">
                    {formatUsdMinor(loan.outstandingMinor)}
                  </td>
                  <td className="data-table__num figure">
                    {(loan.annualRateBps / 100).toFixed(2)}%
                  </td>
                  <td className="data-table__num figure">
                    {formatUsdMinor(loan.dailyInterestMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="panel__note">
        A list, not an amortisation schedule: nothing repays principal yet, so a payment timetable
        would promise something the game does not do.
      </p>
    </section>
  );
}

export function FinancePage(): ReactNode {
  const [pnl, setPnl] = useState<FinancePnlResponse | null>(null);
  const [stats, setStats] = useState<StatisticsResponse | null>(null);
  const [credit, setCredit] = useState<CreditStandingResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [nextPnl, nextStats, nextCredit] = await Promise.all([
      fetchProfitAndLoss(),
      fetchStatistics(),
      fetchCreditStanding(),
    ]);
    setPnl(nextPnl);
    setStats(nextStats);
    setCredit(nextCredit);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unitEconomics = (stats?.metrics ?? []).filter((metric) =>
    ['rask', 'cask', 'yield', 'breakeven_load_factor'].includes(metric.id),
  );

  return (
    <section className="page">
      <h1 className="page__title">Finance</h1>

      {loading ? (
        <StateBlock kind="loading">Reading the ledger.</StateBlock>
      ) : (
        <>
          <section className="panel" aria-label="Unit economics">
            <h2 className="panel__title">Unit economics</h2>
            {stats === null ? (
              <StateBlock kind="broken">The metrics could not be read.</StateBlock>
            ) : (
              <div className="tiles">
                {unitEconomics.map((metric) => (
                  <MetricTile
                    key={metric.id}
                    label={metric.label}
                    description={metric.description}
                    value={metric.value}
                    unit={metric.unit}
                    polarity={metric.polarity}
                    trend={
                      metric.trends.find((trend) => trend.days === 30) ??
                      metric.trends[0] ?? {
                        days: 30,
                        value: null,
                        previousValue: null,
                        changePct: null,
                        changeAbsolute: null,
                        direction: 'unknown',
                      }
                    }
                    drillDown={metric.drillDown}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="panel" aria-label="Profit and loss">
            <h2 className="panel__title">Profit and loss</h2>
            {pnl === null ? (
              <StateBlock kind="broken">The P&amp;L could not be read.</StateBlock>
            ) : pnl.lines.length === 0 ? (
              <StateBlock kind="empty">
                Nothing has been booked in this period. Only the worker settles a flight, so on a
                node without one every line here stays empty.
              </StateBlock>
            ) : (
              <>
                <dl className="figures">
                  <div className="figures__row">
                    <dt>Revenue</dt>
                    <dd className="figure">{formatUsdMinor(pnl.revenueMinor)}</dd>
                  </div>
                  <div className="figures__row">
                    <dt>Cost</dt>
                    <dd className="figure">{formatUsdMinor(pnl.costMinor)}</dd>
                  </div>
                  <div className="figures__row">
                    <dt>Operating profit</dt>
                    <dd
                      className={`figure ${pnl.operatingProfitMinor < 0 ? 'figure--loss' : 'figure--profit'}`}
                    >
                      <span aria-hidden="true">{pnl.operatingProfitMinor < 0 ? '▼' : '▲'}</span>{' '}
                      {formatUsdMinor(pnl.operatingProfitMinor)}
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
                      {pnl.lines.map((line) => (
                        <tr key={line.category}>
                          <th scope="row">{line.category.replace(/_/g, ' ')}</th>
                          <td className="data-table__num figure">
                            {formatUsdMinor(line.amountMinor)}
                          </td>
                          <td className="data-table__num figure">{line.entryCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {pnl !== null && (
            <>
              <DimensionTable
                title="By route"
                rows={pnl.byRoute}
                note="No route has settled a flight in this period."
              />
              <DimensionTable
                title="By aircraft"
                rows={pnl.byAircraft}
                note="No airframe has settled a flight in this period."
              />
              <DimensionTable
                title="By hub"
                rows={pnl.byHub}
                note="Nothing is attributed to a hub in this period."
              />
              <DimensionTable
                title="By cabin class"
                rows={pnl.byCabinClass}
                note="No cabin-class split has been recorded in this period."
              />
            </>
          )}

          {credit === null ? (
            <StateBlock kind="broken">Your credit standing could not be read.</StateBlock>
          ) : (
            <DebtPanel credit={credit} />
          )}

          <p className="page__note">
            Profitability by <strong>cargo</strong> is in §14.3&rsquo;s list and is not here:
            settlement splits no revenue between passengers and freight, so a cargo column would be
            an invented number in the middle of a real table. §14.4&rsquo;s ranked profit-by-route
            chart with its breakeven line is M8-11.
          </p>
        </>
      )}
    </section>
  );
}
