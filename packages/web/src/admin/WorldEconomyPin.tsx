import { useState } from 'react';

import type {
  AdminEconomyConfigChange,
  AdminEconomyConfigSummary,
  AdminPinEconomyConfigResponse,
  AdminWorldSummary,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { compareEconomyConfigs, pinWorldEconomy, type FieldErrors } from './api';

import type { ReactNode } from 'react';

/**
 * Moving one world onto a different economy version (M11-37, design doc §22.3).
 *
 * ## Why it reviews before it commits
 *
 * The same reason the speed change does. A version is a name, and agreeing to a
 * name is not agreeing to anything: `v4` could be a fuel retune or it could move
 * every β coefficient in App. A. So the middle step fetches the actual diff
 * between what this world is running and what it would run, and the button that
 * commits names both versions.
 *
 * The diff is fetched at review time rather than held from the Compare panel
 * above, because they are different questions. Compare answers "how do these two
 * differ"; this answers "what happens to *this world*", and its `from` is
 * whatever the world is on at the moment of asking.
 *
 * ## What the sentence has to include
 *
 * That the change is **not retroactive**. A pinned economy applies to work that
 * has not happened yet; every settled `flight_result` keeps the version it was
 * billed under, which is the whole reason the rows are immutable. An admin who
 * believes a re-pin re-prices history will make a different decision from one
 * who knows it does not.
 *
 * And how much is in flight, because "some events are queued" is not something
 * anyone can weigh.
 *
 * ## What is not decided here
 *
 * Whether the change is allowed. The world may be archived, the version may have
 * gone, somebody else may have re-pinned this world while the review was on
 * screen, or this admin's role may not carry `economy.pin` at all. Those are all
 * the server's answers, and they arrive as refusals against a field rather than
 * as a broken page.
 */

function changeSide(value: AdminEconomyConfigChange['before']): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  return String(value);
}

/**
 * The first few changes, as one line each.
 *
 * A full table inside a confirmation buries the actions; the Compare panel above
 * is where a whole diff is read. Six is enough to recognise the shape of a
 * retune, and the count says what is not shown rather than pretending nothing is.
 */
const PREVIEW_LIMIT = 6;

export function WorldEconomyPin({
  world,
  versions,
  current,
  onChanged,
}: {
  world: AdminWorldSummary;
  versions: AdminEconomyConfigSummary[];
  /** The world's own version, if the list still holds it. Null is worth saying. */
  current: AdminEconomyConfigSummary | null;
  onChanged: () => void | Promise<void>;
}): ReactNode {
  const [draft, setDraft] = useState(world.economyConfigVersion);
  const [review, setReview] = useState<
    | { kind: 'none' }
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; changes: AdminEconomyConfigChange[] }
  >({ kind: 'none' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<AdminPinEconomyConfigResponse | null>(null);

  const fieldId = `economy-pin-${world.id}`;
  const errorId = `${fieldId}-error`;
  const fieldErrors = [
    ...(errors.version ?? []),
    ...(errors.expectedVersion ?? []),
    ...(errors.form ?? []),
  ];
  const unchanged = draft === world.economyConfigVersion;

  function edit(value: string): void {
    setDraft(value);
    // A review is about one target version. Choosing another invalidates it
    // rather than applying to whatever is in the box now.
    setReview({ kind: 'none' });
    setErrors({});
    setDone(null);
  }

  async function startReview(): Promise<void> {
    setReview({ kind: 'loading' });
    setDone(null);
    try {
      const result = await compareEconomyConfigs(draft, world.economyConfigVersion);
      setReview(
        result?.ok === true
          ? { kind: 'ready', changes: result.value.changes }
          : // A refusal or a missing version: the confirmation still stands,
            // because the server decides the pin either way. What it cannot do
            // is claim to know what moves.
            { kind: 'unavailable' },
      );
    } catch {
      setReview({ kind: 'unavailable' });
    }
  }

  async function commit(): Promise<void> {
    setSubmitting(true);
    setErrors({});

    const result = await pinWorldEconomy(world.id, draft, world.economyConfigVersion);
    setSubmitting(false);

    if (!result.ok) {
      setReview({ kind: 'none' });
      setErrors(result.fields);
      return;
    }

    setDone(result.pin);
    setReview({ kind: 'none' });
    await onChanged();
  }

  return (
    <article className="admin__subject">
      <h3 className="admin__heading">{world.name}</h3>
      <p className="admin__note">
        Running <strong>{world.economyConfigVersion}</strong>
        {current === null ? (
          <> — which is not in the list above, so it was created outside this build.</>
        ) : current.notes === null ? (
          <>.</>
        ) : (
          <> — {current.notes}</>
        )}{' '}
        {world.status === 'archived' && <>This world is archived.</>}
      </p>

      <div className="admin__field">
        <label className="admin__label" htmlFor={fieldId}>
          Pin to
        </label>
        <select
          className="admin__input"
          id={fieldId}
          value={draft}
          aria-describedby={fieldErrors.length > 0 ? errorId : undefined}
          aria-invalid={fieldErrors.length > 0 ? true : undefined}
          onChange={(event) => {
            edit(event.target.value);
          }}
        >
          {/* The world's own version may not be in the list — an economy written
              by a different build, which is exactly the case the shipped/stored
              check above exists for. Offering it keeps the control honest about
              where the world actually is. */}
          {current === null && (
            <option value={world.economyConfigVersion}>{world.economyConfigVersion}</option>
          )}
          {versions.map((v) => (
            <option key={v.version} value={v.version}>
              {v.version}
              {v.version === world.economyConfigVersion ? ' (current)' : ''}
            </option>
          ))}
        </select>
        {fieldErrors.length > 0 && (
          <ul className="admin__errors" id={errorId} role="alert">
            {fieldErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </div>

      {review.kind === 'none' && (
        <Button variant="primary" disabled={unchanged} onClick={() => void startReview()}>
          Review change
        </Button>
      )}

      {review.kind === 'loading' && <StateBlock kind="loading">Working out what moves…</StateBlock>}

      {(review.kind === 'ready' || review.kind === 'unavailable') && (
        <div
          className="admin__confirm"
          role="group"
          aria-label={`Confirm the economy change for ${world.name}`}
        >
          <p className="admin__confirm-lead">
            <strong>
              {world.economyConfigVersion} → {draft}
            </strong>{' '}
            for “{world.name}”.
          </p>

          {review.kind === 'unavailable' ? (
            <p className="admin__note">
              The difference between these two versions could not be read, so this cannot say what
              moves. The server will still check the change, and refuse it if the version is not
              there.
            </p>
          ) : review.changes.length === 0 ? (
            <p className="admin__note">
              Nothing differs between the two payloads. The pin is still recorded, and the world
              still changes which version it names.
            </p>
          ) : (
            <>
              <p className="admin__note">
                {String(review.changes.length)}{' '}
                {review.changes.length === 1 ? 'field moves' : 'fields move'}
                {review.changes.length > PREVIEW_LIMIT
                  ? `, the first ${String(PREVIEW_LIMIT)} of them:`
                  : ':'}
              </p>
              <ul className="admin__consequences">
                {review.changes.slice(0, PREVIEW_LIMIT).map((change) => (
                  <li key={change.path}>
                    <span className="figure">{change.path}</span>: {changeSide(change.before)} →{' '}
                    {changeSide(change.after)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <ul className="admin__consequences">
            <li>
              Nothing already settled is re-priced. Every <code>flight_result</code> keeps the
              version it was billed under, which is why these rows cannot be edited — only added to.
            </li>
            <li>
              {world.pendingEvents === 0
                ? 'Nothing is waiting in this world’s queue, so the new numbers apply from the next thing that happens.'
                : `${String(world.pendingEvents)} scheduled ${
                    world.pendingEvents === 1 ? 'event' : 'events'
                  } will settle under ${draft} rather than ${world.economyConfigVersion}.`}
            </li>
            <li>
              Reversible by pinning {world.economyConfigVersion} back. That is a second change with
              its own audit entry, not an undo — what has already settled stays settled.
            </li>
            <li>Recorded in the audit log, with the before and after.</li>
          </ul>

          <div className="admin__confirm-actions">
            <Button variant="primary" disabled={submitting} onClick={() => void commit()}>
              {submitting ? 'Pinning…' : `Pin “${world.name}” to ${draft}`}
            </Button>
            <Button
              variant="tertiary"
              onClick={() => {
                setReview({ kind: 'none' });
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {done !== null && (
        <p className="admin__ok" role="status">
          “{done.worldName}” moved from {done.before} to {done.after}
          {done.diff.length > 0 &&
            `, ${String(done.diff.length)} field${done.diff.length === 1 ? '' : 's'} different`}
          {done.pendingEvents > 0 &&
            `, with ${String(done.pendingEvents)} queued ${done.pendingEvents === 1 ? 'event' : 'events'} that will settle under it`}
          .
        </p>
      )}
    </article>
  );
}
