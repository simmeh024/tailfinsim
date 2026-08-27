import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { EXECUTIVE_OFFICE_COUNT, type ExecutiveFloorState } from '@tailfin/shared';

import { dismissExecutive, fetchExecutiveFloor, hireExecutive } from './api';
import { CSUITE_CANDIDATES, type CSuiteCandidate } from './csuite-roster';
import { formatSalary } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The C-Suite — staffing the executive floor's offices (§9.1 follow-up, Phase 2).
 *
 * The executive floor's counterpart to Headquarters, and it wears the same roster
 * layout. The difference is the model: an executive office is **generic**, so
 * there is no seat to match — any candidate goes into any open office, and an
 * airline can employ as many executives as it has **opened offices**. Past that,
 * the remaining candidates are **locked** — greyed with a padlock — until another
 * office opens on the executive floor.
 *
 * The salary on each card is the one the server bills, from the shared catalogue;
 * the portraits and the roles (and the gameplay effects that come with them) are
 * placeholders for now, exactly as the ground-floor traits are.
 */
export function ExecutiveSuitePage(): ReactNode {
  const [floor, setFloor] = useState<ExecutiveFloorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const hiredById = new Map((floor?.hires ?? []).map((hire) => [hire.candidateId, hire]));
  const officesUnlocked = floor?.officesUnlocked ?? 0;
  const filled = floor?.hires.length ?? 0;
  const freeOffices = Math.max(0, officesUnlocked - filled);
  const floorUnlocked = floor?.unlocked === true;

  return (
    <section className="page hq-page" aria-label="C-Suite">
      <header className="hq-page__heading">
        <div>
          <p className="airline-page__eyebrow">Executive Floor</p>
          <h1 className="page__title">C-Suite</h1>
          <p className="page__note">
            Your executive floor’s people. An office holds one executive, and any candidate fits any
            open office — so hire freely while you have a free office. With none free, the rest of
            the market is locked until you open another office on the executive floor.
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

      {error !== null && (
        <p className="hq-page__error" role="alert">
          {error}
        </p>
      )}

      {!loading && !floorUnlocked && (
        <p className="hq-page__plan-hint">
          Your executive floor is not open yet. Open it from the floor plan to the right, then open
          an office or two before hiring your C-Suite.
        </p>
      )}

      {!loading && floorUnlocked && officesUnlocked === 0 && (
        <p className="hq-page__plan-hint">
          Your executive floor is open, but it has no offices yet. Open an office from the floor
          plan to the right, then hire someone into it.
        </p>
      )}

      <div className="hq-roster" aria-busy={loading}>
        <section className="hq-seat" aria-label="C-Suite market">
          <ul className="hq-grid">
            {CSUITE_CANDIDATES.map((candidate: CSuiteCandidate) => {
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
    </section>
  );
}
