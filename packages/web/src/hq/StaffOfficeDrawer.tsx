import { useEffect, useRef, useState } from 'react';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { formatSalary, type HqCandidate } from './hq-roster';

import type { SeatFailure } from './HeadquartersPage';
import type { ReactNode } from 'react';

/**
 * The staffing drawer (M5-04 UX follow-up).
 *
 * Opened by clicking a room on the Head Office floor-plan — any of the ten, a
 * department seat or a neutral office — so the room the player picked is the
 * subject: the header names it and its `description` says what it is for, and
 * every candidate's action reads "Hire & Assign" because it assigns to *that*
 * office.
 *
 * The candidate list is chosen by the caller: a role seat is offered its own
 * role's people; a neutral office is offered any un-hired candidate, with the
 * world's one social-media specialist shown first and badged when `specialistId`
 * names it, because they carry a standing edge a generic hire does not. A role
 * seat passes a null `specialistId`, so no badge appears where it would not mean
 * anything.
 *
 * ## What the UX pass changed here
 *
 * Three things, all of them matching the page behind it. The drawer showed each
 * candidate's salary but never what the office would cost once they were in it,
 * so a hire was priced and never budgeted — `payrollAfter` supplies that. A
 * refused hire painted its message on the page *behind* the open drawer, where
 * nobody could see it. And "Remove from Office" ended a contract on one click.
 */

interface StaffOfficeDrawerProps {
  /** The office being staffed — "Office 08" for a neutral room, the role for a seat. */
  officeName: string;
  /** One line under the title: what a neutral office is, or what a role seat unlocks. */
  description: string;
  /** Who sits there now, if anyone — shown with a remove control. */
  occupant: { candidateId: string; candidateName: string } | null;
  /** Candidates eligible to assign here (already filtered to the un-hired). */
  candidates: readonly HqCandidate[];
  /** The id of the world's specialist, so it can be surfaced and badged. */
  specialistId: string | null;
  /** An assignment or removal is in flight — controls disable. */
  busy: boolean;
  /** The office's monthly salary bill as it stands. */
  payrollMinor: number;
  /** What that bill becomes with this candidate in this office — a replacement nets off. */
  payrollAfter: (candidate: HqCandidate) => number;
  /** A refusal or a transport failure from this office's own last action. */
  failure: SeatFailure | null;
  onAssign: (candidate: HqCandidate) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function StaffOfficeDrawer({
  officeName,
  description,
  occupant,
  candidates,
  specialistId,
  busy,
  payrollMinor,
  payrollAfter,
  failure,
  onAssign,
  onRemove,
  onClose,
}: StaffOfficeDrawerProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const heading = occupant !== null ? `Manage ${officeName}` : `Staff ${officeName}`;

  return (
    <div
      className="modal-scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal hq-staff"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-office-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="modal__header">
          <div>
            <h2 id="staff-office-title" className="modal__title">
              {heading}
            </h2>
            <p className="modal__subtitle">{description}</p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal__body">
          {payrollMinor > 0 && (
            <p className="hq-staff__payroll">
              <span className="hq-staff__payroll-label">Head office payroll</span>
              <strong>{formatSalary(payrollMinor)}/mo</strong>
            </p>
          )}

          {/* The failure belongs where the action was taken, not on the page behind. */}
          {failure !== null && (
            <StateBlock kind={failure.kind} className="hq-staff__failure">
              {failure.message}
            </StateBlock>
          )}

          {occupant !== null && (
            <section className="hq-staff__current" aria-label="Current occupant">
              <p className="hq-staff__current-who">
                <span className="hq-staff__current-label">In this office</span>
                <strong>{occupant.candidateName}</strong>
              </p>
              {confirmingRemove ? (
                <div className="hq-staff__confirm">
                  <p className="hq-staff__confirm-note">
                    Ends {occupant.candidateName}&rsquo;s contract and empties the office.
                  </p>
                  <div className="hq-staff__confirm-actions">
                    <Button variant="danger" size="sm" disabled={busy} onClick={onRemove}>
                      Confirm — remove
                    </Button>
                    <Button
                      variant="tertiary"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmingRemove(false)}
                    >
                      Keep
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="hq-staff__remove-cta"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(true)}
                >
                  Remove from Office
                </Button>
              )}
            </section>
          )}

          {candidates.length === 0 ? (
            <StateBlock kind="empty" className="hq-staff__none">
              Every candidate is already employed. Remove someone from another office to free them
              up.
            </StateBlock>
          ) : (
            <ul className="hq-staff__list">
              {candidates.map((candidate) => {
                const isSpecialist = candidate.id === specialistId;
                const given = candidate.name.split(' ')[0] ?? candidate.name;
                return (
                  <li
                    key={candidate.id}
                    className="hq-staff__candidate"
                    data-specialist={isSpecialist}
                  >
                    <img
                      className="hq-staff__portrait"
                      src={candidate.portrait}
                      alt={candidate.name}
                      loading="lazy"
                    />
                    <div className="hq-staff__body">
                      <p className="hq-staff__name">
                        {candidate.name}
                        {isSpecialist && <span className="hq-staff__badge">Specialist</span>}
                      </p>
                      <p className="hq-staff__meta">
                        {candidate.tier} · {formatSalary(candidate.salaryPerMonthMinor)}/mo
                        <span className="hq-staff__after">
                          payroll {formatSalary(payrollAfter(candidate))}/mo
                        </span>
                      </p>
                      <p className="hq-staff__trait">
                        <strong>{candidate.boost.label}.</strong>{' '}
                        {candidate.trait?.detail ?? candidate.boost.description}
                      </p>
                    </div>
                    <Button
                      className="hq-staff__assign-cta"
                      disabled={busy}
                      onClick={() => onAssign(candidate)}
                    >
                      {occupant !== null ? `Replace with ${given}` : 'Hire & Assign'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
