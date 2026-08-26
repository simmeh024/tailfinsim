import {
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  OFFICE_ROLES,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import floor10 from './assets/floorplan/hq-floor-10.webp';
import floor6 from './assets/floorplan/hq-floor-6.webp';
import floor8 from './assets/floorplan/hq-floor-8.webp';
import { HQ_CANDIDATES } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The HQ layout overview, for the context panel (M5-04, App. H.4).
 *
 * A floor-plan of the headquarters that says, at a glance, which offices the
 * airline holds and who sits in them. The plan is a rendered image — one per
 * expansion tier, six / eight / ten offices — and the occupant info is laid over
 * the matching room: a **rounded avatar** and name where a seat is filled, a
 * faint "Vacant" where it is not.
 *
 * The rooms sit at fixed positions in each render, so the overlay is placed by
 * normalised coordinates: each office has a column (left or right of the
 * corridor) and a row, and each tier has its own row centres because a taller
 * plan spreads the same rooms differently. The image is stretched to the panel
 * and the container carries the render's aspect ratio, so the coordinates hold at
 * any width.
 */

/** The plan render, and its aspect ratio, keyed by neutral seats unlocked. */
const FLOORPLAN: Record<number, { src: string; aspect: string }> = {
  0: { src: floor6, aspect: '1024 / 1536' },
  2: { src: floor8, aspect: '934 / 1683' },
  4: { src: floor10, aspect: '887 / 1774' },
};

/** Column centres, as a fraction of image width — left and right of the corridor. */
const COLUMN_X: Record<'left' | 'right', number> = { left: 0.245, right: 0.755 };

/** Row centres, as a fraction of image height, per neutral-seat tier. */
const ROW_Y: Record<number, readonly number[]> = {
  0: [0.255, 0.515, 0.78],
  2: [0.175, 0.395, 0.61, 0.83],
  4: [0.135, 0.315, 0.495, 0.675, 0.85],
};

/** Where each seat sits in the plan, top to bottom, left then right. */
const SEAT_GRID: readonly { seat: OfficeSeatId; row: number; col: 'left' | 'right' }[] = [
  { seat: 'route-planner', row: 0, col: 'left' },
  { seat: 'revenue-manager', row: 0, col: 'right' },
  { seat: 'ops-controller', row: 1, col: 'left' },
  { seat: 'chief-pilot', row: 1, col: 'right' },
  { seat: 'ground-ops', row: 2, col: 'left' },
  { seat: 'safety-compliance', row: 2, col: 'right' },
  { seat: 'neutral-1', row: 3, col: 'left' },
  { seat: 'neutral-2', row: 3, col: 'right' },
  { seat: 'neutral-3', row: 4, col: 'left' },
  { seat: 'neutral-4', row: 4, col: 'right' },
];

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function seatTitle(seat: OfficeSeatId): string {
  return isNeutralSeat(seat) ? 'Neutral office' : OFFICE_ROLES[seat].title;
}

interface HqLayoutPanelProps {
  office: OfficeStateResponse | null;
}

export function HqLayoutPanel({ office }: HqLayoutPanelProps): ReactNode {
  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const hiredBySeat = new Map((office?.hires ?? []).map((hire) => [hire.seat, hire]));
  const filled = hiredBySeat.size;

  const plan = FLOORPLAN[neutralSeats] ?? FLOORPLAN[0];
  const rows = ROW_Y[neutralSeats] ?? ROW_Y[0] ?? [];
  const visible = SEAT_GRID.slice(0, totalSeats);

  return (
    <div className="hq-layout">
      <p className="hq-layout__count">
        <strong>{filled}</strong> of {totalSeats} offices staffed
        {office?.hasExtendedAuthority === true && (
          <span className="hq-layout__authority"> · long-haul authority</span>
        )}
      </p>

      <div
        className="hq-layout__floor"
        style={{ backgroundImage: `url(${plan?.src ?? ''})`, aspectRatio: plan?.aspect ?? '2 / 3' }}
      >
        {visible.map(({ seat, row, col }) => {
          const hire = hiredBySeat.get(seat);
          const occupant =
            hire !== undefined
              ? (HQ_CANDIDATES.find((candidate) => candidate.id === hire.candidateId) ?? null)
              : null;
          return (
            <div
              key={seat}
              className="hq-cell"
              data-seat={seat}
              data-neutral={isNeutralSeat(seat)}
              data-occupied={hire !== undefined}
              style={{
                left: `${String((COLUMN_X[col] ?? 0.5) * 100)}%`,
                top: `${String((rows[row] ?? 0.5) * 100)}%`,
              }}
              title={
                hire !== undefined ? `${hire.candidateName} — ${seatTitle(seat)}` : seatTitle(seat)
              }
            >
              {hire !== undefined ? (
                <>
                  {occupant !== null && (
                    <img
                      className="hq-cell__avatar"
                      src={occupant.portrait}
                      alt={hire.candidateName}
                    />
                  )}
                  <span className="hq-cell__name">{hire.candidateName}</span>
                </>
              ) : (
                <span className="hq-cell__vacant">Vacant</span>
              )}
            </div>
          );
        })}
      </div>

      {office?.nextExpansion != null && (
        <p className="hq-layout__path">
          Next: +{office.nextExpansion.addsSeats} offices ·{' '}
          {MONEY.format(office.nextExpansion.costMinor / 100)} — expand from the Headquarters page.
        </p>
      )}
    </div>
  );
}
