import { useEffect, useState } from 'react';

import type {
  AirframeDetailResponse,
  AircraftOrderListResponse,
  FleetAirframesResponse,
  FleetCatalogueResponse,
} from '@tailfin/shared';

import { AirframeDetail } from './AirframeDetail';
import {
  fetchAircraftOrders,
  fetchAirframeDetail,
  fetchFleetAirframes,
  fetchFleetCatalogue,
} from './api';
import { FleetMarket } from './FleetMarket';
import { FleetOrders } from './FleetOrders';
import { FleetTable } from './FleetTable';

import type { ReactNode } from 'react';

/**
 * The aircraft catalogue, as this world sees it (M4-02, §7.2b).
 *
 * §7.2b's promise is that the fleet meta *changes underneath everyone
 * simultaneously* — so the first thing a player needs from this page is not a
 * specification table but an answer to *"what can I fly, and what is coming?"*
 *
 * Two decisions carry that:
 *
 *   - **Arriving types are listed, not hidden.** M4-02's second acceptance
 *     criterion. A prototype with a date is a plan; a prototype that is absent
 *     is a surprise.
 *   - **Nothing before its first flight appears at all.** The server does that
 *     filtering, and it is stronger than hiding: §7.2b says an aircraft *does
 *     not exist* in a world whose clock has not reached it, and a 1950s world
 *     that greyed out an A350 would be telling a player about a future their
 *     world does not have.
 *
 * Every state and every figure here is the server's. The client cannot compute
 * availability — lint forbids `packages/web` importing `@tailfin/sim`, so it
 * could not reach `availabilityOf` even by accident, which is exactly the point
 * (§21).
 *
 * ## Two lists, and the owned one comes first (M4-07)
 *
 * The airframe list is what *this airline* actually owns; the catalogue is what
 * the world offers. The fleet goes above, because a player who opens this page
 * usually has a decision about an aeroplane they already have rather than one
 * they might buy — and the fleet table is sorted so the decision is the first
 * row.
 *
 * The two lists load independently. A catalogue that fails must not hide the
 * fleet, and an empty fleet is a real state rather than an error: a player who
 * has not bought anything yet is exactly who most needs the catalogue.
 */

export function FleetPage(): ReactNode {
  const [catalogue, setCatalogue] = useState<FleetCatalogueResponse | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [fleet, setFleet] = useState<FleetAirframesResponse | null>(null);
  const [fleetFailed, setFleetFailed] = useState(false);
  const [orders, setOrders] = useState<AircraftOrderListResponse | null>(null);
  const [ordersFailed, setOrdersFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AirframeDetailResponse | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchFleetCatalogue()
      .then((value) => {
        if (live) setCatalogue(value);
      })
      .catch(() => {
        if (live) setCatalogueFailed(true);
      });
    void fetchFleetAirframes()
      .then((value) => {
        if (live) setFleet(value);
      })
      .catch(() => {
        if (live) setFleetFailed(true);
      });
    void fetchAircraftOrders()
      .then((value) => {
        if (live) setOrders(value);
      })
      .catch(() => {
        if (live) setOrdersFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailFailed(false);
      return;
    }
    let live = true;
    // Cleared first, so the previous aircraft's specification is never on screen
    // under the new one's registration while the request is in flight.
    setDetail(null);
    setDetailFailed(false);
    void fetchAirframeDetail(selectedId)
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch(() => {
        if (live) setDetailFailed(true);
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  return (
    <section className="admin__section">
      <h1 className="page__title">Fleet</h1>

      <h2 className="fleet__section-heading">Your aircraft</h2>
      {fleetFailed ? (
        <p className="admin__note" role="alert">
          Could not load your fleet.
        </p>
      ) : fleet === null ? (
        <p className="admin__note">Loading your fleet…</p>
      ) : (
        <FleetTable airframes={fleet.airframes} selectedId={selectedId} onSelect={setSelectedId} />
      )}

      {selectedId !== null &&
        (detailFailed ? (
          <p className="admin__note" role="alert">
            Could not load that aircraft.
          </p>
        ) : detail === null ? (
          <p className="admin__note">Loading aircraft…</p>
        ) : (
          <AirframeDetail
            detail={detail}
            onClose={() => {
              setSelectedId(null);
            }}
          />
        ))}

      <h2 className="fleet__section-heading">Open orders</h2>
      {ordersFailed ? (
        <p className="admin__note" role="alert">
          Could not load your aircraft orders.
        </p>
      ) : orders === null ? (
        <p className="admin__note">Loading your aircraft orders…</p>
      ) : (
        <FleetOrders orders={orders.orders} />
      )}

      <h2 className="fleet__section-heading">Catalogue</h2>
      {catalogueFailed ? (
        <p className="admin__note" role="alert">
          Could not load the aircraft catalogue.
        </p>
      ) : catalogue === null ? (
        <p className="admin__note">Loading the catalogue…</p>
      ) : catalogue.types.length === 0 ? (
        // The 1950s world: a real state, and a very different one from a
        // failed request.
        <p className="admin__note">
          No aircraft type has flown yet in this world. Nothing in the catalogue exists at this
          date.
        </p>
      ) : (
        <FleetMarket
          catalogue={catalogue}
          onAcquired={(acquisition) => {
            // Lease and used delivery are immediate; new orders stay pending.
            // Refreshing is harmless in both cases and keeps the owned list in
            // sync without making the market own M4-07's state.
            if (acquisition.airframe !== null) {
              void fetchFleetAirframes()
                .then(setFleet)
                .catch(() => setFleetFailed(true));
            }
            void fetchAircraftOrders()
              .then((value) => {
                setOrders(value);
                setOrdersFailed(false);
              })
              .catch(() => setOrdersFailed(true));
          }}
        />
      )}
    </section>
  );
}
