import { useMemo, useState } from 'react';

import {
  EXECUTIVE_OFFICE_COUNT,
  HEADQUARTERS_BASE_SEATS,
  isNeutralSeat,
  OFFICE_ROLES,
  type ExecutiveFloorState,
  type ExecutiveHire,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

import floor10 from './assets/floorplan/hq-floor-10.webp';
import floor6 from './assets/floorplan/hq-floor-6.webp';
import floor8 from './assets/floorplan/hq-floor-8.webp';
import { csuiteCandidate } from './csuite-roster';
import { EXEC_FLOOR_ASPECT, execFloorImage } from './exec-floorplan';
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

/**
 * The executive floor's ten rooms, in the order the art furnishes them as offices
 * open (top-right first, then filling down the two columns). Office index `i`
 * (0-based) sits here, so when `officesUnlocked` is 3 the three open rooms line up
 * with the three furnished rooms in `exec-floor-3`.
 */
const EXEC_COLUMN_X: Record<'left' | 'right', number> = { left: 0.22, right: 0.78 };
const EXEC_ROW_Y: readonly number[] = [0.1, 0.285, 0.465, 0.645, 0.83];
const EXEC_SEAT_GRID: readonly { row: number; col: 'left' | 'right' }[] = [
  { row: 0, col: 'right' },
  { row: 0, col: 'left' },
  { row: 1, col: 'left' },
  { row: 1, col: 'right' },
  { row: 2, col: 'left' },
  { row: 2, col: 'right' },
  { row: 3, col: 'left' },
  { row: 3, col: 'right' },
  { row: 4, col: 'left' },
  { row: 4, col: 'right' },
];

/** The stable label for an executive office by its index, e.g. "Executive Office 03". */
export function executiveOfficeLabel(index: number): string {
  return `Executive Office ${String(index + 1).padStart(2, '0')}`;
}

/** The offices in floor order — the identity behind "Office 01 … Office 10". */
export const OFFICE_SEQUENCE: readonly OfficeSeatId[] = SEAT_GRID.map((entry) => entry.seat);

/** The stable office number for a seat, e.g. "Office 08". Same on plan and card. */
export function officeLabel(seat: OfficeSeatId): string {
  const index = OFFICE_SEQUENCE.indexOf(seat);
  return `Office ${String(index + 1).padStart(2, '0')}`;
}

/** Money in the player's display currency, no fraction (M8-02). Takes USD minor units. */
const MONEY = { format: (minor: number): string => formatUsdMinor(minor, { fractionDigits: 0 }) };

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
  /** Which floor the pager starts on — the C-Suite page opens on the executive floor. */
  initialFloor?: 'ground' | 'executive';
  /**
   * The executive floor's state, owned by the shell (like {@link office}) so the
   * C-Suite roster and this plan never disagree. Absent (undefined) means no
   * executive floor is wired — no pager, ground floor only — which is how the bare
   * overview renders in a test.
   */
  execFloor?: ExecutiveFloorState | null;
  /** Open the executive floor (a paid unlock the shell performs). */
  onUnlockExecFloor?: () => Promise<ExpandResult>;
  /** Open the next executive office (a paid unlock the shell performs). */
  onOpenExecOffice?: () => Promise<ExpandResult>;
  /** The executive office index the parent is managing — its room stays selected. */
  selectedExecOffice?: number | null;
  /** Make the executive rooms interactive: click an office to hire into or fire from it. */
  onSelectExecOffice?: (index: number | null) => void;
}

export function HqLayoutPanel({
  office,
  onExpand,
  onSelectSeat,
  selectedSeat = null,
  hoveredSeat = null,
  onHoverSeat,
  initialFloor = 'ground',
  execFloor,
  onUnlockExecFloor,
  onOpenExecOffice,
  selectedExecOffice = null,
  onSelectExecOffice,
}: HqLayoutPanelProps): ReactNode {
  const [expanding, setExpanding] = useState(false);
  const [expandError, setExpandError] = useState<string | null>(null);

  // The executive floor is a second floor reached by the pager. Its state is owned
  // by the shell and passed in, so a hire made from the C-Suite roster and one made
  // from this plan land on the same object.
  const [floor, setFloor] = useState<'ground' | 'executive'>(initialFloor);
  const execState: ExecutiveFloorState | null = execFloor ?? null;
  const [execBusy, setExecBusy] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  // Which hire sits in which office. A hire carries its own `officeIndex` now, so
  // it appears in the office the player clicked; older hires without one fall back
  // to the lowest free office so they still show up.
  const execHireByOffice = useMemo(() => {
    const byOffice = new Map<number, ExecutiveHire>();
    const pending: ExecutiveHire[] = [];
    for (const hire of execState?.hires ?? []) {
      if (hire.officeIndex !== null && !byOffice.has(hire.officeIndex)) {
        byOffice.set(hire.officeIndex, hire);
      } else {
        pending.push(hire);
      }
    }
    let slot = 0;
    for (const hire of pending) {
      while (byOffice.has(slot)) slot += 1;
      byOffice.set(slot, hire);
      slot += 1;
    }
    return byOffice;
  }, [execState?.hires]);

  const unlockFloor = async (): Promise<void> => {
    if (onUnlockExecFloor === undefined) return;
    setExecBusy(true);
    setExecError(null);
    const result = await onUnlockExecFloor();
    if (!result.ok) setExecError(result.message ?? 'Could not open the executive floor');
    setExecBusy(false);
  };

  const unlockOffice = async (): Promise<void> => {
    if (onOpenExecOffice === undefined) return;
    setExecBusy(true);
    setExecError(null);
    const result = await onOpenExecOffice();
    if (!result.ok) setExecError(result.message ?? 'Could not open the office');
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

  // The whole staff organisation's monthly salary — ground floor and executive
  // floor together — the same total on both pages, since the panel is shared.
  const payrollMinor =
    (office?.hires ?? []).reduce((sum, hire) => sum + hire.monthlySalaryMinor, 0) +
    (execState?.hires ?? []).reduce((sum, hire) => sum + hire.monthlySalaryMinor, 0);

  return (
    <div className="hq-layout">
      {execState !== null && (
        <div className="hq-layout__pager" role="tablist" aria-label="Headquarters floor">
          <button
            type="button"
            role="tab"
            className="hq-layout__pager-btn"
            data-active={floor === 'executive'}
            aria-selected={floor === 'executive'}
            onClick={() => setFloor('executive')}
          >
            <span className="hq-layout__pager-arrow" aria-hidden="true">
              ▲
            </span>{' '}
            Executive
          </button>
          <button
            type="button"
            role="tab"
            className="hq-layout__pager-btn"
            data-active={floor === 'ground'}
            aria-selected={floor === 'ground'}
            onClick={() => setFloor('ground')}
          >
            <span className="hq-layout__pager-arrow" aria-hidden="true">
              ▼
            </span>{' '}
            Ground
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

      <p className="hq-layout__payroll">
        Staff payroll <strong>{MONEY.format(payrollMinor)}</strong>/mo
      </p>

      {floor === 'ground' && (
        <div
          className="hq-layout__floor hq-layout__floor--arrive-down"
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
          className="hq-layout__floor hq-layout__floor--exec hq-layout__floor--arrive-up"
          style={{
            backgroundImage: `url(${execFloorImage(execState.officesUnlocked)})`,
            aspectRatio: EXEC_FLOOR_ASPECT,
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
                    {MONEY.format(execState.revenueGateMinor - execState.monthlyRevenueMinor)}
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
                  : `Unlock the Executive Floor · ${MONEY.format(execState.unlockCostMinor)}`}
              </button>
              {execError !== null && (
                <p className="hq-exec-gate__error" role="alert">
                  {execError}
                </p>
              )}
            </div>
          ) : (
            <>
              {EXEC_SEAT_GRID.map((pos, index) => {
                const label = executiveOfficeLabel(index);
                const num = String(index + 1).padStart(2, '0');
                const style = {
                  left: `${String((EXEC_COLUMN_X[pos.col] ?? 0.5) * 100)}%`,
                  top: `${String((EXEC_ROW_Y[pos.row] ?? 0.5) * 100)}%`,
                };

                // Offices past the ones the airline has opened are not built yet:
                // shown locked, with a padlock, and never interactive.
                if (index >= execState.officesUnlocked) {
                  return (
                    <div
                      key={index}
                      className="hq-cell hq-cell--locked"
                      style={style}
                      title={`${label} — not built yet`}
                    >
                      <span className="hq-cell__num">{num}</span>
                      <span className="hq-cell__lock" aria-hidden="true">
                        🔒
                      </span>
                    </div>
                  );
                }

                const hire = execHireByOffice.get(index);
                const occupant =
                  hire !== undefined ? (csuiteCandidate(hire.candidateId) ?? null) : null;
                const interactive = onSelectExecOffice !== undefined;

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
                    hire !== undefined ? 'Activate to manage.' : 'Activate to hire an executive.';
                  return (
                    <button
                      key={index}
                      type="button"
                      className="hq-cell hq-cell--interactive"
                      data-occupied={hire !== undefined}
                      data-selected={selectedExecOffice === index}
                      style={style}
                      aria-label={`${label}, ${state}. ${action}`}
                      aria-pressed={selectedExecOffice === index}
                      onClick={() => onSelectExecOffice?.(index)}
                    >
                      <span className="hq-cell__num">{num}</span>
                      {inner}
                    </button>
                  );
                }

                return (
                  <div
                    key={index}
                    className="hq-cell"
                    data-occupied={hire !== undefined}
                    style={style}
                    title={hire !== undefined ? `${hire.candidateName} — ${label}` : label}
                  >
                    {inner}
                  </div>
                );
              })}

              {execState.nextOffice !== null && (
                <div className="hq-exec-next">
                  <button
                    type="button"
                    className="hq-exec-next__btn"
                    disabled={execBusy}
                    onClick={() => void unlockOffice()}
                  >
                    {execBusy
                      ? 'Opening…'
                      : `Open office ${String(execState.officesUnlocked + 1)} of ${String(EXECUTIVE_OFFICE_COUNT)} · ${MONEY.format(execState.nextOffice.costMinor)}`}
                  </button>
                  {execError !== null && (
                    <p className="hq-exec-gate__error" role="alert">
                      {execError}
                    </p>
                  )}
                </div>
              )}
            </>
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
              : `Expand · +${office.nextExpansion.addsSeats} offices for ${MONEY.format(office.nextExpansion.costMinor)}`}
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
