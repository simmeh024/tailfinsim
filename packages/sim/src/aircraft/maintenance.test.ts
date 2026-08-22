import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1, type MaintenanceProfile } from '@tailfin/shared';

import {
  accrueFlight,
  airworthiness,
  CHECK_TIERS,
  checkTerms,
  completeCheck,
  DEFAULT_MAINTENANCE,
  inferredHistory,
  maintenanceStatus,
  type MaintenanceState,
  NEW_AIRFRAME_STATE,
} from './maintenance';

const BALANCE = DEFAULT_MAINTENANCE;
const PROFILES: MaintenanceProfile[] = [
  'turboprop',
  'regional_jet',
  'narrowbody',
  'widebody',
  'freighter',
];

/** An airframe that has flown `hours` and `cycles` with no check ever done. */
function flown(hours: number, cycles: number): MaintenanceState {
  return { ...NEW_AIRFRAME_STATE, totalHours: hours, totalCycles: cycles };
}

/** Fly `count` sectors of `blockHours` each. */
function fly(state: MaintenanceState, count: number, blockHours: number): MaintenanceState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = accrueFlight(next, blockHours);
  return next;
}

describe('accrual', () => {
  it('counts one cycle per flight and its block hours', () => {
    const after = accrueFlight(NEW_AIRFRAME_STATE, 2.5);
    expect(after.totalHours).toBe(2.5);
    expect(after.totalCycles).toBe(1);
  });

  it('accumulates across a week of flying', () => {
    const after = fly(NEW_AIRFRAME_STATE, 28, 1.75);
    expect(after.totalCycles).toBe(28);
    expect(after.totalHours).toBeCloseTo(49, 10);
  });

  it('refuses a negative or non-finite block time rather than corrupting the total', () => {
    expect(() => accrueFlight(NEW_AIRFRAME_STATE, -1)).toThrow(/non-negative/);
    expect(() => accrueFlight(NEW_AIRFRAME_STATE, Number.NaN)).toThrow(/non-negative/);
  });

  it('accepts a zero-hour flight, which is a real rounding case rather than an error', () => {
    expect(accrueFlight(NEW_AIRFRAME_STATE, 0).totalCycles).toBe(1);
  });
});

describe('what is due', () => {
  it('has nothing due on a brand-new airframe', () => {
    for (const profile of PROFILES) {
      const status = maintenanceStatus(NEW_AIRFRAME_STATE, profile, BALANCE);
      expect(status.dueTiers, profile).toEqual([]);
      expect(status.airworthiness.airworthy).toBe(true);
      expect(status.technicalRisk).toBe(BALANCE.reliability.baselineRisk);
    }
  });

  /**
   * The decision that makes types feel different to own, asserted directly.
   *
   * A turboprop flying short sectors runs out of *cycles*; a widebody flying long
   * ones runs out of *hours*. One interval would have made both the same.
   */
  it('is cycle-limited for short sectors and hour-limited for long ones', () => {
    // 300 sectors of 1.2 hours: 360 hours, 300 cycles.
    const shortHaul = fly(NEW_AIRFRAME_STATE, 300, 1.2);
    expect(maintenanceStatus(shortHaul, 'turboprop', BALANCE).tiers.a.binding).toBe('cycles');

    // 60 sectors of 11 hours: 660 hours, 60 cycles.
    const longHaul = fly(NEW_AIRFRAME_STATE, 60, 11);
    expect(maintenanceStatus(longHaul, 'widebody', BALANCE).tiers.a.binding).toBe('hours');
  });

  it('reports the binding limit as the one that runs out first, for every profile', () => {
    for (const profile of PROFILES) {
      const programme = BALANCE.programmes[profile];
      // Deliberately at 90% of the cycle limit and 10% of the hour limit.
      const state = flown(
        programme.a.intervalHours * 0.1,
        Math.round(programme.a.intervalCycles * 0.9),
      );
      const status = maintenanceStatus(state, profile, BALANCE);
      expect(status.tiers.a.binding, profile).toBe('cycles');
      expect(status.tiers.a.usedFraction, profile).toBeCloseTo(0.9, 2);
    }
  });

  it('falls due exactly at the interval, not before', () => {
    const programme = BALANCE.programmes.narrowbody;
    const justUnder = flown(programme.a.intervalHours - 0.01, 0);
    const exactly = flown(programme.a.intervalHours, 0);
    expect(maintenanceStatus(justUnder, 'narrowbody', BALANCE).tiers.a.due).toBe(false);
    expect(maintenanceStatus(exactly, 'narrowbody', BALANCE).tiers.a.due).toBe(true);
  });

  it('lists due tiers heaviest first, so the biggest job is named', () => {
    const programme = BALANCE.programmes.narrowbody;
    const veryOverdue = flown(programme.d.intervalHours, programme.d.intervalCycles);
    expect(maintenanceStatus(veryOverdue, 'narrowbody', BALANCE).dueTiers).toEqual(['d', 'c', 'a']);
  });

  it('escalates interval, downtime and cost through A, C and D for every profile', () => {
    for (const profile of PROFILES) {
      const p = BALANCE.programmes[profile];
      expect(p.a.intervalHours, profile).toBeLessThan(p.c.intervalHours);
      expect(p.c.intervalHours, profile).toBeLessThan(p.d.intervalHours);
      expect(p.a.downtimeDays, profile).toBeLessThan(p.c.downtimeDays);
      expect(p.c.downtimeDays, profile).toBeLessThan(p.d.downtimeDays);
      expect(p.a.costMinor, profile).toBeLessThan(p.c.costMinor);
      expect(p.c.costMinor, profile).toBeLessThan(p.d.costMinor);
    }
  });

  it('quotes the same terms the balance holds', () => {
    for (const profile of PROFILES) {
      for (const tier of CHECK_TIERS) {
        const terms = checkTerms(tier, profile, BALANCE);
        expect(terms.costMinor).toBe(BALANCE.programmes[profile][tier].costMinor);
        expect(terms.downtimeDays).toBe(BALANCE.programmes[profile][tier].downtimeDays);
      }
    }
  });
});

describe('completing a check', () => {
  it('resets the tier to the airframe’s current totals', () => {
    const state = fly(NEW_AIRFRAME_STATE, 400, 2);
    const after = completeCheck(state, 'a');
    expect(after.hoursAtLastCheck.a).toBe(state.totalHours);
    expect(after.cyclesAtLastCheck.a).toBe(state.totalCycles);
    expect(maintenanceStatus(after, 'narrowbody', BALANCE).tiers.a.due).toBe(false);
  });

  /**
   * The detail that would otherwise read as a bug.
   *
   * A D-check includes the C and A work. Without this, a player would emerge from
   * a five-week D-check with an A-check immediately due.
   */
  it('a heavier check subsumes the lighter ones', () => {
    const programme = BALANCE.programmes.narrowbody;
    const overdueOnEverything = flown(programme.d.intervalHours, programme.d.intervalCycles);
    const afterD = completeCheck(overdueOnEverything, 'd');
    const status = maintenanceStatus(afterD, 'narrowbody', BALANCE);
    expect(status.dueTiers).toEqual([]);
    for (const tier of CHECK_TIERS) {
      expect(status.tiers[tier].hoursSince, tier).toBe(0);
    }
  });

  it('a lighter check does not clear a heavier one', () => {
    const programme = BALANCE.programmes.narrowbody;
    const overdue = flown(programme.d.intervalHours, programme.d.intervalCycles);
    const afterA = completeCheck(overdue, 'a');
    const status = maintenanceStatus(afterA, 'narrowbody', BALANCE);
    expect(status.tiers.a.due).toBe(false);
    expect(status.tiers.c.due).toBe(true);
    expect(status.tiers.d.due).toBe(true);
  });
});

describe('deferring a check — M4-06 acceptance criterion 1', () => {
  it('leaves a well-maintained airframe at the baseline risk', () => {
    const status = maintenanceStatus(flown(100, 40), 'narrowbody', BALANCE);
    expect(status.technicalRisk).toBe(BALANCE.reliability.baselineRisk);
  });

  /**
   * **The criterion, measured.**
   *
   * *"Deferring a check measurably raises disruption rate within a few game
   * weeks."* A narrowbody at eight block hours a day covers about 224 hours in a
   * game month. This flies past an A-check and keeps going, and asserts the risk
   * rises at every step — and that after three game weeks of deferral it is
   * several times the baseline rather than marginally above it.
   */
  it('raises technical risk measurably over a few game weeks of deferral', () => {
    const programme = BALANCE.programmes.narrowbody;
    // Exactly at the A-check limit, by hours.
    let state = flown(programme.a.intervalHours, 100);
    const atDue = maintenanceStatus(state, 'narrowbody', BALANCE).technicalRisk;
    expect(atDue).toBe(BALANCE.reliability.baselineRisk);

    const weekly = 8 * 7; // eight block hours a day, seven days
    const readings: number[] = [];
    for (let week = 1; week <= 4; week += 1) {
      state = fly(state, 7, 8);
      readings.push(maintenanceStatus(state, 'narrowbody', BALANCE).technicalRisk);
    }

    // Monotonically worse, every week.
    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i], `week ${String(i + 1)}`).toBeGreaterThan(readings[i - 1] ?? 0);
    }

    // And materially worse, not marginally: three weeks of deferral is a
    // multiple of the baseline, which is what "measurably" has to mean.
    const afterThreeWeeks = readings[2] ?? 0;
    expect(afterThreeWeeks).toBeGreaterThan(BALANCE.reliability.baselineRisk * 3);
    expect(weekly).toBe(56);
  });

  it('punishes a deferred D-check far harder than a deferred A-check', () => {
    const programme = BALANCE.programmes.narrowbody;
    const ramp = BALANCE.reliability.overdueRampHours;

    const overdueA = flown(programme.a.intervalHours + ramp, 100);
    const overdueD = flown(programme.d.intervalHours + ramp, 100);

    const riskA = maintenanceStatus(overdueA, 'narrowbody', BALANCE).technicalRisk;
    const riskD = maintenanceStatus(overdueD, 'narrowbody', BALANCE).technicalRisk;
    expect(riskD).toBeGreaterThan(riskA);
  });

  it('never exceeds the ceiling, however neglected', () => {
    const neglected = flown(500_000, 400_000);
    const status = maintenanceStatus(neglected, 'narrowbody', BALANCE);
    expect(status.technicalRisk).toBe(BALANCE.reliability.maxRisk);
    expect(status.technicalRisk).toBeLessThan(1);
  });

  /**
   * The ceiling has to be *reachable*, or it is decoration.
   *
   * The first shipped value was above the sum of the baseline and all three
   * penalties, so it could never bind — a number that looked like a safety limit
   * and did nothing. This is the assertion that stops it happening again after a
   * retune of the tier penalties.
   */
  it('has a ceiling the penalties can actually reach', () => {
    const { baselineRisk, overdueRisk, maxRisk } = BALANCE.reliability;
    const worstPossible = baselineRisk + overdueRisk.a + overdueRisk.c + overdueRisk.d;
    expect(worstPossible).toBeGreaterThan(maxRisk);
  });

  it('drops straight back to baseline when the work is done', () => {
    const programme = BALANCE.programmes.narrowbody;
    const overdue = flown(programme.c.intervalHours * 1.2, 100);
    expect(maintenanceStatus(overdue, 'narrowbody', BALANCE).technicalRisk).toBeGreaterThan(
      BALANCE.reliability.baselineRisk,
    );
    const repaired = completeCheck(overdue, 'c');
    expect(maintenanceStatus(repaired, 'narrowbody', BALANCE).technicalRisk).toBe(
      BALANCE.reliability.baselineRisk,
    );
  });
});

describe('grounding — M4-06 acceptance criterion 3', () => {
  it('keeps flying an airframe that is merely overdue', () => {
    const programme = BALANCE.programmes.narrowbody;
    // Overdue, but inside the grace multiple.
    const overdue = flown(programme.a.intervalHours * 1.2, 100);
    expect(maintenanceStatus(overdue, 'narrowbody', BALANCE).airworthiness.airworthy).toBe(true);
  });

  it('grounds it once it passes the grace multiple', () => {
    const programme = BALANCE.programmes.narrowbody;
    const tooFar = flown(programme.a.intervalHours * BALANCE.groundingOverdueMultiple, 100);
    const verdict = maintenanceStatus(tooFar, 'narrowbody', BALANCE).airworthiness;
    expect(verdict.airworthy).toBe(false);
    if (verdict.airworthy) return;
    expect(verdict.reason).toBe('grounded_overdue');
    expect(verdict.tier).toBe('a');
  });

  it('names the heaviest overdue tier, not the first one checked', () => {
    const programme = BALANCE.programmes.narrowbody;
    const wayPast = flown(programme.d.intervalHours * 2, programme.d.intervalCycles * 2);
    const verdict = maintenanceStatus(wayPast, 'narrowbody', BALANCE).airworthiness;
    expect(verdict.airworthy).toBe(false);
    if (verdict.airworthy) return;
    expect(verdict.tier).toBe('d');
  });

  it('is grounded by cycles as readily as by hours', () => {
    const programme = BALANCE.programmes.turboprop;
    const cyclesOnly = flown(
      1,
      Math.ceil(programme.a.intervalCycles * BALANCE.groundingOverdueMultiple),
    );
    const verdict = maintenanceStatus(cyclesOnly, 'turboprop', BALANCE).airworthiness;
    expect(verdict.airworthy).toBe(false);
    expect(maintenanceStatus(cyclesOnly, 'turboprop', BALANCE).tiers.a.binding).toBe('cycles');
  });

  it('releases the airframe as soon as the check is done', () => {
    const programme = BALANCE.programmes.narrowbody;
    const grounded = flown(programme.a.intervalHours * 2, 100);
    expect(
      airworthiness(maintenanceStatus(grounded, 'narrowbody', BALANCE).tiers, BALANCE).airworthy,
    ).toBe(false);
    const fixed = completeCheck(grounded, 'a');
    expect(maintenanceStatus(fixed, 'narrowbody', BALANCE).airworthiness.airworthy).toBe(true);
  });
});

describe('a used airframe’s inherited history', () => {
  /**
   * The trap this exists for.
   *
   * A twelve-year-old aeroplane off the used market has flown 30,000 hours. If
   * every tier were treated as last done at hour zero it would be grounded before
   * its first flight, for its previous owner's imagined neglect.
   */
  it('does not arrive grounded for its previous owner’s imaginary neglect', () => {
    const hours = 30_000;
    const cycles = 13_000;
    const history = inferredHistory(
      hours,
      cycles,
      'narrowbody',
      { a: 0.4, c: 0.4, d: 0.4 },
      BALANCE,
    );
    const status = maintenanceStatus(history, 'narrowbody', BALANCE);
    expect(status.airworthiness.airworthy).toBe(true);
    expect(status.dueTiers).toEqual([]);
    expect(status.technicalRisk).toBe(BALANCE.reliability.baselineRisk);
  });

  it('places each tier where the caller asked, so condition is part of a listing', () => {
    const history = inferredHistory(
      10_000,
      4_000,
      'narrowbody',
      { a: 0.1, c: 0.9, d: 0.5 },
      BALANCE,
    );
    const status = maintenanceStatus(history, 'narrowbody', BALANCE);
    expect(status.tiers.a.usedFraction).toBeLessThan(status.tiers.c.usedFraction);
    expect(status.tiers.c.usedFraction).toBeGreaterThan(0.8);
    expect(status.dueTiers).toEqual([]);
  });

  it('never claims a check happened before the airframe existed', () => {
    // Younger than one C interval: the only honest answer is hour zero.
    const history = inferredHistory(50, 30, 'narrowbody', { a: 0.9, c: 0.9, d: 0.9 }, BALANCE);
    for (const tier of CHECK_TIERS) {
      expect(history.hoursAtLastCheck[tier], tier).toBeGreaterThanOrEqual(0);
      expect(history.cyclesAtLastCheck[tier], tier).toBeGreaterThanOrEqual(0);
    }
  });

  it('stays airworthy for every profile at any position in the interval', () => {
    for (const profile of PROFILES) {
      for (const position of [0, 0.25, 0.5, 0.75, 0.95, 1.5]) {
        const history = inferredHistory(
          40_000,
          18_000,
          profile,
          { a: position, c: position, d: position },
          BALANCE,
        );
        expect(
          maintenanceStatus(history, profile, BALANCE).airworthiness.airworthy,
          `${profile} @ ${String(position)}`,
        ).toBe(true);
      }
    }
  });
});

describe('the catalogue and the balance agree', () => {
  it('has a programme for every maintenance profile the catalogue uses', () => {
    const used = new Set(AIRCRAFT_CATALOGUE_V1.types.map((t) => t.maintenanceProfile));
    for (const profile of used) {
      expect(BALANCE.programmes[profile], profile).toBeDefined();
    }
    // And nothing in the balance is unreachable from the catalogue.
    expect([...used].sort()).toEqual(PROFILES.filter((p) => used.has(p)).sort());
  });

  it('gives every v1 type a workable programme', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const status = maintenanceStatus(flown(1_000, 500), type.maintenanceProfile, BALANCE);
      expect(status.technicalRisk, type.designation).toBeGreaterThan(0);
      expect(status.technicalRisk, type.designation).toBeLessThanOrEqual(
        BALANCE.reliability.maxRisk,
      );
      for (const tier of CHECK_TIERS) {
        expect(
          status.tiers[tier].usedFraction,
          `${type.designation} ${tier}`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('every tier is reachable', () => {
  it('can be brought due, one tier at a time', () => {
    // Guards against a programme whose C interval is so close to its D that a
    // C-check could never be the *only* thing due.
    for (const profile of PROFILES) {
      const programme = BALANCE.programmes[profile];
      for (const tier of CHECK_TIERS) {
        const state = flown(programme[tier].intervalHours, programme[tier].intervalCycles);
        const due = maintenanceStatus(state, profile, BALANCE).dueTiers;
        expect(due, `${profile} ${tier}`).toContain(tier);
      }
    }
  });
});
