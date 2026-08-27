import { useCallback, useEffect, useRef, useState } from 'react';

import type { AutomationMode, AutomationStateResponse, OperationsTaskView } from '@tailfin/shared';

import { fetchAutomation, setAutomation } from './automation';

import type { ReactNode } from 'react';

/**
 * The operations-policies modal (M5-05, ADR-0023).
 *
 * Where a player climbs the automation ladder for a system — Manual, Policy or
 * Delegated — and writes the one rule it has today: cancel a delay longer than a
 * ceiling. **Delegated is greyed until the Ops Controller is hired**, because the
 * delegated tier runs on that seat; the modal reads whether it is filled from the
 * office the Headquarters page already loaded. It also shows the operations queue
 * — the situations the worker left waiting — so §3.1's "waits for you" is visible.
 */

const MODES: readonly { value: AutomationMode; label: string; blurb: string }[] = [
  {
    value: 'manual',
    label: 'Manual',
    blurb: 'You handle every disruption. Best results, most attention.',
  },
  {
    value: 'policy',
    label: 'Policy',
    blurb: 'Your rule runs automatically; anything it does not cover waits for you.',
  },
  {
    value: 'delegated',
    label: 'Delegated',
    blurb: 'Your Ops Controller runs the rule for you, a little more cautiously, for their salary.',
  },
];

const DEFAULT_CEILING = 120;

interface PoliciesModalProps {
  open: boolean;
  onClose: () => void;
  /** Whether the Ops Controller seat is filled — gates Delegated. */
  hasOpsController: boolean;
}

export function PoliciesModal({ open, onClose, hasOpsController }: PoliciesModalProps): ReactNode {
  const [mode, setMode] = useState<AutomationMode>('manual');
  const [cancelEnabled, setCancelEnabled] = useState(false);
  const [cancelMinutes, setCancelMinutes] = useState(DEFAULT_CEILING);
  const [tasks, setTasks] = useState<OperationsTaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const hydrate = useCallback((state: AutomationStateResponse) => {
    const setting = state.settings.find((s) => s.system === 'disruption');
    setMode(setting?.mode ?? 'manual');
    const ceiling = setting?.policy?.disruptionResponse?.cancelDelaysOverMinutes ?? null;
    setCancelEnabled(ceiling !== null);
    setCancelMinutes(ceiling ?? DEFAULT_CEILING);
    setTasks(state.tasks);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError(null);
    void fetchAutomation().then((state) => {
      if (!live) return;
      if (state !== null) hydrate(state);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [open, hydrate]);

  // A delegated setting is meaningless without the seat: fall back to Policy so
  // the control never shows a mode the server would run as something else.
  useEffect(() => {
    if (mode === 'delegated' && !hasOpsController) setMode('policy');
  }, [mode, hasOpsController]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const policy =
      mode === 'manual'
        ? null
        : {
            disruptionResponse: {
              cancelDelaysOverMinutes: cancelEnabled
                ? Math.max(1, Math.round(cancelMinutes))
                : null,
            },
          };
    const outcome = await setAutomation('disruption', { mode, policy });
    setSaving(false);
    if (outcome.ok) {
      hydrate(outcome.state);
      onClose();
    } else {
      setError(outcome.message);
    }
  };

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="policies-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="modal__header">
          <div>
            <h2 id="policies-title" className="modal__title">
              Operations policies
            </h2>
            <p className="modal__subtitle">
              Choose how much of your operation runs itself while you are away.
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal__body" aria-busy={loading}>
          <fieldset className="policy-field">
            <legend className="policy-field__legend">Disruption response</legend>

            <div className="policy-modes" role="radiogroup" aria-label="Disruption response mode">
              {MODES.map((option) => {
                const disabled = option.value === 'delegated' && !hasOpsController;
                return (
                  <label
                    key={option.value}
                    className="policy-mode"
                    data-active={mode === option.value}
                    data-disabled={disabled}
                  >
                    <input
                      type="radio"
                      name="disruption-mode"
                      value={option.value}
                      checked={mode === option.value}
                      disabled={disabled}
                      onChange={() => setMode(option.value)}
                    />
                    <span className="policy-mode__label">{option.label}</span>
                    <span className="policy-mode__blurb">
                      {option.blurb}
                      {disabled && (
                        <span className="policy-mode__gate">
                          {' '}
                          Hire an Ops Controller to delegate.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>

            {mode !== 'manual' && (
              <div className="policy-rule">
                <label className="policy-rule__toggle">
                  <input
                    type="checkbox"
                    checked={cancelEnabled}
                    onChange={(event) => setCancelEnabled(event.target.checked)}
                  />
                  Cancel a delay longer than
                </label>
                <input
                  type="number"
                  className="policy-rule__minutes"
                  min={1}
                  value={cancelMinutes}
                  disabled={!cancelEnabled}
                  aria-label="Cancel delays longer than, in minutes"
                  onChange={(event) => setCancelMinutes(Number(event.target.value))}
                />
                <span className="policy-rule__unit">minutes</span>
                {!cancelEnabled && (
                  <span className="policy-rule__note">Never cancel — accept every delay.</span>
                )}
              </div>
            )}
          </fieldset>

          {tasks.length > 0 && (
            <section className="policy-tasks" aria-label="Waiting for you">
              <h3 className="policy-tasks__title">Waiting for you</h3>
              <ul className="policy-tasks__list">
                {tasks.map((task) => (
                  <li key={task.id} className="policy-tasks__item">
                    {task.detail}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error !== null && (
            <p className="modal__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="modal__footer">
          <button type="button" className="modal__button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="modal__button modal__button--primary"
            onClick={() => void onSave()}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save policy'}
          </button>
        </footer>
      </div>
    </div>
  );
}
