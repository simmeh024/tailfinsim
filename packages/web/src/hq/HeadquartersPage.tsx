import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import {
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { dismissOffice, fetchOffice, hireOffice, officeFailureKind } from './api';
import { rosterDayIndex, rotatingRoster } from './csuite-rotation';
import { ExecutiveStaffDrawer } from './ExecutiveStaffDrawer';
import {
  boostStrength,
  candidatesForRole,
  formatSalary,
  HQ_CANDIDATES,
  HQ_ROLES,
  specialistById,
  tierMetal,
  type HqCandidate,
} from './hq-roster';
import { officeLabel } from './HqLayoutPanel';
import { MarketCountdown } from './MarketCountdown';
import { monthlyPayrollMinor, payrollAfterHire, payrollRunway, payrollStrain } from './payroll';
import { PoliciesModal } from './PoliciesModal';
import { StaffOfficeDrawer } from './StaffOfficeDrawer';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { StateKind } from '../ui/StateBlock';
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

/** A failure, and the seat whose control produced it — so it can be shown there. */
export interface SeatFailure {
  seat: OfficeSeatId;
  kind: Extract<StateKind, 'refused' | 'broken'>;
  message: string;
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
 * is the number on the ledger. The **payroll total** in the heading is summed from
 * the server's own `monthlySalaryMinor` for exactly the same reason.
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
 *
 * ## What the page had to be told to say
 *
 * Five things were true of the office and invisible on it, and they are the
 * substance of the UX pass:
 *
 * - **What it costs.** Seats were counted and people were priced one at a time;
 *   the monthly bill was nowhere. See `payroll.ts`.
 * - **Whether the airline carries it.** The cash sits in the shell, so a card can
 *   say a hire is more than a month of it before the ledger does.
 * - **What a tier buys.** Bronze/silver/gold borders and three band names, with
 *   nothing saying a higher band asks more and brings more.
 * - **How the four compare.** Each boost was a badge and a sentence; a bar makes
 *   the seat's one shared lever comparable across the shortlist.
 * - **What a vacancy costs.** "Unlocks …" reads as an offer; `HqRole.vacant`
 *   reads the same fact as the thing not happening today.
 *
 * And two it said badly. A refusal appeared as one page-level paragraph, far from
 * the seat that produced it and identical whether the server had said no or had
 * not answered at all; failures now sit in their own seat and keep *refused* and
 * *broken* apart. And the daily reshuffle rewrote every shortlist under the
 * player's cursor the moment the window turned; the new one is offered now, not
 * imposed — see {@link MarketCountdown}.
 */
export function HeadquartersPage(): ReactNode {
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<OfficeSeatId | null>(null);
  const [failure, setFailure] = useState<SeatFailure | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  // Which seat is mid-dismissal. Letting someone go ends a contract and, on the
  // gate seat, revokes flying authority; one click was too few (idea #6).
  const [confirming, setConfirming] = useState<OfficeSeatId | null>(null);
  // The 24-hour window the page is showing. Pinned at mount rather than derived
  // from a ticking clock, so a turnover cannot rewrite the page mid-read; the
  // countdown reports the boundary and `pendingDay` offers it.
  const [dayIndex, setDayIndex] = useState(() => rosterDayIndex());
  const [pendingDay, setPendingDay] = useState<number | null>(null);
  const shell = useOutletContext<OwnAirlineShellContext | null>();
  const syncOffice = shell?.replaceOffice;
  const cashMinor = shell?.ownAirline?.airline?.cash ?? null;
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

  const hiredBySeat = new Map<OfficeSeatId, { candidateId: string; candidateName: string }>(
    (office?.hires ?? []).map((hire) => [
      hire.seat,
      { candidateId: hire.candidateId, candidateName: hire.candidateName },
    ]),
  );
  // The salary the server is actually billing for each seat — not the candidate
  // catalogue's figure for the same person. They agree today; if they ever stop,
  // the page should show the one on the ledger.
  const salaryBySeat = new Map<OfficeSeatId, number>(
    (office?.hires ?? []).map((hire) => [hire.seat, hire.monthlySalaryMinor]),
  );
  // One person, one office: a candidate already sitting in any seat is out of the
  // running for another. The server enforces this too, so this only spares the
  // player a doomed pick.
  const hiredCandidateIds = new Set((office?.hires ?? []).map((hire) => hire.candidateId));

  const act = useCallback(
    async (seat: OfficeSeatId, run: () => ReturnType<typeof hireOffice>): Promise<boolean> => {
      setPending(seat);
      setFailure(null);
      const outcome = await run();
      if (outcome.ok) {
        setOffice(outcome.state);
        syncOffice?.(outcome.state);
      } else {
        setFailure({
          seat,
          kind: officeFailureKind(outcome.failure),
          message: outcome.failure.message,
        });
      }
      setPending(null);
      return outcome.ok;
    },
    [syncOffice],
  );

  const onHire = useCallback(
    (seat: OfficeSeatId, candidate: HqCandidate): Promise<boolean> => {
      setConfirming(null);
      return act(seat, () =>
        hireOffice({
          seat,
          candidateId: candidate.id,
          candidateName: candidate.name,
          candidateRole: candidate.roleId,
        }),
      );
    },
    [act],
  );

  const onDismiss = useCallback(
    async (seat: OfficeSeatId): Promise<void> => {
      setConfirming(null);
      await act(seat, () => dismissOffice(seat));
    },
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
    [act, setSelectedSeat],
  );

  const removeFromOffice = useCallback(
    async (seat: OfficeSeatId): Promise<void> => {
      const ok = await act(seat, () => dismissOffice(seat));
      if (ok) setSelectedSeat(null);
    },
    [act, setSelectedSeat],
  );

  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const filled = hiredBySeat.size;
  const hasOpsController = (office?.hires ?? []).some((hire) => hire.seat === 'ops-controller');
  const payrollMinor = monthlyPayrollMinor(office);

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
      <MarketCountdown marketSize={SEAT_MARKET_SIZE} onBoundary={setPendingDay} />

      {pendingDay !== null && (
        <div className="hq-page__reshuffle" role="status">
          <p className="hq-page__reshuffle-note">
            A new shortlist is on the market. The seats below still show the one you have been
            reading — nothing changed under you.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setDayIndex(pendingDay);
              setPendingDay(null);
            }}
          >
            Show today&rsquo;s shortlist
          </Button>
        </div>
      )}

      <header className="hq-page__heading">
        <div>
          <p className="airline-page__eyebrow">Head Office</p>
          <h1 className="page__title">Headquarters</h1>
          <p className="page__note">
            Each seat unlocks a concrete capability — and the person you put in it brings a small
            standing boost of their own, worth their salary. A seat holds one person; an unfilled
            candidate is greyed, the one you hire is in colour. The shortlist reshuffles daily.
          </p>
          {/*
            The tier legend. The metal on a card's border and the band under its
            name were two encodings of one thing, and neither said what the thing
            bought — so a player had no reason to pay more (idea #3).
          */}
          <p className="hq-page__legend">
            <span className="hq-page__legend-key" data-metal="bronze" aria-hidden="true" />
            Supervisor
            <span className="hq-page__legend-key" data-metal="silver" aria-hidden="true" />
            Manager
            <span className="hq-page__legend-key" data-metal="gold" aria-hidden="true" />
            Senior Manager. A higher band asks a higher salary and brings a bigger boost on the
            seat&rsquo;s own lever.
          </p>
        </div>
        <div className="hq-page__aside">
          <div className="hq-page__actions">
            <Button onClick={() => setPoliciesOpen(true)}>Policies</Button>
            <Link to="/c-suite" className="btn btn--secondary">
              C-Suite
            </Link>
          </div>
          {/*
            One live region either way, never two: while the office is loading the
            summary *is* the loading block, so assistive technology hears a single
            answer about the office rather than a count racing a status.
          */}
          {loading ? (
            <StateBlock kind="loading" className="hq-page__summary">
              Reading the office…
            </StateBlock>
          ) : (
            <p className="hq-page__count" role="status">
              <strong>{filled}</strong> of {totalSeats} seats filled
              {payrollMinor > 0 && (
                <>
                  {' · '}
                  <span className="hq-page__payroll">{formatSalary(payrollMinor)}/mo payroll</span>
                </>
              )}
              {office?.hasExtendedAuthority === true && (
                <>
                  {' · '}
                  <span className="hq-page__authority">long-haul authority unlocked</span>
                </>
              )}
            </p>
          )}
        </div>
      </header>

      <PoliciesModal
        open={policiesOpen}
        onClose={() => setPoliciesOpen(false)}
        hasOpsController={hasOpsController}
      />

      <div className="hq-roster" aria-busy={loading}>
        {HQ_ROLES.map((seat) => {
          const hiredId = hiredBySeat.get(seat.id)?.candidateId;
          const candidates = seatShortlist(seat.id, dayIndex, hiredId);
          const hiredCandidate = candidates.find((candidate) => candidate.id === hiredId) ?? null;
          const seatPending = pending === seat.id;
          const seatFailure = failure !== null && failure.seat === seat.id ? failure : null;
          const seatSalary = salaryBySeat.get(seat.id);
          // The strongest boost among the candidates on offer today. Every card's
          // bar is drawn against it, and a card matching it is badged.
          const strongest = candidates.reduce(
            (best, candidate) => Math.max(best, Math.abs(candidate.boost.magnitude)),
            0,
          );

          return (
            <section key={seat.id} className="hq-seat" aria-label={seat.role}>
              <header className="hq-seat__header">
                <div>
                  <h2 className="hq-seat__role">
                    <span>{seat.role}</span>
                    {/*
                      Decoration only, and no `title`. The rule it used to hide in
                      a tooltip is the paragraph directly below, where a keyboard
                      and a screen reader can both reach it (idea #14).
                    */}
                    {seat.gates !== undefined && (
                      <span className="hq-seat__gate-flag" aria-hidden="true">
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
                <div className="hq-seat__standing">
                  {/*
                    Until the server has answered, the seat says so. It used to
                    read "Seat vacant" on first paint and correct itself a moment
                    later — a claim about the office made before the office had
                    been read (idea #7).
                  */}
                  <p className="hq-seat__status" data-vacant={!loading && hiredCandidate === null}>
                    {loading
                      ? 'Reading the office…'
                      : hiredCandidate !== null
                        ? `Seat filled by ${hiredCandidate.name}`
                        : 'Seat vacant'}
                  </p>
                  {!loading && hiredCandidate !== null && seatSalary !== undefined && (
                    <p className="hq-seat__salary">{formatSalary(seatSalary)}/mo</p>
                  )}
                  {!loading && hiredCandidate === null && (
                    <p className="hq-seat__vacant">{seat.vacant}</p>
                  )}
                </div>
              </header>

              {/*
                The failure belongs to the seat whose control produced it. One
                page-level paragraph meant a refusal on the sixth seat announced
                itself off the top of the screen (idea #8).
              */}
              {seatFailure !== null && (
                <StateBlock kind={seatFailure.kind} className="hq-seat__failure">
                  {seatFailure.message}
                </StateBlock>
              )}

              <ul className="hq-grid">
                {candidates.map((candidate) => {
                  const isHired = hiredId === candidate.id;
                  const given = candidate.name.split(' ')[0] ?? candidate.name;
                  const isStrongest =
                    strongest > 0 && Math.abs(candidate.boost.magnitude) === strongest;
                  // What hiring this person would do to the monthly bill, read
                  // against the airline's cash. Unknown cash — the page rendered
                  // without a shell — says nothing rather than guessing.
                  const strain = isHired
                    ? null
                    : payrollStrain(
                        payrollRunway(cashMinor, payrollAfterHire(office, seat.id, candidate)),
                      );
                  const isConfirming = confirming === seat.id && isHired;
                  return (
                    <li
                      key={candidate.id}
                      className="hq-card"
                      data-hired={isHired}
                      data-metal={tierMetal(candidate.tier)}
                    >
                      <div
                        className="hq-card__portrait"
                        data-hired={isHired}
                        data-pending={loading}
                      >
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

                        {/* No `title` here either: it repeated the sentence beside it. */}
                        <p className="hq-card__boost">
                          <span className="hq-card__boost-badge">{candidate.boost.label}</span>
                          <span className="hq-card__boost-detail">
                            {candidate.boost.description}
                          </span>
                        </p>

                        {/*
                          The comparison, not the figure — the badge above already
                          carries the number, so the bar is decoration and stays
                          out of the accessibility tree rather than being read a
                          second time in a less useful form (idea #4).
                        */}
                        <div className="hq-card__strength" aria-hidden="true">
                          <span
                            className="hq-card__strength-fill"
                            style={{
                              inlineSize: `${String(Math.round(boostStrength(candidate, candidates) * 100))}%`,
                            }}
                          />
                        </div>
                        {isStrongest && (
                          <p className="hq-card__strongest">
                            Strongest of the {candidates.length} on offer
                          </p>
                        )}

                        {strain !== null && strain !== 'comfortable' && (
                          <p className="hq-card__afford" data-strain={strain}>
                            {strain === 'unaffordable'
                              ? 'This payroll would exceed your cash'
                              : 'Leaves under three months of payroll in cash'}
                          </p>
                        )}

                        {isConfirming ? (
                          <div className="hq-card__confirm">
                            <p className="hq-card__confirm-note">
                              {seat.gates !== undefined
                                ? 'Letting them go revokes long-haul, ETOPS and international authority.'
                                : `Ends ${given}’s contract and stops the salary.`}
                            </p>
                            <div className="hq-card__confirm-actions">
                              <Button
                                variant="danger"
                                size="sm"
                                disabled={seatPending}
                                onClick={() => void onDismiss(seat.id)}
                              >
                                {`Confirm — let ${given} go`}
                              </Button>
                              <Button
                                variant="tertiary"
                                size="sm"
                                disabled={seatPending}
                                onClick={() => setConfirming(null)}
                              >
                                Keep
                              </Button>
                            </div>
                          </div>
                        ) : (
                          /*
                            Every hire on a seat is a peer of the other three, so
                            none of them is the page's primary action; UX-08's
                            `primary` is reserved for the one-of-a-region controls
                            (the reshuffle offer) and `danger` for the dismissal
                            that has been confirmed.
                          */
                          <Button
                            className="hq-card__cta"
                            disabled={loading || seatPending}
                            onClick={() =>
                              isHired ? setConfirming(seat.id) : void onHire(seat.id, candidate)
                            }
                          >
                            {isHired ? 'Let go' : `Hire ${given}`}
                          </Button>
                        )}
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
        Every office is a room on the Head Office plan in the context panel — click one to hire,
        replace or remove its staff. Expand your headquarters from there too.
      </p>

      {managing !== null && (
        <StaffOfficeDrawer
          officeName={drawerName}
          description={drawerDescription}
          occupant={managingOccupant}
          candidates={drawerCandidates}
          specialistId={managingIsNeutral ? (specialist?.id ?? null) : null}
          busy={pending === managing}
          payrollMinor={payrollMinor}
          payrollAfter={(candidate) => payrollAfterHire(office, managing, candidate)}
          failure={failure !== null && failure.seat === managing ? failure : null}
          onAssign={(candidate) => void assignToOffice(managing, candidate)}
          onRemove={() => void removeFromOffice(managing)}
          onClose={() => setSelectedSeat(null)}
        />
      )}

      {/* The executive floor plan (up a floor on the panel) opens its drawer here too. */}
      <ExecutiveStaffDrawer />
    </section>
  );
}
