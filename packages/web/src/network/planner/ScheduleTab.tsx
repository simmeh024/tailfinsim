import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../ui/Button';

import {
  rankedSlots,
  scheduleIssues,
  slotContribution,
  utilisationByAircraft,
  type FlightIssue,
} from './analysis';
import { buildRotation } from './editor';
import { Timeline, TimelineBlock, TimelineRow, TimelineSlot, minuteLabel } from './Timeline';
import { Chip, compactMoney, DayPicker, Meter, Segmented } from './ui';

import type { ScheduleEditor } from './editor';
import type {
  NetworkSelection,
  PlannedFlight,
  PlannerAircraft,
  RoutePlan,
  Timeslot,
  Weekday,
} from './types';
import type { Tone } from './ui';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';

const HOUR_START = 4;
const HOUR_END = 24;
const UTILISATION_TARGET = 8; // block hours a day before an aircraft reads "well used"

const SLOT_TONE: Record<Timeslot['availability'], Tone> = {
  available: 'positive',
  limited: 'warn',
  full: 'negative',
};

interface DragState {
  flightId: string;
  originAircraftId: string;
  originDeparture: number;
  minutesPerPx: number;
  startClientX: number;
  deltaMinutes: number;
  overAircraftId: string | null;
}

function snap(minute: number): number {
  return Math.round(minute / 5) * 5;
}

/** Turnaround/ground time before this aircraft's next flight, capped for the tail. */
function tailMinutes(flight: PlannedFlight, flights: readonly PlannedFlight[]): number {
  const arrival = flight.departureMinute + flight.blockMinutes;
  const next = flights
    .filter((f) => f.aircraftId === flight.aircraftId && f.departureMinute >= arrival)
    .sort((a, b) => a.departureMinute - b.departureMinute)[0];
  return next === undefined ? 0 : Math.max(0, Math.min(next.departureMinute - arrival, 120));
}

export function ScheduleTab({
  plan,
  aircraft,
  selection,
  onSelect,
  editor,
}: {
  plan: RoutePlan;
  aircraft: readonly PlannerAircraft[];
  selection: NetworkSelection | null;
  onSelect: (selection: NetworkSelection) => void;
  editor: ScheduleEditor;
}): ReactNode {
  const { route } = plan;
  const flights = plan.flights;
  const frequency = plan.frequency;
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const issues = useMemo(
    () => scheduleIssues(flights, aircraft, plan.slots),
    [flights, aircraft, plan.slots],
  );
  const issueByFlight = useMemo(() => {
    const map = new Map<string, FlightIssue>();
    for (const issue of issues) if (!map.has(issue.flightId)) map.set(issue.flightId, issue);
    return map;
  }, [issues]);
  const utilisation = useMemo(() => utilisationByAircraft(flights), [flights]);
  const bestSlotHour = useMemo(() => rankedSlots(plan, flights)[0]?.slot.hour, [plan, flights]);

  const frequencyKind: 'daily' | 'weekdays' = frequency.kind;
  const days: Weekday[] = frequency.kind === 'weekdays' ? frequency.days : [1, 2, 3, 4, 5, 6, 7];
  const weekly = flights.length * (frequency.kind === 'daily' ? 7 : frequency.days.length);
  const flyers = aircraft.filter((a) => !a.isPool);

  const toggleDay = (day: Weekday) => {
    if (frequency.kind !== 'weekdays') {
      editor.setFrequency(route.id, { kind: 'weekdays', days: [day] });
      return;
    }
    const next = frequency.days.includes(day)
      ? frequency.days.filter((d) => d !== day)
      : [...frequency.days, day];
    if (next.length === 0) return;
    editor.setFrequency(route.id, { kind: 'weekdays', days: next.sort((a, b) => a - b) });
  };

  // --- Templates & suggest (idea 4, 5) --------------------------------------

  const applyTemplate = useCallback(
    (kind: 'peaks' | 'spread' | 'clear') => {
      const frame = flyers[0];
      if (!frame && kind !== 'clear') return;
      if (kind === 'clear') {
        editor.setFlights(route.id, []);
        return;
      }
      const hours = kind === 'peaks' ? [7, 17] : [6, 10, 14, 18];
      const built = hours.flatMap((hour) => buildRotation(route, frame!, hour));
      editor.setFlights(route.id, built);
    },
    [editor, route, flyers],
  );

  const suggest = useCallback(() => {
    if (flyers.length === 0) return;
    const ranked = rankedSlots(plan, []).filter((entry) => entry.contribution > 0);
    // Round-robin the best slots across the aircraft, a couple of rotations each.
    const built: PlannedFlight[] = [];
    ranked.slice(0, flyers.length * 2).forEach((entry, index) => {
      const frame = flyers[index % flyers.length]!;
      built.push(...buildRotation(route, frame, entry.slot.hour));
    });
    editor.setFlights(route.id, built);
  }, [editor, plan, route, flyers]);

  // --- Drag to retime / reassign (idea 1) -----------------------------------

  const onBlockPointerDown = useCallback(
    (event: ReactPointerEvent, flight: PlannedFlight) => {
      const track = (event.target as HTMLElement).closest('[data-net-track]');
      if (!(track instanceof HTMLElement)) return;
      const rect = track.getBoundingClientRect();
      const minutesPerPx = ((HOUR_END - HOUR_START) * 60) / rect.width;
      setDrag({
        flightId: flight.id,
        originAircraftId: flight.aircraftId,
        originDeparture: flight.departureMinute,
        minutesPerPx,
        startClientX: event.clientX,
        deltaMinutes: 0,
        overAircraftId: flight.aircraftId,
      });
      onSelect({ kind: 'flight', id: flight.id });
    },
    [onSelect],
  );

  // --- Click an empty spot on a row to add a rotation there (idea 1, easier add) ---

  const addRotationAtClick = useCallback(
    (frame: PlannerAircraft, event: ReactMouseEvent<HTMLDivElement>) => {
      // A click that lands on a flight block — or the idle row's own add button — is
      // that control's job; the track only handles clicks on its empty background.
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = (event.clientX - rect.left) / rect.width;
      const hour = Math.round(HOUR_START + fraction * (HOUR_END - HOUR_START));
      editor.addRotation(route, frame, Math.max(HOUR_START, Math.min(HOUR_END - 1, hour)));
      onSelect({ kind: 'aircraft', id: frame.id });
    },
    [editor, route, onSelect],
  );

  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const move = (event: PointerEvent): void => {
      const current = dragRef.current;
      if (!current) return;
      const deltaMinutes = (event.clientX - current.startClientX) * current.minutesPerPx;
      const row = (
        document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      )?.closest('[data-aircraft-id]');
      const overAircraftId =
        row instanceof HTMLElement
          ? (row.dataset.aircraftId ?? current.overAircraftId)
          : current.overAircraftId;
      setDrag({ ...current, deltaMinutes, overAircraftId });
    };
    const up = (): void => {
      const current = dragRef.current;
      if (current) {
        const newDeparture = snap(current.originDeparture + current.deltaMinutes);
        const moved = Math.abs(newDeparture - current.originDeparture) >= 5;
        const reassigned =
          current.overAircraftId !== null && current.overAircraftId !== current.originAircraftId;
        if (moved || reassigned) {
          editor.moveFlight(
            route.id,
            current.flightId,
            newDeparture,
            current.overAircraftId ?? undefined,
          );
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragActive, editor, route.id]);

  const dirty = editor.isDirty(route.id);

  const saving = editor.isSaving(route.id);

  const problem = editor.problemFor(route.id);

  return (
    <div className="net-schedule">
      {/* Toolbar: frequency, templates, suggest, draft controls */}
      <div className="net-schedule__bar">
        <div className="net-schedule__group">
          <span className="net-schedule__group-label">Frequency</span>
          <Segmented
            label="Frequency template"
            value={frequencyKind}
            onChange={(kind) => {
              editor.setFrequency(
                route.id,
                kind === 'daily' ? { kind: 'daily' } : { kind: 'weekdays', days },
              );
            }}
            options={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekdays', label: 'Custom' },
            ]}
          />
          {frequency.kind === 'weekdays' && <DayPicker days={days} onToggle={toggleDay} />}
        </div>

        <div className="net-schedule__group">
          <span className="net-schedule__group-label">Templates</span>
          <Button variant="secondary" onClick={() => applyTemplate('peaks')}>
            Peak banks
          </Button>
          <Button variant="secondary" onClick={() => applyTemplate('spread')}>
            Even spread
          </Button>
          <Button variant="secondary" onClick={suggest}>
            ✨ Suggest
          </Button>
          <Button variant="secondary" onClick={() => applyTemplate('clear')}>
            Clear
          </Button>
        </div>

        <div className="net-schedule__group net-schedule__group--right">
          <Button variant="secondary" disabled={!editor.canUndo} onClick={editor.undo}>
            ↩ Undo
          </Button>
          <Button variant="secondary" disabled={!editor.canRedo} onClick={editor.redo}>
            Redo ↪
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              editor.resetRoute(route, aircraft);
            }}
          >
            Reset
          </Button>
          {/*
            "Published" only after the server has said so (IMPROVE-04). It used
            to appear the instant the button was clicked, while nothing had been
            saved — the state a reload exposed as a lie.
          */}
          <Button
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => {
              void editor.publish(route.id, aircraft);
            }}
          >
            {saving ? 'Publishing…' : dirty ? 'Publish' : 'Published'}
          </Button>
          {dirty && !saving && <Chip tone="warn">Unsaved</Chip>}
        </div>
      </div>

      {/*
        What the server refused, and why (IMPROVE-04).

        Beside the client-side warnings rather than instead of them: those are
        advice about a draft, this is an answer about a save. App. B.4 requires
        the player to be told *which* leg cannot be flown, so the detail is the
        server's own sentence rather than a summary of it.
      */}
      {problem !== null && (
        <p className="net-warnings" role="alert">
          <span className="net-warnings__count">⚠ Not published</span>
          <span>{problem.detail}</span>
        </p>
      )}

      {/* Live warnings (idea 2) */}
      {issues.length > 0 && (
        <div className="net-warnings" role="status">
          <span className="net-warnings__count">
            ⚠ {issues.length} issue{issues.length > 1 ? 's' : ''}
          </span>
          <ul className="net-warnings__list">
            {issues.slice(0, 4).map((issue) => (
              <li key={`${issue.flightId}:${issue.kind}`}>{issue.detail}</li>
            ))}
          </ul>
        </div>
      )}

      <Timeline hourStart={HOUR_START} hourEnd={HOUR_END}>
        <TimelineRow label="Departure slots" sub="cost · quality">
          {plan.slots
            .filter((slot) => slot.hour >= HOUR_START && slot.hour < HOUR_END)
            .map((slot) => (
              <TimelineSlot
                key={slot.hour}
                hour={slot.hour}
                tone={SLOT_TONE[slot.availability]}
                selected={
                  (selection?.kind === 'slot' && selection.id === String(slot.hour)) ||
                  slot.hour === bestSlotHour
                }
                title={`${minuteLabel(slot.hour * 60)} · ${slot.quality} · ${slot.availability} · value ${compactMoney(slotContribution(plan, slot))}`}
                onClick={() => {
                  onSelect({ kind: 'slot', id: String(slot.hour) });
                }}
              />
            ))}
        </TimelineRow>

        {aircraft.map((frame) => {
          const rowFlights = flights.filter((f) => f.aircraftId === frame.id);
          const hours = utilisation.get(frame.id) ?? 0;
          const idle = !frame.isPool && rowFlights.length === 0;
          return (
            <TimelineRow
              key={frame.id}
              label={
                <>
                  {frame.isPool ? 'Fleet pool' : frame.registration}
                  {idle && <span className="net-row__flag">idle</span>}
                </>
              }
              sub={frame.isPool ? 'unassigned' : `${frame.typeDesignation} · ${hours.toFixed(1)}h`}
              selected={
                (selection?.kind === 'aircraft' && selection.id === frame.id) ||
                drag?.overAircraftId === frame.id
              }
              onLabelClick={() => {
                onSelect({ kind: 'aircraft', id: frame.id });
              }}
              meter={
                frame.isPool ? undefined : (
                  <Meter
                    value={Math.min(1, hours / 14)}
                    tone={hours >= UTILISATION_TARGET ? 'positive' : idle ? 'negative' : 'warn'}
                    label={`${hours.toFixed(1)} block hours a day`}
                  />
                )
              }
              onTrackClick={(event) => {
                addRotationAtClick(frame, event);
              }}
              trackTitle={`Click an empty spot to add a rotation on ${
                frame.isPool ? 'the fleet pool' : frame.registration
              }`}
              trackAttrs={{ 'data-aircraft-id': frame.id }}
            >
              {rowFlights.map((flight) => {
                const isDragging = drag?.flightId === flight.id;
                const startMinute = isDragging
                  ? snap(flight.departureMinute + (drag?.deltaMinutes ?? 0))
                  : flight.departureMinute;
                const issue = issueByFlight.get(flight.id);
                return (
                  <TimelineBlock
                    key={flight.id}
                    startMinute={startMinute}
                    durationMinutes={flight.blockMinutes}
                    turnaroundMinutes={isDragging ? 0 : tailMinutes(flight, flights)}
                    tone={issue ? 'negative' : flight.direction === 'out' ? 'accent' : 'positive'}
                    selected={selection?.kind === 'flight' && selection.id === flight.id}
                    title={
                      issue
                        ? issue.detail
                        : `${flight.originIcao} → ${flight.destinationIcao} dep ${minuteLabel(startMinute)} — drag to retime or move rows`
                    }
                    label={
                      <>
                        {flight.direction === 'out' ? '→' : '←'} {flight.destinationIcao}
                      </>
                    }
                    onPointerDown={(event) => {
                      onBlockPointerDown(event, flight);
                    }}
                    onClick={() => {
                      onSelect({ kind: 'flight', id: flight.id });
                    }}
                  />
                );
              })}
              {idle && (
                <button
                  type="button"
                  className="net-row__empty net-row__empty--add"
                  onClick={() => {
                    editor.addRotation(route, frame, bestSlotHour ?? 8);
                    onSelect({ kind: 'aircraft', id: frame.id });
                  }}
                >
                  ＋ Add a rotation — or drag a flight here
                </button>
              )}
            </TimelineRow>
          );
        })}
      </Timeline>

      {/* Live economics footer (idea 3) */}
      <div className="net-schedule__footer">
        <span>
          <strong className="figure">{flights.length}</strong> departures/day ·{' '}
          <strong className="figure">{weekly}</strong>/week
        </span>
        <span>
          Load <strong className="figure">{(plan.economics.loadFactor * 100).toFixed(0)}%</strong>
        </span>
        <span>
          Revenue{' '}
          <strong className="figure">{compactMoney(plan.economics.weeklyRevenueMinor)}</strong>/wk
        </span>
        <span
          className={
            plan.economics.weeklyRevenueMinor - plan.economics.weeklyCostMinor >= 0
              ? 'net-schedule__profit net-schedule__profit--up'
              : 'net-schedule__profit net-schedule__profit--down'
          }
        >
          Profit{' '}
          <strong className="figure">
            {compactMoney(plan.economics.weeklyRevenueMinor - plan.economics.weeklyCostMinor)}
          </strong>
          /wk
        </span>
      </div>

      <p className="net-schedule__legend">
        <span className="net-legend__swatch net-legend__swatch--accent" /> Outbound
        <span className="net-legend__swatch net-legend__swatch--positive" /> Return
        <span className="net-legend__swatch net-legend__swatch--negative" /> Issue
        <span className="net-legend__swatch net-legend__swatch--turn" /> Turnaround
      </p>
    </div>
  );
}
