import { useState } from 'react';

import {
  MAX_SPEED_MULTIPLIER,
  type AdminSpeedChangeResponse,
  type AdminWorldSummary,
} from '@tailfin/shared';

import { changeWorldSpeed, type FieldErrors } from './api';

import type { ReactNode } from 'react';

/**
 * Changing a running world's speed (M1A-03, design doc §22.2).
 *
 * ## Why there is a confirmation at all
 *
 * Because the interesting part of this change is not the part an admin can see.
 * The multiplier is one number, but game time is `epoch + speed × elapsed`, so
 * altering it re-anchors the world's `launch_date` and rewrites how every past
 * instant maps onto the calendar. An input that simply saved would look like it
 * had done something small.
 *
 * So the change is deliberately two steps, and the middle one states what will
 * happen in the terms the acceptance criterion asks for: the current speed, the
 * new one, and what becomes of the events already scheduled. The button that
 * commits it names the value it is committing, so a mis-click on the wrong row
 * is visible before it is irreversible.
 *
 * ## What is not decided here
 *
 * Whether the change is allowed — the world might be archived, or somebody else
 * might have changed the speed while this was on screen. Those are facts about
 * the world rather than about the form, and §21 puts them on the server, which
 * answers with the reason and the field it belongs against.
 */

/** `2024-10-23 00:00` — UTC, matching the badge and every log line. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * A real-world wait, in whatever unit reads plainly.
 *
 * Used to turn a ratio into something an admin can weigh. "1.5× sooner" is
 * arithmetic; "an hour becomes forty minutes" is the thing they are actually
 * deciding about.
 */
function formatWait(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${String(Math.round(minutes))} minutes`;
  const hours = minutes / 60;
  const rounded = Math.round(hours * 10) / 10;
  return `${String(rounded)} hours`;
}

/** What one in-game hour of waiting costs in real time, before and after. */
function waitComparison(current: number, next: number): string {
  return `a wait that takes ${formatWait(60 / current)} now would take ${formatWait(60 / next)}`;
}

export function WorldSpeed({
  world,
  onChanged,
}: {
  world: AdminWorldSummary;
  onChanged: () => void | Promise<void>;
}): ReactNode {
  const [draft, setDraft] = useState(world.speedMultiplier.toFixed(2));
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<AdminSpeedChangeResponse | null>(null);

  const next = Number(draft);
  const usable = Number.isFinite(next) && next > 0 && next <= MAX_SPEED_MULTIPLIER;
  const errorId = 'world-speed-error';
  const fieldErrors = [...(errors.speedMultiplier ?? []), ...(errors.form ?? [])];

  function edit(value: string): void {
    setDraft(value);
    // Anything typed invalidates a confirmation that was about a different
    // number, so the review has to be done again rather than silently applying
    // to whatever is in the box now.
    setConfirming(false);
    setErrors({});
    setDone(null);
  }

  async function commit(): Promise<void> {
    setSubmitting(true);
    setErrors({});

    const result = await changeWorldSpeed(world.id, next, world.speedMultiplier);
    setSubmitting(false);

    if (!result.ok) {
      setConfirming(false);
      setErrors(result.fields);
      return;
    }

    setDone(result.change);
    setConfirming(false);
    await onChanged();
  }

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Speed</h2>
      <p className="admin__note">
        “{world.name}” runs at <strong>{world.speedMultiplier.toFixed(2)}×</strong>. The in-game
        date is {formatAt(world.inGameDate)}.
      </p>

      <div className="admin__field">
        <label className="admin__label" htmlFor="world-speed-new">
          New speed multiplier
        </label>
        <input
          className="admin__input"
          id="world-speed-new"
          type="number"
          step="0.25"
          min="0.25"
          max={MAX_SPEED_MULTIPLIER}
          value={draft}
          aria-describedby={fieldErrors.length > 0 ? errorId : 'world-speed-hint'}
          aria-invalid={fieldErrors.length > 0 ? true : undefined}
          onChange={(event) => {
            edit(event.target.value);
          }}
        />
        <span className="admin__hint" id="world-speed-hint">
          2 means a game day passes every twelve hours. Stored to two decimal places.
        </span>
        {fieldErrors.length > 0 && (
          <ul className="admin__errors" id={errorId} role="alert">
            {fieldErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </div>

      {!confirming && (
        <button
          className="admin__submit"
          type="button"
          disabled={!usable || next === world.speedMultiplier}
          onClick={() => {
            setConfirming(true);
            setDone(null);
          }}
        >
          Review change
        </button>
      )}

      {confirming && usable && (
        // Labelled and grouped, so the consequences are read as one thing rather
        // than as loose prose next to a button.
        <div className="admin__confirm" role="group" aria-label="Confirm the speed change">
          <p className="admin__confirm-lead">
            <strong>
              {world.speedMultiplier.toFixed(2)}× → {next.toFixed(2)}×
            </strong>{' '}
            for “{world.name}”.
          </p>
          <ul className="admin__consequences">
            <li>
              The in-game date does not jump. It is {formatAt(world.inGameDate)} and carries on from
              wherever it has reached when you confirm — the world’s launch date is re-anchored so
              that stays true.
            </li>
            <li>
              {world.pendingEvents === 0
                ? 'Nothing is scheduled in this world’s queue. Events are stored in game time, so anything scheduled later is unaffected too.'
                : `${String(world.pendingEvents)} scheduled ${
                    world.pendingEvents === 1 ? 'event keeps' : 'events keep'
                  } the in-game moment ${
                    world.pendingEvents === 1 ? 'it has' : 'they have'
                  } now — nothing is rescheduled, because the queue stores game time. What changes is the real-world wait: ${waitComparison(world.speedMultiplier, next)}.`}
            </li>
            <li>
              The world’s past is rewritten. Dates are worked out from a single speed, so an in-game
              date you noted earlier will map to a different moment afterwards, and changing the
              speed back does not undo it.
            </li>
            <li>Recorded in the audit log, with the before and after.</li>
          </ul>

          <div className="admin__confirm-actions">
            <button
              className="admin__submit"
              type="button"
              disabled={submitting}
              onClick={() => void commit()}
            >
              {submitting ? 'Changing…' : `Change speed to ${next.toFixed(2)}×`}
            </button>
            <button
              className="admin__cancel"
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {done !== null && (
        <p className="admin__ok" role="status">
          “{world.name}” now runs at {done.after.speedMultiplier.toFixed(2)}×. The in-game date did
          not move: {formatAt(done.after.inGameDate)}.
          {done.driftMs !== 0 &&
            ` (${String(Math.abs(done.driftMs))} ms lost to rounding, which cannot make an event fire early.)`}
        </p>
      )}
    </section>
  );
}
