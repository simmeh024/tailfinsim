import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  GroundContractsResponse,
  GroundServiceLineView,
  GroundStationResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../../currency/display';
import { Button } from '../../ui/Button';
import { StateBlock } from '../../ui/StateBlock';
import { useWorldClock } from '../../world/useWorldClock';
import {
  closeSelfHandling,
  fetchGroundContracts,
  fetchGroundStation,
  openSelfHandling,
  signGroundContract,
  terminateGroundContract,
  type GroundWrite,
} from '../ground-api';
import {
  commitmentInWords,
  freeSlots,
  GRADE_LABEL,
  multiplier,
  percent,
  scarcityInWords,
  SERVICE_LINE_LABEL,
  termPresentation,
  type TermPresentation,
} from '../ground-presentation';

import { Chip } from './ui';

import type { ReactNode } from 'react';

import '../ground.css';

/**
 * Ground handling, per station (SURFACE-05, M5-06, §9.3's Layer C).
 *
 * ## Why it is a view of the Network page
 *
 * A handling contract is an arrangement **at an airport**, beside the two other
 * arrangements a player makes there — slots (M7-05) and stands (M7-06) — which
 * are already the Network page's Slots and Gates views. A third view with the
 * same airport picker keeps the three a player needs to fly a station side by
 * side, and the lapse alert lands here (`/network?view=ground&contract=…`).
 *
 * ## What it shows
 *
 *   - **Across the network**: every arrangement the airline holds, with its
 *     term, its volume commitment and what leaving would cost — the destination
 *     the "before it lapses" alert links to.
 *   - **One station**: for each service line, what is arranged, what walk-up
 *     costs instead, every vendor grade with **all five** of §9.3's numbers and
 *     how full it is, and self-handling with its trade.
 *
 * Every figure is the server's, and every write answers with the station's whole
 * picture, which replaces the page's — a refused write replaces nothing and says
 * why. No write is retried: signing and terminating move money.
 */

type Station = GroundStationResponse | 'loading' | 'error';

function money(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

function TermCell({ term }: { term: TermPresentation }): ReactNode {
  return (
    <span className="net-ground__term">
      <Chip tone={term.tone}>{term.label}</Chip>{' '}
      <span className="net-ground__term-detail">{term.detail}</span>
    </span>
  );
}

/** Every arrangement across the network — where the lapse alert lands. */
function NetworkContracts({
  contracts,
  focus,
  gameNow,
  speed,
  onOpen,
}: {
  contracts: GroundContractsResponse | 'loading' | 'error';
  focus: string | null;
  gameNow: Date | null;
  speed: number | null;
  onOpen: (icao: string) => void;
}): ReactNode {
  if (contracts === 'loading') {
    return <StateBlock kind="loading">Reading your handling arrangements…</StateBlock>;
  }
  if (contracts === 'error') {
    return <StateBlock kind="broken">Could not load your handling arrangements.</StateBlock>;
  }
  if (contracts.contracts.length === 0) {
    return (
      <StateBlock kind="empty">
        Nothing arranged anywhere: every turn is handled walk-up, at the walk-up price. Pick a
        station below to sign a handler or handle a line yourself.
      </StateBlock>
    );
  }
  return (
    <table className="admin__table net-comp-table net-ground__table">
      <thead>
        <tr>
          <th scope="col">Station</th>
          <th scope="col">Line</th>
          <th scope="col">Handled by</th>
          <th scope="col">Term</th>
          <th scope="col">Commitment</th>
          <th scope="col">To leave now</th>
          <th scope="col">
            <span className="visually-hidden">Open</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {contracts.contracts.map((row) => (
          <tr
            key={row.id}
            data-contract={row.id}
            aria-current={row.id === focus ? 'true' : undefined}
            className={row.id === focus ? 'net-ground__focus' : undefined}
          >
            <th scope="row" className="figure">
              {row.icao}
            </th>
            <td>{SERVICE_LINE_LABEL[row.serviceLine]}</td>
            <td>
              {row.kind === 'self'
                ? `Your own staff, ${String(row.headcount ?? 0)} heads`
                : `${GRADE_LABEL[row.grade ?? 'standard']} handler`}
            </td>
            <td>
              <TermCell term={termPresentation(row, gameNow, speed)} />
            </td>
            <td>
              {commitmentInWords(row)}
              {row.shortfallFeeMinor > 0 && (
                <span className="net-ground__term-detail">
                  {' '}
                  — {money(row.shortfallFeeMinor)} shortfall if it ended now
                </span>
              )}
            </td>
            <td className="figure">
              {row.kind === 'self' ? 'nothing' : money(row.earlyTerminationPenaltyMinor)}
            </td>
            <td>
              <Button
                variant="tertiary"
                onClick={() => {
                  onOpen(row.icao);
                }}
              >
                Open {row.icao}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One service line at the station: what is arranged, the vendors, and doing it yourself. */
function LineSection({
  icao,
  line,
  busy,
  gameNow,
  speed,
  onWrite,
}: {
  icao: string;
  line: GroundServiceLineView;
  busy: boolean;
  gameNow: Date | null;
  speed: number | null;
  onWrite: (request: () => Promise<GroundWrite>) => void;
}): ReactNode {
  const contracted = line.contracted;
  const self = line.selfHandling;
  const current = contracted?.kind === 'self' ? (contracted.headcount ?? 0) : null;
  const [heads, setHeads] = useState<number>(current ?? self.requiredHeadcount);
  const titleId = `ground-${icao}-${line.serviceLine}`;
  const breakFee = contracted?.kind === 'vendor' ? contracted.earlyTerminationPenaltyMinor : 0;

  return (
    <section className="net-panel net-ground__line" aria-labelledby={titleId}>
      <div className="net-panel__head">
        <h4 id={titleId} className="net-panel__title">
          {SERVICE_LINE_LABEL[line.serviceLine]}
        </h4>
        <span className="net-panel__hint">
          {contracted === null
            ? `Walk-up: every turn bought on the day at ${multiplier(line.walkUpPriceIndex)} the standard price.`
            : contracted.kind === 'self'
              ? `Your own staff: ${String(contracted.headcount ?? 0)} of ${String(self.requiredHeadcount)} heads (${percent(contracted.staffing ?? 0)} staffed).`
              : `${GRADE_LABEL[contracted.grade ?? 'standard']} handler under contract.`}
        </span>
      </div>

      {contracted !== null && (
        <p className="net-ground__arranged">
          <TermCell term={termPresentation(contracted, gameNow, speed)} />{' '}
          {contracted.kind === 'vendor' ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                onWrite(() => terminateGroundContract(contracted.id));
              }}
            >
              End the contract — {money(contracted.earlyTerminationPenaltyMinor)} to break it now
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                onWrite(() => closeSelfHandling(contracted.id));
              }}
            >
              Close the operation — no penalty, the payroll stops
            </Button>
          )}
        </p>
      )}

      <table className="admin__table net-comp-table">
        <caption className="visually-hidden">
          Handlers for {SERVICE_LINE_LABEL[line.serviceLine]} at {icao}
        </caption>
        <thead>
          <tr>
            <th scope="col">Grade</th>
            <th scope="col">Slots</th>
            <th scope="col">Reliability</th>
            <th scope="col">Speed</th>
            <th scope="col">Quality</th>
            <th scope="col">Price</th>
            <th scope="col">Commits you to</th>
            <th scope="col">
              <span className="visually-hidden">Sign</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {line.offers.map((offer) => {
            const yours = contracted?.kind === 'vendor' && contracted.grade === offer.grade;
            const full = freeSlots(offer) === 0 && !yours;
            return (
              <tr key={offer.grade} data-full={full ? 'yes' : 'no'}>
                <th scope="row">{GRADE_LABEL[offer.grade]}</th>
                <td>
                  {full ? <Chip tone="warn">Full</Chip> : null}{' '}
                  <span className="net-ground__term-detail">{scarcityInWords(offer)}</span>
                </td>
                <td className="figure">{percent(offer.reliability)}</td>
                <td className="figure">{multiplier(offer.speedFactor)}</td>
                <td className="figure">{percent(offer.quality)}</td>
                <td className="figure">{multiplier(offer.priceIndex)}</td>
                <td>
                  {offer.committedDepartures === 0
                    ? 'no volume'
                    : `${String(offer.committedDepartures)} departures`}
                  <span className="net-ground__term-detail">
                    {' '}
                    · {money(offer.fullTermPenaltyMinor)} to break a full term
                  </span>
                </td>
                <td>
                  {yours ? (
                    <Chip tone="positive">Yours</Chip>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={busy || full}
                      onClick={() => {
                        onWrite(() => signGroundContract(icao, line.serviceLine, offer.grade));
                      }}
                    >
                      {contracted === null
                        ? `Sign ${GRADE_LABEL[offer.grade].toLowerCase()}`
                        : `Sign ${GRADE_LABEL[offer.grade].toLowerCase()} — replaces the current arrangement${
                            breakFee > 0 ? `, ${money(breakFee)} to break it` : ''
                          }`}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="net-ground__self">
        <h5 className="net-ground__self-title">Handle it yourself</h5>
        {self.available ? (
          <>
            <p className="net-ground__term-detail">
              The trade is fixed cost against per-turn cost: {String(self.requiredHeadcount)} heads
              handle this station properly, at {money(self.salaryPerHeadMinor)} a head a month —
              payable whether or not anything flies — instead of paying a handler for every turn. It
              pays where the station is busy; below the station’s full headcount it costs less and
              handles worse.
            </p>
            <label className="net-ground__heads">
              <span>Heads</span>
              <input
                type="number"
                min={1}
                max={10_000}
                value={heads}
                onChange={(event) => {
                  setHeads(Math.max(1, Math.floor(Number(event.target.value) || 1)));
                }}
              />
            </label>{' '}
            <Button
              variant="secondary"
              disabled={busy || heads === current}
              onClick={() => {
                onWrite(() => openSelfHandling(icao, line.serviceLine, heads));
              }}
            >
              {current === null
                ? `Handle it yourself — ${String(heads)} heads, ${money(heads * self.salaryPerHeadMinor)} a month${
                    breakFee > 0 ? `, ${money(breakFee)} to break the current contract` : ''
                  }`
                : `Restaff to ${String(heads)} heads — ${money(heads * self.salaryPerHeadMinor)} a month`}
            </Button>
          </>
        ) : (
          <p className="net-ground__term-detail">
            Not available here: handling a line yourself needs a station, and you have no hub at{' '}
            {icao}. A hub is where an airline has the people and equipment to run its own ramp.
          </p>
        )}
      </div>
    </section>
  );
}

export interface GroundHandlingViewProps {
  /** The airports the airline flies through. */
  airports: readonly string[];
  /** A station to open on — from a deep link. */
  initialStation?: string | null;
  /** A contract to highlight and open the station of — the lapse alert's subject. */
  initialContract?: string | null;
}

export function GroundHandlingView({
  airports,
  initialStation = null,
  initialContract = null,
}: GroundHandlingViewProps): ReactNode {
  const [contracts, setContracts] = useState<GroundContractsResponse | 'loading' | 'error'>(
    'loading',
  );
  const [icao, setIcao] = useState<string | null>(initialStation);
  const [station, setStation] = useState<Station>('loading');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { inGameTime, speedMultiplier } = useWorldClock();

  const loadContracts = useCallback(async () => {
    try {
      setContracts(await fetchGroundContracts());
    } catch {
      setContracts('error');
    }
  }, []);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  // The stations worth picking: where the airline flies, and where it holds anything.
  const options = useMemo(() => {
    const codes = new Set(airports);
    if (typeof contracts === 'object') for (const row of contracts.contracts) codes.add(row.icao);
    if (initialStation !== null) codes.add(initialStation);
    return [...codes].sort();
  }, [airports, contracts, initialStation]);

  // Arriving from a lapse alert: open the station the contract is at.
  useEffect(() => {
    if (initialContract === null || typeof contracts !== 'object') return;
    const match = contracts.contracts.find((row) => row.id === initialContract);
    if (match !== undefined) setIcao((current) => current ?? match.icao);
  }, [initialContract, contracts]);

  // Otherwise the first station, once there is one.
  useEffect(() => {
    if (icao === null && initialContract === null && options.length > 0) {
      setIcao(options[0] ?? null);
    }
  }, [icao, initialContract, options]);

  useEffect(() => {
    if (icao === null) return;
    let live = true;
    setStation('loading');
    setRefusal(null);
    fetchGroundStation(icao)
      .then((value) => {
        if (live) setStation(value);
      })
      .catch(() => {
        if (live) setStation('error');
      });
    return () => {
      live = false;
    };
  }, [icao]);

  const onWrite = useCallback(
    (request: () => Promise<GroundWrite>) => {
      setBusy(true);
      setRefusal(null);
      void request()
        .then((result) => {
          if (result.ok) {
            setStation(result.station);
            void loadContracts();
          } else {
            // The station on screen stays exactly as it was: the server refused.
            setRefusal(result.refusal.message);
          }
        })
        .catch(() => {
          setRefusal('That change could not be confirmed. Reload before trying again.');
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [loadContracts],
  );

  return (
    <div className="net-performance net-ground">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Ground handling</h2>
      </div>
      <p className="net-panel__hint">
        Who works your turns at each station (§9.3): a vendor on a term, your own staff, or nobody
        arranged and every turn bought walk-up. A vendor’s slots are shared by every airline in the
        world — a full vendor is a market fact, and a slot frees when a contract ends.
      </p>

      <section className="net-panel" aria-labelledby="ground-network-title">
        <div className="net-panel__head">
          <h3 id="ground-network-title" className="net-panel__title">
            Across your network
          </h3>
        </div>
        <NetworkContracts
          contracts={contracts}
          focus={initialContract}
          gameNow={inGameTime}
          speed={speedMultiplier}
          onOpen={setIcao}
        />
      </section>

      <section className="net-panel" aria-labelledby="ground-station-title">
        <div className="net-panel__head">
          <h3 id="ground-station-title" className="net-panel__title">
            {icao === null ? 'Station' : `Station ${icao}`}
          </h3>
          {options.length > 0 && (
            <label className="net-slots__pick">
              <span className="visually-hidden">Station</span>
              <select
                className="net-rail__search"
                value={icao ?? ''}
                onChange={(event) => {
                  setIcao(event.target.value);
                }}
              >
                {options.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {icao === null ? (
          <StateBlock kind="empty">
            Open a route first. Ground handling is arranged at the airports you fly through.
          </StateBlock>
        ) : station === 'loading' ? (
          <StateBlock kind="loading">Reading the station’s handlers…</StateBlock>
        ) : station === 'error' ? (
          <StateBlock kind="broken">Could not load this station’s handlers.</StateBlock>
        ) : (
          <>
            {refusal !== null && <StateBlock kind="refused">{refusal}</StateBlock>}
            {station.lines.map((line) => (
              <LineSection
                key={`${station.icao}-${line.serviceLine}-${line.contracted?.id ?? 'none'}`}
                icao={station.icao}
                line={line}
                busy={busy}
                gameNow={inGameTime}
                speed={speedMultiplier}
                onWrite={onWrite}
              />
            ))}
          </>
        )}
      </section>
    </div>
  );
}
