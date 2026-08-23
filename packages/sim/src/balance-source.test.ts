import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import {
  DEFAULT_AIRPORT_FEES,
  DEFAULT_BOOKING_CURVE,
  DEFAULT_CLASS_MIX,
  DEFAULT_CREW,
  DEFAULT_DISRUPTION_COST,
  DEFAULT_GRAVITY,
  DEFAULT_ITINERARY,
  DEFAULT_LOGIT,
  DEFAULT_MODULATION,
  DEFAULT_NPC,
  DEFAULT_SCHED_FIT,
  DEFAULT_SEGMENTS,
  DEFAULT_SETTLEMENT,
  EFFICIENCY_CEILINGS,
  FARE_FLOOR_RATIO,
  VIABLE_DAILY_PASSENGERS,
} from './index';

/**
 * M3-11's first acceptance criterion: **no balance constant appears as a
 * literal in `packages/sim`.**
 *
 * The numbers live in `ECONOMY_CONFIG_V1` in `@tailfin/shared`, which is the
 * payload seeded into `economy_config` and the schema an admin's retune is
 * validated against. Everything `packages/sim` exports as a `DEFAULT_*` is a
 * slice of that object — the *same object*, not a copy of its values.
 *
 * Two checks, because either alone is escapable:
 *
 *   - **Identity.** `toBe`, not `toEqual`. A hand-copied table with the same
 *     numbers in it would satisfy `toEqual` and would be exactly the duplication
 *     this issue exists to remove: two places to change a coefficient, one of
 *     which is a deploy away from the live one.
 *   - **Source.** Identity says nothing about a scalar — a re-introduced
 *     `const FARE_FLOOR_RATIO = 0.6` would pass it. So the declarations are read
 *     off disk and each right-hand side is required to be a slice.
 *
 * A test rather than a lint rule because the interesting claim is about *where a
 * value came from*, which lint cannot see.
 */

const SIM_SRC = dirname(fileURLToPath(import.meta.url));

/** Every balance export, and the slice of the shipped payload it must be. */
const BALANCE_EXPORTS = [
  ['DEFAULT_GRAVITY', DEFAULT_GRAVITY, ECONOMY_CONFIG_V1.demand.gravity, 'demand/gravity.ts'],
  ['DEFAULT_SEGMENTS', DEFAULT_SEGMENTS, ECONOMY_CONFIG_V1.demand.segments, 'demand/gravity.ts'],
  [
    'VIABLE_DAILY_PASSENGERS',
    VIABLE_DAILY_PASSENGERS,
    ECONOMY_CONFIG_V1.demand.viableDailyPassengers,
    'demand/gravity.ts',
  ],
  [
    'DEFAULT_MODULATION',
    DEFAULT_MODULATION,
    ECONOMY_CONFIG_V1.demand.modulation,
    'demand/modulation.ts',
  ],
  ['DEFAULT_LOGIT', DEFAULT_LOGIT, ECONOMY_CONFIG_V1.demand.logit, 'demand/logit.ts'],
  [
    'DEFAULT_SCHED_FIT',
    DEFAULT_SCHED_FIT,
    ECONOMY_CONFIG_V1.demand.schedFit,
    'demand/sched-fit.ts',
  ],
  [
    'DEFAULT_CLASS_MIX',
    DEFAULT_CLASS_MIX,
    ECONOMY_CONFIG_V1.demand.classMix,
    'demand/class-allocation.ts',
  ],
  [
    'DEFAULT_BOOKING_CURVE',
    DEFAULT_BOOKING_CURVE,
    ECONOMY_CONFIG_V1.demand.bookingCurve,
    'demand/booking-curve.ts',
  ],
  [
    'DEFAULT_ITINERARY',
    DEFAULT_ITINERARY,
    ECONOMY_CONFIG_V1.demand.itinerary,
    'demand/itinerary.ts',
  ],
  ['DEFAULT_CREW', DEFAULT_CREW, ECONOMY_CONFIG_V1.crew, 'crew/complement.ts'],
  [
    'DEFAULT_SETTLEMENT',
    DEFAULT_SETTLEMENT,
    ECONOMY_CONFIG_V1.costs.settlement,
    'economy/settlement.ts',
  ],
  [
    'DEFAULT_AIRPORT_FEES',
    DEFAULT_AIRPORT_FEES,
    ECONOMY_CONFIG_V1.costs.defaultAirportFees,
    'economy/settlement.ts',
  ],
  [
    'DEFAULT_DISRUPTION_COST',
    DEFAULT_DISRUPTION_COST,
    ECONOMY_CONFIG_V1.costs.disruption,
    'economy/disruption-cost.ts',
  ],
  [
    'EFFICIENCY_CEILINGS',
    EFFICIENCY_CEILINGS,
    ECONOMY_CONFIG_V1.boosts.ceilings,
    'economy/boosts.ts',
  ],
  [
    'FARE_FLOOR_RATIO',
    FARE_FLOOR_RATIO,
    ECONOMY_CONFIG_V1.pricing.fareFloorRatio,
    'economy/fare-floor.ts',
  ],
  ['DEFAULT_NPC', DEFAULT_NPC, ECONOMY_CONFIG_V1.npc, 'npc/carrier.ts'],
] as const;

describe('where the balance numbers come from', () => {
  it.each(BALANCE_EXPORTS.filter(([, value]) => typeof value === 'object'))(
    '%s is the shipped payload’s own object, not a copy of it',
    (_name, value, slice) => {
      expect(value).toBe(slice);
    },
  );

  it.each(BALANCE_EXPORTS.filter(([, value]) => typeof value !== 'object'))(
    '%s is the shipped payload’s value',
    (_name, value, slice) => {
      expect(value).toBe(slice);
    },
  );

  it('declares every one of them as a slice, with no literal on the right', () => {
    // The check identity cannot make. A scalar re-introduced as
    // `export const FARE_FLOOR_RATIO = 0.6;` would satisfy every assertion
    // above and would be a second place to change a balance number.
    const offenders: string[] = [];

    for (const [name, , , file] of BALANCE_EXPORTS) {
      const source = readFileSync(join(SIM_SRC, file), 'utf8');
      const declaration = new RegExp(`^export const ${name}(?::[^=]+)? =\\s*([\\s\\S]*?);$`, 'm');
      const match = declaration.exec(source);

      if (!match) {
        offenders.push(`${name}: no declaration found in ${file}`);
        continue;
      }
      const rhs = match[1]?.trim() ?? '';
      if (!rhs.startsWith('ECONOMY_CONFIG_V1.')) {
        offenders.push(`${name} in ${file} is not a slice of ECONOMY_CONFIG_V1: ${rhs}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads the fuel price from the payload too, through a named field', () => {
    // `DEFAULT_FUEL_MARKET` is the one that is an object wrapping a slice rather
    // than a slice itself, because `FuelMarket` is a sim type that the payload
    // nests differently. Checked by value, and by source, for that reason.
    const source = readFileSync(join(SIM_SRC, 'economy/fuel-price.ts'), 'utf8');
    expect(source).toContain('ECONOMY_CONFIG_V1.fuel.basePricePerTonne');
    expect(source).not.toMatch(/basePricePerTonne:\s*1_000/);
  });
});

describe('what is deliberately still a literal', () => {
  it('leaves aircraft performance out of the economy', () => {
    // §22.3's list is the economy console's, and it does not include physics.
    // Payload/range, fuel-burn curves and flight profiles are the §22.5
    // catalogue, versioned by `world.aircraft_catalogue_version` — a fare change
    // and an aerodynamics change must not share a version number, or a
    // `flight_result` can no longer say which of the two explained it.
    const source = readFileSync(join(SIM_SRC, 'flight/fuel.ts'), 'utf8');
    expect(source).not.toContain('ECONOMY_CONFIG_V1');
  });
});
