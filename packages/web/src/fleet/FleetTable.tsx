import type { AirframeStatus, FleetAirframeView, FleetUtilisation } from '@tailfin/shared';

import type { ReactNode } from 'react';

/**
 * The fleet table (M4-07).
 *
 * The task's columns are *"registration, type, livery thumbnail, base, status,
 * hours, utilisation, next check"*, and two of them need a word.
 *
 * **The livery thumbnail is a server-rendered image or nothing.** It is nothing
 * today: M6-01 defines the layered document and M6-02 the templates, but no
 * saved document or M6-06 server raster exists yet. What stands in its place is a type mark — the
 * manufacturer's initial and the aircraft class — which is deliberately *not* a
 * livery. The client never composes one, so when M6-06 fills
 * `liveryThumbnailUrl` this file renders it and nothing else changes. That is
 * M4-07's second acceptance criterion held structurally rather than met.
 *
 * **"Base" is where the aeroplane is.** Tailfin has no aircraft base: §9.2's base
 * is a *crew* base and §17 makes it an unlockable hub facility, and neither is
 * built. Labelling a column "base" and filling it with a delivery airport would
 * be a number that means nothing — so the column says what it is.
 */

const STATUS_LABEL: Record<AirframeStatus, string> = {
  in_service: 'In service',
  in_check: 'In check',
  grounded: 'Grounded',
};

/** Short enough for a table cell; the detail view spells the type out. */
const CLASS_MARK: Record<FleetAirframeView['aircraftClass'], string> = {
  turboprop_regional: 'TP',
  regional_jet: 'RJ',
  narrowbody: 'NB',
  widebody: 'WB',
  widebody_ulh: 'ULH',
  freighter: 'F',
};

function utilisationLabel(utilisation: FleetUtilisation | null): string {
  // Null is "too new to have a rate", which is not "idle". §2488's onboarding
  // warning fires on this number, so a fresh delivery must not read as unused.
  if (utilisation === null) return 'new';
  return `${utilisation.blockHoursPerDay.toFixed(1)} h/day`;
}

function utilisationTitle(utilisation: FleetUtilisation | null): string {
  if (utilisation === null) return 'Delivered less than a game day ago.';
  return `${utilisation.blockHours.toFixed(1)} block hours over ${utilisation.windowDays.toFixed(1)} game days.`;
}

function nextCheckLabel(view: FleetAirframeView): string {
  const next = view.nextCheck;
  if (next === null) return '—';

  const tier = `${next.tier.toUpperCase()}-check`;
  if (next.due) return `${tier} due`;
  // The binding limit only, because that is the one that will arrive — quoting
  // both makes the row unreadable and quoting the wrong one is a false plan.
  const remaining =
    next.binding === 'hours'
      ? `${String(Math.round(next.hoursRemaining))} h`
      : `${String(Math.round(next.cyclesRemaining))} cycles`;
  return `${tier} in ${remaining}`;
}

/**
 * The livery cell.
 *
 * An `<img>` when the server has a sprite, and a type mark when it has not.
 * Never a composed livery: this fleet response has no livery document or template and the
 * client has no renderer. Building a client-side approximation would guarantee the
 * fleet table and the world map disagreed about what a player's aircraft looks
 * like.
 */
function LiveryCell({ view }: { view: FleetAirframeView }): ReactNode {
  if (view.liveryThumbnailUrl !== null) {
    return (
      <img
        className="fleet__livery"
        src={view.liveryThumbnailUrl}
        alt={`${view.registration} livery`}
        width={64}
        height={24}
        loading="lazy"
      />
    );
  }

  return (
    <span
      className="fleet__livery fleet__livery--none"
      title="No livery yet — the livery builder arrives with the design tools."
      data-livery="none"
    >
      {view.manufacturer.slice(0, 1)}
      <span className="fleet__livery-class">{CLASS_MARK[view.aircraftClass]}</span>
    </span>
  );
}

export function FleetTable({
  airframes,
  selectedId,
  onSelect,
}: {
  airframes: readonly FleetAirframeView[];
  selectedId: string | null;
  onSelect: (airframeId: string) => void;
}): ReactNode {
  if (airframes.length === 0) {
    return (
      <p className="fleet__empty">
        No aircraft yet. Lease one and it can start flying the day it arrives; a factory order takes
        weeks of the world's calendar.
      </p>
    );
  }

  const grounded = airframes.filter((view) => !view.airworthy).length;

  return (
    <>
      {grounded > 0 && (
        // Said once, at the top, rather than left to be noticed row by row.
        <p className="fleet__alarm" role="status">
          {grounded === 1 ? 'One aircraft cannot fly.' : `${String(grounded)} aircraft cannot fly.`}{' '}
          A grounded airframe can still be booked into the check it is due.
        </p>
      )}
      <table className="fleet__table">
        <caption>
          {String(airframes.length)} aircraft, most urgent first. Utilisation is block hours a day
          over the last game week.
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Livery</span>
            </th>
            <th scope="col">Registration</th>
            <th scope="col">Type</th>
            <th scope="col">At</th>
            <th scope="col">Status</th>
            <th scope="col">Hours</th>
            <th scope="col">Utilisation</th>
            <th scope="col">Next check</th>
            <th scope="col">
              <span className="visually-hidden">Detail</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {airframes.map((view) => (
            <tr
              key={view.airframeId}
              data-status={view.status}
              data-selected={view.airframeId === selectedId ? 'yes' : 'no'}
              aria-selected={view.airframeId === selectedId}
            >
              <td>
                <LiveryCell view={view} />
              </td>
              <td>
                <strong>{view.registration}</strong>
              </td>
              <td>
                {view.typeDesignation}
                <br />
                <span className="node__commit">{view.manufacturer}</span>
              </td>
              <td>{view.locationIcao ?? '—'}</td>
              <td>
                {STATUS_LABEL[view.status]}
                {view.status === 'in_check' && view.checkCompletesAt !== null && (
                  <>
                    <br />
                    <span className="node__commit">
                      {view.checkTier?.toUpperCase()} until {view.checkCompletesAt.slice(0, 10)}
                    </span>
                  </>
                )}
              </td>
              <td className="figure">{Math.round(view.hours)}</td>
              <td className="figure" title={utilisationTitle(view.utilisation)}>
                {utilisationLabel(view.utilisation)}
              </td>
              <td>{nextCheckLabel(view)}</td>
              <td>
                {/* `aria-label` rather than a visually-hidden span: the
                    accessible name is computed by trimming each text node and
                    joining them, so "Detail" plus " for PH-TFA" comes out as
                    "Detailfor PH-TFA". One attribute, one clean label. */}
                <button
                  type="button"
                  className="fleet__open"
                  aria-label={`Detail for ${view.registration}`}
                  onClick={() => {
                    onSelect(view.airframeId);
                  }}
                >
                  Detail
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
