import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import {
  aggregateExecutiveBoosts,
  EXECUTIVE_BOOST_LEVERS,
  EXECUTIVE_OFFICE_COUNT,
  type AggregatedExecutiveBoost,
  type ExecutiveFloorState,
} from '@tailfin/shared';

import {
  dismissExecutive,
  fetchExecutiveFloor,
  hireExecutive,
  unlockExecutiveFloor,
  unlockExecutiveOffice,
} from './api';
import { CSUITE_CANDIDATES, csuiteCandidate, type CSuiteCandidate } from './csuite-roster';
import {
  msUntilRefresh,
  rosterDayIndex,
  rotatingExecutiveRoster,
  ROSTER_SIZE,
} from './csuite-rotation';
import { ExecutiveFloorPlan } from './ExecutiveFloorPlan';
import { formatSalary } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The C-Suite — staffing the executive floor's offices (§9.1 follow-up, Phase 2/3).
 *
 * The executive floor's counterpart to Headquarters. An executive office is
 * **generic**, so there is no seat to match — any candidate goes into any open
 * office, and an airline can employ as many executives as it has **opened
 * offices**. Past that, the remaining candidates are **locked** — greyed with a
 * padlock — until another office opens.
 *
 * The market is not the whole roster at once: it shows a **rotating ten**,
 * reshuffled every 24 hours (see {@link rotatingExecutiveRoster}), with a live
 * countdown to the next turnover at the top of the page. Anyone already hired
 * stays on the page even when they rotate out of the shortlist, so you can always
 * let them go. Each card carries the executive's role and the one small standing
 * **boost** they bring; the boosts an airline currently employs are summed into
 * the "Boosts in play" panel.
 *
 * The salary and the boost on each card come from the shared catalogue by id — the
 * same the server bills and the worker will apply — so the client only renders
 * them, it does not assert them.
 */

/** A whole-seconds HH:MM:SS countdown from a millisecond span. */
function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** One aggregated boost as a signed, unit-aware string, e.g. "Fuel cost −3.0%". */
function formatAggregatedBoost(boost: AggregatedExecutiveBoost): string {
  const meta = EXECUTIVE_BOOST_LEVERS[boost.lever];
  const sign = boost.totalMagnitude >= 0 ? '+' : '−';
  const size = Math.abs(boost.totalMagnitude);
  const amount = meta.unit === 'percent' ? `${(size * 100).toFixed(1)}%` : size.toString();
  return `${meta.label} ${sign}${amount}`;
}

export function ExecutiveSuitePage(): ReactNode {
  const [floor, setFloor] = useState<ExecutiveFloorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The executive floor's own open-floor / open-office actions, now driven from
  // this page rather than the shell's context panel.
  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchExecutiveFloor().then((state) => {
      if (!live) return;
      setFloor(state);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, []);

  // The countdown ticks once a second; when it crosses a 24-hour boundary the day
  // index changes and the shortlist below is recomputed from the new `now`.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const act = useCallback(
    async (candidateId: string, run: () => ReturnType<typeof hireExecutive>): Promise<void> => {
      setPending(candidateId);
      setError(null);
      const outcome = await run();
      if (outcome.ok) setFloor(outcome.state);
      else setError(outcome.failure.message);
      setPending(null);
    },
    [],
  );

  const runExec = useCallback(
    async (run: () => ReturnType<typeof unlockExecutiveFloor>): Promise<void> => {
      setExecBusy(true);
      setExecError(null);
      const outcome = await run();
      if (outcome.ok) setFloor(outcome.state);
      else setExecError(outcome.failure.message);
      setExecBusy(false);
    },
    [],
  );

  const hiredById = new Map((floor?.hires ?? []).map((hire) => [hire.candidateId, hire]));
  const officesUnlocked = floor?.officesUnlocked ?? 0;
  const filled = floor?.hires.length ?? 0;
  const freeOffices = Math.max(0, officesUnlocked - filled);
  const floorUnlocked = floor?.unlocked === true;

  const dayIndex = rosterDayIndex(now);

  // Today's shortlist, plus any hired executive who has rotated out of it — so a
  // standing hire is always visible and can always be let go.
  const shown = useMemo<CSuiteCandidate[]>(() => {
    const shortlist = rotatingExecutiveRoster(CSUITE_CANDIDATES, dayIndex, ROSTER_SIZE);
    const inList = new Set(shortlist.map((candidate) => candidate.id));
    const hiredOutside = (floor?.hires ?? [])
      .filter((hire) => !inList.has(hire.candidateId))
      .map((hire) => csuiteCandidate(hire.candidateId))
      .filter((candidate): candidate is CSuiteCandidate => candidate !== undefined);
    return [...shortlist, ...hiredOutside];
  }, [dayIndex, floor?.hires]);

  const boostsInPlay = useMemo<AggregatedExecutiveBoost[]>(
    () => aggregateExecutiveBoosts((floor?.hires ?? []).map((hire) => hire.candidateId)),
    [floor?.hires],
  );

  const countdown = formatCountdown(msUntilRefresh(now));

  return (
    <section className="page hq-page" aria-label="C-Suite">
      <div className="csuite-refresh" role="timer" aria-label="Time until the roster refreshes">
        <span className="csuite-refresh__label">Roster refreshes in</span>
        <span className="csuite-refresh__clock">{countdown}</span>
        <span className="csuite-refresh__note">
          A new shortlist of {ROSTER_SIZE} executives every 24 hours
        </span>
      </div>

      <header className="hq-page__heading">
        <div>
          <p className="airline-page__eyebrow">Executive Floor</p>
          <h1 className="page__title">C-Suite</h1>
          <p className="page__note">
            Your executive floor’s people. An office holds one executive, and any candidate fits any
            open office — so hire freely while you have a free office. With none free, the rest of
            the shortlist is locked until you open another office on the executive floor.
          </p>
        </div>
        <div className="hq-page__aside">
          <Link to="/headquarters" className="hq-page__policies">
            ‹ Headquarters
          </Link>
          <p className="hq-page__count" role="status">
            <strong>{filled}</strong> of {officesUnlocked} office{officesUnlocked === 1 ? '' : 's'}{' '}
            staffed
            {officesUnlocked < EXECUTIVE_OFFICE_COUNT && floorUnlocked && (
              <>
                {' · '}
                <span className="hq-page__authority">open more on the floor</span>
              </>
            )}
          </p>
        </div>
      </header>

      <div className="csuite-page__layout">
        <div className="csuite-page__main">
          {boostsInPlay.length > 0 && (
            <section className="csuite-boosts" aria-label="Boosts in play">
              <p className="csuite-boosts__title">Boosts in play</p>
              <ul className="csuite-boosts__list">
                {boostsInPlay.map((boost) => (
                  <li key={boost.lever} className="csuite-boosts__chip">
                    {formatAggregatedBoost(boost)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {error !== null && (
            <p className="hq-page__error" role="alert">
              {error}
            </p>
          )}

          {!loading && !floorUnlocked && (
            <p className="hq-page__plan-hint">
              Your executive floor is not open yet. Open it on the floor plan beside the roster,
              then open an office or two before hiring your C-Suite.
            </p>
          )}

          {!loading && floorUnlocked && officesUnlocked === 0 && (
            <p className="hq-page__plan-hint">
              Your executive floor is open, but it has no offices yet. Open an office on the floor
              plan beside the roster, then hire someone into it.
            </p>
          )}

          <div className="hq-roster" aria-busy={loading}>
            <section className="hq-seat" aria-label="C-Suite market">
              <ul className="hq-grid">
                {shown.map((candidate: CSuiteCandidate) => {
                  const isHired = hiredById.has(candidate.id);
                  const locked = !isHired && freeOffices === 0;
                  const given = candidate.name.split(' ')[0] ?? candidate.name;
                  const busy = pending === candidate.id;
                  return (
                    <li
                      key={candidate.id}
                      className="hq-card"
                      data-hired={isHired}
                      data-locked={locked}
                    >
                      <div className="hq-card__portrait" data-hired={isHired}>
                        <img src={candidate.portrait} alt={candidate.name} loading="lazy" />
                        {locked && (
                          <span className="hq-card__lock" aria-hidden="true">
                            🔒
                          </span>
                        )}
                      </div>

                      <div className="hq-card__body">
                        <p className="hq-card__name">{candidate.name}</p>
                        <p className="hq-card__role">{candidate.role}</p>

                        <p className="hq-card__boost" title={candidate.boost.description}>
                          <span className="hq-card__boost-badge">{candidate.boost.label}</span>
                          <span className="hq-card__boost-detail">
                            {candidate.boost.description}
                          </span>
                        </p>

                        <dl className="hq-card__meta">
                          <div>
                            <dt>Tier</dt>
                            <dd>{candidate.tier}</dd>
                          </div>
                          <div>
                            <dt>Salary</dt>
                            <dd>{formatSalary(candidate.monthlySalaryMinor)}/mo</dd>
                          </div>
                        </dl>

                        <button
                          type="button"
                          className="hq-card__action"
                          aria-pressed={isHired}
                          disabled={loading || busy || locked}
                          onClick={() =>
                            isHired
                              ? void act(candidate.id, () => dismissExecutive(candidate.id))
                              : void act(candidate.id, () => hireExecutive(candidate.id))
                          }
                        >
                          {isHired ? 'Let go' : locked ? 'No free office' : `Hire ${given}`}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>

        {floor !== null && (
          <aside className="csuite-page__floor" aria-label="Executive floor">
            <ExecutiveFloorPlan
              execState={floor}
              busy={execBusy}
              error={execError}
              onUnlockFloor={() => void runExec(() => unlockExecutiveFloor())}
              onOpenOffice={() => void runExec(() => unlockExecutiveOffice())}
            />
          </aside>
        )}
      </div>
    </section>
  );
}
