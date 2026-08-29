import { useEffect, useRef } from 'react';

import { type CSuiteCandidate } from './csuite-roster';
import { formatSalary } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The executive staffing drawer — the C-Suite floor's counterpart to
 * {@link StaffOfficeDrawer}, opened by clicking an office on the executive floor
 * plan.
 *
 * An executive office is **generic**, so the drawer is simpler than the ground
 * floor's: an occupied office offers only "Let go" (there is no role to match, and
 * a replacement would just be a free office anyway), and an empty office offers the
 * day's hireable executives — the same rotating shortlist the roster shows — each
 * with its role and standing boost, so hiring from the plan and hiring from the
 * roster reach for the same people.
 */

interface StaffExecDrawerProps {
  /** The office being staffed — "Executive Office 03". */
  officeName: string;
  /** Who sits there now, if anyone — shown with a "Let go" control. */
  occupant: { candidateId: string; candidateName: string } | null;
  /** Executives eligible to hire here (already filtered to the un-hired). */
  candidates: readonly CSuiteCandidate[];
  /** A hire or a dismissal is in flight — controls disable. */
  busy: boolean;
  onHire: (candidate: CSuiteCandidate) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function StaffExecDrawer({
  officeName,
  occupant,
  candidates,
  busy,
  onHire,
  onRemove,
  onClose,
}: StaffExecDrawerProps): ReactNode {
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
        aria-labelledby="staff-exec-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className="modal__header">
          <div>
            <h2 id="staff-exec-title" className="modal__title">
              {heading}
            </h2>
            <p className="modal__subtitle">
              An executive office takes any candidate — any C-Suite member fits any open office.
            </p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="modal__body">
          {occupant !== null ? (
            <section className="hq-staff__current" aria-label="Current occupant">
              <p className="hq-staff__current-who">
                <span className="hq-staff__current-label">In this office</span>
                <strong>{occupant.candidateName}</strong>
              </p>
              <button type="button" className="hq-staff__remove" disabled={busy} onClick={onRemove}>
                Let go
              </button>
            </section>
          ) : candidates.length === 0 ? (
            <p className="hq-staff__empty">
              Every executive on today’s shortlist is already employed. Let one go, or wait for the
              roster to refresh.
            </p>
          ) : (
            <ul className="hq-staff__list">
              {candidates.map((candidate) => {
                const given = candidate.name.split(' ')[0] ?? candidate.name;
                return (
                  <li key={candidate.id} className="hq-staff__candidate">
                    <img
                      className="hq-staff__portrait"
                      src={candidate.portrait}
                      alt={candidate.name}
                      loading="lazy"
                    />
                    <div className="hq-staff__body">
                      <p className="hq-staff__name">{candidate.name}</p>
                      <p className="hq-staff__meta">
                        {candidate.role} · {candidate.tier} ·{' '}
                        {formatSalary(candidate.monthlySalaryMinor)}/mo
                      </p>
                      <p className="hq-staff__trait">
                        <strong>{candidate.boost.label}.</strong> {candidate.boost.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="hq-staff__assign"
                      disabled={busy}
                      onClick={() => onHire(candidate)}
                    >
                      Hire {given}
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
