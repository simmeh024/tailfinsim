import { useEffect, useState } from 'react';

import {
  EXECUTIVE_OFFICE_COUNT,
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  OFFICE_ROLES,
  type ExecutiveFloorState,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { fetchExecutiveFloor, unlockExecutiveFloor, unlockExecutiveOffice } from './api';
import floor10 from './assets/floorplan/hq-floor-10.webp';
import floor6 from './assets/floorplan/hq-floor-6.webp';
import floor8 from './assets/floorplan/hq-floor-8.webp';
import { execFloorImage } from './exec-floorplan';
import { candidateById } from './hq-roster';

import type { ReactNode } from 'react';

/**
 * The HQ layout overview and — on the Headquarters page — its interactive floor
 * (M5-04, App. H.4; the neutral-office interaction is M5-04's UX follow-up).
 *
 * A floor-plan of the headquarters that says, at a glance, which offices the
 * airline holds and who sits in them. The plan is a rendered image — one per
 * expansion tier, six / eight / ten offices — and the occupant info is laid over
 * the matching room: a **rounded avatar** and name where a seat is filled, a
 * faint "Vacant" where it is not.
 *
 * ## Two modes, one component
 *
 * With no `onSelectSeat`, the plan is a **read-only overview** — the rooms are
 * inert. Pass `onSelectSeat` and every room becomes a **button**: the room is the
 * office, so clicking Office 08 is how you staff Office 08, and clicking the Route
 * Planner's room is how you fill that seat. Selection is lifted to the parent, so
 * the drawer that owns the hire opens against the room the player picked.
 *
 * The rooms sit at fixed positions in each render, so the overlay is placed by
 * normalised coordinates: each office has a column (left or right of the
 * corridor) and a row, and each tier has its own row centres because a taller
 * plan spreads the same rooms differently.
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

/** The offices in floor order — the identity behind "Office 01 … Office 10". */
export const OFFICE_SEQUENCE: readonly OfficeSeatId[] = SEAT_GRID.map((entry) => entry.seat);

/** The stable office number for a seat, e.g. "Office 08". Same on plan and card. */
export function officeLabel(seat: OfficeSeatId): string {
  const index = OFFICE_SEQUENCE.indexOf(seat);
  return `Office ${String(index + 1).padStart(2, '0')}`;
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function seatTitle(seat: OfficeSeatId): string {
  return isNeutralSeat(seat) ? 'Neutral office' : OFFICE_ROLES[seat].title;
}

/** The outcome of a panel-driven expansion purchase, from the shell that owns cash. */
export interface ExpandResult {
  ok: boolean;
  message?: string;
}

interface HqLayoutPanelProps {
  office: OfficeStateResponse | null;
  /** Buy the next expansion. Absent in a bare render (a test), where the button hides. */
  onExpand?: () => Promise<ExpandResult>;
  /**
   * Make the neutral rooms interactive. When set, each unlocked neutral office is
   * a button that selects that office; role rooms stay display-only. Absent for
   * the read-only overview panel.
   */
  onSelectSeat?: (seat: OfficeSeatId) => void;
  /** The office the parent is managing — its room gets a persistent selected state. */
  selectedSeat?: OfficeSeatId | null;
  /** The office the parent is hovering/focusing elsewhere — mirrored onto its room. */
  hoveredSeat?: OfficeSeatId | null;
  /** Told when a room is hovered or focused, so a card can highlight in step. */
  onHoverSeat?: (seat: OfficeSeatId | null) => void;
}

export function HqLayoutPanel({
  office,
  onExpand,
  onSelectSeat,
  selectedSeat = null,
  hoveredSeat = null,
  onHoverSeat,
}: HqLayoutPanelProps): ReactNode {
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  // The executive floor is a second floor reached by the pager. It manages its
  // own state here — fetched once, refreshed on an unlock — so the ground floor
  // and the shell that owns this panel need to know nothing about it.
  const [floor, setFloor] = useState<'ground' | 'executive'>('ground');
  const [execState, setExecState] = useState<ExecutiveFloorState | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  // The executive floor is only managed on the interactive Headquarters panel;
  // the read-only overview (and every bare render in a test) never reaches for it,
  // so it does no network work where the feature cannot be used anyway.
  const interactivePanel = onSelectSeat !== undefined;
  useEffect(() => {
    if (!interactivePanel) return;
    let live = true;
    void fetchExecutiveFloor().then((state) => {
      if (live) setExecState(state);
    });
    return () => {
      live = false;
    };
  }, [interactivePanel]);

  const unlockFloor = async (): Promise<void> => {
    setExecBusy(true);
    setExecError(null);
    const result = await unlockExecutiveFloor();
    if (result.ok) setExecState(result.state);
    else setExecError(result.failure.message);
    setExecBusy(false);
  };

  const unlockOffice = async (): Promise<void> => {
    setExecBusy(true);
    setExecError(null);
    const result = await unlockExecutiveOffice();
    if (result.ok) setExecState(result.state);
    else setExecError(result.failure.message);
    setExecBusy(false);
  };

  const runExpand = async (): Promise<void> => {
    if (onExpand === undefined) return;
    setExpanding(true);
    setExpandError(null);
    const result = await onExpand();
    if (!result.ok) setExpandError(result.message ?? 'Could not expand headquarters');
    setExpanding(false);
  };

  const neutralSeats = office?.neutralSeats ?? 0;
  const totalSeats = HEADQUARTERS_BASE_SEATS + neutralSeats;
  const hiredBySeat = new Map((office?.hires ?? []).map((hire) => [hire.seat, hire]));
  const filled = hiredBySeat.size;

  const plan = FLOORPLAN[neutralSeats] ?? FLOORPLAN[0];
  const rows = ROW_Y[neutralSeats] ?? ROW_Y[0] ?? [];
  const visible = SEAT_GRID.slice(0, totalSeats);

  return (
    <div className="hq-layout">
      {execState !== null && (
        <div className="hq-layout__pager" role="tablist" aria-label="Headquarters floor">
          <button
            type="button"
            role="tab"
            className="hq-layout__pager-btn"
            data-active={floor === 'ground'}
            aria-selected={floor === 'ground'}
            onClick={() => setFloor('ground')}
          >
            ‹ Ground
          </button>
          <button
            type="button"
            role="tab"
            className="hq-layout__pager-btn"
            data-active={floor === 'executive'}
            aria-selected={floor === 'executive'}
            onClick={() => setFloor('executive')}
          >
            Executive ›
          </button>
        </div>
      )}

      <p className="hq-layout__count">
        {floor === 'ground' ? (
          <>
            <strong>{filled}</strong> of {totalSeats} offices staffed
            {office?.hasExtendedAuthority === true && (
              <span className="hq-layout__authority"> · long-haul authority</span>
            )}
          </>
        ) : (
          <>
            <strong>{execState?.officesUnlocked ?? 0}</strong> of {EXECUTIVE_OFFICE_COUNT} executive
            offices open
          </>
        )}
      </p>

      {floor === 'ground' && (
        <div
          className="hq-layout__floor"
          style={{
            backgroundImage: `url(${plan?.src ?? ''})`,
            aspectRatio: plan?.aspect ?? '2 / 3',
          }}
        >
          {visible.map(({ seat, row, col }) => {
            const hire = hiredBySeat.get(seat);
            const occupant = hire !== undefined ? candidateById(hire.candidateId) : null;
            const neutral = isNeutralSeat(seat);
            // Every room is managed from the plan when it is interactive — the six
            // department seats as well as the neutral ones. The roster above is the
            // other way in for a role seat; the plan is the way in for all ten.
            const interactive = onSelectSeat !== undefined;
            const style = {
              left: `${String((COLUMN_X[col] ?? 0.5) * 100)}%`,
              top: `${String((rows[row] ?? 0.5) * 100)}%`,
            };

            const inner =
              hire !== undefined ? (
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
              ) : interactive ? (
                <span className="hq-cell__add" aria-hidden="true">
                  + Hire
                </span>
              ) : (
                <span className="hq-cell__vacant">Vacant</span>
              );

            if (interactive) {
              const state = hire !== undefined ? 'Staffed' : 'Vacant';
              const action =
                hire !== undefined ? 'Activate to manage.' : 'Activate to assign staff.';
              return (
                <button
                  key={seat}
                  type="button"
                  className="hq-cell hq-cell--interactive"
                  data-seat={seat}
                  data-neutral={neutral}
                  data-occupied={hire !== undefined}
                  data-selected={selectedSeat === seat}
                  data-hovered={hoveredSeat === seat}
                  style={style}
                  aria-label={`${officeLabel(seat)}, ${seatTitle(seat)}, ${state}. ${action}`}
                  aria-pressed={selectedSeat === seat}
                  onClick={() => onSelectSeat?.(seat)}
                  onMouseEnter={() => onHoverSeat?.(seat)}
                  onMouseLeave={() => onHoverSeat?.(null)}
                  onFocus={() => onHoverSeat?.(seat)}
                  onBlur={() => onHoverSeat?.(null)}
                >
                  <span className="hq-cell__num">{officeLabel(seat)}</span>
                  {inner}
                </button>
              );
            }

            return (
              <div
                key={seat}
                className="hq-cell"
                data-seat={seat}
                data-neutral={neutral}
                data-occupied={hire !== undefined}
                data-hovered={hoveredSeat === seat}
                style={style}
                title={
                  hire !== undefined
                    ? `${hire.candidateName} — ${seatTitle(seat)}`
                    : seatTitle(seat)
                }
              >
                {inner}
              </div>
            );
          })}
        </div>
      )}

      {floor === 'executive' && execState !== null && (
        <div
          className="hq-layout__floor hq-layout__floor--exec"
          style={{
            backgroundImage: `url(${execFloorImage(execState.officesUnlocked)})`,
            aspectRatio: '887 / 1774',
          }}
        >
          {!execState.unlocked ? (
            <div className="hq-exec-gate">
              <p className="hq-exec-gate__title">Executive Floor</p>
              {execState.monthlyRevenueMinor >= execState.revenueGateMinor ? (
                <p className="hq-exec-gate__ok">Requirements met — the floor is yours to open.</p>
              ) : (
                <p className="hq-exec-gate__need">
                  You do not meet the requirements yet — need{' '}
                  <strong>
                    {MONEY.format(
                      (execState.revenueGateMinor - execState.monthlyRevenueMinor) / 100,
                    )}
                  </strong>{' '}
                  more income a month.
                </p>
              )}
              <button
                type="button"
                className="hq-exec-gate__unlock"
                disabled={execBusy || execState.monthlyRevenueMinor < execState.revenueGateMinor}
                onClick={() => void unlockFloor()}
              >
                {execBusy
                  ? 'Opening…'
                  : `Unlock the Executive Floor · ${MONEY.format(execState.unlockCostMinor / 100)}`}
              </button>
              {execError !== null && (
                <p className="hq-exec-gate__error" role="alert">
                  {execError}
                </p>
              )}
            </div>
          ) : (
            execState.nextOffice !== null && (
              <div className="hq-exec-next">
                <button
                  type="button"
                  className="hq-exec-next__btn"
                  disabled={execBusy}
                  onClick={() => void unlockOffice()}
                >
                  {execBusy
                    ? 'Opening…'
                    : `Open office ${String(execState.officesUnlocked + 1)} of ${String(EXECUTIVE_OFFICE_COUNT)} · ${MONEY.format(execState.nextOffice.costMinor / 100)}`}
                </button>
                {execError !== null && (
                  <p className="hq-exec-gate__error" role="alert">
                    {execError}
                  </p>
                )}
              </div>
            )
          )}
        </div>
      )}

      {floor === 'ground' && office?.nextExpansion != null && onExpand !== undefined && (
        <div className="hq-layout__expand">
          <button
            type="button"
            className="hq-layout__expand-btn"
            disabled={expanding}
            onClick={() => void runExpand()}
          >
            {expanding
              ? 'Expanding…'
              : `Expand · +${office.nextExpansion.addsSeats} offices for ${MONEY.format(office.nextExpansion.costMinor / 100)}`}
          </button>
          {expandError !== null && (
            <p className="hq-layout__expand-error" role="alert">
              {expandError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
