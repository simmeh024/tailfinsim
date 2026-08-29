import { minuteLabel } from './Timeline';
import { Chip, compactMoney, major, Meter } from './ui';

import type { NetworkSelection, PlannerAircraft, RoutePlan } from './types';
import type { ReactNode } from 'react';

/**
 * The right-hand context panel's content for the Network page.
 *
 * The shell owns the panel frame, heading and dismissal (`context-selection.tsx`);
 * this supplies the body for whatever is selected — a route, a flight, an aircraft
 * or a departure slot — so the panel changes with the selection exactly as H.4
 * asks. Returns the title/subtitle the shell header shows alongside the body.
 */

export interface DescribedSelection {
  title: string;
  subtitle?: string;
  body: ReactNode;
}

/** The edits the context panel can trigger on the current selection. */
export interface SelectionActions {
  addRotation: (aircraftId: string, hour: number) => void;
  removeFlight: (flightId: string) => void;
  reassignFlight: (flightId: string, aircraftId: string) => void;
}

function Row({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="net-ctx__row">
      <span className="net-ctx__row-label">{label}</span>
      <span className="net-ctx__row-value figure">{value}</span>
    </div>
  );
}

export function describeSelection(
  selection: NetworkSelection,
  plan: RoutePlan,
  aircraft: readonly PlannerAircraft[],
  allFlights: readonly RoutePlan['flights'][number][],
  actions: SelectionActions,
): DescribedSelection | null {
  const { route } = plan;
  const flyers = aircraft.filter((a) => !a.isPool);

  if (selection.kind === 'route') {
    const e = plan.economics;
    return {
      title: `${route.originIcao} → ${route.destinationIcao}`,
      subtitle: `${route.greatCircleNm.toFixed(0)} nm`,
      body: (
        <div className="net-ctx">
          <Row label="Weekly frequency" value={`${String(e.weeklyFrequency)}×`} />
          <Row label="Load factor" value={`${(e.loadFactor * 100).toFixed(0)}%`} />
          <Row label="Weekly revenue" value={compactMoney(e.weeklyRevenueMinor)} />
          <Row
            label="Weekly profit"
            value={compactMoney(e.weeklyRevenueMinor - e.weeklyCostMinor)}
          />
          <Row label="Rivals" value={plan.competitors.length} />
          <p className="net-ctx__hint">
            Pick a flight, an aircraft or a slot on the Schedule tab to plan the rotation.
          </p>
        </div>
      ),
    };
  }

  if (selection.kind === 'flight') {
    const flight = allFlights.find((f) => f.id === selection.id);
    if (!flight) return null;
    const frame = aircraft.find((a) => a.id === flight.aircraftId);
    const arrival = flight.departureMinute + flight.blockMinutes;
    return {
      title: `${flight.originIcao} → ${flight.destinationIcao}`,
      subtitle: flight.direction === 'out' ? 'Outbound leg' : 'Return leg',
      body: (
        <div className="net-ctx">
          <Row label="Departs" value={minuteLabel(flight.departureMinute)} />
          <Row label="Arrives" value={minuteLabel(arrival)} />
          <Row
            label="Block time"
            value={`${Math.floor(flight.blockMinutes / 60)}h ${String(flight.blockMinutes % 60)}m`}
          />
          <Row label="Aircraft" value={frame?.registration ?? 'Fleet pool'} />
          <Row
            label="Repeats"
            value={
              flight.frequency.kind === 'daily'
                ? 'Daily'
                : `${String(flight.frequency.days.length)} days/wk`
            }
          />
          {flyers.filter((a) => a.id !== flight.aircraftId).length > 0 && (
            <div className="net-ctx__actions">
              <span className="net-ctx__actions-label">Move to</span>
              {flyers
                .filter((a) => a.id !== flight.aircraftId)
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="net-btn net-btn--sm"
                    onClick={() => {
                      actions.reassignFlight(flight.id, a.id);
                    }}
                  >
                    {a.registration}
                  </button>
                ))}
            </div>
          )}
          <button
            type="button"
            className="net-btn net-btn--sm net-btn--danger"
            onClick={() => {
              actions.removeFlight(flight.id);
            }}
          >
            Remove flight
          </button>
        </div>
      ),
    };
  }

  if (selection.kind === 'aircraft') {
    const frame = aircraft.find((a) => a.id === selection.id);
    if (!frame) return null;
    const rowFlights = allFlights.filter((f) => f.aircraftId === frame.id);
    return {
      title: frame.isPool ? 'Fleet pool' : frame.registration,
      subtitle: frame.isPool ? 'Unassigned flying' : frame.typeDesignation,
      body: (
        <div className="net-ctx">
          {!frame.isPool && (
            <>
              <Row label="Type" value={frame.typeDesignation} />
              <div className="net-ctx__row">
                <span className="net-ctx__row-label">Utilisation</span>
                <span className="net-ctx__row-value">
                  <Meter
                    value={Math.min(1, frame.utilisationHoursPerDay / 14)}
                    tone={frame.utilisationHoursPerDay >= 8 ? 'positive' : 'warn'}
                  />
                </span>
              </div>
              <Row label="Block hours/day" value={frame.utilisationHoursPerDay.toFixed(1)} />
            </>
          )}
          <Row label="Flights today" value={rowFlights.length} />
          <p className="net-ctx__hint">
            {frame.isPool
              ? 'Flights left in the pool are flown by any spare airframe.'
              : 'A fixed aircraft flies a set rotation; move it to the pool to share it.'}
          </p>
        </div>
      ),
    };
  }

  // slot
  const hour = Number(selection.id);
  const slot = plan.slots.find((s) => s.hour === hour);
  if (!slot) return null;
  const qualityTone =
    slot.quality === 'peak' ? 'warn' : slot.quality === 'shoulder' ? 'accent' : 'neutral';
  const availTone =
    slot.availability === 'available'
      ? 'positive'
      : slot.availability === 'limited'
        ? 'warn'
        : 'negative';
  return {
    title: `${minuteLabel(hour * 60)} slot`,
    subtitle: `${route.originIcao} departure band`,
    body: (
      <div className="net-ctx">
        <div className="net-ctx__row">
          <span className="net-ctx__row-label">Quality</span>
          <span className="net-ctx__row-value">
            <Chip tone={qualityTone}>{slot.quality}</Chip>
          </span>
        </div>
        <div className="net-ctx__row">
          <span className="net-ctx__row-label">Availability</span>
          <span className="net-ctx__row-value">
            <Chip tone={availTone}>{slot.availability}</Chip>
          </span>
        </div>
        <Row label="Slot cost" value={major(slot.costMinor)} />
        {slot.availability !== 'full' && flyers.length > 0 && (
          <div className="net-ctx__actions">
            <span className="net-ctx__actions-label">Add rotation</span>
            {flyers.map((a) => (
              <button
                key={a.id}
                type="button"
                className="net-btn net-btn--sm"
                onClick={() => {
                  actions.addRotation(a.id, hour);
                }}
              >
                {a.registration}
              </button>
            ))}
          </div>
        )}
        <p className="net-ctx__hint">
          {slot.availability === 'full'
            ? 'This band is full — no slot to take here.'
            : 'A peak slot costs more but sits in the demand bank; an off-peak one is cheap and quiet.'}
        </p>
      </div>
    ),
  };
}
