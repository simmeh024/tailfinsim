import { describe, expect, it } from 'vitest';

import { AdminCashMovementCause } from '@tailfin/shared';

import { RATE_CAUSES } from './runway';

/**
 * Which movements the runway turns into a burn rate (M8-08).
 *
 * `classifyCause` is a `switch` with no `default` over every `CashMovementCause`,
 * so a **new** cause fails the build until somebody classifies it. What that
 * cannot catch is somebody reclassifying an existing one, and two of those
 * decisions are load-bearing enough to state out loud rather than leave to a
 * reviewer noticing a one-line diff.
 */
describe('what counts as a burn rate', () => {
  it('leaves out the bills the commitments already project exactly', () => {
    // Counted here as well, each of these would be charged twice: once in the
    // trailing rate and once as the dated bill the projection knows is coming.
    for (const cause of [
      'crew_payroll',
      'crew_base_overhead',
      'office_salary',
      'ground_self_handling_payroll',
      'loan_interest',
    ] as const) {
      expect(RATE_CAUSES).not.toContain(cause);
    }
  });

  it('leaves out capital and financing, which are not rates at all', () => {
    /*
     * A $390M aeroplane inside a thirty-day window implies a burn of $13M a game
     * day, and would report an airline that has just bought a fleet as having
     * days to live. A drawn loan does the opposite and reports one that has just
     * borrowed as immortal.
     */
    for (const cause of [
      'aircraft_new_purchase',
      'aircraft_used_purchase',
      'aircraft_lease_deposit',
      'airline_founding',
      'admin_adjustment',
      'loan_draw',
      'office_expansion',
      'executive_floor',
      'crew_hiring',
    ] as const) {
      expect(RATE_CAUSES).not.toContain(cause);
    }
  });

  it('keeps trading, which is the only honest rate there is', () => {
    expect(RATE_CAUSES).toContain('flight_settlement');
    expect(RATE_CAUSES).toContain('maintenance_check');
  });

  it('classifies every cause the database has, and invents none', () => {
    for (const cause of RATE_CAUSES) {
      expect(AdminCashMovementCause.options).toContain(cause);
    }
  });
});
