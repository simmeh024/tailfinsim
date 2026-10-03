import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import {
  TURNAROUND_PHASE_WINDOWS,
  type AirportGatesResponse,
  type AirportStand,
  type ApronAircraft,
  type GateContract,
  type StandDay,
  type TurnaroundPhase,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { leaseStand, releaseStand } from '../network/api';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  CONTRACT_LABEL,
  HEAT_GLYPH,
  HEAT_LABEL,
  STAND_KIND_LABEL,
  gameClock,
  heatBand,
  percent,
} from './apron-presentation';

import type { ReactNode } from 'react';

/**
 * The airport map's two panels (M7-07, App. B.7's interactions).
 *
 * > *"Click a gate to see the day's rotation and utilisation · click your
 * > aircraft for the flight panel · lease/release gates directly on the map."*
 *
 * Leasing goes through M7-06's own `leaseStand`/`releaseStand` — the map is a
 * second way into the gates endpoints, not a second set of them — and their
 * answer is the `gates` half of the apron, which the view folds in so the
 * stand changes colour without a second request. The quoted fee is echoed back
 * exactly as the gates page does, so a price that moved in the meantime is
 * re-quoted rather than charged.
 */

function money(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

export interface StandPanelProps {
  icao: string;
  stand: AirportStand;
  /** Your stand's day, when you hold it and the server sampled one. */
  day: StandDay | undefined;
  onClose: () => void;
  /** A lease or release succeeded: the airport's fresh stands. */
  onGates: (gates: AirportGatesResponse) => void;
}

export function StandPanel({ icao, stand, day, onClose, onGates }: StandPanelProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A different stand is a different conversation: drop the half-made decision.
  useEffect(() => {
    setConfirmingRelease(false);
    setFailure(null);
    headingRef.current?.focus();
  }, [stand.position]);

  const confirmRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmingRelease) confirmRef.current?.querySelector('button')?.focus();
  }, [confirmingRelease]);

  const change = (contract: GateContract | null) => {
    setBusy(true);
    setFailure(null);
    const request =
      contract === null
        ? releaseStand(icao, stand.position)
        : leaseStand(icao, stand.position, contract, stand.annualFeeMinor[contract]);
    void request
      .then((result) => {
        if (result.ok) onGates(result.gates);
        else setFailure(result.reason);
      })
      .catch(() => {
        setFailure('That change could not be saved. Nothing is assumed to have changed.');
      })
      .finally(() => {
        setBusy(false);
        setConfirmingRelease(false);
      });
  };

  const yours = stand.yourContract;
  const rivals = stand.holders.filter((holder) => !holder.isYou);

  return (
    <aside className="apron-panel" aria-labelledby="apron-panel-title">
      <div className="apron-panel__head">
        <h3 className="apron-panel__title" id="apron-panel-title" tabIndex={-1} ref={headingRef}>
          Stand {stand.position}
        </h3>
        <Button variant="tertiary" size="sm" onClick={onClose} aria-label="Close stand panel">
          ×
        </Button>
      </div>
      <p className="apron-panel__sub">{STAND_KIND_LABEL[stand.kind]}</p>

      <dl className="apron-panel__facts">
        <div>
          <dt>Your contract</dt>
          <dd>{yours === null ? 'None — you hold nothing here' : CONTRACT_LABEL[yours]}</dd>
        </div>
        <div>
          <dt>Other holders</dt>
          <dd>
            {rivals.length === 0
              ? 'Nobody else'
              : rivals
                  .map((holder) => `${holder.name} (${CONTRACT_LABEL[holder.contract]})`)
                  .join(', ')}
          </dd>
        </div>
        <div>
          <dt>Walk-up</dt>
          <dd className="figure">{money(stand.commonUseTurnFeeMinor)} a turn</dd>
        </div>
      </dl>

      {stand.exclusivelyHeld && (
        <p className="apron-panel__note">
          {yours === 'exclusive'
            ? 'Your exclusive lease closes this stand to every other airline.'
            : 'An exclusive lease closes this stand to every other airline, you included.'}
        </p>
      )}

      {yours !== null && <StandDayView day={day} utilisation={stand.utilisation} />}

      {failure !== null && (
        <StateBlock kind="refused" className="apron-panel__failure">
          {failure}
        </StateBlock>
      )}

      {yours === null ? (
        stand.available ? (
          <div className="apron-panel__actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                change('preferential');
              }}
            >
              Lease preferential — {money(stand.annualFeeMinor.preferential)} a year
            </Button>
            {stand.holders.length === 0 && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  change('exclusive');
                }}
              >
                Lease exclusive — {money(stand.annualFeeMinor.exclusive)} a year
              </Button>
            )}
            <p className="apron-panel__hint">
              Billed monthly. An exclusive lease buys no operational advantage — only that nobody
              else can have the stand.
            </p>
          </div>
        ) : (
          <p className="apron-panel__note">
            Not available to lease while another airline holds it exclusively.
          </p>
        )
      ) : confirmingRelease ? (
        <div
          className="apron-panel__confirm"
          ref={confirmRef}
          role="group"
          aria-label={`Confirm releasing ${stand.position}`}
        >
          <p className="apron-panel__note">
            Ends your {CONTRACT_LABEL[yours].toLowerCase()} lease on {stand.position}. Turns that
            used it fall back to a spare gate or a remote stand, at the walk-up fee.
          </p>
          <div className="apron-panel__actions apron-panel__actions--row">
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                change(null);
              }}
            >
              {busy ? 'Releasing…' : `Confirm — release ${stand.position}`}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmingRelease(false);
              }}
            >
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div className="apron-panel__actions">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setConfirmingRelease(true);
            }}
          >
            Release {stand.position}
          </Button>
        </div>
      )}
    </aside>
  );
}

/** *"The day's rotation and utilisation"* — the turns this stand worked, and what that came to. */
function StandDayView({
  day,
  utilisation,
}: {
  day: StandDay | undefined;
  utilisation: AirportStand['utilisation'];
}): ReactNode {
  const figures = day?.utilisation ?? utilisation;
  return (
    <section className="apron-panel__day" aria-label="The day's rotation">
      <h4 className="apron-panel__heading">The day’s rotation</h4>
      {figures !== null && (
        <p className="apron-panel__utilisation">
          <span aria-hidden="true">{HEAT_GLYPH[heatBand(figures)]}</span>{' '}
          <span className="figure">{percent(figures.fraction)}</span> of the operating day ·{' '}
          <span className="figure">{figures.turns}</span> turn{figures.turns === 1 ? '' : 's'} ·{' '}
          {HEAT_LABEL[heatBand(figures)]}
        </p>
      )}
      {figures?.belowFloor === true && (
        <p className="apron-panel__note">
          Below the utilisation floor: a stand you barely use can be withdrawn. The fix is more
          rotations through it, or giving it back.
        </p>
      )}
      {day === undefined || day.turns.length === 0 ? (
        <p className="apron-panel__hint">No turns sampled on this stand yet.</p>
      ) : (
        <ol className="apron-panel__turns">
          {day.turns.map((turn) => (
            <li key={`${turn.arrivedAt}-${turn.registration ?? ''}`} className="figure">
              {gameClock(turn.arrivedAt)}–{gameClock(turn.departsAt)} ·{' '}
              {turn.registration ?? 'unregistered'}
              {turn.fromIcao !== null && ` · from ${turn.fromIcao}`}
              {turn.toIcao !== null && ` · to ${turn.toIcao}`}
            </li>
          ))}
        </ol>
      )}
      <p className="apron-panel__hint">Times are the world’s clock, UTC.</p>
    </section>
  );
}

export interface AircraftPanelProps {
  aircraft: ApronAircraft;
  /** The stand it is drawn on, or null on the overflow apron. */
  standPosition: string | null;
  progress: Record<TurnaroundPhase, number>;
  onClose: () => void;
}

/** *"Click your aircraft for the flight panel."* */
export function AircraftPanel({
  aircraft,
  standPosition,
  progress,
  onClose,
}: AircraftPanelProps): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [aircraft.key]);

  return (
    <aside className="apron-panel" aria-labelledby="apron-panel-title">
      <div className="apron-panel__head">
        <h3 className="apron-panel__title" id="apron-panel-title" tabIndex={-1} ref={headingRef}>
          {aircraft.registration ?? 'Unregistered aircraft'}
        </h3>
        <Button variant="tertiary" size="sm" onClick={onClose} aria-label="Close aircraft panel">
          ×
        </Button>
      </div>
      <p className="apron-panel__sub">
        {aircraft.typeDesignation ?? 'Unknown type'} · {aircraft.airline.name}
      </p>

      <dl className="apron-panel__facts">
        <div>
          <dt>On stand</dt>
          <dd>
            {standPosition ?? 'Remote apron (overflow)'} since{' '}
            <span className="figure">{gameClock(aircraft.arrivedAt)}</span>
          </dd>
        </div>
        <div>
          <dt>Next departure</dt>
          <dd>
            {aircraft.departsAt === null ? (
              'None scheduled from here'
            ) : (
              <>
                <span className="figure">{gameClock(aircraft.departsAt)}</span>
                {aircraft.nextDestinationIcao !== null && ` to ${aircraft.nextDestinationIcao}`}
              </>
            )}
          </dd>
        </div>
      </dl>

      <h4 className="apron-panel__heading">Turnaround</h4>
      <ul className="apron-panel__rings">
        {TURNAROUND_PHASE_WINDOWS.map((window) => (
          <li key={window.phase}>
            <span>{window.label}</span>{' '}
            <span className="figure">{percent(progress[window.phase])}</span>
          </li>
        ))}
      </ul>

      <p className="apron-panel__hint">Times are the world’s clock, UTC.</p>
      <Link className="apron-panel__link" to="/fleet">
        Open in Fleet
      </Link>
    </aside>
  );
}
