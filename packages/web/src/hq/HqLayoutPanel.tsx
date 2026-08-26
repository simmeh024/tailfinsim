import {
  OFFICE_ROLE_ORDER,
  OFFICE_ROLES,
  type OfficeRole,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { HQ_CANDIDATES } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The HQ layout overview, for the context panel (M5-04, App. H.4).
 *
 * H.4's context panel is "a view that never covers the world"; this is the
 * Headquarters page's occupant of it — a floor-plan of the six office seats that
 * says, at a glance, which unlocks the airline holds. A filled seat shows the
 * hire's **rounded avatar** and name in the seat's accent; a vacant one shows the
 * seat's icon and "Seat vacant".
 *
 * It reads the office state the page already fetched, and the candidate roster
 * for the portrait — the server sends the hired candidate's id, and the roster is
 * where that id becomes a face. A hired candidate the roster does not know (an
 * older market entry) falls back to the seat icon rather than a broken image.
 */

/** One line icon per seat. `currentColor` so each takes its seat's accent. */
const ROLE_ICON: Record<OfficeRole, ReactNode> = {
  'route-planner': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 11 21 3l-8 18-2-7-8-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ),
  'revenue-manager': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v18M8 7a3 3 0 0 1 3-3h2a3 3 0 0 1 0 6h-2a3 3 0 0 0 0 6h2a3 3 0 0 0 3-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  ),
  'ops-controller': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </svg>
  ),
  'chief-pilot': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3 4 9l8 3 8-3-8-6ZM6 11v4c0 2 3 4 6 4s6-2 6-4v-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ),
  'ground-ops': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 7h11v9H2ZM13 10h4l3 3v3h-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="18" r="1.8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="18" r="1.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  'safety-compliance': (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

interface HqLayoutPanelProps {
  office: OfficeStateResponse | null;
}

export function HqLayoutPanel({ office }: HqLayoutPanelProps): ReactNode {
  const hiredByRole = new Map((office?.hires ?? []).map((hire) => [hire.role, hire]));
  const filled = hiredByRole.size;

  return (
    <div className="hq-layout">
      <p className="hq-layout__count">
        <strong>{filled}</strong> of {OFFICE_ROLE_ORDER.length} seats filled
        {office?.hasExtendedAuthority === true && (
          <span className="hq-layout__authority"> · long-haul authority</span>
        )}
      </p>

      <ul className="hq-layout__floor">
        {OFFICE_ROLE_ORDER.map((role) => {
          const hire = hiredByRole.get(role);
          const occupant =
            hire !== undefined
              ? (HQ_CANDIDATES.find((candidate) => candidate.id === hire.candidateId) ?? null)
              : null;
          return (
            <li key={role} className="hq-room" data-role={role} data-occupied={hire !== undefined}>
              <span className="hq-room__dot" aria-hidden="true" />
              <div className="hq-room__figure">
                {hire !== undefined && occupant !== null ? (
                  <img
                    className="hq-room__avatar"
                    src={occupant.portrait}
                    alt={`${hire.candidateName}, ${OFFICE_ROLES[role].title}`}
                    loading="lazy"
                  />
                ) : (
                  <span className="hq-room__icon" aria-hidden="true">
                    {ROLE_ICON[role]}
                  </span>
                )}
              </div>
              <p className="hq-room__role">{OFFICE_ROLES[role].title}</p>
              <p className="hq-room__occupant">
                {hire !== undefined ? hire.candidateName : 'Seat vacant'}
              </p>
            </li>
          );
        })}
      </ul>

      {/*
        Expansion is a preview of a mechanic that does not exist yet: the six base
        offices are all "built", and buying more office space is post-MVP. Shown
        disabled rather than omitted so the layout matches the design, and marked
        so it never reads as a live purchase.
      */}
      <div className="hq-layout__expand" aria-disabled="true">
        <div>
          <p className="hq-layout__expand-title">Expand Headquarters</p>
          <p className="hq-layout__expand-note">+2 office spaces · $10,000,000</p>
        </div>
        <span className="hq-layout__soon">Soon</span>
      </div>
      <p className="hq-layout__path">
        Expansion path: 6 offices → 8 offices ($10,000,000) → 10 offices ($25,000,000 max).
      </p>
    </div>
  );
}
