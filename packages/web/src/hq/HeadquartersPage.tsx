import { useCallback, useEffect, useState } from 'react';

import { OFFICE_ROLES, type OfficeRole, type OfficeStateResponse } from '@tailfin/shared';

import { dismissOffice, fetchOffice, hireOffice } from './api';
import { candidatesForRole, formatSalary, HQ_ROLES, type HqCandidate } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * Headquarters — the office hires (M5-04, §9.1).
 *
 * Layer A of the design's three staffing layers: the senior people who take a job
 * off the player's hands. The page is organised by **seat**, and under each seat
 * the **candidates** in the market for it. Each seat states the concrete
 * capability filling it unlocks — never a stat bonus, per §9.1 and the M5-04
 * acceptance criterion.
 *
 * ## The office is the server's now
 *
 * Which seat is filled, and by whom, is read from `/api/office`; hiring and
 * dismissing go back to the server and return the whole office. The salary shown
 * is the seat's, from the shared role catalogue — the one the worker actually
 * bills every month — not a candidate's asking figure, so the number on the card
 * is the number on the ledger. The candidate market (the named faces and their
 * traits) is still the client's; what crosses the wire is which seat you filled.
 *
 * ## The gate reads as a gate
 *
 * Filling Safety & Compliance unlocks long-haul, ETOPS and international routes —
 * the server refuses those routes until it is filled. The page says so, and marks
 * the state, so the seat reads as the unlock it is rather than one more hire.
 *
 * ## Hired reads as colour, unhired as grey
 *
 * An unfilled candidate is greyed, the hired one is in colour — a CSS `filter` on
 * the portrait keyed off `data-hired`, so one asset serves both states.
 */
export function HeadquartersPage(): ReactNode {
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<OfficeRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchOffice().then((state) => {
      if (!live) return;
      setOffice(state);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, []);

  const hiredByRole = new Map<OfficeRole, string>(
    (office?.hires ?? []).map((hire) => [hire.role, hire.candidateId]),
  );

  const act = useCallback(async (role: OfficeRole, run: () => ReturnType<typeof hireOffice>) => {
    setPending(role);
    setError(null);
    const outcome = await run();
    if (outcome.ok) setOffice(outcome.state);
    else setError(outcome.failure.message);
    setPending(null);
  }, []);

  const onHire = useCallback(
    (candidate: HqCandidate) =>
      act(candidate.roleId, () =>
        hireOffice({
          role: candidate.roleId,
          candidateId: candidate.id,
          candidateName: candidate.name,
        }),
      ),
    [act],
  );

  const onDismiss = useCallback((role: OfficeRole) => act(role, () => dismissOffice(role)), [act]);

  const filled = hiredByRole.size;

  return (
    <section className="page hq-page" aria-label="Headquarters">
      <header className="hq-page__heading">
        <div>
          <p className="airline-page__eyebrow">Head Office</p>
          <h1 className="page__title">Headquarters</h1>
          <p className="page__note">
            Senior hires are capability unlocks, not stat bonuses — each one takes a job off your
            hands or opens one up. A seat holds one person; an unfilled candidate is greyed, the one
            you hire is in colour.
          </p>
        </div>
        <p className="hq-page__count" role="status">
          <strong>{filled}</strong> of {HQ_ROLES.length} seats filled
          {office?.hasExtendedAuthority === true && (
            <>
              {' · '}
              <span className="hq-page__authority">long-haul authority unlocked</span>
            </>
          )}
        </p>
      </header>

      {error !== null && (
        <p className="hq-page__error" role="alert">
          {error}
        </p>
      )}

      <div className="hq-roster" aria-busy={loading}>
        {HQ_ROLES.map((seat) => {
          const candidates = candidatesForRole(seat.id);
          const hiredId = hiredByRole.get(seat.id);
          const hiredCandidate = candidates.find((candidate) => candidate.id === hiredId) ?? null;
          const salary = formatSalary(OFFICE_ROLES[seat.id].monthlySalaryMinor);
          const seatPending = pending === seat.id;

          return (
            <section key={seat.id} className="hq-seat" aria-label={seat.role}>
              <header className="hq-seat__header">
                <div>
                  <h2 className="hq-seat__role">
                    <span>{seat.role}</span>
                    {seat.gates !== undefined && (
                      <span className="hq-seat__gate-flag" title={seat.gates} aria-hidden="true">
                        Gate
                      </span>
                    )}
                  </h2>
                  <p className="hq-seat__unlock">
                    <span className="hq-card__label">Unlocks</span>
                    {seat.unlock}
                  </p>
                  {seat.gates !== undefined && <p className="hq-card__gate">{seat.gates}</p>}
                </div>
                <p className="hq-seat__status">
                  {hiredCandidate ? `Seat filled by ${hiredCandidate.name}` : 'Seat vacant'}
                </p>
              </header>

              <ul className="hq-grid">
                {candidates.map((candidate) => {
                  const isHired = hiredId === candidate.id;
                  const given = candidate.name.split(' ')[0] ?? candidate.name;
                  return (
                    <li key={candidate.id} className="hq-card" data-hired={isHired}>
                      <div className="hq-card__portrait" data-hired={isHired}>
                        <img
                          src={candidate.portrait}
                          alt={`${candidate.name}, candidate for ${seat.role}`}
                          loading="lazy"
                        />
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
                            <dd>{salary}/mo</dd>
                          </div>
                        </dl>

                        <p className="hq-card__trait">
                          <span className="hq-card__trait-badge">{given}</span>
                          <span>
                            <strong>{candidate.trait.label}.</strong> {candidate.trait.detail}
                          </span>
                        </p>

                        <button
                          type="button"
                          className="hq-card__action"
                          aria-pressed={isHired}
                          disabled={loading || seatPending}
                          onClick={() =>
                            isHired ? void onDismiss(seat.id) : void onHire(candidate)
                          }
                        >
                          {isHired ? 'Let go' : `Hire ${given}`}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
