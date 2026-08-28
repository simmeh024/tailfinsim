import { useCallback, useState } from 'react';
import { useOutletContext } from 'react-router';

import { dismissExecutive, hireExecutive } from './api';
import { CSUITE_CANDIDATES, type CSuiteCandidate } from './csuite-roster';
import { rosterDayIndex, rotatingExecutiveRoster } from './csuite-rotation';
import { executiveOfficeLabel } from './HqLayoutPanel';
import { StaffExecDrawer } from './StaffExecDrawer';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { ReactNode } from 'react';

/**
 * The executive floor's staffing drawer, driven by the shell.
 *
 * The executive floor plan lives in the shell's context panel and is shown on both
 * the Headquarters and the C-Suite pages, so its drawer must open on either. This
 * component is that drawer: it reads the shell-owned floor and the selected office
 * through the outlet context, and hires or lets go straight from the plan — the
 * same hire the roster would make, landing on the same shared state. Both pages
 * render it; on its own (no shell) it renders nothing, because there is no plan to
 * open it.
 */
export function ExecutiveStaffDrawer(): ReactNode {
  const shell = useOutletContext<OwnAirlineShellContext | null>();
  const [busy, setBusy] = useState(false);

  const floor = shell?.execFloor ?? null;
  const selected = shell?.selectedExecOffice ?? null;
  const close = useCallback(() => shell?.selectExecOffice(null), [shell]);

  const run = useCallback(
    async (perform: () => ReturnType<typeof hireExecutive>): Promise<void> => {
      if (shell === null) return;
      setBusy(true);
      const outcome = await perform();
      setBusy(false);
      if (outcome.ok) {
        shell.replaceExecFloor(outcome.state);
        shell.selectExecOffice(null);
      }
    },
    [shell],
  );

  if (shell === null || floor === null || selected === null) return null;

  const occupant = floor.hires[selected] ?? null;
  const hiredIds = new Set(floor.hires.map((hire) => hire.candidateId));
  const candidates: CSuiteCandidate[] = rotatingExecutiveRoster(
    CSUITE_CANDIDATES,
    rosterDayIndex(),
  ).filter((candidate) => !hiredIds.has(candidate.id));

  return (
    <StaffExecDrawer
      officeName={executiveOfficeLabel(selected)}
      occupant={
        occupant !== null
          ? { candidateId: occupant.candidateId, candidateName: occupant.candidateName }
          : null
      }
      candidates={candidates}
      busy={busy}
      onHire={(candidate) => void run(() => hireExecutive(candidate.id))}
      onRemove={() => {
        if (occupant !== null) void run(() => dismissExecutive(occupant.candidateId));
      }}
      onClose={close}
    />
  );
}
