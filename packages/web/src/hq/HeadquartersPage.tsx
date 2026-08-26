import { useCallback, useState } from 'react';

import {
  candidatesForRole,
  formatSalary,
  HQ_ROLES,
  type HqCandidate,
  type HqRoleId,
} from './hq-roster';

import type { ReactNode } from 'react';

/**
 * Headquarters — the office hires (M5-04, §9.1).
 *
 * Layer A of the design's three staffing layers: the senior people who take a job
 * off the player's hands. The page is organised by **seat**, and under each seat
 * the **candidates** in the market for it. Each seat states the concrete
 * capability filling it unlocks — never a stat bonus, per §9.1 and the M5-04
 * acceptance criterion — and each candidate shows a salary, a tier and their own
 * visible trait.
 *
 * ## One hire per seat
 *
 * A seat holds one person. Hiring a candidate fills the seat and puts the others
 * back on the market; hiring a different one swaps. State is a map from seat to
 * the hired candidate, held here for now — the real candidate market, its refresh
 * over game time, and the salary billing are the server half of M5-04 that lands
 * on top of this without changing the layout.
 *
 * ## Hired reads as colour, unhired as grey
 *
 * The one visual rule the brief asked for: an unfilled candidate is greyed, the
 * hired one is in colour. It is a CSS `filter` on the portrait keyed off
 * `data-hired`, so one asset serves both states and the office fills in with
 * colour as you hire.
 */
export function HeadquartersPage(): ReactNode {
  const [hiredByRole, setHiredByRole] = useState<ReadonlyMap<HqRoleId, string>>(new Map());

  const hire = useCallback((candidate: HqCandidate) => {
    setHiredByRole((current) => {
      const next = new Map(current);
      if (next.get(candidate.roleId) === candidate.id) next.delete(candidate.roleId);
      else next.set(candidate.roleId, candidate.id);
      return next;
    });
  }, []);

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
        </p>
      </header>

      <div className="hq-roster">
        {HQ_ROLES.map((seat) => {
          const candidates = candidatesForRole(seat.id);
          const hiredId = hiredByRole.get(seat.id);
          const hiredCandidate = candidates.find((candidate) => candidate.id === hiredId) ?? null;

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
                            <dd>{formatSalary(candidate.salaryPerMonthMinor)}/mo</dd>
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
                          onClick={() => hire(candidate)}
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
