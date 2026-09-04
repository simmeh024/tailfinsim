import { useEffect, useState } from 'react';

import type { HubConnectionBank, HubConnectionsResponse, HubTerminalFlight } from '@tailfin/shared';

import { StateBlock } from '../../ui/StateBlock';
import { fetchHubConnections } from '../api';

import { Chip, Meter, StatTile } from './ui';

import type { ReactNode } from 'react';

/**
 * The Connections view — how well your hub banks for onward connections (§7.4).
 *
 * A network-level read, not a route's: it asks the whole schedule at your hub
 * *"do my arrivals feed my departures?"*. Every figure comes from the server's
 * timing analysis over the flights the worker has materialised — this page
 * computes nothing, it lays the answer out.
 *
 * Empty is a real answer, not an error: until a rotation is published and the
 * worker turns it into flights, there is nothing to connect, and the page says so
 * rather than showing a broken grid.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The times are game-time instants anchored at UTC; render them in UTC so the
 * clock a player sees does not depend on the machine's timezone.
 */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

export function HubConnectionsView(): ReactNode {
  const [data, setData] = useState<HubConnectionsResponse | 'loading' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    setData('loading');
    fetchHubConnections()
      .then((response) => {
        if (live) setData(response);
      })
      .catch(() => {
        if (live) setData('error');
      });
    return () => {
      live = false;
    };
  }, []);

  if (data === 'loading') {
    return <StateBlock kind="loading">Loading your hub…</StateBlock>;
  }
  if (data === 'error') {
    return <StateBlock kind="broken">Could not load your hub connections.</StateBlock>;
  }

  if (data.inboundFlights === 0 && data.outboundFlights === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Connections at {data.hubIcao}</h2>
        </div>
        <StateBlock kind="empty">
          Nothing is scheduled through your hub yet. Publish a rotation on the Schedule tab, and
          once it is flying this will show how your arrivals and departures bank for connections.
        </StateBlock>
      </section>
    );
  }

  const connectingRate =
    data.inboundFlights === 0 ? null : data.connectingInbound / data.inboundFlights;

  return (
    <div className="net-performance">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Connections at {data.hubIcao}</h2>
        <span className="net-panel__hint">
          {data.minConnectMinutes}–{data.maxConnectMinutes} min connect window · next{' '}
          {data.horizonDays} {data.horizonDays === 1 ? 'day' : 'days'}
        </span>
      </div>

      <div className="net-tiles">
        <StatTile label="Arrivals" value={data.inboundFlights} tone="neutral" />
        <StatTile label="Departures" value={data.outboundFlights} tone="neutral" />
        <StatTile
          label="Feasible connections"
          value={data.feasibleConnections}
          tone={data.feasibleConnections > 0 ? 'positive' : 'neutral'}
          sub={
            connectingRate === null
              ? undefined
              : `${(connectingRate * 100).toFixed(0)}% of arrivals connect onward`
          }
          tip="Inbound → outbound pairs that leave inside the connect window. A flight straight back to the city you arrived from is not counted."
        />
        <StatTile
          label="Dead-end arrivals"
          value={data.deadEndArrivalCount}
          tone={data.deadEndArrivalCount > 0 ? 'warn' : 'positive'}
          tip="Arrivals whose passengers can reach nothing onward inside the window — a leg you might retime."
        />
        <StatTile
          label="Unfed departures"
          value={data.unfedDepartureCount}
          tone={data.unfedDepartureCount > 0 ? 'warn' : 'positive'}
          tip="Departures that no arrival can feed — a bank that starts cold."
        />
      </div>

      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Banks</h3>
          <span className="net-panel__hint">
            {data.banks.length} {data.banks.length === 1 ? 'wave' : 'waves'} of activity
          </span>
        </div>
        <table className="admin__table net-comp-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Arrivals</th>
              <th scope="col">Departures</th>
              <th scope="col">Connections</th>
            </tr>
          </thead>
          <tbody>
            {data.banks.map((bank) => (
              <BankRow key={bank.startUtc} bank={bank} />
            ))}
          </tbody>
        </table>
      </section>

      {data.deadEndArrivals.length > 0 && (
        <TerminalList
          title="Arrivals that connect to nothing"
          caption="onward"
          flights={data.deadEndArrivals}
          total={data.deadEndArrivalCount}
          verb="from"
        />
      )}
      {data.unfedDepartures.length > 0 && (
        <TerminalList
          title="Departures nothing feeds"
          caption="feeding"
          flights={data.unfedDepartures}
          total={data.unfedDepartureCount}
          verb="to"
        />
      )}
    </div>
  );
}

function BankRow({ bank }: { bank: HubConnectionBank }): ReactNode {
  const sameDay = dayLabel(bank.startUtc) === dayLabel(bank.endUtc);
  const when = sameDay
    ? `${dayLabel(bank.startUtc)} ${hhmm(bank.startUtc)}–${hhmm(bank.endUtc)}`
    : `${dayLabel(bank.startUtc)} ${hhmm(bank.startUtc)} – ${dayLabel(bank.endUtc)} ${hhmm(bank.endUtc)}`;
  const density = bank.arrivals === 0 ? 0 : Math.min(1, bank.connections / bank.arrivals);
  return (
    <tr>
      <th scope="row">{when}</th>
      <td className="figure">{bank.arrivals}</td>
      <td className="figure">{bank.departures}</td>
      <td>
        <div className="net-comp-product">
          <Meter value={density} tone="accent" />
          <span className="figure">{bank.connections}</span>
        </div>
      </td>
    </tr>
  );
}

function TerminalList({
  title,
  caption,
  flights,
  total,
  verb,
}: {
  title: string;
  caption: string;
  flights: readonly HubTerminalFlight[];
  total: number;
  verb: 'from' | 'to';
}): ReactNode {
  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h3 className="net-panel__title">{title}</h3>
        {total > flights.length && (
          <span className="net-panel__hint">
            showing {flights.length} of {total}
          </span>
        )}
      </div>
      <ul className="net-terminal-list">
        {flights.map((flight) => (
          <li key={flight.flightId} className="net-terminal-list__item">
            <Chip tone="warn">no {caption} link</Chip>
            <span className="net-terminal-list__pair">
              {verb} {flight.spokeIcao}
            </span>
            <span className="net-terminal-list__time figure">
              {dayLabel(flight.atUtc)} {hhmm(flight.atUtc)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
