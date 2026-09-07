import { describe, expect, it } from 'vitest';

import {
  diagnoseRoute,
  medianOf,
  type DiagnosisInput,
  type PeerBenchmark,
} from './route-diagnosis';
import { addFlight, emptyTraffic, type TrafficTotals } from './unit-economics';

/**
 * §14.4's drill-down, and M8-11's first acceptance criterion.
 *
 * > The drill-down names a specific cause, not a generic breakdown.
 *
 * So the tests that matter are the ones where a *generic* answer would be
 * wrong: a thin route whose cost base no load factor could cover must not be
 * told to re-time, and a thin route a rival owns must not be told to re-time
 * either.
 */

/** One sector, folded, with everything adjustable. */
function route(overrides: Partial<Parameters<typeof addFlight>[1]> = {}): TrafficTotals {
  return addFlight(emptyTraffic(), {
    seats: 180,
    passengers: 144,
    spilledPassengers: 0,
    cargoKg: 0,
    distanceKm: 1_000,
    revenueMinor: 1_800_000,
    costMinor: 1_500_000,
    blockSeconds: 7_200,
    onTime: true,
    ...overrides,
  });
}

/** The airline's median route: 12.5¢/RPK, 8.33¢/ASK, 80% full. */
const PEERS: PeerBenchmark = {
  yieldMinor: 12.5,
  caskMinor: 8.333,
  loadFactor: 0.8,
  routes: 9,
};

function diagnose(
  totals: TrafficTotals,
  overrides: Partial<Omit<DiagnosisInput, 'totals'>> = {},
): ReturnType<typeof diagnoseRoute> {
  return diagnoseRoute({
    totals,
    peers: PEERS,
    rivalShare: null,
    rivalShareThreshold: 0.6,
    ...overrides,
  });
}

describe('diagnosing a route', () => {
  it('says there is nothing to fix on a route above the line', () => {
    const healthy = diagnose(route());
    expect(healthy.contributionMinor).toBeGreaterThan(0);
    // Not "your weakest lever" dressed up as a problem: §14.4 ranks profitable
    // routes too, and the honest drill-down for one of them is nothing.
    expect(healthy.cause).toBe('none');
    expect(healthy.action).toBe('keep');
  });

  it('sends an under-priced route to be repriced', () => {
    // Full, cheap to fly, and sold too cheaply: 7¢/RPK against a 12.5¢ median.
    const cheap = route({ passengers: 170, revenueMinor: 1_190_000, costMinor: 1_400_000 });
    const found = diagnose(cheap);
    expect(found.cause).toBe('yield');
    expect(found.action).toBe('reprice');
    expect(found.gaps.yield.worthMinor).toBeGreaterThan(0);
  });

  it('sends a route with the wrong aeroplane to be re-gauged', () => {
    // Priced at the median but costing half again as much per seat offered.
    const dear = route({ passengers: 144, revenueMinor: 1_800_000, costMinor: 2_400_000 });
    const found = diagnose(dear);
    expect(found.cause).toBe('cost');
    expect(found.action).toBe('re-gauge');
    expect(found.gaps.cost.worthMinor).toBeGreaterThan(0);
  });

  it('never tells a player to re-time a route no load factor could save (AC1)', () => {
    /*
     * The failure a gap-ranking implementation makes. This route is thin *and*
     * structurally unprofitable: its cost per seat offered exceeds its revenue
     * per seat sold, so every extra passenger loses money. A diagnosis that
     * named the biggest gap would say "load factor, re-time it", and re-timing
     * cannot help — the aeroplane is wrong for the sector.
     */
    /*
     * 180 seats over 1,000 km, so 180,000 ASK. Forty passengers paying 5¢/RPK
     * against a cost of 10¢/ASK: the seats cost twice per offered kilometre
     * what the sold ones earn, so breakeven needs a load factor of 2.0.
     */
    const hopeless = route({ passengers: 40, revenueMinor: 200_000, costMinor: 1_800_000 });
    const found = diagnose(hopeless);

    expect(found.breakevenLoadFactor ?? 0).toBeGreaterThan(1);
    expect(found.unfillable).toBe(true);
    expect(found.cause).not.toBe('load_factor');
    expect(found.action).not.toBe('re-time');
    expect(['cost', 'yield']).toContain(found.cause);
  });

  it('sends an under-filled route to be re-timed when nobody else is there', () => {
    // It would pay at the median load; it is simply half empty.
    const thin = route({ passengers: 70, revenueMinor: 875_000, costMinor: 1_000_000 });
    const found = diagnose(thin, { rivalShare: 0.1 });
    expect(found.unfillable).toBe(false);
    expect((found.loadFactor ?? 1) < (found.breakevenLoadFactor ?? 0)).toBe(true);
    expect(found.cause).toBe('load_factor');
    expect(found.action).toBe('re-time');
  });

  it('sends the same route to be cut when a rival owns the market', () => {
    // Identical numbers. The only difference is who else is flying it — which
    // is the one question the route's own figures cannot answer.
    const thin = route({ passengers: 70, revenueMinor: 875_000, costMinor: 1_000_000 });
    const found = diagnose(thin, { rivalShare: 0.85 });
    expect(found.cause).toBe('competitor');
    expect(found.action).toBe('cut');
    expect(found.rivalShare).toBe(0.85);
  });

  it('prefers re-timing when competition is unknown, because it costs less to be wrong', () => {
    const thin = route({ passengers: 70, revenueMinor: 875_000, costMinor: 1_000_000 });
    // Re-timing a route a rival owns wastes a week. Cutting a route that only
    // needed re-timing throws a market away.
    expect(diagnose(thin, { rivalShare: null }).cause).toBe('load_factor');
  });

  it('reads a flight that sold nothing as a demand problem', () => {
    const empty = route({ passengers: 0, revenueMinor: 0, costMinor: 1_200_000 });
    const found = diagnose(empty);
    // Breakeven is null — a yield of zero has no ratio — so the tree cannot
    // reach its cost-or-yield question, and the answer is not in doubt.
    expect(found.breakevenLoadFactor).toBeNull();
    expect(found.cause).toBe('load_factor');
  });

  it('always carries the working, whichever cause won (§14.1)', () => {
    const found = diagnose(route({ passengers: 70, revenueMinor: 875_000, costMinor: 1_000_000 }), {
      rivalShare: 0.9,
    });
    expect(found.cause).toBe('competitor');
    // A player told "cut this" will want to know what the alternatives were
    // worth, so every gap is quantified on every answer.
    expect(found.gaps.yield.own).not.toBeNull();
    expect(found.gaps.cost.peer).toBe(PEERS.caskMinor);
    expect(found.gaps.load.worthMinor).toBeGreaterThan(0);
  });

  it('still answers with no peers at all', () => {
    // A one-route airline has no median. `cask > yield` is then the diagnosis
    // on its own: the seats cost more to offer than the sold ones earn.
    const alone: PeerBenchmark = { yieldMinor: null, caskMinor: null, loadFactor: null, routes: 1 };
    const hopeless = route({ passengers: 40, revenueMinor: 200_000, costMinor: 1_800_000 });
    const found = diagnose(hopeless, { peers: alone });
    expect(found.cause).toBe('cost');
    expect(found.gaps.cost.worthMinor).toBe(0);
    expect(found.gaps.cost.peer).toBeNull();
  });

  it('never reports a negative worth for a lever the route is already ahead on', () => {
    // Better than the median on every count and still losing money is possible
    // in a bad window; a negative "worth" would read as a lever to pull.
    const good = route({ passengers: 175, revenueMinor: 2_500_000, costMinor: 2_600_000 });
    const found = diagnose(good);
    for (const lever of Object.values(found.gaps)) {
      expect(lever.worthMinor).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the peer median', () => {
  it('takes the middle of an odd set', () => {
    expect(medianOf([1, 5, 3])).toBe(3);
  });

  it('averages the two middles of an even set', () => {
    // So the benchmark does not jump when one route joins an even network.
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });

  it('ignores the routes that have nothing to measure', () => {
    expect(medianOf([null, 4, null, 6])).toBe(5);
    expect(medianOf([null, null])).toBeNull();
    expect(medianOf([])).toBeNull();
  });
});
