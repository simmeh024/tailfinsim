import { describe, expect, it } from 'vitest';

import {
  checkDueAlert,
  competitorAlerts,
  contractExpiryAlert,
  crewShortfallAlerts,
  dscrAlert,
  evaluateAlerts,
  reconcileAlerts,
  routeLossAlert,
  spillAlert,
  type AirlineAlertState,
  type AlertRouteState,
  type AlertThresholds,
} from './rules';

/**
 * The thresholds the server ships, restated here so the tests read as
 * arithmetic. Nothing in the rules reads a constant of its own, which is why
 * this literal is allowed to exist in a test rather than in the module.
 */
const THRESHOLDS: AlertThresholds = {
  routeLossWindowDays: 7,
  routeLossMinDays: 3,
  runwayCriticalDays: 30,
  dscrHeadroom: 0.2,
  crewShortfallDays: 5,
  checkDueWarnFraction: 0.9,
  contractExpiryDays: 30,
  contractExpiryCriticalDays: 7,
  competitorLookbackDays: 14,
  spillRateCeiling: 0.15,
  spillMinFlights: 5,
};

function route(overrides: Partial<AlertRouteState> = {}): AlertRouteState {
  return {
    routeId: 'route-1',
    label: 'EGLL–KJFK',
    days: [],
    flights: 0,
    carried: 0,
    spilled: 0,
    newRivals: [],
    ...overrides,
  };
}

function airline(overrides: Partial<AirlineAlertState> = {}): AirlineAlertState {
  return {
    airlineId: 'airline-1',
    airlineLabel: 'Test Air',
    runwayDays: null,
    dscr: null,
    dscrMinimum: 1.25,
    routes: [],
    crew: [],
    checks: [],
    contracts: [],
    ...overrides,
  };
}

function losingDays(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    day: `2026-03-${String(index + 1).padStart(2, '0')}`,
    contributionMinor: -100_000,
  }));
}

describe('a route losing money', () => {
  it('fires when every day it flew in the window lost money', () => {
    const alert = routeLossAlert(route({ days: losingDays(4) }), THRESHOLDS);
    expect(alert).toMatchObject({ kind: 'route_loss_making', severity: 'critical' });
    expect(alert?.detail).toContain('4 day(s)');
  });

  /**
   * The rule the obvious implementation gets wrong.
   *
   * A thrice-weekly route can never produce seven consecutive negative days, so
   * a consecutive-day test would exempt exactly the thin routes §14.4 exists to
   * find. Three flown days, all losing, is a losing week.
   */
  it('fires on a route that does not fly every day', () => {
    expect(routeLossAlert(route({ days: losingDays(3) }), THRESHOLDS)).not.toBeNull();
  });

  it('stays quiet on a route with too little history to be a trend', () => {
    expect(routeLossAlert(route({ days: losingDays(2) }), THRESHOLDS)).toBeNull();
  });

  it('stays quiet when any day in the window made money', () => {
    const days = [...losingDays(5), { day: '2026-03-06', contributionMinor: 1 }];
    expect(routeLossAlert(route({ days }), THRESHOLDS)).toBeNull();
  });

  /** Break-even is not money leaving. */
  it('treats a zero-contribution day as not a loss', () => {
    const days = [...losingDays(4), { day: '2026-03-05', contributionMinor: 0 }];
    expect(routeLossAlert(route({ days }), THRESHOLDS)).toBeNull();
  });
});

describe('debt service coverage', () => {
  it('is critical below the floor, because borrowing is already refused', () => {
    const alert = dscrAlert(airline({ dscr: 1.1 }), THRESHOLDS);
    expect(alert).toMatchObject({ kind: 'dscr_headroom', severity: 'critical' });
  });

  it('is a warning inside the headroom above the floor', () => {
    const alert = dscrAlert(airline({ dscr: 1.4 }), THRESHOLDS);
    expect(alert).toMatchObject({ severity: 'warning' });
    expect(alert?.detail).toContain('1.40');
  });

  it('is silent with comfortable coverage', () => {
    expect(dscrAlert(airline({ dscr: 1.51 }), THRESHOLDS)).toBeNull();
  });

  /** An airline that owes nothing has no ratio; §13.1's gate does not apply to it. */
  it('is silent for an airline with no debt', () => {
    expect(dscrAlert(airline({ dscr: null }), THRESHOLDS)).toBeNull();
  });
});

describe('the cash runway', () => {
  it('reads a null projection as beyond the horizon, never as zero days', () => {
    const state = airline({ runwayDays: null });
    expect(evaluateAlerts(state, THRESHOLDS).filter((a) => a.kind === 'cash_runway')).toEqual([]);
  });

  it('fires below the threshold', () => {
    const alerts = evaluateAlerts(airline({ runwayDays: 18 }), THRESHOLDS);
    expect(alerts.map((a) => a.kind)).toContain('cash_runway');
    expect(alerts[0]?.title).toContain('18');
  });

  it('does not fire exactly at the threshold', () => {
    expect(evaluateAlerts(airline({ runwayDays: 30 }), THRESHOLDS)).toEqual([]);
  });
});

describe('crew shortfall', () => {
  it('is critical when the fleet is already short', () => {
    const alerts = crewShortfallAlerts(
      airline({
        crew: [
          { family: 'A320', rank: 'captain', available: 4, requiredNow: 6, requiredAtHorizon: 6 },
        ],
      }),
      THRESHOLDS,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', subjectKey: 'crew:A320:captain' });
    expect(alerts[0]?.title).toContain('2');
  });

  /** The forecastable case: an aeroplane arriving inside the horizon raises the complement. */
  it('warns when only the arriving aircraft create the shortage', () => {
    const alerts = crewShortfallAlerts(
      airline({
        crew: [
          { family: 'A320', rank: 'captain', available: 6, requiredNow: 6, requiredAtHorizon: 8 },
        ],
      }),
      THRESHOLDS,
    );
    expect(alerts[0]).toMatchObject({ severity: 'warning' });
    expect(alerts[0]?.detail).toContain('5 day(s)');
  });

  it('says nothing about a covered rank', () => {
    const alerts = crewShortfallAlerts(
      airline({
        crew: [
          { family: 'A320', rank: 'captain', available: 9, requiredNow: 6, requiredAtHorizon: 8 },
        ],
      }),
      THRESHOLDS,
    );
    expect(alerts).toEqual([]);
  });
});

describe('a due check with nothing booked', () => {
  const base = { airframeId: 'frame-1', registration: 'G-TFAA', tier: 'c', grounded: false };

  it('is critical once overdue', () => {
    const alert = checkDueAlert({ ...base, usedFraction: 1.2, inCheck: false }, THRESHOLDS);
    expect(alert).toMatchObject({ kind: 'check_due_unbooked', severity: 'critical' });
    expect(alert?.title).toContain('C-check');
  });

  it('warns while the check is only approaching', () => {
    const alert = checkDueAlert({ ...base, usedFraction: 0.95, inCheck: false }, THRESHOLDS);
    expect(alert).toMatchObject({ severity: 'warning' });
    expect(alert?.detail).toContain('95%');
  });

  /** *No slot booked* is the whole rule: an aeroplane in a check has already been dealt with. */
  it('is silent for an airframe already in a check', () => {
    expect(checkDueAlert({ ...base, usedFraction: 1.4, inCheck: true }, THRESHOLDS)).toBeNull();
  });

  it('is silent while the interval is not close', () => {
    expect(checkDueAlert({ ...base, usedFraction: 0.5, inCheck: false }, THRESHOLDS)).toBeNull();
  });
});

describe('a lapsing handling contract', () => {
  const base = { contractId: 'contract-1', airportIcao: 'EGLL', serviceLine: 'ramp and baggage' };

  it('warns inside the notice window', () => {
    const alert = contractExpiryAlert({ ...base, daysRemaining: 21 }, THRESHOLDS);
    expect(alert).toMatchObject({ kind: 'ground_contract_expiring', severity: 'warning' });
  });

  it('turns critical as the term runs out', () => {
    expect(contractExpiryAlert({ ...base, daysRemaining: 5 }, THRESHOLDS)).toMatchObject({
      severity: 'critical',
    });
  });

  it('says contract rather than lease, because a gate lease does not exist', () => {
    const alert = contractExpiryAlert({ ...base, daysRemaining: 5 }, THRESHOLDS);
    expect(alert?.detail).not.toContain('lease');
    expect(alert?.detail).toContain('vendor slot');
  });

  it('is silent for a term still far off', () => {
    expect(contractExpiryAlert({ ...base, daysRemaining: 60 }, THRESHOLDS)).toBeNull();
  });
});

describe('a competitor entering', () => {
  it('raises one alert per rival, keyed so a second arrival is still news', () => {
    const alerts = competitorAlerts(
      route({
        newRivals: [
          { airlineId: 'rival-1', name: 'Aer Nova' },
          { airlineId: 'rival-2', name: 'Northwind' },
        ],
      }),
      THRESHOLDS,
    );
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.subjectKey)).toEqual(['route-1:rival-1', 'route-1:rival-2']);
    // The link is still the player's own route, not the rival's.
    expect(new Set(alerts.map((a) => a.subjectId))).toEqual(new Set(['route-1']));
  });

  it('says nothing about a market with no new entrant', () => {
    expect(competitorAlerts(route(), THRESHOLDS)).toEqual([]);
  });
});

describe('spill', () => {
  it('fires above the ceiling and leads with the count', () => {
    const alert = spillAlert(route({ flights: 20, carried: 3400, spilled: 800 }), THRESHOLDS);
    expect(alert).toMatchObject({ kind: 'route_spill', severity: 'warning' });
    expect(alert?.title).toContain('800');
    expect(alert?.detail).toContain('19%');
  });

  it('does not fire at the ceiling itself', () => {
    expect(spillAlert(route({ flights: 20, carried: 850, spilled: 150 }), THRESHOLDS)).toBeNull();
  });

  /** One full Friday is not a route-wide problem. */
  it('needs enough flights to mean anything', () => {
    expect(spillAlert(route({ flights: 2, carried: 100, spilled: 90 }), THRESHOLDS)).toBeNull();
  });
});

/**
 * M8-13's second acceptance criterion, as arithmetic.
 *
 * The sweep runs every tick by design, so *"not repeated every tick"* has to
 * mean the second evaluation of an unchanged world raises nothing.
 */
describe('reconciliation', () => {
  const evaluated = [
    routeLossAlert(route({ days: losingDays(4) }), THRESHOLDS),
    dscrAlert(airline({ dscr: 1.1 }), THRESHOLDS),
  ].flatMap((alert) => (alert ? [alert] : []));

  it('raises everything on an airline with nothing open', () => {
    const result = reconcileAlerts(evaluated, []);
    expect(result.raise).toHaveLength(2);
    expect(result.resolve).toEqual([]);
    expect(result.unchanged).toBe(0);
  });

  it('raises nothing the second time round', () => {
    const open = evaluated.map((alert, index) => ({
      id: `open-${String(index)}`,
      kind: alert.kind,
      subjectKey: alert.subjectKey,
    }));
    const result = reconcileAlerts(evaluated, open);
    expect(result.raise).toEqual([]);
    expect(result.resolve).toEqual([]);
    expect(result.unchanged).toBe(2);
  });

  it('resolves an open alert whose condition has gone', () => {
    const open = [{ id: 'stale', kind: 'route_spill' as const, subjectKey: 'route-9' }];
    const result = reconcileAlerts(evaluated, open);
    expect(result.resolve).toEqual(['stale']);
    expect(result.raise).toHaveLength(2);
  });

  /**
   * Two rules can share a subject — a route can be both loss-making and
   * spilling — so the identity has to be the pair, not the subject alone.
   */
  it('keys on kind and subject together', () => {
    const open = [{ id: 'other-kind', kind: 'route_spill' as const, subjectKey: 'route-1' }];
    const result = reconcileAlerts(evaluated, open);
    expect(result.raise.map((a) => a.kind)).toContain('route_loss_making');
    expect(result.resolve).toEqual(['other-kind']);
  });
});
