import { StateBlock } from '../../ui/StateBlock';

import { Timeline, TimelineBlock, TimelineRow, minuteLabel } from './Timeline';
import { Meter } from './ui';

import type { NetworkSelection, PlannedFlight, PlannerAircraft, RoutePlan } from './types';
import type { ReactNode } from 'react';

/**
 * The Fleet Schedule — every aircraft's whole day across every route, in one
 * timeline. Where the per-route Schedule tab answers "how is this route flown",
 * this answers "what is each aircraft doing" — the view for spotting an idle
 * airframe or a clash. Built from the same mock plans as the route tabs.
 */

const HOUR_START = 4;
const HOUR_END = 24;

function tail(flight: PlannedFlight, flights: PlannedFlight[]): number {
  const arrival = flight.departureMinute + flight.blockMinutes;
  const next = flights
    .filter((f) => f.aircraftId === flight.aircraftId && f.departureMinute >= arrival)
    .sort((a, b) => a.departureMinute - b.departureMinute)[0];
  return next === undefined ? 0 : Math.max(0, Math.min(next.departureMinute - arrival, 120));
}

export function FleetScheduleView({
  plans,
  aircraft,
  selection,
  onSelect,
}: {
  plans: readonly RoutePlan[];
  aircraft: readonly PlannerAircraft[];
  selection: NetworkSelection | null;
  onSelect: (selection: NetworkSelection) => void;
}): ReactNode {
  const allFlights = plans.flatMap((plan) => plan.flights);
  const flyers = aircraft.filter((a) => !a.isPool);

  return (
    <div className="net-fleetsched">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Fleet schedule</h2>
        <span className="net-panel__hint">
          {flyers.length} aircraft · {allFlights.length} flights / day
        </span>
      </div>

      <Timeline hourStart={HOUR_START} hourEnd={HOUR_END}>
        {flyers.map((frame) => {
          const rowFlights = allFlights.filter((f) => f.aircraftId === frame.id);
          const routeCount = new Set(rowFlights.map((f) => f.routeId)).size;
          return (
            <TimelineRow
              key={frame.id}
              label={frame.registration}
              sub={`${frame.typeDesignation} · ${String(routeCount)} route${routeCount === 1 ? '' : 's'}`}
              selected={selection?.kind === 'aircraft' && selection.id === frame.id}
              onLabelClick={() => {
                onSelect({ kind: 'aircraft', id: frame.id });
              }}
              meter={
                <Meter
                  value={Math.min(1, frame.utilisationHoursPerDay / 14)}
                  tone={frame.utilisationHoursPerDay >= 8 ? 'positive' : 'warn'}
                  label={`${frame.utilisationHoursPerDay.toFixed(1)} block hours a day`}
                />
              }
            >
              {rowFlights.map((flight) => (
                <TimelineBlock
                  key={flight.id}
                  startMinute={flight.departureMinute}
                  durationMinutes={flight.blockMinutes}
                  turnaroundMinutes={tail(flight, allFlights)}
                  tone={flight.direction === 'out' ? 'accent' : 'positive'}
                  selected={selection?.kind === 'flight' && selection.id === flight.id}
                  title={`${flight.originIcao} → ${flight.destinationIcao} dep ${minuteLabel(
                    flight.departureMinute,
                  )}`}
                  label={
                    <>
                      {flight.originIcao}–{flight.destinationIcao}
                    </>
                  }
                  onClick={() => {
                    onSelect({ kind: 'flight', id: flight.id });
                  }}
                />
              ))}
              {rowFlights.length === 0 && (
                <span className="net-row__empty">Idle all day — no flights assigned</span>
              )}
            </TimelineRow>
          );
        })}
        {flyers.length === 0 && (
          <StateBlock kind="empty">
            No aircraft in the fleet yet. Acquire one on the Fleet page to schedule flights.
          </StateBlock>
        )}
      </Timeline>
    </div>
  );
}
