import { Fragment, useCallback, useEffect, useState } from 'react';

import type { AdminWorldSummary } from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { createWorld, fetchWorlds, type FieldErrors } from './api';
import { WorldLifecycle } from './WorldLifecycle';
import { WorldSpeed } from './WorldSpeed';

import type { FormEvent, ReactNode } from 'react';

/**
 * Worlds: what exists, and a form to make another (M1A-02, design doc §22.2).
 *
 * M1-09 already knew how to turn a config into a world. What was missing was a
 * way to *decide* the config without a shell — the parameters of a world are a
 * decision rather than a constant, and decisions belong somewhere with a record
 * of who made them.
 *
 * There is no status field on the form. A world always starts in `staging` and
 * opening one is a separate, deliberate act (M1A-04), so rather than a rule
 * saying an open world cannot be created here, there is no way to ask for one.
 */

interface Draft {
  name: string;
  epoch: string;
  speedMultiplier: string;
  aircraftCatalogueVersion: string;
  economyConfigVersion: string;
  playerCap: string;
}

/**
 * The flagship world's parameters, as the starting point.
 *
 * Prefilled rather than blank because the overwhelmingly common case is creating
 * a world like the one already running, and a blank date field invites a guess
 * about the format. The one field deliberately left empty is the name, which is
 * the only one that must be different.
 */
const BLANK: Draft = {
  name: '',
  epoch: '2024-10-20T00:00',
  speedMultiplier: '2',
  aircraftCatalogueVersion: 'v1',
  economyConfigVersion: 'v1',
  playerCap: '',
};

/** `2026-08-18 14:07` — UTC, matching the badge and every log line. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * One labelled input, with its hint and any reasons it was refused.
 *
 * The hint and the errors sit **outside** the `<label>` and are tied to the
 * input with `aria-describedby`. Nesting them inside would fold them into the
 * input's accessible name, so a screen reader would announce the field as
 * "Name A world with this name already exists. Pick another." — the label is
 * what a field is *called*, and a description is a separate thing. A test caught
 * this by failing to find a label called "Name" the moment an error appeared.
 */
function Field({
  id,
  label,
  hint,
  errors,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  errors: string[] | undefined;
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactNode;
}): ReactNode {
  const failed = errors !== undefined && errors.length > 0;
  const describedBy = [hint === undefined ? null : `${id}-hint`, failed ? `${id}-error` : null]
    .filter((part): part is string => part !== null)
    .join(' ');

  return (
    <div className="admin__field">
      <label className="admin__label" htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': failed ? true : undefined,
      })}
      {hint !== undefined && (
        <span className="admin__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {failed && (
        <ul className="admin__errors" id={`${id}-error`} role="alert">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Refusals that belong to the whole form rather than to one field. */
function FormErrors({ messages }: { messages: string[] | undefined }): ReactNode {
  if (!messages || messages.length === 0) return null;
  return (
    <ul className="admin__errors" role="alert">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

export function WorldsPanel(): ReactNode {
  const [worlds, setWorlds] = useState<AdminWorldSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Looked up from the current list rather than held as state, so the control
  // shows the world as last loaded — including a speed somebody else changed —
  // instead of a copy taken when the row was clicked.
  const selected = worlds?.find((entry) => entry.id === selectedId);

  const reload = useCallback(async () => {
    try {
      setWorlds(await fetchWorlds());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const set = (field: keyof Draft, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setCreated(null);
    setErrors({});

    // Sent as the config shape the server validates, with the two fields that
    // are not strings converted here. An empty cap means uncapped, which is null
    // rather than zero — zero would be a world nobody can join.
    const result = await createWorld({
      name: draft.name.trim(),
      epoch: draft.epoch.length === 16 ? `${draft.epoch}:00.000Z` : draft.epoch,
      speedMultiplier: Number(draft.speedMultiplier),
      aircraftCatalogueVersion: draft.aircraftCatalogueVersion.trim(),
      economyConfigVersion: draft.economyConfigVersion.trim(),
      playerCap: draft.playerCap.trim() === '' ? null : Number(draft.playerCap),
    });

    setSubmitting(false);

    if (result.ok) {
      setCreated(result.world.name);
      setDraft({ ...BLANK, name: '' });
      await reload();
      return;
    }
    setErrors(result.fields);
  }

  return (
    <>
      <section className="admin__section">
        <h2 className="admin__heading">Worlds</h2>
        {worlds === null && !loadFailed && <StateBlock kind="loading">Loading…</StateBlock>}
        {loadFailed && <StateBlock kind="broken">Could not load the world list.</StateBlock>}
        {worlds !== null &&
          (worlds.length === 0 ? (
            <StateBlock kind="empty">No worlds yet.</StateBlock>
          ) : (
            <table className="admin__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Speed</th>
                  <th scope="col">In-game date</th>
                  <th scope="col">Epoch</th>
                  <th scope="col">Queue</th>
                  <th scope="col">Airlines</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {worlds.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.name}</td>
                    <td>{entry.status}</td>
                    <td className="figure">{entry.speedMultiplier.toFixed(2)}×</td>
                    <td className="figure">{formatAt(entry.inGameDate)}</td>
                    <td className="figure">{formatAt(entry.epoch)}</td>
                    <td className="figure">{entry.pendingEvents}</td>
                    <td className="figure">{entry.airlines}</td>
                    <td>
                      <button
                        className="admin__rowaction"
                        type="button"
                        // Named for the row it belongs to. Several worlds means
                        // several identical-looking buttons, and "Manage" five
                        // times over is unusable with a screen reader and
                        // ambiguous in a test.
                        aria-label={`Manage ${entry.name}`}
                        aria-pressed={selectedId === entry.id}
                        onClick={() => {
                          setSelectedId(selectedId === entry.id ? null : entry.id);
                        }}
                      >
                        Manage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </section>

      {selected !== undefined && (
        // Keyed on the world, so picking a different row starts fresh controls
        // rather than carrying the previous world's half-typed number — or,
        // worse, its half-typed reset confirmation — into them.
        <Fragment key={selected.id}>
          <WorldSpeed world={selected} onChanged={reload} />
          <WorldLifecycle world={selected} onChanged={reload} />
        </Fragment>
      )}

      <section className="admin__section">
        <h2 className="admin__heading">Create a world</h2>
        <p className="admin__note">
          Starts in <strong>staging</strong>. Opening it for play is a separate action.
        </p>

        <form className="admin__form" onSubmit={(event) => void submit(event)}>
          <FormErrors messages={errors.form} />

          <Field id="world-name" label="Name" errors={errors.name}>
            {(props) => (
              <input
                {...props}
                className="admin__input"
                value={draft.name}
                onChange={(event) => {
                  set('name', event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="world-epoch"
            label="Epoch (UTC)"
            hint="Where the calendar begins, and where a reset returns to. Must be in the past."
            errors={errors.epoch}
          >
            {(props) => (
              <input
                {...props}
                className="admin__input"
                type="datetime-local"
                value={draft.epoch}
                onChange={(event) => {
                  set('epoch', event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="world-speed"
            label="Speed multiplier"
            hint="2 means a game day passes every twelve hours."
            errors={errors.speedMultiplier}
          >
            {(props) => (
              <input
                {...props}
                className="admin__input"
                type="number"
                step="0.25"
                min="0.25"
                max="100"
                value={draft.speedMultiplier}
                onChange={(event) => {
                  set('speedMultiplier', event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="world-aircraft"
            label="Aircraft catalogue version"
            errors={errors.aircraftCatalogueVersion}
          >
            {(props) => (
              <input
                {...props}
                className="admin__input"
                value={draft.aircraftCatalogueVersion}
                onChange={(event) => {
                  set('aircraftCatalogueVersion', event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="world-economy"
            label="Economy config version"
            hint="Pinned, so retuning the economy does not change a world already running."
            errors={errors.economyConfigVersion}
          >
            {(props) => (
              <input
                {...props}
                className="admin__input"
                value={draft.economyConfigVersion}
                onChange={(event) => {
                  set('economyConfigVersion', event.target.value);
                }}
                required
              />
            )}
          </Field>

          <Field
            id="world-cap"
            label="Player cap"
            hint="Leave empty for no cap."
            errors={errors.playerCap}
          >
            {(props) => (
              <input
                {...props}
                className="admin__input"
                type="number"
                min="1"
                value={draft.playerCap}
                onChange={(event) => {
                  set('playerCap', event.target.value);
                }}
              />
            )}
          </Field>

          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create world'}
          </Button>

          {created !== null && (
            <p className="admin__ok" role="status">
              Created “{created}”, in staging.
            </p>
          )}
        </form>
      </section>
    </>
  );
}
