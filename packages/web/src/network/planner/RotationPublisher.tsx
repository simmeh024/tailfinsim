import { useCallback, useEffect, useState } from 'react';

import type { FleetAirframeView, ScheduleCostEstimate, ScheduleView } from '@tailfin/shared';

import { fetchFleetAirframes } from '../../fleet/api';
import { StateBlock } from '../../ui/StateBlock';
import {
  deleteSchedule,
  fetchSchedules,
  publishSchedule,
  setScheduleActive,
  updateSchedule,
  type AuthoredLeg,
  type PublishScheduleOutcome,
  type ScheduleDraft,
} from '../api';

import { Chip, compactMoney, DayPicker } from './ui';

import type { Weekday } from './types';
import type { ReactNode } from 'react';

/**
 * Publishing a rotation — the real schedule authoring (M2-03, §8.2).
 *
 * The Schedule tab's drag timeline is a visual draft; this is the path that
 * actually saves. A rotation is a sequence of **stops**, so a player can build a
 * longer route with intermediate airports (AMS→KEF→JFK), tick **auto-return** for
 * a nonstop leg home, and publish. The server opens any route the airline does
 * not yet serve, checks every leg against the aircraft's range, and returns the
 * cost — all surfaced here, including exactly which leg it refused and why.
 */

const ICAO = /^[A-Z0-9]{3,4}$/;

function toTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fromTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

interface Stop {
  destinationIcao: string;
  departureMinuteLocal: number;
}

/** origin + stops → the API's ordered airport-pair legs. */
function toLegs(origin: string, stops: readonly Stop[]): AuthoredLeg[] {
  const legs: AuthoredLeg[] = [];
  let from = origin.toUpperCase();
  for (const stop of stops) {
    const destinationIcao = stop.destinationIcao.toUpperCase();
    legs.push({
      originIcao: from,
      destinationIcao,
      departureMinuteLocal: stop.departureMinuteLocal,
    });
    from = destinationIcao;
  }
  return legs;
}

export function RotationPublisher({
  seedOrigin,
  seedDestination,
}: {
  seedOrigin: string;
  seedDestination: string;
}): ReactNode {
  const [airframes, setAirframes] = useState<readonly FleetAirframeView[]>([]);
  const [schedules, setSchedules] = useState<readonly ScheduleView[] | null>(null);

  const [airframeId, setAirframeId] = useState('');
  const [origin, setOrigin] = useState(seedOrigin);
  const [stops, setStops] = useState<Stop[]>([
    { destinationIcao: seedDestination, departureMinuteLocal: 480 },
  ]);
  const [autoReturn, setAutoReturn] = useState(true);
  const [days, setDays] = useState<Weekday[]>([]); // empty = daily

  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cost, setCost] = useState<ScheduleCostEstimate | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadSchedules = useCallback(() => {
    void fetchSchedules()
      .then(setSchedules)
      .catch(() => setSchedules([]));
  }, []);

  useEffect(() => {
    let live = true;
    void fetchFleetAirframes()
      .then((response) => {
        if (!live) return;
        setAirframes(response.airframes);
        setAirframeId((current) => current || (response.airframes[0]?.airframeId ?? ''));
      })
      .catch(() => {
        /* no fleet, or not signed in — the form says so via the disabled publish. */
      });
    reloadSchedules();
    return () => {
      live = false;
    };
  }, [reloadSchedules]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setOrigin(seedOrigin);
    setStops([{ destinationIcao: seedDestination, departureMinuteLocal: 480 }]);
    setAutoReturn(true);
    setDays([]);
    setCost(null);
    setWarning(null);
    setError(null);
  }, [seedOrigin, seedDestination]);

  const addStop = useCallback(() => {
    setStops((current) => {
      const last = current[current.length - 1];
      return [
        ...current,
        {
          destinationIcao: '',
          departureMinuteLocal: Math.min(1439, (last?.departureMinuteLocal ?? 480) + 120),
        },
      ];
    });
  }, []);

  const editStop = useCallback((index: number, patch: Partial<Stop>) => {
    setStops((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }, []);

  const removeStop = useCallback((index: number) => {
    setStops((current) => (current.length > 1 ? current.filter((_, i) => i !== index) : current));
  }, []);

  const loadForEdit = useCallback((schedule: ScheduleView) => {
    // The saved legs are absolute; show them as origin + stops. Only the outbound
    // legs (up to the return, which auto-return re-adds) are editable here.
    const legs = schedule.legs;
    setEditingId(schedule.id);
    setAirframeId(schedule.airframeId);
    setOrigin(legs[0]?.originIcao ?? '');
    setStops(
      legs.map((leg) => ({
        destinationIcao: leg.destinationIcao,
        departureMinuteLocal: leg.departureMinute % 1440,
      })),
    );
    setDays(
      schedule.repeat.kind === 'weekdays' ? schedule.repeat.days.map((d) => d as Weekday) : [],
    );
    setAutoReturn(false);
    setCost(null);
    setWarning(null);
    setError(null);
  }, []);

  const validLegs =
    ICAO.test(origin.trim().toUpperCase()) &&
    stops.length > 0 &&
    stops.every((s) => ICAO.test(s.destinationIcao.trim().toUpperCase()));
  const canPublish = validLegs && (editingId !== null || airframeId !== '') && !busy;

  const publish = useCallback(async () => {
    setBusy(true);
    setError(null);
    setWarning(null);
    setCost(null);
    const repeat =
      days.length > 0 ? ({ kind: 'weekdays', days } as const) : ({ kind: 'daily' } as const);
    const legs = toLegs(origin, stops);
    try {
      const outcome: PublishScheduleOutcome =
        editingId !== null
          ? await updateSchedule(editingId, { legs, autoReturn, repeat })
          : await publishSchedule({ airframeId, legs, autoReturn, repeat } satisfies ScheduleDraft);
      if (outcome.ok) {
        setCost(outcome.response.cost);
        setWarning(outcome.response.warning);
        reloadSchedules();
        // After a create, clear the leg inputs for the next one — but keep the
        // cost on screen, so the player sees what they just published.
        if (editingId === null) {
          setOrigin(seedOrigin);
          setStops([{ destinationIcao: seedDestination, departureMinuteLocal: 480 }]);
          setAutoReturn(true);
          setDays([]);
        }
      } else {
        setError(outcome.detail);
      }
    } catch {
      setError('The rotation could not be published. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [
    airframeId,
    autoReturn,
    days,
    editingId,
    origin,
    reloadSchedules,
    seedDestination,
    seedOrigin,
    stops,
  ]);

  return (
    <div className="net-rotations">
      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">
            {editingId === null ? 'Publish a rotation' : 'Edit rotation'}
          </h3>
          {editingId !== null && (
            <button type="button" className="net-route__close" onClick={resetForm}>
              New rotation
            </button>
          )}
        </div>

        <div className="net-rot-form">
          <label className="net-rot-field">
            <span>Aircraft</span>
            <select
              value={airframeId}
              disabled={editingId !== null}
              onChange={(e) => setAirframeId(e.target.value)}
            >
              {airframes.length === 0 && <option value="">No aircraft in your fleet</option>}
              {airframes.map((a) => (
                <option key={a.airframeId} value={a.airframeId}>
                  {a.registration} · {a.typeDesignation}
                  {a.locationIcao ? ` · at ${a.locationIcao}` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="net-rot-legs">
            <div className="net-rot-leg net-rot-leg--origin">
              <span className="net-rot-leg__label">Start at</span>
              <input
                className="net-rot-icao"
                aria-label="Origin airport"
                value={origin}
                maxLength={4}
                onChange={(e) => setOrigin(e.target.value.toUpperCase())}
              />
            </div>
            {stops.map((stop, index) => (
              <div className="net-rot-leg" key={index}>
                <span className="net-rot-leg__arrow" aria-hidden="true">
                  ↓
                </span>
                <input
                  className="net-rot-icao"
                  aria-label={`Stop ${String(index + 1)} airport`}
                  placeholder="ICAO"
                  value={stop.destinationIcao}
                  maxLength={4}
                  onChange={(e) =>
                    editStop(index, { destinationIcao: e.target.value.toUpperCase() })
                  }
                />
                <input
                  type="time"
                  aria-label={`Stop ${String(index + 1)} departure`}
                  value={toTime(stop.departureMinuteLocal)}
                  onChange={(e) =>
                    editStop(index, { departureMinuteLocal: fromTime(e.target.value) })
                  }
                />
                {stops.length > 1 && (
                  <button
                    type="button"
                    className="net-rot-remove"
                    aria-label={`Remove stop ${String(index + 1)}`}
                    onClick={() => removeStop(index)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="net-rot-addleg" onClick={addStop}>
              + Add a stop
            </button>
          </div>

          <label className="net-rot-checkbox">
            <input
              type="checkbox"
              checked={autoReturn}
              onChange={(e) => setAutoReturn(e.target.checked)}
            />
            <span>
              Auto-return — always add a nonstop flight straight back to{' '}
              {origin.toUpperCase() || 'the start'}
            </span>
          </label>

          <div className="net-rot-field">
            <span>Days</span>
            <div className="net-rot-days">
              <button
                type="button"
                className={`net-rot-daily${days.length === 0 ? ' net-rot-daily--on' : ''}`}
                onClick={() => setDays([])}
              >
                Every day
              </button>
              <DayPicker
                days={days}
                onToggle={(day) =>
                  setDays((current) =>
                    current.includes(day) ? current.filter((d) => d !== day) : [...current, day],
                  )
                }
              />
            </div>
          </div>

          <div className="net-rot-actions">
            <button
              type="button"
              className="net-rot-publish"
              disabled={!canPublish}
              onClick={() => void publish()}
            >
              {busy ? 'Publishing…' : editingId === null ? 'Publish rotation' : 'Save changes'}
            </button>
          </div>

          {error !== null && (
            <p className="page__note" role="alert">
              {error}
            </p>
          )}
          {warning !== null && (
            <p className="net-rot-warning" role="status">
              ⚠ {warning}
            </p>
          )}
          {cost !== null && <CostSummary cost={cost} />}
        </div>
      </section>

      <SavedRotations schedules={schedules} onEdit={loadForEdit} onChanged={reloadSchedules} />
    </div>
  );
}

function CostSummary({ cost }: { cost: ScheduleCostEstimate }): ReactNode {
  return (
    <div className="net-rot-cost">
      <div className="net-rot-cost__head">
        <span>
          {cost.legs.length} {cost.legs.length === 1 ? 'leg' : 'legs'} ·{' '}
          {Math.round(cost.totalDistanceNm).toLocaleString()} nm
        </span>
        <span className="figure">{compactMoney(cost.totalVariableCostMinor)} / cycle</span>
      </div>
      {cost.routesOpened > 0 && (
        <p className="net-rot-cost__opened">
          Opened {cost.routesOpened} new {cost.routesOpened === 1 ? 'route' : 'routes'} — set their
          fares in Pricing.
        </p>
      )}
      <ul className="net-rot-cost__legs">
        {cost.legs.map((leg, i) => (
          <li key={i}>
            <span>
              {leg.originIcao} → {leg.destinationIcao}
              {leg.opened && (
                <>
                  {' '}
                  <Chip tone="accent">new</Chip>
                </>
              )}
            </span>
            <span className="figure">
              {Math.round(leg.distanceNm).toLocaleString()} nm ·{' '}
              {compactMoney(leg.variableCostMinor)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SavedRotations({
  schedules,
  onEdit,
  onChanged,
}: {
  schedules: readonly ScheduleView[] | null;
  onEdit: (schedule: ScheduleView) => void;
  onChanged: () => void;
}): ReactNode {
  const toggle = useCallback(
    (schedule: ScheduleView) => {
      void setScheduleActive(schedule.id, !schedule.active).then(onChanged);
    },
    [onChanged],
  );
  const remove = useCallback(
    (schedule: ScheduleView) => {
      void deleteSchedule(schedule.id).then(onChanged);
    },
    [onChanged],
  );

  if (schedules === null) return <StateBlock kind="loading">Loading your rotations…</StateBlock>;
  if (schedules.length === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h3 className="net-panel__title">Your rotations</h3>
        </div>
        <StateBlock kind="empty">No rotations yet. Build one above and publish it.</StateBlock>
      </section>
    );
  }

  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h3 className="net-panel__title">Your rotations</h3>
        <span className="net-panel__hint">{schedules.length} running</span>
      </div>
      <ul className="net-rot-list">
        {schedules.map((schedule) => (
          <li
            key={schedule.id}
            className={`net-rot-item${schedule.active ? '' : ' net-rot-item--paused'}`}
          >
            <div className="net-rot-item__path">
              {schedule.legs[0]?.originIcao}
              {schedule.legs.map((leg) => (
                <span key={leg.departureMinute}> → {leg.destinationIcao}</span>
              ))}
            </div>
            <div className="net-rot-item__meta figure">
              {schedule.repeat.kind === 'daily' ? 'Daily' : `${schedule.repeat.days.length}×/wk`} ·{' '}
              {schedule.upcomingFlights} upcoming
            </div>
            <div className="net-rot-item__actions">
              <Chip tone={schedule.active ? 'positive' : 'neutral'}>
                {schedule.active ? 'Active' : 'Paused'}
              </Chip>
              <button type="button" className="net-route__close" onClick={() => onEdit(schedule)}>
                Edit
              </button>
              <button type="button" className="net-route__close" onClick={() => toggle(schedule)}>
                {schedule.active ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                className="net-route__close net-route__close--danger"
                onClick={() => remove(schedule)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
