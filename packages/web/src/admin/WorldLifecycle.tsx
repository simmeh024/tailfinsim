import { useState } from 'react';

import { WORLD_TRANSITIONS, type AdminWorldSummary, type WorldStatus } from '@tailfin/shared';

import { changeWorldStatus, type FieldErrors, resetWorld } from './api';

import type { ReactNode } from 'react';

/**
 * A world's life: open it, lock it, archive it, reset it (M1A-04, §22.2).
 *
 * ## Two controls, deliberately unalike
 *
 * The transitions are reversible or harmless — an opened world can be locked, a
 * locked one reopened — so they get one confirmation step each, stating what the
 * new state means for the people in the world.
 *
 * The reset is neither. It rewinds the clock to the epoch and destroys every
 * airline in the world, and nothing brings them back. So it looks different,
 * sits apart, states the counts it is about to destroy, demands a reason for the
 * log, and will not enable its button until the world's **name has been typed**.
 * A checkbox is one click away from a mis-click; a name is not something muscle
 * memory supplies on the wrong row.
 *
 * ## Which buttons exist is the server's rule, borrowed
 *
 * `WORLD_TRANSITIONS` is shared, so the console offers exactly the moves that
 * will work rather than offering everything and explaining the refusals. The
 * server checks it again — this decides what is rendered, not what is permitted.
 */

/** What each destination means, in the words that matter to an admin about to do it. */
const CONSEQUENCE: Record<WorldStatus, string> = {
  staging: 'Back to staging. Players cannot reach it.',
  open: 'Players can join and play. The clock is already running either way — opening does not start it.',
  locked:
    'Play stops. The world stays exactly as it is and the clock keeps running, so an in-flight aircraft is still in the air when it reopens. Reversible.',
  archived:
    'Permanent. An archived world is read-only for ever — its networks and airline history stay browsable, and it cannot be reopened or reset.',
};

/** The verb on the button, rather than the state name. Admins do things; they do not assign enums. */
const VERB: Record<WorldStatus, string> = {
  staging: 'Return to staging',
  open: 'Open for play',
  locked: 'Lock',
  archived: 'Archive',
};

/** `2024-10-23 00:00` — UTC, as everywhere else. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function Errors({ messages, id }: { messages: string[]; id?: string }): ReactNode {
  if (messages.length === 0) return null;
  return (
    <ul className="admin__errors" id={id} role="alert">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

export function WorldLifecycle({
  world,
  onChanged,
}: {
  world: AdminWorldSummary;
  onChanged: () => void | Promise<void>;
}): ReactNode {
  const [pending, setPending] = useState<WorldStatus | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const allowed = WORLD_TRANSITIONS[world.status];

  async function commit(status: WorldStatus): Promise<void> {
    setBusy(true);
    setErrors({});

    const result = await changeWorldStatus(world.id, status, world.status);
    setBusy(false);
    setPending(null);

    if (!result.ok) {
      setErrors(result.fields);
      return;
    }

    setDone(`“${world.name}” is now ${result.change.after}.`);
    await onChanged();
  }

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Lifecycle</h2>
      <p className="admin__note">
        “{world.name}” is <strong>{world.status}</strong>.{' '}
        {allowed.length === 0
          ? 'An archived world is a record of what happened, so nothing here can move it.'
          : `It can become ${allowed.join(' or ')}.`}
      </p>

      <Errors messages={errors.form ?? []} />

      {pending === null && allowed.length > 0 && (
        <div className="admin__confirm-actions">
          {allowed.map((status) => (
            <button
              key={status}
              className="admin__submit"
              type="button"
              onClick={() => {
                setPending(status);
                setDone(null);
                setErrors({});
              }}
            >
              {VERB[status]}
            </button>
          ))}
        </div>
      )}

      {pending !== null && (
        <div className="admin__confirm" role="group" aria-label="Confirm the status change">
          <p className="admin__confirm-lead">
            <strong>
              {world.status} → {pending}
            </strong>{' '}
            for “{world.name}”.
          </p>
          <ul className="admin__consequences">
            <li>{CONSEQUENCE[pending]}</li>
            {pending === 'archived' && (
              <li>
                {world.airlines === 0
                  ? 'No airlines are in this world.'
                  : `${count(world.airlines, 'airline stays', 'airlines stay')} exactly as they are — archiving destroys nothing, which is the point of it.`}
              </li>
            )}
            <li>Recorded in the audit log, with the before and after.</li>
          </ul>
          <div className="admin__confirm-actions">
            <button
              className="admin__submit"
              type="button"
              disabled={busy}
              onClick={() => void commit(pending)}
            >
              {busy ? 'Working…' : `${VERB[pending]} “${world.name}”`}
            </button>
            <button
              className="admin__cancel"
              type="button"
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {done !== null && (
        <p className="admin__ok" role="status">
          {done}
        </p>
      )}

      <WorldReset world={world} onChanged={onChanged} />
    </section>
  );
}

/**
 * The reset (ADR-0005).
 *
 * Separated from the transitions above by more than a heading: this is the one
 * control in the console that destroys data nobody can get back, and it is meant
 * to feel like it.
 */
function WorldReset({
  world,
  onChanged,
}: {
  world: AdminWorldSummary;
  onChanged: () => void | Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (world.status === 'archived') {
    return (
      <p className="admin__note">
        Archived worlds cannot be reset. They are kept so their history stays browsable.
      </p>
    );
  }

  const nameMatches = typedName.trim() === world.name;
  const reasonUsable = reason.trim().length >= 4;

  async function commit(): Promise<void> {
    setBusy(true);
    setErrors({});

    const result = await resetWorld(world.id, typedName.trim(), reason.trim(), world.status);
    setBusy(false);

    if (!result.ok) {
      setErrors(result.fields);
      return;
    }

    setDone(
      `“${world.name}” was reset. Destroyed ${count(result.reset.destroyed.airlines, 'airline', 'airlines')} and ` +
        `${count(result.reset.destroyed.events, 'scheduled event', 'scheduled events')}. ` +
        `The in-game date is back to ${formatAt(result.reset.inGameDate)}.`,
    );
    setOpen(false);
    setTypedName('');
    setReason('');
    await onChanged();
  }

  return (
    <div className="admin__danger">
      <h3 className="admin__danger-heading">Reset</h3>

      {!open && (
        <>
          <p className="admin__note">
            Rewinds the clock to the epoch and destroys everything the rewind invalidates. There is
            no undo.
          </p>
          <button
            className="admin__danger-button"
            type="button"
            onClick={() => {
              setOpen(true);
              setDone(null);
              setErrors({});
            }}
          >
            Reset “{world.name}”…
          </button>
        </>
      )}

      {open && (
        <div
          className="admin__confirm admin__confirm--danger"
          role="group"
          aria-label="Confirm the reset"
        >
          <p className="admin__confirm-lead">
            <strong>This destroys data and cannot be undone.</strong>
          </p>
          <ul className="admin__consequences">
            <li>
              {world.airlines === 0
                ? 'No airlines exist in this world, so none will be destroyed.'
                : `${count(world.airlines, 'airline', 'airlines')} will be deleted, with everything they hold. The players keep their accounts — an airline is a player’s presence in one world, not the account itself.`}
            </li>
            <li>
              {world.pendingEvents === 0
                ? 'Nothing is scheduled in the queue.'
                : `${count(world.pendingEvents, 'scheduled event', 'scheduled events')} will be deleted. They are scheduled against a timeline that will no longer exist, so rescheduling them would be guessing.`}
            </li>
            <li>
              The clock returns to the epoch, {formatAt(world.epoch)}. It is{' '}
              {formatAt(world.inGameDate)} in there now.
            </li>
            <li>
              The world goes back to <strong>staging</strong>, so nobody can join until it is opened
              again.
            </li>
            <li>
              Airports, runways and catchment are untouched — they are global reference data, not
              this world’s.
            </li>
            {world.status === 'open' && (
              <li className="admin__danger-note">
                <strong>This world is open.</strong> Anyone playing it right now loses their
                airline.
              </li>
            )}
          </ul>

          <div className="admin__field">
            <label className="admin__label" htmlFor="reset-reason">
              Why
            </label>
            <input
              className="admin__input"
              id="reset-reason"
              value={reason}
              aria-describedby="reset-reason-hint"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <span className="admin__hint" id="reset-reason-hint">
              Goes into the audit log. It is what answers “why is this world back at zero?” months
              from now.
            </span>
            <Errors messages={errors.reason ?? []} />
          </div>

          <div className="admin__field">
            <label className="admin__label" htmlFor="reset-name">
              Type “{world.name}” to confirm
            </label>
            <input
              className="admin__input"
              id="reset-name"
              value={typedName}
              autoComplete="off"
              aria-describedby="reset-name-hint"
              onChange={(event) => {
                setTypedName(event.target.value);
              }}
            />
            <span className="admin__hint" id="reset-name-hint">
              The name is asked for because it cannot be typed by accident on the wrong world.
            </span>
            <Errors messages={[...(errors.confirmName ?? []), ...(errors.form ?? [])]} />
          </div>

          <div className="admin__confirm-actions">
            <button
              className="admin__danger-button"
              type="button"
              disabled={busy || !nameMatches || !reasonUsable}
              onClick={() => void commit()}
            >
              {busy ? 'Resetting…' : `Reset “${world.name}” permanently`}
            </button>
            <button
              className="admin__cancel"
              type="button"
              onClick={() => {
                setOpen(false);
                setTypedName('');
                setErrors({});
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {done !== null && (
        <p className="admin__ok" role="status">
          {done}
        </p>
      )}
    </div>
  );
}
