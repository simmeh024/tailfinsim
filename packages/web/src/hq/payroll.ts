import type { OfficeSeatId, OfficeStateResponse } from '@tailfin/shared';

import type { HqCandidate } from './hq-roster';

/**
 * What the head office costs, and whether the airline can carry it (ideas #1, #2).
 *
 * The Headquarters page counted seats and priced people one at a time, and never
 * once said what the office costs a month — the number the worker actually bills.
 * Every figure here comes from `office.hires[].monthlySalaryMinor`, which is the
 * server's own billing figure, so the total on the page is the total on the
 * ledger rather than a client-side re-derivation from the candidate catalogue.
 *
 * ## Affordability is a reading, not a rule
 *
 * Nothing in this file gates anything. The server decides whether a hire is
 * allowed and the worker decides what it costs; `payrollRunway` only divides two
 * numbers the client already holds so a card can say "this is more than a month
 * of your cash" before the player finds out the slow way. The bands are a
 * presentation choice about when to warn, and are deliberately not economy
 * numbers — no balance literal lives here, because none of this reaches the
 * simulation.
 */

/** The office's total monthly salary bill, in USD minor units. */
export function monthlyPayrollMinor(office: OfficeStateResponse | null): number {
  return (office?.hires ?? []).reduce((total, hire) => total + hire.monthlySalaryMinor, 0);
}

/**
 * What the bill becomes if `candidate` is put in `seat`.
 *
 * A seat holds one person, so hiring into an occupied seat is a *replacement*:
 * the incumbent's salary comes off in the same move. Getting that wrong would
 * show a player swapping a Senior Manager for a Supervisor an increase.
 */
export function payrollAfterHire(
  office: OfficeStateResponse | null,
  seat: OfficeSeatId,
  candidate: HqCandidate,
): number {
  const outgoing = (office?.hires ?? []).find((hire) => hire.seat === seat);
  return (
    monthlyPayrollMinor(office) -
    (outgoing?.monthlySalaryMinor ?? 0) +
    candidate.salaryPerMonthMinor
  );
}

/**
 * How many months of that payroll the airline's cash covers, or null when the
 * cash is not known (the page rendered without a shell) or the office is free.
 *
 * Infinity is not returned for a zero bill: "no payroll" is not a runway, and a
 * caller that displayed it would be answering a question nobody asked.
 */
export function payrollRunway(cashMinor: number | null, payrollMinor: number): number | null {
  if (cashMinor === null || payrollMinor <= 0) return null;
  return cashMinor / payrollMinor;
}

/** How hard a hire would press on the airline's cash. */
export type PayrollStrain = 'unaffordable' | 'tight' | 'comfortable';

/**
 * The band a runway falls in.
 *
 * Under one month the airline cannot cover the next bill at all; under three it
 * can, but not for long. Both are presentation thresholds — see the note above —
 * and the page only ever uses them to add a sentence, never to disable a control.
 */
export function payrollStrain(runwayMonths: number | null): PayrollStrain | null {
  if (runwayMonths === null) return null;
  if (runwayMonths < 1) return 'unaffordable';
  if (runwayMonths < 3) return 'tight';
  return 'comfortable';
}
