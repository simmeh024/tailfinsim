import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';
import { DEFAULT_FUEL_MARKET } from '@tailfin/sim';
import type { ClassOperator } from '@tailfin/sim';

import { buildCompetition, type OperatorName } from './competition';
import {
  REFERENCE_FEES,
  REFERENCE_HANDLING_PRICE_FACTOR,
  REFERENCE_SELF,
  REFERENCE_STATION,
} from './economics';

import type { RouteEconomics, RouteRow } from './fares';
import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * The live competition read (M3-12, §8.3, A.3–A.4).
 *
 * Built on A.8's worked market, like the waterfall, so the shares are the logit's
 * own and can be reasoned about. Proves what this file adds on top of the share
 * model: you are in the market, everyone's share is derived from the *one*
 * allocation, and the list is ordered by who holds the market.
 */

const POOLS: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };

const YOU_ID = '00000000-0000-4000-8000-000000000001';
const LCC_ID = '00000000-0000-4000-8000-000000000002';
const LEGACY_ID = '00000000-0000-4000-8000-000000000003';

/** A.8's Rival A — the LCC, €69, five times daily. */
const LCC: ClassOperator = {
  id: LCC_ID,
  frequency: 5,
  productScore: 0.38,
  reputation: 0.45,
  cabins: { economy: { seats: 5_000, fareMinor: 6_900 } },
};

/** A.8's Rival B — the legacy carrier, €140, four times daily. */
const LEGACY: ClassOperator = {
  id: LEGACY_ID,
  frequency: 4,
  productScore: 0.78,
  reputation: 0.72,
  cabins: { economy: { seats: 5_000, fareMinor: 14_000 } },
};

const ECONOMICS: RouteEconomics = {
  aircraft: {
    cruiseSpeedKt: 447,
    cruiseBurnTPerNm: 0.0062,
    maxTakeoffWeightT: 79,
    seatsByCabin: { economy: 5_000 },
  },
  fleet: [
    {
      cruiseSpeedKt: 447,
      cruiseBurnTPerNm: 0.0062,
      maxTakeoffWeightT: 79,
      seatsByCabin: { economy: 5_000 },
    },
  ],
  basis: { kind: 'single' as const, label: 'test aircraft' },
  market: DEFAULT_FUEL_MARKET,
  originStation: REFERENCE_STATION,
  handlingPriceFactor: REFERENCE_HANDLING_PRICE_FACTOR,
  originFees: REFERENCE_FEES,
  destinationFees: REFERENCE_FEES,
  segmentPools: POOLS,
  competitors: [LCC, LEGACY],
  self: { ...REFERENCE_SELF, frequency: 4 },
  settlement: {} as RouteEconomics['settlement'],
  fareFloorRatio: 0.6,
};

const ROUTE: RouteRow = {
  id: 'route-1',
  worldId: 'world-1',
  airlineId: YOU_ID,
  originIcao: 'AAAA',
  destinationIcao: 'BBBB',
  greatCircleNm: 500,
  // €95, the A.8 fare for "you".
  fares: { economy: 9_500 },
};

const OWN: ResolvedPlayerAirline = { id: YOU_ID, worldId: 'world-1', status: 'active' };

const NAMES: ReadonlyMap<string, OperatorName> = new Map([
  [YOU_ID, { name: 'Your Airline', kind: 'player' }],
  [LCC_ID, { name: 'Budget Air', kind: 'npc' }],
  [LEGACY_ID, { name: 'Legacy Lines', kind: 'player' }],
]);

describe('buildCompetition', () => {
  it('includes you as one operator among the rivals', () => {
    const market = buildCompetition(OWN, ROUTE, ECONOMICS, NAMES);
    expect(market.operators).toHaveLength(3);
    const you = market.operators.find((o) => o.isYou);
    expect(you?.airlineId).toBe(YOU_ID);
    expect(you?.name).toBe('Your Airline');
    // 4 daily → 28 weekly.
    expect(you?.economyFareMinor).toBe(9_500);
    expect(you?.weeklyFrequency).toBe(28);
    // Exactly one operator is you.
    expect(market.operators.filter((o) => o.isYou)).toHaveLength(1);
  });

  it('derives every share from one allocation and orders by market held', () => {
    const market = buildCompetition(OWN, ROUTE, ECONOMICS, NAMES);
    // Ordered by share, descending.
    for (let i = 1; i < market.operators.length; i += 1) {
      expect(market.operators[i - 1]!.share).toBeGreaterThanOrEqual(market.operators[i]!.share);
    }
    // Shares are a division of the same market — they cannot exceed it.
    const total = market.operators.reduce((sum, o) => sum + o.share, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(1 + 1e-9);
    expect(market.marketDailyPassengers).toBeCloseTo(1_200, 6);
  });

  it('carries each operator’s kind and headline fare', () => {
    const market = buildCompetition(OWN, ROUTE, ECONOMICS, NAMES);
    const lcc = market.operators.find((o) => o.airlineId === LCC_ID);
    expect(lcc?.kind).toBe('npc');
    expect(lcc?.economyFareMinor).toBe(6_900);
    expect(lcc?.weeklyFrequency).toBe(35); // 5 daily
  });

  it('gives a monopolist the whole market', () => {
    const market = buildCompetition(OWN, ROUTE, { ...ECONOMICS, competitors: [] }, NAMES);
    expect(market.operators).toHaveLength(1);
    expect(market.operators[0]?.isYou).toBe(true);
    expect(market.operators[0]?.share).toBeCloseTo(1, 6);
  });
});
