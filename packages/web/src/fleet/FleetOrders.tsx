import type { AircraftOrder } from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import { formatMoney } from './market-model';

import type { ReactNode } from 'react';

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}

/** Pending factory commitments already accepted by authoritative M4-04. */
export function FleetOrders({ orders }: { orders: readonly AircraftOrder[] }): ReactNode {
  const pending = orders.filter((order) => order.status === 'pending');

  if (pending.length === 0) {
    return <StateBlock kind="empty">No aircraft are awaiting delivery.</StateBlock>;
  }

  return (
    <div className="fleet-orders" aria-label="Aircraft awaiting delivery">
      {pending.map((order) => (
        <article className="fleet-order" key={order.id}>
          <div className="fleet-order__heading">
            <div>
              <span className="market__eyebrow">Factory order</span>
              <h3>{order.typeDesignation}</h3>
            </div>
            <span className="fleet-order__status">Awaiting delivery</span>
          </div>
          <dl>
            <div>
              <dt>Accepted</dt>
              <dd>{dateTime(order.orderedAt)}</dd>
            </div>
            <div>
              <dt>Estimated delivery</dt>
              <dd>{dateTime(order.deliveryAt)}</dd>
            </div>
            <div>
              <dt>Delivery airport</dt>
              <dd className="figure">{order.deliveryAirportIcao}</dd>
            </div>
            <div>
              <dt>Configuration</dt>
              <dd>
                {order.buildOptionIds.length === 0
                  ? 'Standard specification'
                  : `${String(order.buildOptionIds.length)} factory option${order.buildOptionIds.length === 1 ? '' : 's'}`}
              </dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd className="figure">{formatMoney(order.chargedMinor)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
