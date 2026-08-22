import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import type {
  AdminAirlineDetailResponse,
  AdminAirlineRoute,
  AdminCashMovementCause,
  FareTable,
} from '@tailfin/shared';

import { fetchAdminAirline } from './api';

import type { ReactNode } from 'react';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; value: AdminAirlineDetailResponse | null }
  | { state: 'failed' };

const CAUSE_LABEL: Record<AdminCashMovementCause, string> = {
  airline_founding: 'Airline founding',
  airline_rebrand: 'Airline rebrand',
  flight_settlement: 'Flight settlement',
  migration_opening_balance: 'Migration opening balance',
};

/** `2026-08-18 14:07` — UTC, as everywhere else in the console. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Integer minor units; the actual currency remains M8-02's decision. */
function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatMovement(minor: number): string {
  const sign = minor > 0 ? '+' : '';
  return `${sign}${formatCash(minor)}`;
}

function formatFares(fares: FareTable): string {
  const entries = Object.entries(fares);
  if (entries.length === 0) return 'none recorded';
  return entries.map(([cabin, amount]) => `${cabin} ${formatCash(amount)}`).join(', ');
}

function RouteRows({ routes }: { routes: AdminAirlineRoute[] }): ReactNode {
  if (routes.length === 0) return <p className="admin__note">No routes recorded.</p>;
  return (
    <table className="admin__table">
      <thead>
        <tr>
          <th scope="col">State</th>
          <th scope="col">Origin</th>
          <th scope="col">Destination</th>
          <th scope="col">Distance</th>
          <th scope="col">Fares</th>
          <th scope="col">Opened</th>
        </tr>
      </thead>
      <tbody>
        {routes.map((route) => (
          <tr key={route.id}>
            <td>{route.active ? 'active' : 'closed'}</td>
            <td>
              <span className="figure">{route.originIcao}</span> · {route.originName}
            </td>
            <td>
              <span className="figure">{route.destinationIcao}</span> · {route.destinationName}
            </td>
            <td className="figure">{route.greatCircleNm.toFixed(0)} nm</td>
            <td>{formatFares(route.fares)}</td>
            <td className="figure">{formatAt(route.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** AIR-10's read-only support record for player and NPC airlines alike. */
export function AdminAirlinePage(): ReactNode {
  const { airlineId } = useParams();
  const [movementOffset, setMovementOffset] = useState(0);
  const [detail, setDetail] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    setDetail({ state: 'loading' });
    void fetchAdminAirline(airlineId ?? '', movementOffset)
      .then((value) => {
        if (live) setDetail({ state: 'ready', value });
      })
      .catch(() => {
        if (live) setDetail({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [airlineId, movementOffset]);

  if (detail.state === 'loading') return <p className="admin__note">Loading…</p>;
  if (detail.state === 'failed') {
    return (
      <p className="admin__note" role="alert">
        Could not load this airline.
      </p>
    );
  }
  if (detail.value === null) {
    return (
      <section className="admin__section">
        <h2 className="admin__heading">Not found</h2>
        <p className="admin__note">No airline with that id.</p>
        <Link className="admin__back" to="/admin/players">
          Back to players
        </Link>
      </section>
    );
  }

  const { airline, cashMovements } = detail.value;
  const movementEnd = Math.min(
    cashMovements.offset + cashMovements.entries.length,
    cashMovements.total,
  );
  const archetype = airline.archetype === null ? '' : ` · ${airline.archetype}`;

  return (
    <>
      <section className="admin__section">
        {airline.owner === null ? (
          <Link className="admin__back" to="/admin/carriers">
            Back to carriers
          </Link>
        ) : (
          <Link className="admin__back" to={`/admin/players/${airline.owner.id}`}>
            Back to {airline.owner.displayName}
          </Link>
        )}
        <h2 className="admin__heading">{airline.name}</h2>
        <p className="admin__note">
          <span className="figure">
            {airline.iataCode} · {airline.icaoCode} · {airline.callsign}
          </span>{' '}
          in {airline.worldName}. {airline.kind === 'npc' ? `NPC${archetype}.` : 'Player airline.'}
        </p>
        <p className="admin__hint">
          Read-only support record. Cash cannot be changed here: every balance change must pass
          through AIR-06 and leave an immutable movement with a cause and reference.
        </p>
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Identity and standing</h3>
        <table className="admin__table">
          <tbody>
            <tr>
              <th scope="row">Owner</th>
              <td>
                {airline.owner === null ? (
                  'NPC'
                ) : (
                  <Link to={`/admin/players/${airline.owner.id}`}>{airline.owner.displayName}</Link>
                )}
              </td>
              <th scope="row">Base country</th>
              <td className="figure">{airline.baseCountry}</td>
            </tr>
            <tr>
              <th scope="row">State</th>
              <td>{airline.status}</td>
              <th scope="row">State since</th>
              <td className="figure">{formatAt(airline.statusChangedAt)}</td>
            </tr>
            <tr>
              <th scope="row">Cash</th>
              <td className="figure">{formatCash(airline.cashMinor)}</td>
              <th scope="row">Reputation</th>
              <td className="figure">{airline.reputation.toFixed(2)}</td>
            </tr>
            <tr>
              <th scope="row">Founded</th>
              <td className="figure">{formatAt(airline.createdAt)}</td>
              <th scope="row">Ceased</th>
              <td className="figure">
                {airline.ceasedAt === null ? '—' : formatAt(airline.ceasedAt)}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="admin__hint">
          Cash is shown without a currency symbol until M8-02 defines one.
        </p>
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Routes ({airline.routes.length})</h3>
        <RouteRows routes={airline.routes} />
        <p className="admin__hint">Closed routes remain visible as airline history.</p>
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Cash movements ({cashMovements.total})</h3>
        {cashMovements.entries.length === 0 ? (
          <p className="admin__note">No cash movements recorded.</p>
        ) : (
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">Game time</th>
                <th scope="col">Cause</th>
                <th scope="col">Reference</th>
                <th scope="col">Movement</th>
                <th scope="col">Balance after</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {cashMovements.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="figure">{formatAt(entry.occurredAt)}</td>
                  <td>{CAUSE_LABEL[entry.cause]}</td>
                  <td className="figure">{entry.reference}</td>
                  <td className="figure">{formatMovement(entry.amountMinor)}</td>
                  <td className="figure">{formatCash(entry.balanceAfterMinor)}</td>
                  <td className="figure">{formatAt(entry.recordedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {cashMovements.total > cashMovements.limit && (
          <div className="admin__form" aria-label="Cash movement pages">
            <button
              className="admin__submit"
              type="button"
              disabled={cashMovements.offset === 0}
              onClick={() => {
                setMovementOffset(Math.max(0, cashMovements.offset - cashMovements.limit));
              }}
            >
              Newer
            </button>
            <span className="admin__note" role="status">
              {cashMovements.offset + 1}–{movementEnd} of {cashMovements.total}
            </span>
            <button
              className="admin__submit"
              type="button"
              disabled={movementEnd >= cashMovements.total}
              onClick={() => {
                setMovementOffset(cashMovements.offset + cashMovements.limit);
              }}
            >
              Older
            </button>
          </div>
        )}
      </section>
    </>
  );
}
