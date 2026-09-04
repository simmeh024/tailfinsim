import { useState } from 'react';

import { Button } from '../../ui/Button';
import { openRoute, type OpenRouteOutcome } from '../api';

import type { ReactNode } from 'react';

/**
 * The "Open New Route" flow (App. B.4).
 *
 * Unchanged in behaviour from the old page: two ICAO fields and a server-checked
 * open, with the refusal naming *which* of the seven reachability checks failed —
 * "never a generic unavailable". Now surfaced from the planner's route rail.
 */

const REACHABILITY_LABEL: Record<string, string> = {
  range: 'Out of range',
  runway: 'Runway too short',
  wingspan: 'Aircraft too large for the stand',
  etops: 'Beyond the diversion limit',
  curfew: 'Outside operating hours',
  traffic_rights: 'No traffic rights for that country pair',
  slots: 'No slot in that band',
};

export function OpenRouteForm({
  onOpened,
  initialOrigin = '',
  initialDestination = '',
}: {
  onOpened: (routeId: string) => void;
  /** Pre-fill from a deep link (e.g. the world map's "open route from" action). */
  initialOrigin?: string;
  initialDestination?: string;
}): ReactNode {
  const [origin, setOrigin] = useState(initialOrigin.toUpperCase());
  const [destination, setDestination] = useState(initialDestination.toUpperCase());
  const [outcome, setOutcome] = useState<OpenRouteOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await openRoute(origin, destination);
      setOutcome(result);
      if (result.ok) {
        setOrigin('');
        setDestination('');
        onOpened(result.routeId);
      }
    } catch {
      setOutcome(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="net-open">
      <div className="net-open__fields">
        <label className="fares__field">
          <span className="visually-hidden">Origin ICAO</span>
          <input
            className="fares__input figure"
            type="text"
            placeholder="EHAM"
            maxLength={4}
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value.toUpperCase());
            }}
          />
        </label>
        <span aria-hidden="true">→</span>
        <label className="fares__field">
          <span className="visually-hidden">Destination ICAO</span>
          <input
            className="fares__input figure"
            type="text"
            placeholder="LEBL"
            maxLength={4}
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value.toUpperCase());
            }}
          />
        </label>
        <Button
          variant="primary"
          disabled={busy || origin.length < 4 || destination.length < 4}
          onClick={() => void submit()}
        >
          Open
        </Button>
      </div>

      {outcome !== null && !outcome.ok && (
        <p className="fares__violation" role="alert">
          {outcome.kind === 'unreachable' && (
            <>
              <strong>
                {REACHABILITY_LABEL[outcome.reachability.reason] ?? outcome.reachability.reason}
              </strong>{' '}
              — {outcome.reachability.detail}
            </>
          )}
          {outcome.kind === 'authority-required' && <>{outcome.detail}</>}
          {outcome.kind === 'unknown-airport' && <>No airport with the code {outcome.icao}.</>}
          {outcome.kind === 'same-airport' && <>A route needs two different airports.</>}
          {outcome.kind === 'no-airline' && (
            <>You do not have an airline in this world yet, so there is nothing to fly the route.</>
          )}
          {outcome.kind === 'active-world-required' && (
            <>Choose which world you want to operate in before opening a route.</>
          )}
          {outcome.kind === 'duplicate' && <>You already fly that pair.</>}
        </p>
      )}
    </div>
  );
}
