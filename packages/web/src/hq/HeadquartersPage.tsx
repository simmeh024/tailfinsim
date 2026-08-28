import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import {
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { dismissOffice, fetchOffice, hireOffice } from './api';
import { formatCountdown, msUntilRefresh, rosterDayIndex, rotatingRoster } from './csuite-rotation';
import {
  candidatesForRole,
  formatSalary,
  HQ_CANDIDATES,
  HQ_ROLES,
  specialistById,
  type HqCandidate,
} from './hq-roster';
import { officeLabel } from './HqLayoutPanel';
import { PoliciesModal } from './PoliciesModal';
import { StaffOfficeDrawer } from './StaffOfficeDrawer';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

/** How many candidates the market shows per seat before the daily reshuffle. */
const SEAT_MARKET_SIZE = 4;

/**
 * Today's shortlist for a seat — a rotating {@link SEAT_MARKET_SIZE} of the role's
 * candidates — with the currently hired candidate always kept in view even when
 * they rotate out, so a standing hire can always be managed.
 */
function seatShortlist(
  roleId: HqCandidate['roleId'],
  dayIndex: number,
  hiredId: string | undefined,
): readonly HqCandidate[] {
  const pool = candidatesForRole(roleId);
  const shortlist = rotatingRoster(pool, dayIndex, SEAT_MARKET_SIZE);
  if (hiredId === undefined || shortlist.some((candidate) => candidate.id === hiredId)) {
    return shortlist;
  }
  const hired = pool.find((candidate) => candidate.id === hiredId);
  return hired === undefined ? shortlist : [...shortlist, hired];
}

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
 * still lives only in the real Safety & Compliance seat. The purchase is the
 * plan's Expand button, an AIR-06 charge the shell owns; it refuses when the cash
 * is not there.
 *
 * ## The floor-plan is the panel, and the panel is where you manage offices
 *
 * H.4's context panel shows the office floor-plan on every screen (see
 * {@link AppShell}), and on this page it is **interactive**: clicking a room opens
 * the staffing drawer for that office — every one of the ten, role seats included,
 * so the plan is a second way in alongside the roster below. The selection lives
 * in the shell (it owns the panel); this page reads it through the outlet context
 * to open its drawer, and clears it on a hire or on leaving the page. Rendered on
 * its own in a test the context is null, so the page falls back to local state and
 * the drawer still works. Every office change is mirrored back through
 * `replaceOffice` so the plan updates in lock-step.
 */
export function HeadquartersPage(): ReactNode {
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<OfficeSeatId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const shell = useOutletContext<OwnAirlineShellContext | null>();
  const syncOffice = shell?.replaceOffice;
  // The office the player is managing (drawer open). The interactive plan is the
  // shell's context panel, so the selection lives there and this page reads it;
  // rendered on its own in a test, it falls back to local state so the drawer
  // still works without a shell.
  const [localSeat, setLocalSeat] = useState<OfficeSeatId | null>(null);
  const selectedSeat = shell ? shell.selectedOffice : localSeat;
  const setSelectedSeat = shell ? shell.selectOffice : setLocalSeat;

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

  // Leaving the page drops any office the plan had selected, so returning to it
  // does not reopen the drawer on a stale pick. The selection lives in the shell,
  // which outlives this page, so the clear has to be explicit.
  useEffect(() => () => setSelectedSeat(null), [setSelectedSeat]);

  // The market refreshes every 24 hours; the countdown ticks once a second and,
  // when it crosses a boundary, the day index changes and each seat reshuffles.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dayIndex = rosterDayIndex(now);

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

  // Assign into (or replace an occupant of) the office the drawer is on, then
  // close it — but only on success, so a refused hire keeps the drawer and its
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

  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const filled = hiredBySeat.size;
  const hasOpsController = (office?.hires ?? []).some((hire) => hire.seat === 'ops-controller');

  // The world offers exactly one specialist; the server names it. It is highlighted
  // in the staffing drawer, and only offered while it is not already employed.
  const specialist = office?.offeredSpecialist ? specialistById(office.offeredSpecialist) : null;

  // The office the drawer is on, and who — if anyone — sits there now.
  const managing = selectedSeat;
  const managingOccupant = managing !== null ? (hiredBySeat.get(managing) ?? null) : null;
  const managingIsNeutral = managing !== null && isNeutralSeat(managing);
  const managingRole =
    managing !== null && !managingIsNeutral
      ? (HQ_ROLES.find((role) => role.id === managing) ?? null)
      : null;

  // What the drawer offers depends on the office. A neutral office takes any
  // un-hired candidate, the world's specialist first; a role seat takes only that
  // role's candidates, and neither offers anyone already employed elsewhere.
  const drawerCandidates: readonly HqCandidate[] =
    managing === null
      ? []
      : managingIsNeutral
        ? [
            ...(specialist !== null && !hiredCandidateIds.has(specialist.id) ? [specialist] : []),
            ...HQ_CANDIDATES.filter((candidate) => !hiredCandidateIds.has(candidate.id)),
          ]
        : // A role seat offers today's rotating shortlist for that seat, minus anyone
          // already employed — the same four the roster shows.
          seatShortlist(
            managing as HqCandidate['roleId'],
            dayIndex,
            hiredBySeat.get(managing)?.candidateId,
          ).filter((candidate) => !hiredCandidateIds.has(candidate.id));

  const drawerName =
    managingRole !== null ? managingRole.role : managing !== null ? officeLabel(managing) : '';
  const drawerDescription =
    managingRole !== null
      ? `Unlocks ${managingRole.unlock}${managingRole.gates !== undefined ? ` ${managingRole.gates}` : ''}`
      : 'A neutral office adds one staffed post. It grants no department capability — those stay in the six seats — and does not unlock long-haul authority.';

  return (
    <section className="page hq-page" aria-label="Headquarters">
      <div className="csuite-refresh" role="timer" aria-label="Time until the market refreshes">
        <span className="csuite-refresh__label">Market refreshes in</span>
        <span className="csuite-refresh__clock">{formatCountdown(msUntilRefresh(now))}</span>
        <span className="csuite-refresh__note">
          A fresh shortlist of {SEAT_MARKET_SIZE} candidates per seat every 24 hours
        </span>
      </div>

      <header className="hq-page__heading">
        <div>
          <p className="airline-page__eyebrow">Head Office</p>
          <h1 className="page__title">Headquarters</h1>
          <p className="page__note">
            Each seat unlocks a concrete capability — and the person you put in it brings a small
            standing boost of their own, worth their salary. A seat holds one person; an unfilled
            candidate is greyed, the one you hire is in colour. The shortlist reshuffles daily.
          </p>
        </div>
        <div className="hq-page__aside">
          <div className="hq-page__actions">
            <button
              type="button"
              className="hq-page__policies"
              onClick={() => setPoliciesOpen(true)}
            >
              Policies
            </button>
            <Link to="/c-suite" className="hq-page__policies">
              C-Suite
            </Link>
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
          const hiredId = hiredBySeat.get(seat.id)?.candidateId;
          const candidates = seatShortlist(seat.id, dayIndex, hiredId);
          const hiredCandidate = candidates.find((candidate) => candidate.id === hiredId) ?? null;
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
                            <dd>{formatSalary(candidate.salaryPerMonthMinor)}/mo</dd>
                          </div>
                        </dl>

                        <p className="hq-card__boost" title={candidate.boost.description}>
                          <span className="hq-card__boost-badge">{candidate.boost.label}</span>
                          <span className="hq-card__boost-detail">
                            {candidate.boost.description}
                          </span>
                        </p>

                        {candidate.trait !== undefined && (
                          <p className="hq-card__trait">
                            <span className="hq-card__trait-badge">{given}</span>
                            <span>
                              <strong>{candidate.trait.label}.</strong> {candidate.trait.detail}
                            </span>
                          </p>
                        )}

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

      <p className="hq-page__plan-hint">
        Every office is a room on the Head Office plan to the right — click one to hire, replace or
        remove its staff. Expand your headquarters from there too.
      </p>

      {managing !== null && (
        <StaffOfficeDrawer
          officeName={drawerName}
          description={drawerDescription}
          occupant={managingOccupant}
          candidates={drawerCandidates}
          specialistId={managingIsNeutral ? (specialist?.id ?? null) : null}
          busy={pending === managing}
          onAssign={(candidate) => void assignToOffice(managing, candidate)}
          onRemove={() => void removeFromOffice(managing)}
          onClose={() => setSelectedSeat(null)}
        />
      )}
    </section>
  );
}
