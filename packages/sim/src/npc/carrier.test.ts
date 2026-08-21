import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, NPC_ARCHETYPES, type NpcArchetype } from '@tailfin/shared';

import { allocateByClass } from '../demand/class-allocation';
import { fareFloor, routeVariableCostPerSeatMinor } from '../economy/fare-floor';

import {
  asOperator,
  cabinsFor,
  DEFAULT_NPC,
  decideEntry,
  decideExit,
  decideFare,
  fareFor,
  frequencyFor,
  type MarketView,
  seatsPerDeparture,
} from './carrier';

/**
 * NPC carriers (M3-12, §24).
 *
 * The acceptance criterion these tests exist for is the fourth: *"NPCs never
 * receive resources or modifiers unavailable to players."* That is not provable
 * by reading the code — it is provable by showing an NPC's fare drawn against
 * the same cost model as a player's floor, and an NPC's share decided by the
 * same allocator.
 */

const profileOf = (archetype: NpcArchetype) => DEFAULT_NPC.archetypes[archetype];
const behaviour = DEFAULT_NPC.behaviour;

/** A fat, uncontested short-haul market — A.10's monopoly case. */
function market(over: Partial<MarketView> = {}): MarketView {
  return {
    originIcao: 'EHAM',
    destinationIcao: 'LEBL',
    greatCircleNm: 700,
    dailyPassengers: 900,
    segments: { business: 250, leisure: 500, vfr: 150 },
    incumbents: 0,
    variableCostPerSeatMinor: 6_000,
    floorMinor: 3_600,
    ...over,
  };
}

describe('what an NPC charges', () => {
  it('draws its fare against per-seat variable cost, so it scales with distance', () => {
    const profile = profileOf('flag');
    const short = fareFor(profile, 4_000, 2_400);
    const long = fareFor(profile, 22_000, 13_200);

    expect(short).toBe(Math.ceil(4_000 * profile.fareMarkup));
    expect(long).toBe(Math.ceil(22_000 * profile.fareMarkup));
    // A fixed per-archetype price would be extortionate on the short sector and
    // a giveaway on the long one. This is the property that avoids both.
    expect(long / short).toBeCloseTo(22_000 / 4_000, 6);
  });

  it('never sells below A.10’s floor, even where the markup would', () => {
    // The floor is a share of variable cost and so is the markup, so this can
    // only bite if a retune puts the markup under the floor ratio — which is
    // exactly when it must.
    const cheap = { ...profileOf('charter'), fareMarkup: 1 };
    expect(fareFor(cheap, 10_000, 9_000)).toBe(10_000);
    expect(fareFor(cheap, 10_000, 12_000)).toBe(12_000);
  });

  it('uses the same floor a player is refused at', () => {
    // Not a similar number — the same function, on the same inputs.
    const aircraft = {
      cruiseSpeedKt: 447,
      cruiseBurnTPerNm: 0.0062,
      maxTakeoffWeightT: 79,
      seatsByCabin: { business: 12, economy: 162 },
    };
    const fees = ECONOMY_CONFIG_V1.costs.defaultAirportFees;
    const cost = routeVariableCostPerSeatMinor(
      {
        distanceNm: 700,
        aircraft,
        market: { basePricePerTonne: ECONOMY_CONFIG_V1.fuel.basePricePerTonne },
        originStation: { icao: 'EHAM', ...ECONOMY_CONFIG_V1.fuel.defaultStation },
        originFees: fees,
        destinationFees: fees,
      },
      ECONOMY_CONFIG_V1.costs.settlement,
    );
    const floor = fareFloor(cost, ECONOMY_CONFIG_V1.pricing.fareFloorRatio);

    const fare = fareFor(profileOf('lcc'), cost.perSeatMinor, floor.floorMinor);
    expect(fare).toBeGreaterThanOrEqual(floor.floorMinor);
  });

  it('prices cabins above economy at a real premium', () => {
    const cabins = cabinsFor(profileOf('flag'), 10_000);
    expect(cabins.economy?.fareMinor).toBe(10_000);
    expect(cabins.business?.fareMinor).toBeGreaterThan(cabins.economy!.fareMinor * 2);
    // A business seat priced like an economy seat would be bought by everyone
    // and would make A.6's per-class allocation meaningless.
    expect(cabins.premium_economy?.fareMinor).toBeGreaterThan(cabins.economy!.fareMinor);
  });

  it('sells only the cabins its archetype fits', () => {
    expect(Object.keys(cabinsFor(profileOf('lcc'), 8_000))).toEqual(['economy']);
    expect(Object.keys(cabinsFor(profileOf('charter'), 8_000))).toEqual(['economy']);
    // The flag carrier's front cabin is why an LCC does not simply win
    // everywhere on price.
    expect(Object.keys(cabinsFor(profileOf('flag'), 8_000)).sort()).toEqual([
      'business',
      'economy',
      'premium_economy',
    ]);
  });
});

describe('how often an NPC flies', () => {
  it('sizes frequency to the share it wants, not to the whole market', () => {
    const profile = profileOf('lcc');
    const seats = seatsPerDeparture(profile);
    const freq = frequencyFor(profile, 2_000);
    expect(freq).toBe(Math.round((2_000 * profile.targetShare) / seats));
  });

  it('never plans zero departures, and never exceeds its cap', () => {
    for (const archetype of NPC_ARCHETYPES) {
      const profile = profileOf(archetype);
      expect(frequencyFor(profile, 0)).toBe(1);
      // Slots are finite (§8.1) even before they are modelled, so the cap is
      // real rather than cosmetic.
      expect(frequencyFor(profile, 10_000_000)).toBe(profile.maxFrequency);
    }
  });
});

describe('whether an NPC enters a market', () => {
  it('enters a fat uncontested market — A.10’s monopoly guard', () => {
    const verdict = decideEntry(market(), profileOf('lcc'), behaviour);
    expect(verdict.enter).toBe(true);
  });

  it('declines a market too thin for the archetype', () => {
    const verdict = decideEntry(market({ dailyPassengers: 20 }), profileOf('flag'), behaviour);
    expect(verdict.enter).toBe(false);
    if (verdict.enter) throw new Error('unreachable');
    expect(verdict.code).toBe('too-thin');
  });

  it('declines a sector beyond the archetype’s reach', () => {
    const verdict = decideEntry(
      market({ greatCircleNm: 5_500, dailyPassengers: 1_200 }),
      profileOf('regional'),
      behaviour,
    );
    expect(verdict.enter).toBe(false);
    if (verdict.enter) throw new Error('unreachable');
    // Range is checked before margin, so the reason is the true one.
    expect(verdict.code).toBe('out-of-range');
  });

  it('needs a better market to enter a contested one', () => {
    const empty = decideEntry(market(), profileOf('lcc'), behaviour);
    const crowded = decideEntry(market({ incumbents: 6 }), profileOf('lcc'), behaviour);
    expect(empty.enter).toBe(true);
    // Not forbidden — just a higher bar, which is what keeps a market from
    // being permanently closed to entry once anyone is in it.
    expect(crowded.enter).toBe(false);
  });

  it('sends a charter to a holiday market and not to a business one', () => {
    // The same physical route, the same size, the same cost — only the segment
    // mix differs. A charter's product suits one and not the other, so it fills
    // the aircraft on one and flies it half empty on the other, and *that* is
    // what makes the route pay or not. The bar is the same for both.
    const holiday = market({ segments: { business: 40, leisure: 700, vfr: 160 } });
    const corporate = market({ segments: { business: 700, leisure: 140, vfr: 60 } });

    const onHoliday = decideEntry(holiday, profileOf('charter'), behaviour);
    const onCorporate = decideEntry(corporate, profileOf('charter'), behaviour);

    expect(onHoliday.expectedLoadFactor).toBeGreaterThan(onCorporate.expectedLoadFactor);
    expect(onHoliday.estimatedMargin).toBeGreaterThan(onCorporate.estimatedMargin);
    expect(onHoliday.enter).toBe(true);
    expect(onCorporate.enter).toBe(false);
  });

  it('sends a flag carrier the other way, on the same two markets', () => {
    // The mirror image, and the reason the archetypes are worth having: a flag
    // carrier's mild negative leisure affinity makes the business market the
    // better one for it. Two carriers, two opposite conclusions, same function.
    const holiday = market({ segments: { business: 40, leisure: 700, vfr: 160 } });
    const corporate = market({ segments: { business: 700, leisure: 140, vfr: 60 } });

    const flag = profileOf('flag');
    expect(decideEntry(corporate, flag, behaviour).expectedLoadFactor).toBeGreaterThan(
      decideEntry(holiday, flag, behaviour).expectedLoadFactor,
    );
  });

  it('breaks even at the load factor its markup implies', () => {
    // The property the load-factor model exists to give: an LCC needs a much
    // fuller aircraft than a flag carrier, because its fare is much closer to
    // its cost. `1/markup` is that break-even, and it is the reason low-cost
    // carriers in reality obsess over load factor.
    for (const archetype of NPC_ARCHETYPES) {
      const profile = profileOf(archetype);
      expect(1 / profile.fareMarkup).toBeLessThanOrEqual(1);
    }
    expect(1 / profileOf('lcc').fareMarkup).toBeGreaterThan(1 / profileOf('flag').fareMarkup);
  });

  it('reports a load factor with its verdict, so the log can say why', () => {
    const verdict = decideEntry(market(), profileOf('flag'), behaviour);
    expect(verdict.expectedLoadFactor).toBeGreaterThan(0);
    expect(verdict.expectedLoadFactor).toBeLessThanOrEqual(1);
  });

  it('refuses a market where its own fare would not clear its own cost', () => {
    const verdict = decideEntry(
      market({ variableCostPerSeatMinor: 0 }),
      profileOf('flag'),
      behaviour,
    );
    expect(verdict.enter).toBe(false);
    if (verdict.enter) throw new Error('unreachable');
    expect(verdict.code).toBe('no-viable-fare');
  });

  it('is deterministic', () => {
    const m = market({ dailyPassengers: 613, incumbents: 2 });
    const once = decideEntry(m, profileOf('flag'), behaviour);
    const twice = decideEntry(m, profileOf('flag'), behaviour);
    expect(once).toEqual(twice);
  });
});

describe('whether an NPC leaves a market', () => {
  it('needs sustained loss, not one bad review', () => {
    expect(decideExit(1, behaviour)).toBe(false);
    expect(decideExit(behaviour.exitLossReviews - 1, behaviour)).toBe(false);
    expect(decideExit(behaviour.exitLossReviews, behaviour)).toBe(true);
  });
});

describe('how an NPC moves a fare', () => {
  it('moves part of the way toward the market, keeping its own economics', () => {
    const move = decideFare(10_000, 10_000, 16_000, 3_000, behaviour);
    expect(move.changed).toBe(true);
    // A third of the gap, not the whole of it: a carrier that jumped to the
    // market mean would collapse every market onto one fare in a single review.
    expect(move.fareMinor).toBe(Math.round(10_000 + 6_000 * behaviour.fareAdjustmentRate));
    expect(move.fareMinor).toBeLessThan(16_000);
  });

  it('will not follow a market below the floor', () => {
    const move = decideFare(9_000, 9_000, 1_000, 8_000, behaviour);
    expect(move.fareMinor).toBe(8_000);
  });

  it('leaves a fare alone inside the deadband, so the log stays readable', () => {
    const move = decideFare(10_000, 10_050, 10_050, 3_000, behaviour);
    expect(move.changed).toBe(false);
    expect(move.fareMinor).toBe(10_000);
  });

  it('sets a fare where there was none', () => {
    const move = decideFare(0, 12_000, 0, 3_000, behaviour);
    expect(move).toEqual({ changed: true, fareMinor: 12_000 });
  });
});

describe('an NPC in the demand model', () => {
  it('is allocated by exactly the same code as a player', () => {
    // The no-cheating criterion, demonstrated rather than asserted: build one
    // player-shaped operator and one NPC-shaped operator, hand both to
    // `allocateByClass`, and show it neither knows nor cares which is which.
    const flag = profileOf('flag');
    const npc = asOperator(
      {
        operatorId: 'npc-flag',
        frequency: frequencyFor(flag, 900),
        economyFareMinor: 12_000,
        cabins: cabinsFor(flag, 12_000),
      },
      flag,
    );

    const player = {
      id: 'player',
      frequency: 3,
      productScore: 0.62,
      reputation: 0.55,
      cabins: { economy: { seats: 160, fareMinor: 9_500 } },
    };

    const result = allocateByClass({
      operators: [player, npc],
      segmentPools: { business: 250, leisure: 500, vfr: 150 },
    });

    const total = (id: string) =>
      (result.byOperator[id] ?? []).reduce((sum, row) => sum + row.passengers, 0);

    expect(total('player')).toBeGreaterThan(0);
    expect(total('npc-flag')).toBeGreaterThan(0);
    // The cheaper, economy-only player should win the leisure-heavy economy
    // cabin; the flag carrier's business cabin is uncontested.
    const economy = result.byCabin.find((c) => c.cabin === 'economy');
    const business = result.byCabin.find((c) => c.cabin === 'business');
    expect(economy?.shares?.totalPassengers.player ?? 0).toBeGreaterThan(
      economy?.shares?.totalPassengers['npc-flag'] ?? 0,
    );
    expect(business?.shares?.totalPassengers['npc-flag'] ?? 0).toBeGreaterThan(0);
  });

  it('carries no field a player operator cannot have', () => {
    const flag = profileOf('flag');
    const npc = asOperator(
      { operatorId: 'n', frequency: 2, economyFareMinor: 9_000, cabins: cabinsFor(flag, 9_000) },
      flag,
    );
    // If an NPC ever gained a bonus, it would have to appear as a key here —
    // `ClassOperator` is the entire surface the demand model sees.
    expect(Object.keys(npc).sort()).toEqual([
      'cabins',
      'frequency',
      'id',
      'productScore',
      'reputation',
    ]);
  });
});
