import { describe, expect, it } from 'vitest';

import type { OfficeStateResponse } from '@tailfin/shared';

import { boostStrength, candidatesForRole, type HqCandidate } from './hq-roster';
import { monthlyPayrollMinor, payrollAfterHire, payrollRunway, payrollStrain } from './payroll';

/**
 * What the office costs, and how the four candidates for a seat compare.
 *
 * Both were derivable from data the page already held and neither was on it: the
 * monthly bill was never summed, and a boost was a badge with no scale beside it.
 */

function officeWith(
  hires: { seat: string; candidateId: string; monthlySalaryMinor: number }[],
): OfficeStateResponse {
  return {
    hires: hires.map((hire) => ({
      seat: hire.seat,
      candidateId: hire.candidateId,
      candidateName: hire.candidateId,
      monthlySalaryMinor: hire.monthlySalaryMinor,
      hiredAt: '2026-01-01T00:00:00.000Z',
    })),
    hasExtendedAuthority: false,
    neutralSeats: 0,
    nextExpansion: null,
    offeredSpecialist: 'social-media-reputation',
  } as OfficeStateResponse;
}

describe('the head office payroll', () => {
  it('sums what the server says it is billing, not what the catalogue asks', () => {
    const office = officeWith([
      { seat: 'route-planner', candidateId: 'a', monthlySalaryMinor: 1_200_000 },
      { seat: 'chief-pilot', candidateId: 'b', monthlySalaryMinor: 800_000 },
    ]);
    expect(monthlyPayrollMinor(office)).toBe(2_000_000);
  });

  it('is zero for an office nobody has been hired into, and for no office at all', () => {
    expect(monthlyPayrollMinor(officeWith([]))).toBe(0);
    expect(monthlyPayrollMinor(null)).toBe(0);
  });

  it('nets the incumbent off when the hire replaces someone', () => {
    const office = officeWith([
      { seat: 'route-planner', candidateId: 'expensive', monthlySalaryMinor: 1_500_000 },
    ]);
    const cheaper = candidatesForRole('route-planner').reduce((low, candidate) =>
      candidate.salaryPerMonthMinor < low.salaryPerMonthMinor ? candidate : low,
    );
    // A seat holds one person, so this is a swap: the bill moves to the newcomer's
    // salary rather than carrying both.
    expect(payrollAfterHire(office, 'route-planner', cheaper)).toBe(cheaper.salaryPerMonthMinor);
    expect(payrollAfterHire(office, 'route-planner', cheaper)).toBeLessThan(
      monthlyPayrollMinor(office),
    );
  });

  it('adds the whole salary when the seat was empty', () => {
    const office = officeWith([
      { seat: 'route-planner', candidateId: 'a', monthlySalaryMinor: 1_000_000 },
    ]);
    const candidate = candidatesForRole('chief-pilot')[0]!;
    expect(payrollAfterHire(office, 'chief-pilot', candidate)).toBe(
      1_000_000 + candidate.salaryPerMonthMinor,
    );
  });
});

describe('the affordability reading', () => {
  it('has nothing to say without cash, and nothing to say about a free office', () => {
    expect(payrollRunway(null, 1_000_000)).toBeNull();
    expect(payrollRunway(50_000_000, 0)).toBeNull();
    expect(payrollStrain(null)).toBeNull();
  });

  it('calls a bill the cash cannot cover unaffordable', () => {
    expect(payrollStrain(payrollRunway(900_000, 1_000_000))).toBe('unaffordable');
  });

  it('calls a bill with under three months behind it tight, and more than that comfortable', () => {
    expect(payrollStrain(payrollRunway(2_500_000, 1_000_000))).toBe('tight');
    expect(payrollStrain(payrollRunway(9_000_000, 1_000_000))).toBe('comfortable');
  });
});

describe('the boost comparison', () => {
  const shortlist = candidatesForRole('route-planner').slice(0, 4);

  it('gives the strongest of the group a full bar', () => {
    const strongest = shortlist.reduce((best, candidate) =>
      Math.abs(candidate.boost.magnitude) > Math.abs(best.boost.magnitude) ? candidate : best,
    );
    expect(boostStrength(strongest, shortlist)).toBe(1);
  });

  it('scales the rest against it, never above it', () => {
    for (const candidate of shortlist) {
      const strength = boostStrength(candidate, shortlist);
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    }
  });

  it('measures distance from zero, so a cost cut compares like a revenue lift', () => {
    // Every candidate for one seat shares a lever, and a lever whose good
    // direction is down carries a negative magnitude. Sign must not decide the bar.
    const negated: HqCandidate[] = shortlist.map((candidate) => ({
      ...candidate,
      boost: { ...candidate.boost, magnitude: -candidate.boost.magnitude },
    }));
    for (const [index, candidate] of negated.entries()) {
      expect(boostStrength(candidate, negated)).toBe(boostStrength(shortlist[index]!, shortlist));
    }
  });

  it('is zero for a group with no boost at all rather than dividing by it', () => {
    const flat: HqCandidate[] = shortlist.map((candidate) => ({
      ...candidate,
      boost: { ...candidate.boost, magnitude: 0 },
    }));
    expect(boostStrength(flat[0]!, flat)).toBe(0);
  });
});
