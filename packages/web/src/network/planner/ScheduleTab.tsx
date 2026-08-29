import { Timeline, TimelineBlock, TimelineRow, TimelineSlot, minuteLabel } from './Timeline';
import { DayPicker, Meter, Segmented } from './ui';

import type {
  Frequency,
  NetworkSelection,
  PlannedFlight,
  PlannerAircraft,
  RoutePlan,
  Timeslot,
  Weekday,
} from './types';
import type { Tone } from './ui';
import type { ReactNode } from 'react';

/**
 * The schedule planner — the workspace centrepiece.
 *
 * A 24-hour timeline with the airline's aircraft down the side and their flights
 * laid across it, plus a departure-slot strip and the frequency template. Every
 * flight and slot is selectable, driving the right-hand context panel. The
 * schedule data is mock (`planner/mock.ts`) — there is no M2-03 schedule endpoint
 * yet — but the interactions and shapes are the ones the real planner will use.
 */

const HOUR_START = 4;
const HOUR_END = 24;

const SLOT_TONE: Record<Timeslot['availability'], Tone> = {
  available: 'positive',
  limited: 'warn',
  full: 'negative',
};

/** Turnaround/ground time before this aircraft's next flight, capped for the tail. */
function tailMinutes(flight: PlannedFlight, flights: PlannedFlight[]): number {
  const arrival = flight.departureMinute + flight.blockMinutes;
  const next = flights
    .filter((f) => f.aircraftId === flight.aircraftId && f.departureMinute >= arrival)
    .sort((a, b) => a.departureMinute - b.departureMinute)[0];
  if (next === undefined) return 0;
  return Math.max(0, Math.min(next.departureMinute - arrival, 120));
}

export function ScheduleTab({
  plan,
  aircraft,
  selection,
  onSelect,
  onSetFrequency,
}: {
  plan: RoutePlan;
  aircraft: readonly PlannerAircraft[];
  selection: NetworkSelection | null;
  onSelect: (selection: NetworkSelection) => void;
  onSetFrequency: (frequency: Frequency) => void;
}): ReactNode {
  const { frequency, flights, slots } = plan;

  const frequencyKind: 'daily' | 'weekdays' = frequency.kind;
  const days: Weekday[] = frequency.kind === 'weekdays' ? frequency.days : [1, 2, 3, 4, 5, 6, 7];
  const dailyDepartures = flights.length;
  const weekly = dailyDepartures * (frequency.kind === 'daily' ? 7 : frequency.days.length);

  const toggleDay = (day: Weekday) => {
    if (frequency.kind !== 'weekdays') {
      onSetFrequency({ kind: 'weekdays', days: [day] });
      return;
    }
    const has = frequency.days.includes(day);
    const next = has ? frequency.days.filter((d) => d !== day) : [...frequency.days, day];
    if (next.length === 0) return;
    onSetFrequency({ kind: 'weekdays', days: next.sort((a, b) => a - b) });
  };

  return (
    <div className="net-schedule">
      <div className="net-schedule__bar">
        <div className="net-schedule__freq">
          <span className="net-schedule__freq-label">Frequency</span>
          <Segmented
            label="Frequency template"
            value={frequencyKind}
            onChange={(kind) => {
              onSetFrequency(kind === 'daily' ? { kind: 'daily' } : { kind: 'weekdays', days });
            }}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekdays', label: 'Custom' },
            ]}
          />
          {frequency.kind === 'weekdays' && <DayPicker days={days} onToggle={toggleDay} />}
        </div>
        <div className="net-schedule__summary">
          <strong className="figure">{dailyDepartures}</strong> departures/day ·{' '}
          <strong className="figure">{weekly}</strong>/week
        </div>
      </div>

      <Timeline hourStart={HOUR_START} hourEnd={HOUR_END}>
        <TimelineRow label="Departure slots" sub="cost · quality">
          {slots
            .filter((slot) => slot.hour >= HOUR_START && slot.hour < HOUR_END)
            .map((slot) => (
              <TimelineSlot
                key={slot.hour}
                hour={slot.hour}
                tone={SLOT_TONE[slot.availability]}
                selected={selection?.kind === 'slot' && selection.id === String(slot.hour)}
                title={`${minuteLabel(slot.hour * 60)} · ${slot.quality} · ${slot.availability}`}
                onClick={() => {
                  onSelect({ kind: 'slot', id: String(slot.hour) });
                }}
              />
            ))}
        </TimelineRow>

        {aircraft.map((frame) => {
          const rowFlights = flights.filter((f) => f.aircraftId === frame.id);
          return (
            <TimelineRow
              key={frame.id}
              label={frame.isPool ? 'Fleet pool' : frame.registration}
              sub={frame.isPool ? 'unassigned' : frame.typeDesignation}
              selected={selection?.kind === 'aircraft' && selection.id === frame.id}
              onLabelClick={() => {
                onSelect({ kind: 'aircraft', id: frame.id });
              }}
              meter={
                frame.isPool ? undefined : (
                  <Meter
                    value={Math.min(1, frame.utilisationHoursPerDay / 14)}
                    tone={frame.utilisationHoursPerDay >= 8 ? 'positive' : 'warn'}
                    label={`${frame.utilisationHoursPerDay.toFixed(1)} block hours a day`}
                  />
                )
              }
            >
              {rowFlights.map((flight) => (
                <TimelineBlock
                  key={flight.id}
                  startMinute={flight.departureMinute}
                  durationMinutes={flight.blockMinutes}
                  turnaroundMinutes={tailMinutes(flight, flights)}
                  tone={flight.direction === 'out' ? 'accent' : 'positive'}
                  selected={selection?.kind === 'flight' && selection.id === flight.id}
                  title={`${flight.originIcao} → ${flight.destinationIcao} dep ${minuteLabel(
                    flight.departureMinute,
                  )} arr ${minuteLabel(flight.departureMinute + flight.blockMinutes)}`}
                  label={
                    <>
                      {flight.direction === 'out' ? '→' : '←'} {flight.destinationIcao}
                    </>
                  }
                  onClick={() => {
                    onSelect({ kind: 'flight', id: flight.id });
                  }}
                />
              ))}
              {rowFlights.length === 0 && !frame.isPool && (
                <span className="net-row__empty">
                  No flights — assign a slot to fly this aircraft
                </span>
              )}
            </TimelineRow>
          );
        })}
      </Timeline>

      <p className="net-schedule__legend">
        <span className="net-legend__swatch net-legend__swatch--accent" /> Outbound
        <span className="net-legend__swatch net-legend__swatch--positive" /> Return
        <span className="net-legend__swatch net-legend__swatch--turn" /> Turnaround
      </p>
    </div>
  );
}
