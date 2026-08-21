import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import type { UpdateOwnAirlineInput } from '@tailfin/shared';

import { formatMinorUnits, patchOwnAirline } from './api';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

function FieldError({ field, errors }: { field: string; errors: Record<string, string[]> }) {
  const messages = errors[field];
  if (!messages?.length) return null;
  return (
    <p className="airline-page__field-error" id={`${field}-error`}>
      {messages.join(' ')}
    </p>
  );
}

function describedBy(field: string, hint: string, errors: Record<string, string[]>): string {
  return errors[field]?.length ? `${hint} ${field}-error` : hint;
}

export function AirlinePage(): ReactNode {
  const { ownAirline, ownAirlineError, ownAirlineLoading, replaceOwnAirline } =
    useOutletContext<OwnAirlineShellContext>();
  const errorSummary = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<UpdateOwnAirlineInput | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ownAirline?.airline) return;
    setDraft({
      name: ownAirline.airline.name,
      callsign: ownAirline.airline.callsign,
      baseCountry: ownAirline.airline.baseCountry,
    });
  }, [ownAirline]);

  useEffect(() => {
    if (formError) errorSummary.current?.focus();
  }, [formError]);

  if (ownAirlineLoading) {
    return (
      <section className="page airline-page">
        <h1 className="page__title">Your airline</h1>
        <p className="page__note" aria-live="polite">
          Reading your airline…
        </p>
      </section>
    );
  }

  if (ownAirlineError) {
    return (
      <section className="page airline-page">
        <h1 className="page__title">Your airline</h1>
        <p className="page__note" role="alert">
          Your airline could not be read. Reload to try again.
        </p>
      </section>
    );
  }

  if (!ownAirline?.airline || !draft) {
    return (
      <section className="page airline-page">
        <h1 className="page__title">Your airline</h1>
        <p className="page__note">There is no airline in the active world yet.</p>
        <Link className="airline-page__found" to="/found">
          Open the founding desk
        </Link>
      </section>
    );
  }

  const current = ownAirline.airline;
  if (!ownAirline.rebrand) {
    const restricted = current.status === 'restricted';
    return (
      <section className="page airline-page" aria-labelledby="airline-page-title">
        <div className="airline-page__heading">
          <div>
            <p className="airline-page__eyebrow">Read-only airline record</p>
            <h1 className="page__title" id="airline-page-title">
              {current.name}
            </h1>
            <p className="page__note">
              {restricted
                ? 'Restricted · existing operations remain available, but new commitments and rebrands are paused.'
                : `Ceased ${current.ceasedAt?.slice(0, 10) ?? ''} · operational history remains readable.`}
            </p>
          </div>
          <div className="airline-page__designators" aria-label="Historical airline designators">
            <span>
              IATA <strong className="figure">{current.iataCode}</strong>
            </span>
            <span>
              ICAO <strong className="figure">{current.icaoCode}</strong>
            </span>
          </div>
        </div>

        <dl className="airline-page__metrics">
          <div>
            <dt>Lifecycle</dt>
            <dd>{current.status}</dd>
            <span>changed {current.statusChangedAt.slice(0, 10)}</span>
          </div>
          <div>
            <dt>Cash</dt>
            <dd className="figure">{formatMinorUnits(current.cash)}</dd>
            <span>preserved world record</span>
          </div>
          <div>
            <dt>Reputation</dt>
            <dd className="figure">{current.reputation.toFixed(2)} / 1.00</dd>
            <span>preserved world record</span>
          </div>
        </dl>

        <aside className="airline-page__locked">
          <h2>{restricted ? 'Recovery remains possible' : 'History remains attached'}</h2>
          <p>
            {restricted
              ? 'Existing routes may still be managed and flown. Opening routes, acquiring aircraft and changing the brand require active status.'
              : 'Flights, results and audit entries continue to resolve this airline by its stable id. Its former codes may now be allocated to another live airline.'}
          </p>
        </aside>
      </section>
    );
  }

  const dirty =
    draft.name !== current.name ||
    draft.callsign !== current.callsign ||
    draft.baseCountry !== current.baseCountry;

  const update = (field: keyof UpdateOwnAirlineInput, value: string) => {
    setDraft((before) => (before ? { ...before, [field]: value } : before));
    setErrors((before) => {
      const next = { ...before };
      delete next[field];
      return next;
    });
    setSuccess(null);
  };

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setFormError(null);
    setSuccess(null);
    try {
      const outcome = await patchOwnAirline(draft);
      if (!outcome.ok) {
        setErrors(outcome.refusal.fields ?? {});
        setFormError(outcome.refusal.message);
        return;
      }

      replaceOwnAirline({ ...ownAirline, airline: outcome.result.airline });
      setDraft({
        name: outcome.result.airline.name,
        callsign: outcome.result.airline.callsign,
        baseCountry: outcome.result.airline.baseCountry,
      });
      setSuccess(
        outcome.result.changed
          ? `Rebrand complete. ${formatMinorUnits(outcome.result.chargedMinor)} world currency was recorded in your cash history.`
          : 'That identity was already current; no charge was recorded.',
      );
    } catch {
      setFormError('Tailfin could not reach the airline service. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page airline-page" aria-labelledby="airline-page-title">
      <div className="airline-page__heading">
        <div>
          <p className="airline-page__eyebrow">Private airline record</p>
          <h1 className="page__title" id="airline-page-title">
            {current.name}
          </h1>
          <p className="page__note">
            Identity, current balance and reputation for the active world.
          </p>
        </div>
        <div className="airline-page__designators" aria-label="Airline designators">
          <span>
            IATA <strong className="figure">{current.iataCode}</strong>
          </span>
          <span>
            ICAO <strong className="figure">{current.icaoCode}</strong>
          </span>
        </div>
      </div>

      <dl className="airline-page__metrics">
        <div>
          <dt>Cash</dt>
          <dd className="figure">{formatMinorUnits(current.cash)}</dd>
          <span>world currency · read-only here</span>
        </div>
        <div>
          <dt>Reputation</dt>
          <dd className="figure">{current.reputation.toFixed(2)} / 1.00</dd>
          <span>earned from operations · read-only</span>
        </div>
        <div>
          <dt>Home country</dt>
          <dd className="figure">{current.baseCountry}</dd>
          <span>ISO country code</span>
        </div>
      </dl>

      <div className="airline-page__grid">
        <form
          className="airline-page__editor"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="airline-page__section-heading">
            <div>
              <p className="airline-page__eyebrow">Paid identity event</p>
              <h2>Rebrand this airline</h2>
            </div>
            <div className="airline-page__cost">
              <span>Rebrand cost</span>
              <strong className="figure">{formatMinorUnits(ownAirline.rebrand.costMinor)}</strong>
              <small>world currency</small>
            </div>
          </div>

          <p className="airline-page__explanation">
            Saving a changed identity records one permanent rebrand event and one cash movement.
            Submitting the current identity costs nothing.
          </p>

          {formError && (
            <div className="airline-page__error" role="alert" tabIndex={-1} ref={errorSummary}>
              <strong>The rebrand was not applied.</strong>
              <span>{formError}</span>
            </div>
          )}
          {success && (
            <p className="airline-page__success" role="status">
              {success}
            </p>
          )}

          <div className="airline-page__field">
            <label htmlFor="airline-name">Airline name</label>
            <input
              id="airline-name"
              value={draft.name}
              maxLength={120}
              required
              aria-invalid={Boolean(errors.name)}
              aria-describedby={describedBy('name', 'airline-name-hint', errors)}
              onChange={(event) => update('name', event.target.value)}
            />
            <p id="airline-name-hint">Unicode letters and ordinary punctuation; 120 characters.</p>
            <FieldError field="name" errors={errors} />
          </div>

          <div className="airline-page__field-row">
            <div className="airline-page__field">
              <label htmlFor="airline-callsign">Operational callsign</label>
              <input
                id="airline-callsign"
                className="figure"
                value={draft.callsign}
                minLength={2}
                maxLength={32}
                required
                aria-invalid={Boolean(errors.callsign)}
                aria-describedby={describedBy('callsign', 'airline-callsign-hint', errors)}
                onChange={(event) => update('callsign', event.target.value.toUpperCase())}
              />
              <p id="airline-callsign-hint">Uppercase letters, numbers and single spaces.</p>
              <FieldError field="callsign" errors={errors} />
            </div>

            <div className="airline-page__field">
              <label htmlFor="airline-country">Home country</label>
              <input
                id="airline-country"
                className="figure"
                value={draft.baseCountry}
                minLength={2}
                maxLength={2}
                required
                aria-invalid={Boolean(errors.baseCountry)}
                aria-describedby={describedBy('baseCountry', 'airline-country-hint', errors)}
                onChange={(event) =>
                  update('baseCountry', event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))
                }
              />
              <p id="airline-country-hint">Two-letter ISO code, such as NL or GB.</p>
              <FieldError field="baseCountry" errors={errors} />
            </div>
          </div>

          <button type="submit" disabled={!dirty || busy} aria-busy={busy}>
            {busy
              ? 'Recording rebrand…'
              : `Rebrand for ${formatMinorUnits(ownAirline.rebrand.costMinor)}`}
          </button>
        </form>

        <aside className="airline-page__locked" aria-labelledby="designators-title">
          <p className="airline-page__eyebrow">Stable identity</p>
          <h2 id="designators-title">Designators stay allocated while live</h2>
          <p>
            <strong className="figure">{current.iataCode}</strong> and{' '}
            <strong className="figure">{current.icaoCode}</strong> remain attached to this airline.
            They are released only if the airline ceases; historical records keep this airline’s
            stable id and original codes.
          </p>
          <p>Cash moves through recorded causes. Reputation is earned from operations.</p>
        </aside>
      </div>
    </section>
  );
}
