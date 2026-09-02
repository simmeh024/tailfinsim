import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import type {
  AirlineCodeAvailabilityResponse,
  AirlineFoundingAirport,
  AirlineFoundingOptionsResponse,
  CreateAirlineInput,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { BuildBadge } from '../version/BuildBadge';

import {
  checkFoundingCodes,
  fetchFoundingOptions,
  postAirline,
  searchFoundingAirports,
} from './api';

import type { ReactNode } from 'react';

interface Draft {
  name: string;
  baseCountry: string;
  iataCode: string;
  icaoCode: string;
  callsign: string;
}

type DraftField = keyof Draft;

const EMPTY_DRAFT: Draft = {
  name: '',
  baseCountry: '',
  iataCode: '',
  icaoCode: '',
  callsign: '',
};

const TIER_LABEL: Record<AirlineFoundingAirport['tier'], string> = {
  flagship: 'Flagship',
  large: 'Large',
  medium: 'Medium',
  small: 'Small',
  regional: 'Regional',
};

/** Display only, in the player's display currency (M8-02). Wire stays USD minor. */
function majorUnits(minor: number): string {
  return formatUsdMinor(minor);
}

function fieldDescription(hint: string, field: string, errors: Record<string, string[]>): string {
  return errors[field]?.length ? `${hint} ${field}-error` : hint;
}

function ruleErrors(draft: Draft, worldId: string, hubIdent: string): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (worldId === '') errors.worldId = ['Choose an open world.'];
  if (draft.name.trim() === '') errors.name = ['Enter the public name of your airline.'];
  if (!/^[A-Z]{2}$/.test(draft.baseCountry)) {
    errors.baseCountry = ['Use the two-letter ISO country code, such as NL or GB.'];
  }
  if (!/^[A-Z0-9]{2}$/.test(draft.iataCode)) {
    errors.iataCode = ['Use exactly two uppercase letters or numbers.'];
  }
  if (!/^[A-Z]{3}$/.test(draft.icaoCode)) {
    errors.icaoCode = ['Use exactly three uppercase letters.'];
  }
  if (!/^[A-Z0-9]+(?: [A-Z0-9]+)*$/.test(draft.callsign) || !/[A-Z]/.test(draft.callsign)) {
    errors.callsign = [
      'Use uppercase letters, numbers and single spaces, including at least one letter.',
    ];
  }
  if (hubIdent === '') errors.hubIdent = ['Choose the airport where your airline begins.'];
  return errors;
}

function FieldError({ field, errors }: { field: string; errors: Record<string, string[]> }) {
  const messages = errors[field];
  if (!messages?.length) return null;
  return (
    <p id={`${field}-error`} className="founding__field-error">
      {messages.join(' ')}
    </p>
  );
}

function AirportOption({
  airport,
  selected,
  onSelect,
}: {
  airport: AirlineFoundingAirport;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  const code = airport.iata ?? airport.icao ?? airport.ident;
  return (
    <label className={selected ? 'hub-option hub-option--selected' : 'hub-option'}>
      <input
        type="radio"
        name="founderHub"
        value={airport.ident}
        checked={selected}
        onChange={onSelect}
      />
      <span className="hub-option__code figure">{code}</span>
      <span className="hub-option__identity">
        <strong>{airport.name}</strong>
        <span>
          {airport.city ? `${airport.city} · ` : ''}
          {airport.country} · {airport.ident}
        </span>
      </span>
      <span className="hub-option__terms">
        <span className="hub-option__tier">{TIER_LABEL[airport.tier]}</span>
        <span className="figure">Founder grant · {majorUnits(airport.foundingCostMinor)} now</span>
      </span>
      {airport.feeWarning && <span className="hub-option__warning">▲ {airport.feeWarning}</span>}
    </label>
  );
}

export function FoundingPage(): ReactNode {
  const navigate = useNavigate();
  const errorSummary = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState<AirlineFoundingOptionsResponse | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [selectedWorldId, setSelectedWorldId] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [airportQuery, setAirportQuery] = useState('');
  const [airports, setAirports] = useState<AirlineFoundingAirport[]>([]);
  const [airportsBusy, setAirportsBusy] = useState(false);
  const [airportsFailed, setAirportsFailed] = useState(false);
  const [selectedAirport, setSelectedAirport] = useState<AirlineFoundingAirport | null>(null);
  const [codeCheck, setCodeCheck] = useState<AirlineCodeAvailabilityResponse | null>(null);
  const [codeCheckFailed, setCodeCheckFailed] = useState(false);
  const [raceAlternatives, setRaceAlternatives] = useState<{
    iata?: string[];
    icao?: string[];
  }>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOptions = async () => {
    setOptionsFailed(false);
    try {
      const result = await fetchFoundingOptions();
      setOptions(result);
      const firstAvailable = result.worlds.find((entry) => entry.availability === 'available');
      setSelectedWorldId((current) => (current !== '' ? current : (firstAvailable?.id ?? '')));
    } catch {
      setOptionsFailed(true);
    }
  };

  useEffect(() => {
    void loadOptions();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const delay = airportQuery.trim() === '' ? 0 : 250;
    const timer = window.setTimeout(() => {
      setAirportsBusy(true);
      setAirportsFailed(false);
      void searchFoundingAirports(airportQuery, controller.signal)
        .then((result) => {
          setAirports(result);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            setAirportsFailed(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setAirportsBusy(false);
        });
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [airportQuery]);

  const codesReady =
    selectedWorldId !== '' &&
    draft.name.trim() !== '' &&
    /^[A-Z0-9]{2}$/.test(draft.iataCode) &&
    /^[A-Z]{3}$/.test(draft.icaoCode);

  useEffect(() => {
    if (!codesReady) {
      setCodeCheck(null);
      setCodeCheckFailed(false);
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void checkFoundingCodes({
        worldId: selectedWorldId,
        name: draft.name,
        iataCode: draft.iataCode,
        icaoCode: draft.icaoCode,
      })
        .then((result) => {
          if (active) {
            setCodeCheck(result);
            setCodeCheckFailed(false);
          }
        })
        .catch(() => {
          if (active) setCodeCheckFailed(true);
        });
    }, 350);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [codesReady, draft.iataCode, draft.icaoCode, draft.name, selectedWorldId]);

  useEffect(() => {
    if (formError) errorSummary.current?.focus();
  }, [formError]);

  const selectedWorld = useMemo(
    () => options?.worlds.find((entry) => entry.id === selectedWorldId) ?? null,
    [options, selectedWorldId],
  );

  const update = (field: DraftField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    if (field === 'iataCode' || field === 'icaoCode') {
      setCodeCheck(null);
      setRaceAlternatives((current) => ({
        ...current,
        [field === 'iataCode' ? 'iata' : 'icao']: undefined,
      }));
    }
  };

  const chooseAlternative = (kind: 'iata' | 'icao', code: string) => {
    update(kind === 'iata' ? 'iataCode' : 'icaoCode', code);
  };

  const submit = async () => {
    const nextErrors = ruleErrors(draft, selectedWorldId, selectedAirport?.ident ?? '');
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFormError('Some details need attention before the airline can be founded.');
      return;
    }

    setBusy(true);
    setFormError(null);
    setErrors({});
    setRaceAlternatives({});
    try {
      const input: CreateAirlineInput = {
        worldId: selectedWorldId,
        name: draft.name,
        baseCountry: draft.baseCountry,
        iataCode: draft.iataCode,
        icaoCode: draft.icaoCode,
        callsign: draft.callsign,
        hubIdent: selectedAirport?.ident ?? '',
      };
      const outcome = await postAirline(input);
      if (outcome.ok) {
        void navigate('/network', { replace: true });
        return;
      }

      setErrors(outcome.refusal.fields ?? {});
      setFormError(outcome.refusal.message);
      if (outcome.refusal.codeKind && outcome.refusal.alternatives) {
        setRaceAlternatives({ [outcome.refusal.codeKind]: outcome.refusal.alternatives });
      }
    } catch {
      setFormError('Tailfin could not reach the founding service. Nothing was created; try again.');
    } finally {
      setBusy(false);
    }
  };

  const iataAlternatives = raceAlternatives.iata ?? codeCheck?.iataCode.alternatives ?? [];
  const icaoAlternatives = raceAlternatives.icao ?? codeCheck?.icaoCode.alternatives ?? [];
  const noAvailableWorld =
    options !== null && !options.worlds.some((w) => w.availability === 'available');

  return (
    <main className="founding" aria-labelledby="founding-title">
      <header className="founding__masthead">
        <div className="founding__brand" aria-label="Tailfin">
          <span className="founding__mark" aria-hidden="true">
            ◤
          </span>
          <span>Tailfin</span>
        </div>
        <div className="founding__balance" aria-live="polite">
          <span>Opening cash</span>
          <strong className="figure">
            {selectedWorld ? majorUnits(selectedWorld.openingCashMinor) : '—'}
          </strong>
          <small>world currency</small>
        </div>
      </header>

      <section className="founding__desk">
        <div className="founding__intro">
          <p className="founding__eyebrow">Founding desk · minute zero</p>
          <h1 id="founding-title">What’s your airline called?</h1>
          <p>
            Identity first. Choose the name people remember, the codes operations use, and the
            airport you are willing to build from.
          </p>
        </div>

        {optionsFailed && (
          <div className="founding__load-error" role="alert">
            <p>Could not load the open worlds. No choices have been lost.</p>
            <button type="button" onClick={() => void loadOptions()}>
              Try again
            </button>
          </div>
        )}

        {options === null && !optionsFailed && <p aria-live="polite">Opening the desk…</p>}

        {noAvailableWorld && (
          <div className="founding__load-error" role="status">
            <p>There is no open world in which this account can found another airline.</p>
            {options.memberships.length > 0 && <Link to="/world">Return to your airline</Link>}
          </div>
        )}

        {options !== null && !noAvailableWorld && (
          <form
            className="founding__form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            noValidate
          >
            {formError && (
              <div
                ref={errorSummary}
                className="founding__error-summary"
                role="alert"
                tabIndex={-1}
              >
                <strong>Founding refused</strong>
                <span>{formError}</span>
              </div>
            )}

            <section className="founding__section" aria-labelledby="identity-heading">
              <div className="founding__section-heading">
                <span className="figure">01</span>
                <div>
                  <h2 id="identity-heading">Identity</h2>
                  <p>The public name comes first. Operational shorthand follows it.</p>
                </div>
              </div>

              <div className="founding__field founding__field--wide">
                <label htmlFor="airline-name">Airline name</label>
                <input
                  id="airline-name"
                  name="name"
                  value={draft.name}
                  maxLength={120}
                  autoComplete="organization"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={fieldDescription('name-hint', 'name', errors)}
                  onChange={(event) => update('name', event.target.value)}
                />
                <p id="name-hint" className="founding__hint">
                  Unicode letters are welcome; invisible characters and emoji are not.
                </p>
                <FieldError field="name" errors={errors} />
              </div>

              <div className="founding__field-grid">
                <div className="founding__field">
                  <label htmlFor="base-country">Home country</label>
                  <input
                    id="base-country"
                    name="baseCountry"
                    className="figure"
                    value={draft.baseCountry}
                    maxLength={2}
                    autoComplete="country"
                    aria-invalid={Boolean(errors.baseCountry)}
                    aria-describedby={fieldDescription('base-country-hint', 'baseCountry', errors)}
                    onChange={(event) =>
                      update('baseCountry', event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))
                    }
                  />
                  <p id="base-country-hint" className="founding__hint">
                    Two-letter ISO code, for example NL.
                  </p>
                  <FieldError field="baseCountry" errors={errors} />
                </div>

                <div className="founding__field">
                  <label htmlFor="world">World</label>
                  <select
                    id="world"
                    value={selectedWorldId}
                    aria-invalid={Boolean(errors.worldId)}
                    aria-describedby={errors.worldId ? 'world-error' : undefined}
                    onChange={(event) => {
                      setSelectedWorldId(event.target.value);
                      setErrors((current) => {
                        const next = { ...current };
                        delete next.worldId;
                        return next;
                      });
                    }}
                  >
                    {options.worlds.map((entry) => (
                      <option
                        key={entry.id}
                        value={entry.id}
                        disabled={entry.availability !== 'available'}
                      >
                        {entry.name}
                        {entry.availability === 'full' ? ' — full' : ''}
                        {entry.availability === 'already-founded' ? ' — already joined' : ''}
                      </option>
                    ))}
                  </select>
                  <FieldError field="worldId" errors={errors} />
                </div>
              </div>

              <div className="founding__code-grid">
                <div className="founding__field">
                  <label htmlFor="iata-code">IATA airline code</label>
                  <input
                    id="iata-code"
                    name="iataCode"
                    className="figure"
                    value={draft.iataCode}
                    maxLength={2}
                    aria-invalid={Boolean(errors.iataCode)}
                    aria-describedby={fieldDescription('iata-hint', 'iataCode', errors)}
                    onChange={(event) =>
                      update('iataCode', event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
                    }
                  />
                  <p id="iata-hint" className="founding__hint">
                    Two letters or numbers.
                  </p>
                  <FieldError field="iataCode" errors={errors} />
                  {codeCheck?.iataCode.status === 'available' && (
                    <p className="founding__available" role="status">
                      ✓ {draft.iataCode} is available in this world.
                    </p>
                  )}
                  {(codeCheck?.iataCode.status === 'assigned' || iataAlternatives.length > 0) && (
                    <div className="founding__alternatives">
                      <span>{draft.iataCode} is not available. Try:</span>
                      {iataAlternatives.map((code) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => chooseAlternative('iata', code)}
                          aria-label={`Use IATA code ${code}`}
                        >
                          {code}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="founding__field">
                  <label htmlFor="icao-code">ICAO airline code</label>
                  <input
                    id="icao-code"
                    name="icaoCode"
                    className="figure"
                    value={draft.icaoCode}
                    maxLength={3}
                    aria-invalid={Boolean(errors.icaoCode)}
                    aria-describedby={fieldDescription('icao-hint', 'icaoCode', errors)}
                    onChange={(event) =>
                      update('icaoCode', event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))
                    }
                  />
                  <p id="icao-hint" className="founding__hint">
                    Three letters.
                  </p>
                  <FieldError field="icaoCode" errors={errors} />
                  {codeCheck?.icaoCode.status === 'available' && (
                    <p className="founding__available" role="status">
                      ✓ {draft.icaoCode} is available in this world.
                    </p>
                  )}
                  {(codeCheck?.icaoCode.status === 'assigned' || icaoAlternatives.length > 0) && (
                    <div className="founding__alternatives">
                      <span>{draft.icaoCode} is not available. Try:</span>
                      {icaoAlternatives.map((code) => (
                        <button
                          key={code}
                          type="button"
                          onClick={() => chooseAlternative('icao', code)}
                          aria-label={`Use ICAO code ${code}`}
                        >
                          {code}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="founding__field">
                  <label htmlFor="callsign">Operational callsign</label>
                  <input
                    id="callsign"
                    name="callsign"
                    className="figure"
                    value={draft.callsign}
                    maxLength={32}
                    aria-invalid={Boolean(errors.callsign)}
                    aria-describedby={fieldDescription('callsign-hint', 'callsign', errors)}
                    onChange={(event) => update('callsign', event.target.value.toUpperCase())}
                  />
                  <p id="callsign-hint" className="founding__hint">
                    What controllers say aloud: TAILFIN or SPEEDBIRD 1.
                  </p>
                  <FieldError field="callsign" errors={errors} />
                </div>
              </div>

              {codesReady && !codeCheck && !codeCheckFailed && (
                <p className="founding__checking" aria-live="polite">
                  Checking codes in {selectedWorld?.name ?? 'this world'}…
                </p>
              )}
              {codeCheckFailed && (
                <p className="founding__checking" role="status">
                  Availability could not be checked yet. Founding remains authoritative and will
                  return fresh alternatives if a code races.
                </p>
              )}
              {codeCheck && <p className="founding__checking">{codeCheck.advisory.message}</p>}
            </section>

            <section className="founding__section" aria-labelledby="hub-heading">
              <div className="founding__section-heading">
                <span className="figure">02</span>
                <div>
                  <h2 id="hub-heading">Founder hub</h2>
                  <p>Your first hub costs nothing to acquire. Its operating burden is not free.</p>
                </div>
              </div>

              <div className="founding__field founding__field--wide">
                <label htmlFor="hub-search">Search airports</label>
                <input
                  id="hub-search"
                  type="search"
                  value={airportQuery}
                  placeholder="Airport, city, IATA or ICAO code"
                  aria-describedby="hub-search-hint"
                  onChange={(event) => setAirportQuery(event.target.value)}
                />
                <p id="hub-search-hint" className="founding__hint">
                  {airportQuery.trim() === ''
                    ? 'Three medium-airport recommendations are shown first.'
                    : 'Searching the full scheduled-service airport set.'}
                </p>
              </div>

              <fieldset
                className="founding__hub-list"
                aria-describedby={errors.hubIdent ? 'hubIdent-error' : undefined}
              >
                <legend>
                  {airportQuery.trim() === '' ? 'Recommended medium airports' : 'Search results'}
                </legend>
                {airportsBusy && <p aria-live="polite">Searching airports…</p>}
                {airportsFailed && (
                  <p role="alert">Could not search airports. Change the search to try again.</p>
                )}
                {!airportsBusy && !airportsFailed && airports.length === 0 && (
                  <p>No scheduled-service airport matches that search.</p>
                )}
                {airports.map((entry) => (
                  <AirportOption
                    key={entry.ident}
                    airport={entry}
                    selected={selectedAirport?.ident === entry.ident}
                    onSelect={() => {
                      setSelectedAirport(entry);
                      setErrors((current) => {
                        const next = { ...current };
                        delete next.hubIdent;
                        return next;
                      });
                    }}
                  />
                ))}
              </fieldset>
              <FieldError field="hubIdent" errors={errors} />

              {selectedAirport && (
                <div className="founding__hub-summary" aria-live="polite">
                  <div>
                    <span>Selected hub</span>
                    <strong>
                      {selectedAirport.name} · {selectedAirport.ident}
                    </strong>
                  </div>
                  <div>
                    <span>Founding cost</span>
                    <strong className="figure">
                      {majorUnits(selectedAirport.foundingCostMinor)}
                    </strong>
                  </div>
                  <div>
                    <span>Opening cash after founding</span>
                    <strong className="figure">
                      {selectedWorld ? majorUnits(selectedWorld.openingCashMinor) : '—'}
                    </strong>
                  </div>
                  {selectedAirport.feeWarning && (
                    <p className="founding__hub-warning">
                      ▲ {selectedAirport.feeWarning} It does not block founding.
                    </p>
                  )}
                </div>
              )}
            </section>

            <footer className="founding__commit">
              <div>
                <span>Opening position</span>
                <strong className="figure">
                  {selectedWorld ? majorUnits(selectedWorld.openingCashMinor) : '—'}
                </strong>
                <small>
                  {selectedWorld?.freeHubAllowance === 1
                    ? 'plus one founder-grant hub'
                    : 'world terms unavailable'}
                </small>
              </div>
              <button type="submit" disabled={busy} aria-busy={busy}>
                {busy ? 'Founding…' : 'Found airline'}
              </button>
            </footer>
          </form>
        )}
      </section>

      <BuildBadge />
    </main>
  );
}
