import { useEffect, useRef } from 'react';

import { formatSalary, type HqCandidate } from './hq-roster';

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
  onAssign,
  onRemove,
  onClose,
}: StaffOfficeDrawerProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);

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
          {occupant !== null && (
            <section className="hq-staff__current" aria-label="Current occupant">
              <p className="hq-staff__current-who">
                <span className="hq-staff__current-label">In this office</span>
                <strong>{occupant.candidateName}</strong>
              </p>
              <button type="button" className="hq-staff__remove" disabled={busy} onClick={onRemove}>
                Remove from Office
              </button>
            </section>
          )}

          {candidates.length === 0 ? (
            <p className="hq-staff__empty">
              Every candidate is already employed. Remove someone from another office to free them
              up.
            </p>
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
                      </p>
                      <p className="hq-staff__trait">
                        <strong>{candidate.boost.label}.</strong>{' '}
                        {candidate.trait?.detail ?? candidate.boost.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="hq-staff__assign"
                      disabled={busy}
                      onClick={() => onAssign(candidate)}
                    >
                      {occupant !== null ? `Replace with ${given}` : 'Hire & Assign'}
                    </button>
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
