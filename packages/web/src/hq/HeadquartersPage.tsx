import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router';

import {
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  isSocialMediaSpecialistId,
  OFFICE_ROLES,
  unlockedNeutralSeats,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { dismissOffice, expandOffice, fetchOffice, hireOffice } from './api';
import {
  candidateById,
  candidatesForRole,
  formatSalary,
  HQ_CANDIDATES,
  HQ_ROLES,
  specialistById,
  type HqCandidate,
} from './hq-roster';
import { HqLayoutPanel, officeLabel, type ExpandResult } from './HqLayoutPanel';
import { PoliciesModal } from './PoliciesModal';
import { StaffOfficeDrawer } from './StaffOfficeDrawer';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

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
  const [error, setError] = useState<string | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  // The neutral office the player is managing (drawer open), and the one hovered
  // or focused anywhere — a room and its card share these so they light together.
  const [selectedSeat, setSelectedSeat] = useState<OfficeSeatId | null>(null);
  const [hoveredSeat, setHoveredSeat] = useState<OfficeSeatId | null>(null);
  const [expanding, setExpanding] = useState(false);
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
  // One person, one office: a candidate already sitting in any seat is out of the
  // running for another. The server enforces this too, so this only spares the
  // player a doomed pick.
  const hiredCandidateIds = new Set((office?.hires ?? []).map((hire) => hire.candidateId));

  const act = useCallback(
    async (seat: OfficeSeatId, run: () => ReturnType<typeof hireOffice>): Promise<boolean> => {
      setPending(seat);
      setError(null);
      const outcome = await run();
      if (outcome.ok) {
        setOffice(outcome.state);
        syncOffice?.(outcome.state);
      } else setError(outcome.failure.message);
      setPending(null);
      return outcome.ok;
    },
    [syncOffice],
  );

  const onHire = useCallback(
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

  // Assign into (or replace an occupant of) a specific neutral office, then close
  // the drawer — but only on success, so a refused hire keeps the drawer and its
  // error up rather than silently reverting.
  const assignToOffice = useCallback(
    async (seat: OfficeSeatId, candidate: HqCandidate): Promise<void> => {
      const ok = await act(seat, () =>
        hireOffice({
          seat,
          candidateId: candidate.id,
          candidateName: candidate.name,
          candidateRole: candidate.roleId,
        }),
      );
      if (ok) setSelectedSeat(null);
    },
    [act],
  );

  const removeFromOffice = useCallback(
    async (seat: OfficeSeatId): Promise<void> => {
      const ok = await act(seat, () => dismissOffice(seat));
      if (ok) setSelectedSeat(null);
    },
    [act],
  );

  const onExpandOffice = useCallback(async (): Promise<ExpandResult> => {
    setExpanding(true);
    setError(null);
    const outcome = await expandOffice();
    setExpanding(false);
    if (outcome.ok) {
      setOffice(outcome.state);
      syncOffice?.(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  }, [syncOffice]);

  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const filled = hiredBySeat.size;
  const hasOpsController = (office?.hires ?? []).some((hire) => hire.seat === 'ops-controller');

  // The world offers exactly one specialist; the server names it. It is highlighted
  // in the staffing drawer, and only offered while it is not already employed.
  const specialist = office?.offeredSpecialist ? specialistById(office.offeredSpecialist) : null;

  const neutral = unlockedNeutralSeats(neutralSeats);
  const neutralFilled = neutral.filter((seat) => hiredBySeat.has(seat)).length;
  const neutralVacant = neutral.length - neutralFilled;

  // Candidates free to take a neutral office — nobody already employed — with the
  // world's specialist surfaced first when it is still available.
  const eligible: readonly HqCandidate[] = (() => {
    const generics = HQ_CANDIDATES.filter((candidate) => !hiredCandidateIds.has(candidate.id));
    const offered =
      specialist !== null && !hiredCandidateIds.has(specialist.id) ? [specialist] : [];
    return [...offered, ...generics];
  })();

  const managing = selectedSeat !== null && isNeutralSeat(selectedSeat) ? selectedSeat : null;
  const managingOccupant = managing !== null ? (hiredBySeat.get(managing) ?? null) : null;

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
        <div className="hq-page__aside">
          <button type="button" className="hq-page__policies" onClick={() => setPoliciesOpen(true)}>
            Policies
          </button>
          <p className="hq-page__count" role="status">
            <strong>{filled}</strong> of {totalSeats} seats filled
            {office?.hasExtendedAuthority === true && (
              <>
                {' · '}
                <span className="hq-page__authority">long-haul authority unlocked</span>
              </>
            )}
          </p>
        </div>
      </header>

      <PoliciesModal
        open={policiesOpen}
        onClose={() => setPoliciesOpen(false)}
        hasOpsController={hasOpsController}
      />

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
                            isHired ? void onDismiss(seat.id) : void onHire(seat.id, candidate)
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

      <section className="hq-offices" aria-label="Neutral offices">
        <header className="hq-offices__head">
          <div>
            <h2 className="hq-offices__title">Neutral offices</h2>
            <p className="hq-offices__summary">
              <strong>{neutralFilled}</strong> of {neutral.length} neutral offices staffed
              {neutralVacant > 0 && ` · ${String(neutralVacant)} vacant`}
            </p>
          </div>
        </header>

        <div className="hq-offices__layout">
          <div className="hq-offices__plan">
            <HqLayoutPanel
              office={office}
              onSelectSeat={setSelectedSeat}
              selectedSeat={selectedSeat}
              hoveredSeat={hoveredSeat}
              onHoverSeat={setHoveredSeat}
            />
          </div>

          <div className="hq-offices__side">
            {neutral.length === 0 && (
              <p className="hq-offices__hint">
                Your headquarters has no neutral offices yet. Expand it to open flexible rooms you
                can staff with any candidate.
              </p>
            )}
            <ul className="hq-offices__grid">
              {neutral.map((seat) => {
                const hire = hiredBySeat.get(seat);
                const occupant = hire !== undefined ? candidateById(hire.candidateId) : null;
                const isSpecialist =
                  hire !== undefined && isSocialMediaSpecialistId(hire.candidateId);
                const seatPending = pending === seat;
                return (
                  <li key={seat}>
                    <div
                      className="hq-office-card"
                      data-occupied={hire !== undefined}
                      data-selected={selectedSeat === seat}
                      data-hovered={hoveredSeat === seat}
                      onMouseEnter={() => setHoveredSeat(seat)}
                      onMouseLeave={() => setHoveredSeat(null)}
                    >
                      <header className="hq-office-card__head">
                        <span className="hq-office-card__num">{officeLabel(seat)}</span>
                        <span className="hq-office-card__state" data-occupied={hire !== undefined}>
                          {hire !== undefined ? '● Staffed' : '○ Vacant'}
                        </span>
                      </header>

                      {hire !== undefined ? (
                        <>
                          <div className="hq-office-card__who">
                            {occupant !== null && (
                              <img
                                className="hq-office-card__avatar"
                                src={occupant.portrait}
                                alt=""
                              />
                            )}
                            <div>
                              <p className="hq-office-card__name">{hire.candidateName}</p>
                              <p className="hq-office-card__role">
                                {isSpecialist
                                  ? 'Social media specialist'
                                  : (occupant?.tier ?? 'Staff')}
                              </p>
                            </div>
                          </div>
                          <p className="hq-office-card__perk">
                            {isSpecialist ? '+ Standing edge' : '+1 HQ capacity'}
                            {!isSpecialist && (
                              <span className="hq-office-card__muted">
                                {' '}
                                · no specialist ability
                              </span>
                            )}
                          </p>
                          <div className="hq-office-card__actions">
                            <button
                              type="button"
                              className="hq-office-card__btn"
                              disabled={loading || seatPending}
                              onClick={() => setSelectedSeat(seat)}
                              onFocus={() => setHoveredSeat(seat)}
                              onBlur={() => setHoveredSeat(null)}
                            >
                              Replace
                            </button>
                            <button
                              type="button"
                              className="hq-office-card__btn hq-office-card__btn--quiet"
                              disabled={loading || seatPending}
                              onClick={() => void removeFromOffice(seat)}
                            >
                              Remove from Office
                            </button>
                          </div>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="hq-office-card__hire"
                          disabled={loading || seatPending}
                          aria-label={`Staff ${officeLabel(seat)}`}
                          onClick={() => setSelectedSeat(seat)}
                          onFocus={() => setHoveredSeat(seat)}
                          onBlur={() => setHoveredSeat(null)}
                        >
                          <span className="hq-office-card__plus" aria-hidden="true">
                            +
                          </span>
                          Hire staff
                          <span className="hq-office-card__hint">Any candidate · +1 capacity</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}

              {office?.nextExpansion != null && (
                <li>
                  <div className="hq-office-card hq-office-card--locked">
                    <header className="hq-office-card__head">
                      <span className="hq-office-card__num">
                        +{office.nextExpansion.addsSeats} offices
                      </span>
                      <span className="hq-office-card__state" data-locked="true">
                        🔒 Locked
                      </span>
                    </header>
                    <p className="hq-office-card__perk">
                      Build {office.nextExpansion.addsSeats} more neutral offices ({' '}
                      {office.nextExpansion.totalSeats} total ).
                    </p>
                    <button
                      type="button"
                      className="hq-office-card__hire hq-office-card__hire--buy"
                      disabled={expanding}
                      onClick={() => void onExpandOffice()}
                    >
                      {expanding
                        ? 'Expanding…'
                        : `Expand · ${MONEY.format(office.nextExpansion.costMinor / 100)}`}
                    </button>
                  </div>
                </li>
              )}
            </ul>

            <div className="hq-offices__legend">
              <p className="hq-offices__legend-title">What a neutral office does</p>
              <ul className="hq-offices__benefits">
                <li>+1 staffed HQ capacity</li>
                <li>Takes any management candidate — or the world’s specialist</li>
              </ul>
              <ul className="hq-offices__limits">
                <li>No department capability — those stay in the six seats above</li>
                <li>Does not unlock long-haul authority</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {managing !== null && (
        <StaffOfficeDrawer
          officeName={officeLabel(managing)}
          occupant={managingOccupant}
          candidates={eligible}
          specialistId={specialist?.id ?? null}
          busy={pending === managing}
          onAssign={(candidate) => void assignToOffice(managing, candidate)}
          onRemove={() => void removeFromOffice(managing)}
          onClose={() => setSelectedSeat(null)}
        />
      )}
    </section>
  );
}
