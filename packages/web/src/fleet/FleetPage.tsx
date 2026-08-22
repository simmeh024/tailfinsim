import { useEffect, useState } from 'react';

import type {
  AircraftAvailabilityState,
  AirframeDetailResponse,
  CatalogueEntry,
  FleetAirframesResponse,
  FleetCatalogueResponse,
} from '@tailfin/shared';

import { AirframeDetail } from './AirframeDetail';
import { fetchAirframeDetail, fetchFleetAirframes, fetchFleetCatalogue } from './api';
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

const STATE_LABEL: Record<AircraftAvailabilityState, string> = {
  unannounced: 'Not yet flying',
  prototype: 'In testing',
  orderable: 'Available',
  used_only: 'Used only',
  retired: 'Withdrawn',
};

/** Order the list reads in: what you can buy, what is coming, what is fading. */
const STATE_ORDER: AircraftAvailabilityState[] = [
  'orderable',
  'prototype',
  'used_only',
  'retired',
  'unannounced',
];

function money(minor: number | null): string {
  if (minor === null) return '—';
  const major = Math.round(minor / 100);
  return major >= 1_000_000 ? `${String(Math.round(major / 1_000_000))}M` : String(major);
}

function TypeRow({ entry }: { entry: CatalogueEntry }): ReactNode {
  return (
    <tr data-availability={entry.availability}>
      <td>
        <strong>{entry.designation}</strong>
        <br />
        <span className="node__commit">{entry.manufacturer}</span>
      </td>
      <td>
        {STATE_LABEL[entry.availability]}
        {/* The date, where there is one. M4-02: visible with their EIS date. */}
        {entry.arrivesOn !== null && (
          <>
            <br />
            <span className="node__commit">arrives {entry.arrivesOn}</span>
          </>
        )}
      </td>
      <td className="figure">{entry.seatsTwoClass > 0 ? entry.seatsTwoClass : '—'}</td>
      <td className="figure">{entry.rangeNm}</td>
      <td className="figure">{entry.runwayRequirementM}</td>
      <td className="figure">{entry.wingspanCode}</td>
      <td className="figure">{money(entry.listPrice)}</td>
      <td>
        {/* The server's sentence, rendered verbatim — never re-derived here. */}
        {entry.detail}
        {entry.restrictions.length > 0 && (
          <ul className="admin__errors">
            {entry.restrictions.map((restriction) => (
              <li key={`${restriction.kind}-${restriction.since}`}>
                {restriction.note} (+{money(restriction.amountMinor)} a departure since{' '}
                {restriction.since})
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

export function FleetPage(): ReactNode {
  const [catalogue, setCatalogue] = useState<FleetCatalogueResponse | null>(null);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const [fleet, setFleet] = useState<FleetAirframesResponse | null>(null);
  const [fleetFailed, setFleetFailed] = useState(false);
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

  const sorted =
    catalogue === null
      ? []
      : [...catalogue.types].sort(
          (a, b) =>
            STATE_ORDER.indexOf(a.availability) - STATE_ORDER.indexOf(b.availability) ||
            a.seatsTwoClass - b.seatsTwoClass,
        );

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

      <h2 className="fleet__section-heading">Catalogue</h2>
      {catalogueFailed ? (
        <p className="admin__note" role="alert">
          Could not load the aircraft catalogue.
        </p>
      ) : catalogue === null ? (
        <p className="admin__note">Loading the catalogue…</p>
      ) : (
        <>
          <p className="admin__hint">
            The aircraft catalogue as of {new Date(catalogue.inGameDate).toISOString().slice(0, 10)}{' '}
            in this world. An aircraft that has not yet flown does not appear at all — types arrive
            on their real dates, and the ones still in testing are listed with the date they enter
            service.
          </p>

          {sorted.length === 0 ? (
            // The 1950s world: a real state, and a very different one from a
            // failed request.
            <p className="admin__note">
              No aircraft type has flown yet in this world. Nothing in the catalogue exists at this
              date.
            </p>
          ) : (
            <table>
              <caption>
                {String(sorted.length)} types, available first. Seats are a two-class layout; a dash
                means a freighter.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Seats</th>
                  <th scope="col">Range (nm)</th>
                  <th scope="col">Runway (m)</th>
                  <th scope="col">Code</th>
                  <th scope="col">List</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((entry) => (
                  <TypeRow key={entry.designation} entry={entry} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
