import { describe, expect, it } from 'vitest';

import {
  type AircraftCapability,
  type AirportCapability,
  checkReachability,
  DEFAULT_REACHABILITY,
  REACHABILITY_REASONS,
  type ReachabilityReason,
  type RoutePlan,
} from './reachability';

/**
 * The seven reachability checks (M2-01, App. B.4).
 *
 * Two things are worth protecting here, and the second is the harder one:
 *
 *   1. The arithmetic — an ATR 72 out of Amsterdam reaches the cities App. B.4
 *      says it reaches, and fails Madrid on range.
 *   2. **Every failure names which check failed.** The design doc is explicit:
 *      "The UI shows exactly which one failed, never a generic 'unavailable'."
 *      So each reason has a test, and one test walks the whole enum to prove
 *      none has quietly become unreachable.
 */

/**
 * ATR 72-600, at the load App. B.4 describes as full.
 *
 * 700 nm is the practical radius the design doc gives. It is the number that
 * makes the table work: Warsaw at 595 nm passes with the 1.06 factor applied,
 * Barcelona at 670 nm does not — which is exactly what the doc calls
 * "marginal — payload-limited".
 */
const ATR72: AircraftCapability = {
  rangeNm: 700,
  takeoffRunM: 1_300,
  wingspanCode: 'C',
  etopsMinutes: null,
};

function airport(overrides: Partial<AirportCapability> & { icao: string }): AirportCapability {
  return {
    longestRunwayM: 3_500,
    elevationFt: 0,
    maxWingspanCode: 'F',
    hours: null,
    countryCode: 'NL',
    ...overrides,
  };
}

const AMS = airport({ icao: 'EHAM', countryCode: 'NL' });

/** Distances from AMS, straight out of App. B.4's table. */
const FROM_AMS: Record<string, number> = {
  EGLL: 199,
  LFPG: 215,
  EKCH: 342,
  EIDW: 405,
  LOWW: 518,
  EPWA: 595,
  LEBL: 670,
  LEMD: 789,
  KJFK: 3_157,
  RJTT: 5_032,
};

function plan(overrides: Partial<RoutePlan> = {}): RoutePlan {
  return {
    distanceNm: 199,
    departureMinute: 9 * 60,
    arrivalMinute: 11 * 60,
    diversionMinutes: 0,
    hasTrafficRights: true,
    hasSlot: true,
    ...overrides,
  };
}

/** The destination for a route out of Amsterdam, with everything else permissive. */
function to(icao: string, overrides: Partial<AirportCapability> = {}): AirportCapability {
  return airport({ icao, countryCode: 'GB', ...overrides });
}

describe('what an ATR 72 reaches from Amsterdam', () => {
  // The acceptance criterion, stated as App. B.4's own table.
  it.each([
    ['EGLL', 'London'],
    ['LFPG', 'Paris'],
    ['EKCH', 'Copenhagen'],
    ['EIDW', 'Dublin'],
    ['LOWW', 'Vienna'],
    ['EPWA', 'Warsaw'],
  ])('reaches %s (%s)', (icao) => {
    const result = checkReachability(ATR72, AMS, to(icao), plan({ distanceNm: FROM_AMS[icao] }));
    expect(result).toEqual({ ok: true });
  });

  it('fails Madrid on range, and says so in nautical miles', () => {
    const result = checkReachability(ATR72, AMS, to('LEMD'), plan({ distanceNm: FROM_AMS.LEMD }));

    if (result.ok) throw new Error('expected Madrid to be out of range');
    expect(result.reason).toBe('range');
    // The detail has to be actionable: the distance needed, and what the
    // aircraft has. "Unavailable" would tell a player nothing.
    expect(result.detail).toContain('836');
    expect(result.detail).toContain('700');
    expect(result.detail).toContain('LEMD');
  });

  it('fails Barcelona too, which is what "marginal — payload-limited" means', () => {
    // 670 nm × 1.06 is 710, over the 700 nm radius. The design doc calls this
    // marginal rather than impossible: a lighter load would make it, and that
    // trade is M2-02's.
    const result = checkReachability(ATR72, AMS, to('LEBL'), plan({ distanceNm: FROM_AMS.LEBL }));
    expect(result.ok).toBe(false);
  });

  it('is nowhere near New York or Tokyo', () => {
    for (const icao of ['KJFK', 'RJTT']) {
      const result = checkReachability(ATR72, AMS, to(icao), plan({ distanceNm: FROM_AMS[icao] }));
      if (result.ok) throw new Error(`${icao} should be unreachable`);
      expect(result.reason).toBe('range');
    }
  });

  it('applies the routing factor rather than the great circle alone', () => {
    // The difference between the two is the whole point of check 1: a route at
    // exactly the aircraft's range does not fly, because the aeroplane does not
    // follow the great circle.
    const exactly = checkReachability(ATR72, AMS, to('TEST'), plan({ distanceNm: 700 }));
    expect(exactly.ok).toBe(false);

    const within = checkReachability(
      ATR72,
      AMS,
      to('TEST'),
      plan({ distanceNm: 700 / DEFAULT_REACHABILITY.routeFactor }),
    );
    expect(within.ok).toBe(true);
  });
});

describe('each check, and the order they run in', () => {
  it('refuses a runway that is too short, at the departure end', () => {
    const result = checkReachability(
      ATR72,
      airport({ icao: 'EHAM', longestRunwayM: 1_000 }),
      to('EGLL'),
      plan(),
    );

    if (result.ok) throw new Error('expected a runway failure');
    expect(result.reason).toBe('runway');
    expect(result.detail).toContain('1,000 m');
  });

  it('needs more runway at altitude than at sea level', () => {
    // Thinner air, less thrust, more groundspeed for the same indicated speed.
    // A field that is long enough at sea level may not be at 5,000 ft.
    const short = airport({ icao: 'HIGH', longestRunwayM: 1_500, elevationFt: 5_000 });
    const result = checkReachability(ATR72, short, to('EGLL'), plan());

    if (result.ok) throw new Error('expected a runway failure');
    expect(result.reason).toBe('runway');
    // 1,300 m plus 35% for five thousand feet is 1,755 m.
    expect(result.detail).toContain('1,755');
    expect(result.detail).toContain('elevation');

    // The same aircraft off the same length at sea level is fine.
    const atSeaLevel = airport({ icao: 'FLAT', longestRunwayM: 1_500, elevationFt: 0 });
    expect(checkReachability(ATR72, atSeaLevel, to('EGLL'), plan()).ok).toBe(true);
  });

  it('refuses an aircraft too wide for either end', () => {
    const wide: AircraftCapability = { ...ATR72, wingspanCode: 'E' };

    const atDestination = checkReachability(
      wide,
      AMS,
      to('SMALL', { maxWingspanCode: 'C' }),
      plan(),
    );
    if (atDestination.ok) throw new Error('expected a wingspan failure');
    expect(atDestination.reason).toBe('wingspan');
    expect(atDestination.detail).toContain('SMALL');
    // Names the limit in metres, because a code letter alone means nothing to
    // most people.
    expect(atDestination.detail).toContain('36 m');

    // And at the origin, which is just as disqualifying.
    const atOrigin = checkReachability(
      wide,
      airport({ icao: 'EHAM', maxWingspanCode: 'C' }),
      to('EGLL'),
      plan(),
    );
    expect(atOrigin.ok).toBe(false);
  });

  it('lets an aircraft into an airport rated for exactly its code', () => {
    const result = checkReachability(ATR72, AMS, to('EGLL', { maxWingspanCode: 'C' }), plan());
    expect(result.ok).toBe(true);
  });

  it('refuses a routing that needs more diversion time than the type holds', () => {
    const result = checkReachability(ATR72, AMS, to('EGLL'), plan({ diversionMinutes: 120 }));

    if (result.ok) throw new Error('expected an overwater failure');
    expect(result.reason).toBe('overwater');
    expect(result.detail).toMatch(/no ETOPS approval/i);
  });

  it('accepts a rated type on the same routing, and reports the rating when it is short', () => {
    const rated: AircraftCapability = { ...ATR72, etopsMinutes: 180 };
    expect(checkReachability(rated, AMS, to('EGLL'), plan({ diversionMinutes: 120 })).ok).toBe(
      true,
    );

    const under: AircraftCapability = { ...ATR72, etopsMinutes: 60 };
    const result = checkReachability(under, AMS, to('EGLL'), plan({ diversionMinutes: 120 }));
    if (result.ok) throw new Error('expected an overwater failure');
    expect(result.detail).toContain('60 minutes');
  });

  it('lets an unrated type fly a routing that never leaves diversion range', () => {
    // Most short-haul flying. An aircraft with no ETOPS approval is not grounded,
    // it is simply kept within the default 60-minute rule.
    const result = checkReachability(ATR72, AMS, to('EGLL'), plan({ diversionMinutes: 0 }));
    expect(result).toEqual({ ok: true });
  });

  it('refuses a departure before the airport opens', () => {
    const result = checkReachability(
      ATR72,
      airport({ icao: 'EHAM', hours: { opensMinute: 6 * 60, closesMinute: 23 * 60 } }),
      to('EGLL'),
      plan({ departureMinute: 5 * 60 }),
    );

    if (result.ok) throw new Error('expected a curfew failure');
    expect(result.reason).toBe('curfew');
    expect(result.detail).toContain('05:00');
    expect(result.detail).toContain('06:00–23:00');
  });

  it('refuses an arrival after the far end closes', () => {
    const result = checkReachability(
      ATR72,
      AMS,
      to('EGLL', { hours: { opensMinute: 6 * 60, closesMinute: 23 * 60 } }),
      plan({ arrivalMinute: 23 * 60 + 30 }),
    );

    if (result.ok) throw new Error('expected a curfew failure');
    expect(result.reason).toBe('curfew');
    expect(result.detail).toContain('arrives');
  });

  it('handles an operating window that wraps midnight', () => {
    // A 22:00–05:00 window is open at 23:00 and shut at noon. Treating it as a
    // plain range gets both backwards, which is the sort of bug that only shows
    // up on the night schedule.
    const nightPort = airport({
      icao: 'NIGHT',
      hours: { opensMinute: 22 * 60, closesMinute: 5 * 60 },
      countryCode: 'NL',
    });

    expect(
      checkReachability(ATR72, nightPort, to('EGLL'), plan({ departureMinute: 23 * 60 })).ok,
    ).toBe(true);
    expect(
      checkReachability(ATR72, nightPort, to('EGLL'), plan({ departureMinute: 12 * 60 })).ok,
    ).toBe(false);
  });

  it('ignores curfews at a 24-hour airport', () => {
    const result = checkReachability(ATR72, AMS, to('EGLL'), plan({ departureMinute: 3 * 60 }));
    expect(result.ok).toBe(true);
  });

  it('refuses an international pair with no traffic right', () => {
    const result = checkReachability(ATR72, AMS, to('EGLL'), plan({ hasTrafficRights: false }));

    if (result.ok) throw new Error('expected a rights failure');
    expect(result.reason).toBe('rights');
    expect(result.detail).toContain('NL–GB');
  });

  it('needs no traffic right for a domestic pair', () => {
    // Amsterdam to Rotterdam is not an international sector, and asking for a
    // right would be asking for something that does not exist.
    const result = checkReachability(
      ATR72,
      AMS,
      to('EHRD', { countryCode: 'NL' }),
      plan({ hasTrafficRights: false }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a departure with no slot, last of all', () => {
    const result = checkReachability(ATR72, AMS, to('EGLL'), plan({ hasSlot: false }));

    if (result.ok) throw new Error('expected a slot failure');
    expect(result.reason).toBe('slot');
    expect(result.detail).toContain('09:00');
  });

  it('reports the first failure, not the worst one', () => {
    // Everything wrong at once. Range comes first because it is the physical,
    // permanent problem — there is no point offering to sell somebody a slot
    // for a route their aircraft cannot fly.
    const result = checkReachability(
      { ...ATR72, wingspanCode: 'F' },
      airport({ icao: 'EHAM', longestRunwayM: 500, hours: { opensMinute: 0, closesMinute: 1 } }),
      to('LEMD', { maxWingspanCode: 'A', hours: { opensMinute: 0, closesMinute: 1 } }),
      plan({ distanceNm: 5_000, hasTrafficRights: false, hasSlot: false, diversionMinutes: 300 }),
    );

    if (result.ok) throw new Error('expected a failure');
    expect(result.reason).toBe('range');
  });

  it('runs the checks in App. B.4 order', () => {
    // Removing one obstacle at a time should surface the next reason in order.
    // This is the test that would catch a reordering, which is easy to do by
    // accident and changes what players are told to fix first.
    const seen: ReachabilityReason[] = [];

    const broken = {
      aircraft: { ...ATR72, wingspanCode: 'F' as const, etopsMinutes: null },
      origin: airport({
        icao: 'EHAM',
        longestRunwayM: 500,
        hours: { opensMinute: 0, closesMinute: 1 },
      }),
      destination: to('LEMD', { maxWingspanCode: 'A' }),
      plan: plan({
        distanceNm: 5_000,
        diversionMinutes: 300,
        hasTrafficRights: false,
        hasSlot: false,
      }),
    };

    // 1: range
    let result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 2: runway
    broken.plan = { ...broken.plan, distanceNm: 100 };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 3: wingspan
    broken.origin = { ...broken.origin, longestRunwayM: 3_000 };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 4: overwater
    broken.destination = { ...broken.destination, maxWingspanCode: 'F' };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 5: curfew
    broken.plan = { ...broken.plan, diversionMinutes: 0 };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 6: rights
    broken.origin = { ...broken.origin, hours: null };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // 7: slot
    broken.plan = { ...broken.plan, hasTrafficRights: true };
    result = checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan);
    if (result.ok) throw new Error('expected a failure');
    seen.push(result.reason);

    // And with the slot, everything passes.
    broken.plan = { ...broken.plan, hasSlot: true };
    expect(
      checkReachability(broken.aircraft, broken.origin, broken.destination, broken.plan),
    ).toEqual({ ok: true });

    expect(seen).toEqual(REACHABILITY_REASONS);
  });

  it('has a test for every reason it can give', () => {
    // The acceptance criterion — "every reason enum value has a unit test" —
    // checked structurally, so adding an eighth check without testing it fails
    // here rather than being noticed later.
    expect(REACHABILITY_REASONS).toHaveLength(7);
    expect(new Set(REACHABILITY_REASONS).size).toBe(REACHABILITY_REASONS.length);
  });
});

describe('the shape of the answer', () => {
  it('is a discriminated union, so a caller cannot read a reason off a pass', () => {
    const pass = checkReachability(ATR72, AMS, to('EGLL'), plan());
    expect(pass).toEqual({ ok: true });
    expect(Object.keys(pass)).toEqual(['ok']);

    const fail = checkReachability(ATR72, AMS, to('LEMD'), plan({ distanceNm: 5_000 }));
    if (fail.ok) throw new Error('expected a failure');
    expect(Object.keys(fail).sort()).toEqual(['detail', 'ok', 'reason']);
  });

  it('never answers with an empty explanation', () => {
    // A reason with no detail is the generic "unavailable" App. B.4 forbids,
    // wearing a different hat.
    const failures = [
      plan({ distanceNm: 5_000 }),
      plan({ diversionMinutes: 300 }),
      plan({ hasTrafficRights: false }),
      plan({ hasSlot: false }),
    ];
    for (const attempt of failures) {
      const result = checkReachability(ATR72, AMS, to('LEMD', { countryCode: 'ES' }), attempt);
      if (result.ok) throw new Error('expected a failure');
      expect(result.detail.length).toBeGreaterThan(20);
    }
  });

  it('takes its margins from config rather than from literals', () => {
    // CONTRIBUTING invariant 3. A route that fails at 1.06 passes with no
    // routing allowance at all, which proves the factor is actually applied
    // from the config rather than baked in.
    const marginal = plan({ distanceNm: 690 });
    expect(checkReachability(ATR72, AMS, to('EGLL'), marginal).ok).toBe(false);
    expect(
      checkReachability(ATR72, AMS, to('EGLL'), marginal, {
        ...DEFAULT_REACHABILITY,
        routeFactor: 1,
      }).ok,
    ).toBe(true);
  });
});
