import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';

import {
  asConnectingCompetitor,
  connectionPenalty,
  DEFAULT_ITINERARY,
  enumerateItineraries,
  type Itinerary,
  type ItineraryConfig,
  type ItineraryLeg,
  type Place,
  prorate,
  scheduleFingerprint,
} from './itinerary';
import { computeShares } from './logit';
import { DEMAND_SEGMENTS } from './modulation';

/**
 * Connecting itineraries (M3-07, App. A.14).
 *
 * A.14 publishes three numbers — business 0.9, leisure 0.35, VFR 0.30 — and one
 * claim about what they buy: *"that single asymmetry is why hub carriers chase
 * business traffic and point-to-point LCCs chase leisure."* The first block
 * tests the claim rather than the numbers, because a table of coefficients that
 * does not produce that behaviour has not implemented A.14.
 */

/** Roughly the real places, so the detour arithmetic is against real geography. */
const AMS: Place = { icao: 'EHAM', latitude: 52.3086, longitude: 4.7639, mctMinutes: 50 };
const LHR: Place = { icao: 'EGLL', latitude: 51.4706, longitude: -0.4619, mctMinutes: 75 };
const CDG: Place = { icao: 'LFPG', latitude: 49.0097, longitude: 2.5479 };
const BCN: Place = { icao: 'LEBL', latitude: 41.2971, longitude: 2.0785 };
/** Far enough off the AMS–BCN line to blow the detour limit. */
const HEL: Place = { icao: 'EFHK', latitude: 60.3172, longitude: 24.9633 };

let nextLeg = 0;
function leg(
  over: Partial<ItineraryLeg> & Pick<ItineraryLeg, 'originIcao' | 'destinationIcao'>,
): ItineraryLeg {
  nextLeg += 1;
  const departureMinute = over.departureMinute ?? 8 * 60;
  return {
    id: `leg-${String(nextLeg)}`,
    departureMinute,
    arrivalMinute: over.arrivalMinute ?? departureMinute + 90,
    distanceNm: 400,
    seatsAvailable: 100,
    fareMinor: 9_000,
    productScore: 0.6,
    ...over,
  };
}

/** AMS → CDG → BCN, connecting comfortably. */
function viaParis(overrides: { connect?: number; seats?: number } = {}): ItineraryLeg[] {
  const first = leg({
    originIcao: 'EHAM',
    destinationIcao: 'LFPG',
    departureMinute: 7 * 60,
    arrivalMinute: 8 * 60,
    distanceNm: 220,
    seatsAvailable: overrides.seats ?? 100,
  });
  const second = leg({
    originIcao: 'LFPG',
    destinationIcao: 'LEBL',
    departureMinute: 8 * 60 + (overrides.connect ?? 60),
    arrivalMinute: 8 * 60 + (overrides.connect ?? 60) + 100,
    distanceNm: 460,
    seatsAvailable: overrides.seats ?? 100,
  });
  return [first, second];
}

const enumerate = (legs: ItineraryLeg[], hubs: Place[] = [CDG], config?: ItineraryConfig) =>
  enumerateItineraries({ origin: AMS, destination: BCN, hubs, legs }, config);

describe('business hates connections and leisure tolerates them — A.14’s claim', () => {
  const [itinerary] = enumerate(viaParis());

  it('penalises business far more than leisure', () => {
    expect(itinerary).toBeDefined();
    const business = connectionPenalty(itinerary!, 'business');
    const leisure = connectionPenalty(itinerary!, 'leisure');

    expect(business).toBeGreaterThan(leisure * 2);
  });

  it('uses A.14’s published base penalties verbatim', () => {
    expect(DEFAULT_ITINERARY.basePenalty).toEqual({ business: 0.9, leisure: 0.35, vfr: 0.3 });
  });

  it('costs a business traveller more than a leisure traveller in real share', () => {
    // The claim, run through the actual logit rather than compared as
    // coefficients: a nonstop and a connection, identical in every other way.
    const nonstop = {
      id: 'nonstop',
      fareMinor: 18_000,
      frequency: 2,
      productScore: 0.6,
      reputation: 0.5,
    };
    const connecting = asConnectingCompetitor({
      id: 'connecting',
      itineraries: enumerate(viaParis()),
      reputation: 0.5,
    });

    const pools: Record<DemandSegment, number> = { business: 300, leisure: 300, vfr: 300 };
    const result = computeShares({ operators: [nonstop, connecting], segmentPools: pools });

    const share = (segment: DemandSegment) =>
      result.bySegment[segment].operators.find((o) => o.operatorId === 'connecting')?.share ?? 0;

    // Leisure will take the connection far more readily than business will.
    expect(share('leisure')).toBeGreaterThan(share('business') * 1.5);
  });

  it('is why an LCC chases leisure and a hub carrier chases business', () => {
    // Stated as the ratio between the two penalties against their own price
    // sensitivity: a connection is worth roughly an 80% fare premium to
    // business and a ~12% discount to leisure.
    const businessCost = DEFAULT_ITINERARY.basePenalty.business / 1.1;
    const leisureCost = DEFAULT_ITINERARY.basePenalty.leisure / 3.0;

    expect(businessCost).toBeGreaterThan(leisureCost * 5);
  });
});

describe('validity — A.14’s three rules', () => {
  it('refuses a connection tighter than the airport’s MCT', () => {
    // CDG has no stated MCT, so the 45-minute default applies.
    expect(enumerate(viaParis({ connect: 30 }))).toHaveLength(0);
    expect(enumerate(viaParis({ connect: 45 }))).toHaveLength(1);
  });

  it('honours a per-airport MCT over the default', () => {
    const legs = [
      leg({
        originIcao: 'EHAM',
        destinationIcao: 'EGLL',
        departureMinute: 420,
        arrivalMinute: 480,
        distanceNm: 200,
      }),
      leg({
        originIcao: 'EGLL',
        destinationIcao: 'LEBL',
        departureMinute: 480 + 60,
        arrivalMinute: 480 + 60 + 130,
        distanceNm: 600,
      }),
    ];

    // LHR states 75 minutes, so a 60-minute connection is refused there while
    // it would have been fine at an airport using the default.
    expect(enumerateItineraries({ origin: AMS, destination: BCN, hubs: [LHR], legs })).toHaveLength(
      0,
    );
  });

  it('refuses a connection longer than six hours', () => {
    expect(enumerate(viaParis({ connect: 6 * 60 }))).toHaveLength(1);
    expect(enumerate(viaParis({ connect: 6 * 60 + 1 }))).toHaveLength(0);
  });

  it('refuses a detour beyond 1.35 × great circle', () => {
    // AMS–BCN is about killer 700 nm direct; routing via Helsinki is roughly
    // three times that, which is exactly the shape the rule exists to refuse.
    const legs = [
      leg({
        originIcao: 'EHAM',
        destinationIcao: 'EFHK',
        departureMinute: 420,
        arrivalMinute: 540,
        distanceNm: 800,
      }),
      leg({
        originIcao: 'EFHK',
        destinationIcao: 'LEBL',
        departureMinute: 660,
        arrivalMinute: 900,
        distanceNm: 1_500,
      }),
    ];

    expect(enumerateItineraries({ origin: AMS, destination: BCN, hubs: [HEL], legs })).toHaveLength(
      0,
    );
  });

  it('accepts a hub that is barely off the direct line', () => {
    const [itinerary] = enumerate(viaParis());
    expect(itinerary?.detourRatio).toBeLessThan(DEFAULT_ITINERARY.maxDetourRatio);
    expect(itinerary?.detourRatio).toBeGreaterThan(1);
  });

  it('refuses an itinerary with no seats on either leg', () => {
    expect(enumerate(viaParis({ seats: 0 }))).toHaveLength(0);
  });

  it('takes the tighter leg’s seats, because an itinerary is one booking', () => {
    const legs = viaParis();
    legs[0]!.seatsAvailable = 4;
    legs[1]!.seatsAvailable = 90;

    const [itinerary] = enumerate(legs);
    expect(itinerary?.seatsAvailable).toBe(4);
    expect(
      enumerateItineraries({ origin: AMS, destination: BCN, hubs: [CDG], legs, seatsNeeded: 5 }),
    ).toHaveLength(0);
  });

  it('never connects through an endpoint', () => {
    const legs = [
      leg({ originIcao: 'EHAM', destinationIcao: 'EHAM' }),
      leg({ originIcao: 'EHAM', destinationIcao: 'LEBL', departureMinute: 600 }),
    ];

    expect(enumerateItineraries({ origin: AMS, destination: BCN, hubs: [AMS], legs })).toHaveLength(
      0,
    );
  });

  it('refuses an itinerary that goes nowhere', () => {
    expect(() =>
      enumerateItineraries({ origin: AMS, destination: AMS, hubs: [CDG], legs: viaParis() }),
    ).toThrow(/two different endpoints/);
  });
});

describe('bounded enumeration — the second acceptance criterion', () => {
  it('refuses more hubs than A.14 allows, rather than dropping some', () => {
    // Loudly: a silently truncated hub list is a route that mysteriously stops
    // selling, and the cost argument rests on this set staying small.
    const hubs = Array.from({ length: 11 }, (_, i) => ({
      icao: `H${String(i).padStart(3, '0')}`,
      latitude: 50,
      longitude: 5,
    }));

    expect(() =>
      enumerateItineraries({ origin: AMS, destination: BCN, hubs, legs: viaParis() }),
    ).toThrow(/at most 10 hubs/);
    expect(DEFAULT_ITINERARY.maxHubs).toBe(10);
  });

  it('ignores the network that touches neither endpoint', () => {
    // A.14: enumerating every one-stop over ~4,000 airports is O(n³). The guard
    // is that legs are indexed by endpoint on the way in, so a pair costs
    // hubs × arrivals(H) × departures(H) and the vast majority of legs are
    // never examined at all.
    //
    // Asserted structurally rather than by wall clock. A timing bound here
    // would measure the machine, and this repository has already had one
    // markdown-only pull request fail on exactly that.
    const noise: ItineraryLeg[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      noise.push(
        leg({
          originIcao: `X${String(i % 500).padStart(3, '0')}`,
          destinationIcao: `Y${String(i % 499).padStart(3, '0')}`,
          departureMinute: i % 1_400,
        }),
      );
    }

    // Ten thousand irrelevant legs, including many that connect to each other,
    // produce exactly the one real itinerary and nothing else.
    expect(enumerate([...noise, ...viaParis()])).toHaveLength(1);
    // And with the real pair removed, nothing at all — so the noise is genuinely
    // inert rather than accidentally matching.
    expect(enumerate(noise)).toHaveLength(0);
  });

  it('pairs every arrival with every departure, which is why banks pay', () => {
    // A.14's squared property, and the strongest argument in the design for
    // building hubs properly: six aircraft on the ground together offer nine
    // connections across a 3 × 3 bank, not three.
    const legs: ItineraryLeg[] = [];
    for (let i = 0; i < 3; i += 1) {
      legs.push(
        leg({
          originIcao: 'EHAM',
          destinationIcao: 'LFPG',
          departureMinute: 7 * 60 + i * 5,
          arrivalMinute: 8 * 60 + i * 5,
          distanceNm: 220,
        }),
      );
      legs.push(
        leg({
          originIcao: 'LFPG',
          destinationIcao: 'LEBL',
          departureMinute: 9 * 60 + i * 5,
          arrivalMinute: 10 * 60 + 40 + i * 5,
          distanceNm: 460,
        }),
      );
    }

    expect(enumerate(legs)).toHaveLength(9);
  });

  it('is deterministic — the same schedule enumerates identically', () => {
    const legs = viaParis();
    const forwards = enumerate(legs);
    const backwards = enumerate([...legs].reverse());

    expect(forwards.map((i) => i.first.id + i.second.id)).toEqual(
      backwards.map((i) => i.first.id + i.second.id),
    );
  });
});

describe('the connection penalty', () => {
  it('grows with the time wasted beyond the minimum', () => {
    const tight = enumerate(viaParis({ connect: 45 }))[0]!;
    const loose = enumerate(viaParis({ connect: 5 * 60 }))[0]!;

    expect(connectionPenalty(loose, 'business')).toBeGreaterThan(
      connectionPenalty(tight, 'business'),
    );
  });

  it('charges nothing extra at exactly the minimum', () => {
    const atMct = enumerate(viaParis({ connect: 45 }))[0]!;
    expect(connectionPenalty(atMct, 'leisure')).toBeCloseTo(
      DEFAULT_ITINERARY.basePenalty.leisure,
      12,
    );
  });

  it('adds a terminal change only when both terminals are known and differ', () => {
    const build = (a?: string, b?: string) => {
      const legs = viaParis();
      legs[0]!.terminal = a;
      legs[1]!.terminal = b;
      return enumerate(legs)[0]!;
    };

    expect(build('1', '2').terminalChange).toBe(true);
    expect(build('2', '2').terminalChange).toBe(false);
    // Unknown on either side charges nothing — inventing a penalty from missing
    // data would make every airport without terminal modelling look worse.
    expect(build(undefined, '2').terminalChange).toBe(false);
    expect(build('1', undefined).terminalChange).toBe(false);

    expect(connectionPenalty(build('1', '2'), 'business')).toBeCloseTo(
      connectionPenalty(build('2', '2'), 'business') + DEFAULT_ITINERARY.terminalChangePenalty,
      12,
    );
  });

  it('reads every coefficient from config', () => {
    const harsh: ItineraryConfig = {
      ...DEFAULT_ITINERARY,
      basePenalty: { business: 3, leisure: 3, vfr: 3 },
    };
    const itinerary = enumerate(viaParis())[0]!;

    expect(connectionPenalty(itinerary, 'leisure', harsh)).toBeGreaterThan(3);
  });
});

describe('one competitor in the logit', () => {
  const itineraries = enumerate(viaParis());

  it('sums the leg fares, less the operator’s discount', () => {
    const full = asConnectingCompetitor({ id: 'c', itineraries, reputation: 0.5 });
    const discounted = asConnectingCompetitor({
      id: 'c',
      itineraries,
      reputation: 0.5,
      connectionDiscountMinor: 2_000,
    });

    expect(full.fareMinor).toBe(18_000);
    expect(discounted.fareMinor).toBe(16_000);
  });

  it('counts daily valid connections as frequency', () => {
    const legs = [...viaParis(), ...viaParis({ connect: 120 })];
    const competitor = asConnectingCompetitor({
      id: 'c',
      itineraries: enumerate(legs),
      reputation: 0.5,
    });

    expect(competitor.frequency).toBe(enumerate(legs).length);
    expect(competitor.frequency).toBeGreaterThan(1);
  });

  it('weights product by distance, so the long leg dominates', () => {
    const legs = viaParis();
    legs[0]!.productScore = 0.2; // short leg, poor cabin
    legs[1]!.productScore = 0.9; // long leg, good cabin

    const competitor = asConnectingCompetitor({
      id: 'c',
      itineraries: enumerate(legs),
      reputation: 0.5,
    });

    // 220 nm at 0.2 and 460 nm at 0.9 — nearer the long leg than the mean.
    expect(competitor.productScore).toBeGreaterThan(0.55);
    expect(competitor.productScore).toBeLessThan(0.9);
  });

  it('takes the best connection’s penalty, not the average', () => {
    // A passenger books the connection that suits them; the others are
    // convenience, already priced by ln(Frequency). Averaging would charge them
    // for options they were never going to take — the same reasoning M3-04
    // applies to a bank of departures.
    const legs = [...viaParis({ connect: 50 }), ...viaParis({ connect: 5 * 60 })];
    const all = enumerate(legs);
    const competitor = asConnectingCompetitor({ id: 'c', itineraries: all, reputation: 0.5 });

    const best = Math.min(...all.map((i) => connectionPenalty(i, 'business')));
    expect(competitor.connectionPenalty?.business).toBeCloseTo(best, 12);
  });

  it('carries a penalty for every segment', () => {
    const competitor = asConnectingCompetitor({ id: 'c', itineraries, reputation: 0.5 });
    for (const segment of DEMAND_SEGMENTS) {
      expect(competitor.connectionPenalty?.[segment]).toBeGreaterThan(0);
    }
  });

  it('refuses to compete with nothing', () => {
    expect(() => asConnectingCompetitor({ id: 'c', itineraries: [], reputation: 0.5 })).toThrow(
      /no valid connections/,
    );
  });

  it('refuses a discount that takes the fare below zero', () => {
    expect(() =>
      asConnectingCompetitor({
        id: 'c',
        itineraries,
        reputation: 0.5,
        connectionDiscountMinor: 20_000,
      }),
    ).toThrow(/below zero/);
  });

  it('drops straight into the logit beside a nonstop', () => {
    const result = computeShares({
      operators: [
        { id: 'nonstop', fareMinor: 20_000, frequency: 2, productScore: 0.6, reputation: 0.5 },
        asConnectingCompetitor({ id: 'connecting', itineraries, reputation: 0.5 }),
      ],
      segmentPools: { business: 200, leisure: 600, vfr: 200 },
    });

    // The decomposition has to show the connection as its own line, or "why am
    // I losing" cannot answer "because they fly you direct" (§14.1).
    const row = result.bySegment.business.operators.find((o) => o.operatorId === 'connecting');
    expect(row?.terms.connectionPenalty).toBeLessThan(0);
    // 0.9 base, plus λ for the quarter-hour this connection wastes beyond CDG's
    // 45-minute MCT: 0.25 × 0.25 = 0.0625. Asserted in full rather than as the
    // base alone, because the base alone would pass with λ deleted.
    expect(row?.terms.connectionPenalty).toBeCloseTo(-0.9625, 9);
  });
});

describe('proration — the third acceptance criterion', () => {
  const itinerary = enumerate(viaParis())[0]!;

  it('sums exactly to the itinerary fare', () => {
    // Proportional shares of an integer almost never divide evenly, and
    // rounding each independently loses or invents a unit — on a revenue split
    // that is a reconciliation failure, not a rounding detail.
    //
    // The symmetric itinerary is in here deliberately. Across *two* legs the
    // shares always sum to the fare, so independent rounding only goes wrong
    // when both fractional parts are exactly ½ — an even split of an odd fare.
    // Without that case this test passes against a naive implementation, which
    // is precisely what a mutation run showed.
    const symmetric = viaParis();
    symmetric[0]!.distanceNm = 400;
    symmetric[1]!.distanceNm = 400;
    const even = enumerate(symmetric)[0]!;

    for (const target of [itinerary, even]) {
      for (const fare of [0, 1, 7, 99, 100, 101, 12_345, 18_001, 999_983]) {
        const split = prorate(fare, target);
        expect(
          split.reduce((sum, l) => sum + l.shareMinor, 0),
          `fare ${String(fare)}`,
        ).toBe(fare);
      }
    }
  });

  it('gives the long premium leg more of it — A.14’s stated purpose', () => {
    const legs = viaParis();
    legs[0]!.productScore = 0.4;
    legs[1]!.productScore = 0.9;
    const [short, long] = prorate(10_000, enumerate(legs)[0]!);

    expect(long!.shareMinor).toBeGreaterThan(short!.shareMinor * 3);
  });

  it('weights by distance × product, not by distance alone', () => {
    const even = viaParis();
    even[0]!.distanceNm = 400;
    even[1]!.distanceNm = 400;
    even[0]!.productScore = 0.3;
    even[1]!.productScore = 0.9;

    const [a, b] = prorate(10_000, enumerate(even)[0]!);
    // Equal distances, so any difference is the product weight alone: 3:1.
    expect(b!.shareMinor).toBeCloseTo(a!.shareMinor * 3, -2);
  });

  it('splits evenly when there is no weight to go on', () => {
    const flat = viaParis();
    flat[0]!.productScore = 0;
    flat[1]!.productScore = 0;
    const split = prorate(1_000, enumerate(flat)[0]!);

    expect(split[0]!.shareMinor).toBe(500);
    expect(split[1]!.shareMinor).toBe(500);
  });

  it('is deterministic when the remainder has to break a tie', () => {
    const symmetric = viaParis();
    symmetric[0]!.distanceNm = 400;
    symmetric[1]!.distanceNm = 400;
    const itin = enumerate(symmetric)[0]!;

    // An odd fare across two identical legs: someone must get the extra unit,
    // and it must be the same someone every run.
    expect(prorate(101, itin)).toEqual(prorate(101, itin));
    expect(prorate(101, itin).reduce((s, l) => s + l.shareMinor, 0)).toBe(101);
  });

  it('refuses a fare that is not whole minor units', () => {
    expect(() => prorate(10.5, itinerary)).toThrow(/whole minor units/);
    expect(() => prorate(-1, itinerary)).toThrow(/whole minor units/);
  });
});

describe('caching per schedule change — the fourth acceptance criterion', () => {
  it('gives the same key for the same schedule, whatever order it arrives in', () => {
    const legs = viaParis();
    expect(scheduleFingerprint(legs)).toBe(scheduleFingerprint([...legs].reverse()));
  });

  it('changes when a departure moves', () => {
    const before = viaParis();
    const after = viaParis({ connect: 120 });
    expect(scheduleFingerprint(before)).not.toBe(scheduleFingerprint(after));
  });

  it('changes when a leg fills up', () => {
    // The invalidation easiest to forget: a leg selling out can invalidate a
    // connection without any schedule edit at all.
    const before = viaParis();
    const after = viaParis({ seats: 0 });
    expect(scheduleFingerprint(before)).not.toBe(scheduleFingerprint(after));
  });

  it('changes when a fare or a product score moves', () => {
    const base = viaParis();
    const repriced = viaParis();
    repriced[0]!.fareMinor = 9_500;
    const refitted = viaParis();
    refitted[1]!.productScore = 0.8;

    expect(scheduleFingerprint(base)).not.toBe(scheduleFingerprint(repriced));
    expect(scheduleFingerprint(base)).not.toBe(scheduleFingerprint(refitted));
  });

  it('is stable across calls, so it can key a cache at all', () => {
    const legs = viaParis();
    expect(scheduleFingerprint(legs)).toBe(scheduleFingerprint(legs));
    expect(scheduleFingerprint(legs)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('purity', () => {
  it('enumerates the same itineraries every time', () => {
    const legs = viaParis();
    const first = enumerate(legs);
    const second = enumerate(legs);

    expect(first).toEqual(second);
  });

  it('does not mutate the legs it was given', () => {
    const legs = viaParis();
    const snapshot = JSON.parse(JSON.stringify(legs)) as ItineraryLeg[];
    enumerate(legs);
    const itinerary: Itinerary = enumerate(legs)[0]!;
    prorate(9_999, itinerary);

    expect(legs).toEqual(snapshot);
  });
});
