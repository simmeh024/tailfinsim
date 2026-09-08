import { useCallback, useEffect, useState } from 'react';

import { OperationsDashboardResponse } from '@tailfin/shared';

import { activeCurrency } from '../currency/display';
import { csvMoney, type CsvTable } from '../export/csv';
import { ExportButton } from '../export/ExportButton';
import { StateBlock } from '../ui/StateBlock';

import { DelayAttribution } from './DelayAttribution';

import type { ReactNode } from 'react';

import '../dashboard/dashboard.css';

/**
 * §14.3's five operational dashboards (M8-12).
 *
 * Traffic, punctuality, fleet, crew and ground, on one page and in one request.
 * §14.3 lists them as five dashboards; they are five **sections** here because
 * they share one window and one read, and because a player asking *"why was
 * yesterday bad?"* moves between them in one glance rather than through five
 * navigation clicks.
 *
 * ## One chart language (AC3)
 *
 * Every panel, tile, table and chip on this page is M8-10's — imported from
 * `dashboard/dashboard.css` with **no new component classes of its own**.
 * `operations-ui.test.tsx` asserts that: a second visual vocabulary inside one
 * milestone is exactly what §14.6's *"consistent chart language across every
 * dashboard"* rules out, and the way it happens is somebody adding one page
 * with its own idea of a bar.
 *
 * The one thing this page adds is `DelayAttribution`, which reuses the profit
 * chart's own row-and-bar markup rather than inventing a second bar.
 */

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/**
 * A plain count, grouped.
 *
 * `en-US` explicitly, not the environment's locale, because `currency/display.ts`
 * already pins it for money — and a page where the passenger count groups with
 * dots while the money beside it groups with commas is the inconsistency §14.6's
 * one chart language is about. Display *currency* is the player's choice (M8-02);
 * digit grouping is not, and mixing the two conventions in one row is worse than
 * either.
 */
function num(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** A labelled figure row — M8-10's `figures` block, reused. */
function Figure({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="figures__row">
      <dt>{label}</dt>
      <dd className="figure">{children}</dd>
    </div>
  );
}

function TrafficPanel({ data }: { data: OperationsDashboardResponse }): ReactNode {
  const traffic = data.traffic;
  return (
    <section className="panel" aria-label="Traffic and commercial">
      <h2 className="panel__title">Traffic</h2>
      <dl className="figures">
        <Figure label="Passengers">{num(traffic.passengers)}</Figure>
        <Figure label="Cargo">{num(traffic.cargoTonnes, 1)} t</Figure>
        <Figure label="Load factor">{pct(traffic.loadFactor)}</Figure>
        <Figure label="ASK">{num(traffic.askKm)} km</Figure>
        <Figure label="RPK">{num(traffic.rpkKm)} km</Figure>
        <Figure label="RTK">{num(traffic.rtkKm, 1)} t·km</Figure>
        {/*
          M8-12's second criterion: spill as *passengers turned away*. The count
          leads and the rate follows it — a rate says you are losing 8% of
          something, a count says you turned away 1,240 people, which is a
          decision rather than an observation.
        */}
        <Figure label="Turned away">
          {num(traffic.spilledPassengers)} passengers
          {traffic.spilledPassengers > 0 && (
            <span className="chip chip--warn">{pct(traffic.spillRate)} of demand</span>
          )}
        </Figure>
      </dl>
    </section>
  );
}

function PunctualityPanel({ data }: { data: OperationsDashboardResponse }): ReactNode {
  const p = data.punctuality;
  return (
    <section className="panel" aria-label="Punctuality">
      <h2 className="panel__title">Punctuality</h2>
      <dl className="figures">
        <Figure label="On time (D0)">{pct(p.onTimeD0)}</Figure>
        <Figure label="On time (D15)">{pct(p.onTimeD15)}</Figure>
        <Figure label="Cancelled">
          {num(p.cancelledFlights)}
          {p.cancellationRate !== null && (
            <span className="chip chip--warn">{pct(p.cancellationRate)} of schedule</span>
          )}
        </Figure>
        <Figure label="Delay">{num(p.totalDelayMinutes)} min</Figure>
      </dl>
      <DelayAttribution punctuality={p} />
    </section>
  );
}

function FleetPanel({ data }: { data: OperationsDashboardResponse }): ReactNode {
  const fleet = data.fleet;
  return (
    <section className="panel" aria-label="Fleet and maintenance">
      <h2 className="panel__title">Fleet</h2>
      <dl className="figures">
        <Figure label="Airframes">{num(fleet.airframes)}</Figure>
        <Figure label="AOG">
          {num(fleet.aogCount)}
          {fleet.aogCount > 0 && <span className="chip chip--warn">grounded</span>}
        </Figure>
        <Figure label="In check">{num(fleet.inCheck)}</Figure>
        <Figure label="Utilisation">
          {fleet.blockHoursPerDay === null ? '—' : `${fleet.blockHoursPerDay.toFixed(1)} h/day`}
        </Figure>
        <Figure label="Cost per block hour">
          {fleet.costPerBlockHourMinor === null
            ? '—'
            : `${num(fleet.costPerBlockHourMinor / 100, 2)} per hour`}
        </Figure>
      </dl>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Age</th>
              <th scope="col" className="data-table__num">
                Airframes
              </th>
            </tr>
          </thead>
          <tbody>
            {fleet.ageProfile.map((band) => (
              <tr key={band.label}>
                <th scope="row">{band.label}</th>
                <td className="data-table__num figure">{num(band.airframes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CrewPanel({ data }: { data: OperationsDashboardResponse }): ReactNode {
  const crew = data.crew;
  return (
    <section className="panel" aria-label="Crew">
      <h2 className="panel__title">Crew</h2>
      <dl className="figures">
        <Figure label="Headcount">{num(crew.headcount)}</Figure>
        <Figure label="Reserve coverage">{pct(crew.reserveCoverage)}</Figure>
        <Figure label="In training">{num(crew.converting)}</Figure>
      </dl>

      {crew.byRank.length === 0 ? (
        <StateBlock kind="empty">No crew hired yet.</StateBlock>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col" className="data-table__num">
                  Heads
                </th>
                <th scope="col" className="data-table__num">
                  On duty
                </th>
                <th scope="col" className="data-table__num">
                  Reserve
                </th>
                <th scope="col" className="data-table__num">
                  Sick
                </th>
              </tr>
            </thead>
            <tbody>
              {crew.byRank.map((rank) => (
                <tr key={rank.rank}>
                  <th scope="row">{rank.rank.replace(/_/g, ' ')}</th>
                  <td className="data-table__num figure">{num(rank.headcount)}</td>
                  <td className="data-table__num figure">{num(rank.onDuty)}</td>
                  <td className="data-table__num figure">{num(rank.reserve)}</td>
                  <td className="data-table__num figure">{num(rank.sick)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {crew.moraleByBase.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Base</th>
                <th scope="col" className="data-table__num">
                  Morale
                </th>
                <th scope="col" className="data-table__num">
                  Heads
                </th>
              </tr>
            </thead>
            <tbody>
              {crew.moraleByBase.map((base) => (
                <tr key={base.airportIcao}>
                  <th scope="row">{base.airportIcao}</th>
                  <td className="data-table__num figure">
                    {/*
                      Null is "never reviewed", not zero — the reading
                      `crew_base.morale` has carried since M5-03. Saying so is
                      the difference between a missing worker and unhappy crew.
                    */}
                    {base.morale === null ? 'not reviewed' : pct(base.morale)}
                  </td>
                  <td className="data-table__num figure">{num(base.headcount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GroundPanel({ data }: { data: OperationsDashboardResponse }): ReactNode {
  const ground = data.ground;
  return (
    <section className="panel" aria-label="Ground and vendors">
      <h2 className="panel__title">Ground</h2>
      <dl className="figures">
        <Figure label="Contracts">{num(ground.activeContracts)}</Figure>
        <Figure label="Self-handled">{num(ground.selfHandledStations)} stations</Figure>
      </dl>
      {ground.expiries.length === 0 ? (
        <StateBlock kind="empty">No handling contract is running.</StateBlock>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Station</th>
                <th scope="col">Line</th>
                <th scope="col">Grade</th>
                <th scope="col" className="data-table__num">
                  Lapses in
                </th>
              </tr>
            </thead>
            <tbody>
              {ground.expiries.map((row) => (
                <tr key={`${row.airportIcao}-${row.serviceLine}`}>
                  <th scope="row">{row.airportIcao}</th>
                  <td>{row.serviceLine.replace(/_/g, ' ')}</td>
                  <td>{row.grade}</td>
                  <td className="data-table__num figure">
                    {row.daysRemaining === null ? 'no term' : `${num(row.daysRemaining)} game days`}
                    {row.daysRemaining !== null && row.daysRemaining <= 14 && (
                      <span className="chip chip--warn">soon</span>
                    )}
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

/**
 * The whole operational picture as one metric-per-row table (M8-14).
 *
 * Flat "Metric, Value, Unit" rather than a column per figure, because these five
 * panels have nothing in common to make columns out of — a load factor, an AOG
 * count and a cost per block hour share no axis. One row each is what a
 * spreadsheet can actually pivot.
 *
 * `null` stays `null` all the way through: a load factor with no flights is
 * *unmeasured*, and exporting it as `0` would claim an empty month was a
 * catastrophic one.
 */
function operationsCsv(data: OperationsDashboardResponse): CsvTable {
  const rows: (string | number | null)[][] = [
    ['Window', data.windowDays, 'game days'],
    ['Settled flights', data.flights, 'count'],
    ['Passengers', data.traffic.passengers, 'count'],
    ['Cargo', data.traffic.cargoTonnes, 'tonnes'],
    ['ASK', data.traffic.askKm, 'seat-km'],
    ['RPK', data.traffic.rpkKm, 'passenger-km'],
    ['RTK', data.traffic.rtkKm, 'tonne-km'],
    ['Load factor', data.traffic.loadFactor, 'ratio'],
    ['Spilled passengers', data.traffic.spilledPassengers, 'count'],
    ['Spill rate', data.traffic.spillRate, 'ratio'],
    ['Yield', csvMoney(data.traffic.yieldMinor), activeCurrency()],
    // §14.3 asks for both gates, and they are different claims: D0 is
    // wheels-up on the minute, D15 is the industry's fifteen-minute grace.
    ['On-time performance (D0)', data.punctuality.onTimeD0, 'ratio'],
    ['On-time performance (D15)', data.punctuality.onTimeD15, 'ratio'],
    ['Cancellation rate', data.punctuality.cancellationRate, 'ratio'],
    ['Cancelled flights', data.punctuality.cancelledFlights, 'count'],
    ['Total delay', data.punctuality.totalDelayMinutes, 'minutes'],
    ['Airframes', data.fleet.airframes, 'count'],
    ['AOG', data.fleet.aogCount, 'count'],
    ['In check', data.fleet.inCheck, 'count'],
    ['Block hours per day', data.fleet.blockHoursPerDay, 'hours'],
    ['Cost per block hour', csvMoney(data.fleet.costPerBlockHourMinor), activeCurrency()],
    ['Crew headcount', data.crew.headcount, 'count'],
    ['Reserve coverage', data.crew.reserveCoverage, 'ratio'],
    ['Crew converting', data.crew.converting, 'count'],
    ['Active ground contracts', data.ground.activeContracts, 'count'],
    ['Self-handled stations', data.ground.selfHandledStations, 'count'],
    ['Product score', data.productScore, 'ratio'],
    ['Reputation', data.reputation, 'ratio'],
    ['Revenue', csvMoney(data.revenueMinor), activeCurrency()],
    ['Cost', csvMoney(data.costMinor), activeCurrency()],
  ];

  // Delay causes are the one genuinely tabular thing on the page, so they are
  // appended as their own rows rather than dropped.
  for (const cause of data.punctuality.byCause) {
    rows.push([`Delay — ${cause.cause.replace(/_/g, ' ')}`, cause.minutes, 'minutes']);
  }

  return { headers: ['Metric', 'Value', 'Unit'], rows };
}

export function OperationsPage(): ReactNode {
  const [data, setData] = useState<OperationsDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/statistics/operations', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setData(null);
      } else {
        // Parsed, never cast: a page of numbers renders `NaN` beside a unit
        // rather than degrading, and a `.map` on a moved shape takes it down.
        const parsed = OperationsDashboardResponse.safeParse(await response.json());
        setData(parsed.success ? parsed.data : null);
      }
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page">
      <h1 className="page__title">Operations</h1>

      {loading ? (
        <StateBlock kind="loading">Reading the last month.</StateBlock>
      ) : data === null ? (
        <StateBlock kind="broken">
          The operational figures could not be read. Nothing is wrong with your airline — this page
          is.
        </StateBlock>
      ) : (
        <>
          <p className="page__note">
            The last {data.windowDays} game days, from {num(data.flights)} settled{' '}
            {data.flights === 1 ? 'flight' : 'flights'}. Only the worker settles a flight, so on a
            node without one every figure here stays at zero however much is scheduled.
          </p>

          <div className="panel__head panel__head--bare">
            <h2 className="visually-hidden">Export</h2>
            <ExportButton
              view="operations"
              gameNow={data.gameNow}
              label="Export operations CSV"
              table={() => operationsCsv(data)}
            />
          </div>

          <div className="panel-pair">
            <TrafficPanel data={data} />
            <PunctualityPanel data={data} />
          </div>

          <FleetPanel data={data} />
          <CrewPanel data={data} />
          <GroundPanel data={data} />

          <p className="page__note">
            §14.3 asks for more than this page shows, and the gaps are named rather than filled: a{' '}
            <strong>booking curve</strong> needs bookings modelled over time,
            <strong> vendor scorecards</strong> need turnaround measured against contract, and
            <strong> satisfaction by class</strong> needs a per-cabin survey. None of the three
            exists, and inventing them would be worse than their absence.
          </p>
        </>
      )}
    </section>
  );
}
