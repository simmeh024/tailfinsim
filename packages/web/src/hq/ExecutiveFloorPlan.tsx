import { EXECUTIVE_OFFICE_COUNT, type ExecutiveFloorState } from '@tailfin/shared';

import { EXEC_FLOOR_ASPECT, execFloorImage } from './exec-floorplan';

import type { ReactNode } from 'react';

/**
 * The executive floor, rendered **directly on the C-Suite page** rather than in
 * the shell's context panel.
 *
 * The same floor plan and unlock affordances the Headquarters panel's floor pager
 * shows, but as a presentational component the C-Suite page drives: it owns the
 * `ExecutiveFloorState` (it already fetches it for the roster), so this only draws
 * the current render and reports the two actions — open the floor, open the next
 * office — back up. That is what lets the page stand on its own with no context
 * window beside it.
 */

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

interface ExecutiveFloorPlanProps {
  execState: ExecutiveFloorState;
  busy: boolean;
  error: string | null;
  onUnlockFloor: () => void;
  onOpenOffice: () => void;
}

export function ExecutiveFloorPlan({
  execState,
  busy,
  error,
  onUnlockFloor,
  onOpenOffice,
}: ExecutiveFloorPlanProps): ReactNode {
  const meetsRevenue = execState.monthlyRevenueMinor >= execState.revenueGateMinor;

  return (
    <div className="hq-layout hq-layout--embedded">
      <p className="hq-layout__count">
        <strong>{execState.officesUnlocked}</strong> of {EXECUTIVE_OFFICE_COUNT} executive offices
        open
      </p>

      <div
        className="hq-layout__floor hq-layout__floor--exec"
        style={{
          backgroundImage: `url(${execFloorImage(execState.officesUnlocked)})`,
          aspectRatio: EXEC_FLOOR_ASPECT,
        }}
      >
        {!execState.unlocked ? (
          <div className="hq-exec-gate">
            <p className="hq-exec-gate__title">Executive Floor</p>
            {meetsRevenue ? (
              <p className="hq-exec-gate__ok">Requirements met — the floor is yours to open.</p>
            ) : (
              <p className="hq-exec-gate__need">
                You do not meet the requirements yet — need{' '}
                <strong>
                  {MONEY.format((execState.revenueGateMinor - execState.monthlyRevenueMinor) / 100)}
                </strong>{' '}
                more income a month.
              </p>
            )}
            <button
              type="button"
              className="hq-exec-gate__unlock"
              disabled={busy || !meetsRevenue}
              onClick={onUnlockFloor}
            >
              {busy
                ? 'Opening…'
                : `Unlock the Executive Floor · ${MONEY.format(execState.unlockCostMinor / 100)}`}
            </button>
            {error !== null && (
              <p className="hq-exec-gate__error" role="alert">
                {error}
              </p>
            )}
          </div>
        ) : (
          execState.nextOffice !== null && (
            <div className="hq-exec-next">
              <button
                type="button"
                className="hq-exec-next__btn"
                disabled={busy}
                onClick={onOpenOffice}
              >
                {busy
                  ? 'Opening…'
                  : `Open office ${String(execState.officesUnlocked + 1)} of ${String(EXECUTIVE_OFFICE_COUNT)} · ${MONEY.format(execState.nextOffice.costMinor / 100)}`}
              </button>
              {error !== null && (
                <p className="hq-exec-gate__error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
