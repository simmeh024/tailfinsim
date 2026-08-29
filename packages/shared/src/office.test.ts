import { describe, expect, it } from 'vitest';

import { EXECUTIVE_BOOST_LEVERS } from './executive';
import {
  OFFICE_CANDIDATES,
  OFFICE_ROLES,
  officeCandidate,
  SOCIAL_MEDIA_SPECIALISTS,
  type OfficeRole,
} from './office';

/**
 * The candidate market (§9.1, M5-04 follow-up — tier sets the pay).
 *
 * This catalogue is what the server bills from, so its integrity is a money
 * question: an id that resolves to the wrong salary is a mispriced hire, and a
 * duplicate id is an ambiguous one. The tier-varies check is the whole point of
 * the change — a Director must not cost the same as an Analyst.
 */
describe('the office candidate market', () => {
  it('has unique ids and positive salaries, and names a real role', () => {
    const ids = OFFICE_CANDIDATES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);

    const roles = new Set<OfficeRole>(Object.keys(OFFICE_ROLES) as OfficeRole[]);
    for (const candidate of OFFICE_CANDIDATES) {
      expect(candidate.monthlySalaryMinor, candidate.id).toBeGreaterThan(0);
      expect(Number.isInteger(candidate.monthlySalaryMinor), candidate.id).toBe(true);
      expect(roles.has(candidate.role), candidate.id).toBe(true);
    }
  });

  it('fields at least four candidates for each of the six seats, so the market can show four', () => {
    for (const role of Object.keys(OFFICE_ROLES) as OfficeRole[]) {
      if (role === 'social-media') continue;
      const forRole = OFFICE_CANDIDATES.filter((candidate) => candidate.role === role);
      expect(forRole.length, role).toBeGreaterThanOrEqual(4);
    }
  });

  it('gives every candidate a tiny, salary-scaled boost on a known lever', () => {
    for (const candidate of OFFICE_CANDIDATES) {
      const { lever, magnitude, label, description } = candidate.boost;
      expect(Object.keys(EXECUTIVE_BOOST_LEVERS), candidate.id).toContain(lever);
      expect(label.length, candidate.id).toBeGreaterThan(0);
      expect(description.length, candidate.id).toBeGreaterThan(0);
      // Tiny: never more than ~1.5% of edge either way.
      expect(Math.abs(magnitude), candidate.id).toBeGreaterThan(0);
      expect(Math.abs(magnitude), candidate.id).toBeLessThanOrEqual(0.015);
      // A cost/duration lever helps by going down; everything else by going up.
      const meta = EXECUTIVE_BOOST_LEVERS[lever];
      expect(meta.lowerIsBetter ? magnitude < 0 : magnitude > 0, candidate.id).toBe(true);
    }
  });

  it('scales the boost with the salary — a dearer hire brings a bigger edge', () => {
    const planners = OFFICE_CANDIDATES.filter((c) => c.role === 'route-planner');
    const cheapest = planners.reduce((a, b) =>
      a.monthlySalaryMinor < b.monthlySalaryMinor ? a : b,
    );
    const dearest = planners.reduce((a, b) =>
      a.monthlySalaryMinor > b.monthlySalaryMinor ? a : b,
    );
    expect(Math.abs(dearest.boost.magnitude)).toBeGreaterThan(Math.abs(cheapest.boost.magnitude));
  });

  it('carries exactly the two social media specialists, by their shared ids', () => {
    const specialists = OFFICE_CANDIDATES.filter((candidate) => candidate.role === 'social-media');
    expect(specialists.map((candidate) => candidate.id).sort()).toEqual(
      SOCIAL_MEDIA_SPECIALISTS.map((specialist) => specialist.id).sort(),
    );
  });

  it('lets tier set the pay — a seat’s candidates do not all cost the same', () => {
    // Route Planner is the worked example from the bug report: Analyst, Manager
    // and Director must be three different numbers, not one repeated.
    const routePlanners = OFFICE_CANDIDATES.filter(
      (candidate) => candidate.role === 'route-planner',
    );
    const salaries = new Set(routePlanners.map((candidate) => candidate.monthlySalaryMinor));
    expect(salaries.size).toBe(routePlanners.length);
  });

  it('resolves a candidate by id, and only a real one', () => {
    expect(officeCandidate('route-planner-tom')?.monthlySalaryMinor).toBe(1_200_000);
    expect(officeCandidate('route-planner-victor')?.monthlySalaryMinor).toBe(2_600_000);
    expect(officeCandidate('nobody')).toBeUndefined();
  });
});
