import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';

import {
  HEADQUARTERS_BASE_SEATS,
  OFFICE_ROLES,
  unlockedNeutralSeats,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { dismissOffice, expandOffice, fetchOffice, hireOffice } from './api';
import {
  candidatesForRole,
  formatSalary,
  HQ_CANDIDATES,
  HQ_ROLES,
  type HqCandidate,
} from './hq-roster';

import type { OwnAirlineShellContext } from '../shell/AppShell';
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
 * is the number on the ledger.
 *
 * ## Expansion is real money for real capacity
 *
 * Beyond the six role seats, an airline can expand its headquarters — twice — for
 * two more **neutral** offices each time. A neutral seat takes any candidate and
 * grants no role capability; it is extra staffed capacity, and the long-haul gate
 * still lives only in the real Safety & Compliance seat. The purchase is an AIR-06
 * charge and refuses when the cash is not there.
 *
 * ## The layout overview lives in the context panel, and the shell owns it
 *
 * H.4's context panel shows the office floor-plan on every screen (see
 * {@link AppShell}), so this page does not publish it — it feeds it, mirroring
 * every change back through `replaceOffice`. `useOutletContext` is null in a bare
 * component test, so the sync is optional and the page renders fine on its own.
 */
export function HeadquartersPage(): ReactNode {
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<OfficeSeatId | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const syncOffice = useOutletContext<OwnAirlineShellContext | null>()?.replaceOffice;

  useEffect(() => {
    let live = true;
    void fetchOffice().then((state) => {
      if (!live) return;
      setOffice(state);
      syncOffice?.(state);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [syncOffice]);

  const hiredBySeat = new Map<OfficeSeatId, { candidateId: string; candidateName: string }>(
    (office?.hires ?? []).map((hire) => [
      hire.seat,
      { candidateId: hire.candidateId, candidateName: hire.candidateName },
    ]),
  );

  const act = useCallback(
    async (seat: OfficeSeatId, run: () => ReturnType<typeof hireOffice>) => {
      setPending(seat);
      setError(null);
      const outcome = await run();
      if (outcome.ok) {
        setOffice(outcome.state);
        syncOffice?.(outcome.state);
      } else setError(outcome.failure.message);
      setPending(null);
    },
    [syncOffice],
  );

  const onHire = useCallback(
    (candidate: HqCandidate) =>
      act(candidate.roleId, () =>
        hireOffice({
          seat: candidate.roleId,
          candidateId: candidate.id,
          candidateName: candidate.name,
          candidateRole: candidate.roleId,
        }),
      ),
    [act],
  );

  const onHireNeutral = useCallback(
    (seat: OfficeSeatId, candidate: HqCandidate) =>
      act(seat, () =>
        hireOffice({
          seat,
          candidateId: candidate.id,
          candidateName: candidate.name,
          candidateRole: candidate.roleId,
        }),
      ),
    [act],
  );

  const onDismiss = useCallback(
    (seat: OfficeSeatId) => act(seat, () => dismissOffice(seat)),
    [act],
  );

  const onExpand = useCallback(async () => {
    setExpanding(true);
    setError(null);
    const outcome = await expandOffice();
    if (outcome.ok) {
      setOffice(outcome.state);
      syncOffice?.(outcome.state);
    } else setError(outcome.failure.message);
    setExpanding(false);
  }, [syncOffice]);

  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const filled = hiredBySeat.size;

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
          <strong>{filled}</strong> of {totalSeats} seats filled
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
          const hiredId = hiredBySeat.get(seat.id)?.candidateId;
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

      {office != null && (neutralSeats > 0 || office.nextExpansion != null) && (
        <section className="hq-expand" aria-label="Headquarters expansion">
          <header className="hq-expand__head">
            <h2 className="hq-expand__title">Expand headquarters</h2>
            <p className="hq-expand__size">
              {totalSeats} offices{neutralSeats > 0 ? ` · ${String(neutralSeats)} neutral` : ''}
            </p>
          </header>

          <p className="hq-expand__note">
            Neutral offices take any candidate and add staffed capacity — they do not grant a role’s
            capability, and the long-haul gate still lives in the Safety &amp; Compliance seat.
          </p>

          {office.nextExpansion != null && (
            <button
              type="button"
              className="hq-expand__buy"
              disabled={loading || expanding}
              onClick={() => void onExpand()}
            >
              {expanding
                ? 'Expanding…'
                : `Buy +${String(office.nextExpansion.addsSeats)} offices — $${formatSalary(office.nextExpansion.costMinor)}`}
            </button>
          )}

          {neutralSeats > 0 && (
            <ul className="hq-neutral">
              {unlockedNeutralSeats(neutralSeats).map((seat, index) => {
                const hire = hiredBySeat.get(seat);
                const seatPending = pending === seat;
                const chosen = pick[seat] ?? '';
                return (
                  <li key={seat} className="hq-neutral__seat">
                    <span className="hq-neutral__label">Neutral office {index + 1}</span>
                    {hire ? (
                      <>
                        <span className="hq-neutral__who">{hire.candidateName}</span>
                        <button
                          type="button"
                          className="hq-neutral__action"
                          disabled={loading || seatPending}
                          onClick={() => void onDismiss(seat)}
                        >
                          Let go
                        </button>
                      </>
                    ) : (
                      <>
                        <select
                          className="hq-neutral__pick"
                          value={chosen}
                          aria-label={`Assign a candidate to neutral office ${String(index + 1)}`}
                          onChange={(event) =>
                            setPick((prev) => ({ ...prev, [seat]: event.target.value }))
                          }
                        >
                          <option value="">Choose a candidate…</option>
                          {HQ_ROLES.map((role) => (
                            <optgroup key={role.id} label={role.role}>
                              {candidatesForRole(role.id).map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.name}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="hq-neutral__action"
                          disabled={loading || seatPending || chosen === ''}
                          onClick={() => {
                            const candidate = HQ_CANDIDATES.find((entry) => entry.id === chosen);
                            if (candidate) void onHireNeutral(seat, candidate);
                          }}
                        >
                          Hire
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
