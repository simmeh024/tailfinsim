import { describe, expect, it } from 'vitest';

import { deriveRng } from '../random';

import {
  applicableOutcome,
  causeHazards,
  DEFAULT_DISRUPTION,
  DISRUPTION_CAUSES,
  type DisruptionCause,
  disruptionProbability,
  type DisruptionRisk,
  NO_RISK,
  outcomeIsPossible,
  rollDisruption,
} from './disruption';
import { planFlight } from './machine';
import { DEFAULT_FLIGHT_PROFILE } from './profile';

/**
 * The disruption model (M2-08, §8.4).
 *
 * Four claims, and the first is the acceptance criterion everything else rests
 * on:
 *
 *   1. **The same flight in the same world is always disrupted the same way**,
 *      regardless of what else happened first.
 *   2. Every disruption records a cause, and the likeliest cause is the likeliest
 *      to be blamed.
 *   3. One roll, not six — adding a cause changes the mix, not the scale.
 *   4. The outcome is possible from the phase the flight is actually in, and
 *      `machine.ts` agrees about which those are.
 */

function risk(overrides: Partial<DisruptionRisk> = {}): DisruptionRisk {
  return { ...NO_RISK, ...overrides };
}

/**
 * The first flight in a run that actually gets disrupted.
 *
 * Tests about *what a disruption looks like* should not depend on a particular
 * seed happening to fall below the threshold — that couples them to the RNG's
 * internals, and they would break on any retune of the rates.
 */
function firstRoll(r: DisruptionRisk) {
  for (let i = 0; i < 500; i += 1) {
    const roll = rollDisruption(deriveRng('w', 'flight', `f-${String(i)}`), r);
    if (roll) return roll;
  }
  throw new Error('no disruption in 500 flights — the risk given is too low to test with');
}

/** Roll `n` flights of one world and count what happened. */
function sample(
  worldSeed: string,
  n: number,
  r: DisruptionRisk,
): { disrupted: number; causes: Map<DisruptionCause, number> } {
  const causes = new Map<DisruptionCause, number>();
  let disrupted = 0;

  for (let i = 0; i < n; i += 1) {
    const roll = rollDisruption(deriveRng(worldSeed, 'flight', `f-${String(i)}`), r);
    if (roll) {
      disrupted += 1;
      causes.set(roll.cause, (causes.get(roll.cause) ?? 0) + 1);
    }
  }

  return { disrupted, causes };
}

describe('rollDisruption', () => {
  it('leaves a flight alone when nothing is going wrong anywhere', () => {
    // The honest default while weather, ATC and maintenance do not exist: a
    // world with no weather model has no weather disruption.
    for (let i = 0; i < 100; i += 1) {
      expect(rollDisruption(deriveRng('w', 'flight', String(i)), NO_RISK)).toBeNull();
    }
  });

  describe('reproducibility — M2-08’s first acceptance criterion', () => {
    it('gives the same flight the same answer every time', () => {
      const r = risk({ atcFlow: 0.8, weatherOrigin: 0.5 });

      const once = rollDisruption(deriveRng('world-1', 'flight', 'abc'), r);
      const twice = rollDisruption(deriveRng('world-1', 'flight', 'abc'), r);

      expect(once).toEqual(twice);
    });

    it('is unaffected by how many other flights were rolled first', () => {
      // The property a single sequential generator cannot provide, and the
      // reason streams are derived per flight. Flights are materialised in
      // batches and drained by a queue that may run two workers; the answer
      // must not depend on the interleaving.
      const r = risk({ atcFlow: 0.8 });
      const alone = rollDisruption(deriveRng('world-1', 'flight', 'target'), r);

      for (let i = 0; i < 200; i += 1) {
        rollDisruption(deriveRng('world-1', 'flight', `noise-${String(i)}`), r);
      }

      expect(rollDisruption(deriveRng('world-1', 'flight', 'target'), r)).toEqual(alone);
    });

    it('gives two worlds different weather on the same flight id', () => {
      const r = risk({ weatherOrigin: 0.9, atcFlow: 0.9 });
      const a = sample('world-a', 200, r);
      const b = sample('world-b', 200, r);

      expect(a.disrupted).not.toBe(b.disrupted);
    });

    it('re-rolls a world after its seed changes, which is what a reset does', () => {
      // Compared across a run of flights rather than one, because a single
      // flight may legitimately be undisrupted under both seeds — that is not
      // evidence the seed did nothing.
      const r = risk({ atcFlow: 0.8 });
      const before = sample('seed-before', 200, r);
      const after = sample('seed-after', 200, r);

      expect(before.disrupted).not.toBe(after.disrupted);
    });
  });

  describe('one roll, not six', () => {
    it('never reports more than one cause', () => {
      // A flight cannot be cancelled for crew timeout *and* diverted for
      // weather. The type enforces it; this proves the model does not want to.
      const everything = risk({
        weatherOrigin: 1,
        weatherDestination: 1,
        atcFlow: 1,
        technical: 1,
        crewTimeout: 1,
        groundVendor: 1,
      });

      const roll = firstRoll(everything);
      expect(roll).not.toBeNull();
      expect(DISRUPTION_CAUSES).toContain(roll?.cause);
    });

    it('caps how bad a single flight’s day can get', () => {
      // A world where every flight is disrupted is not hard, it is broken — the
      // player stops being able to tell a good decision from a bad one.
      const catastrophe = risk({
        weatherOrigin: 1,
        weatherDestination: 1,
        atcFlow: 1,
        technical: 1,
        crewTimeout: 1,
        groundVendor: 1,
        airportClosure: 1,
      });

      const { disrupted } = sample('w', 400, catastrophe);
      expect(disrupted / 400).toBeLessThanOrEqual(DEFAULT_DISRUPTION.maxProbability + 0.06);
      // And it must still be brutal — this is a closed airport in a storm.
      expect(disrupted / 400).toBeGreaterThan(0.45);
    });

    it('reports the probability that produced it, for the attribution readout', () => {
      const roll = firstRoll(risk({ atcFlow: 1 }));

      expect(roll?.probability).toBe(disruptionProbability(risk({ atcFlow: 1 })));
      expect(roll?.probability).toBeGreaterThan(0);
    });
  });

  describe('attribution', () => {
    it('blames the cause that was actually likeliest', () => {
      // §14.1: a number a player cannot interrogate is a number they will not
      // trust. Attribution that did not track the hazards would be decoration.
      const { causes } = sample('w', 600, risk({ atcFlow: 0.9, technical: 0.05 }));

      expect(causes.get('atc_flow') ?? 0).toBeGreaterThan((causes.get('technical') ?? 0) * 3);
    });

    it('never blames a cause that was not present', () => {
      const { causes } = sample('w', 400, risk({ crewTimeout: 1 }));

      expect([...causes.keys()]).toEqual(['crew_timeout']);
    });

    it('exposes each cause’s share without rolling anything', () => {
      const hazards = causeHazards(risk({ atcFlow: 1, technical: 1 }));
      const byCause = new Map(hazards.map((h) => [h.cause, h.hazard]));

      expect(byCause.get('atc_flow')).toBeCloseTo(DEFAULT_DISRUPTION.causes.atc_flow.hazard, 10);
      expect(byCause.get('weather_origin')).toBe(0);
      expect(hazards).toHaveLength(DISRUPTION_CAUSES.length);
    });

    it('refuses a risk outside 0–1 rather than extrapolating from it', () => {
      expect(() => causeHazards(risk({ atcFlow: 4 }))).toThrow(/atc_flow/);
    });
  });

  describe('what each cause does', () => {
    it('delays for weather at the origin and diverts for weather at the destination', () => {
      // The asymmetry that makes the two ends different causes rather than one:
      // an aeroplane that has not left waits, one already airborne with nowhere
      // to land goes elsewhere.
      const origin = DEFAULT_DISRUPTION.causes.weather_origin.outcomes;
      const destination = DEFAULT_DISRUPTION.causes.weather_destination.outcomes;

      expect(origin.divert).toBe(0);
      expect(destination.divert).toBeGreaterThan(0);
    });

    it('is the only cause that can produce an air return, for a technical fault', () => {
      // A fault appearing after takeoff is the textbook reason to come back.
      const canAirReturn = DISRUPTION_CAUSES.filter(
        (c) => DEFAULT_DISRUPTION.causes[c].outcomes.airReturn > 0,
      );

      expect(canAirReturn).toEqual(['technical']);
    });

    it('mostly cancels for a crew timeout — waiting does not make a crew legal', () => {
      const outcomes = DEFAULT_DISRUPTION.causes.crew_timeout.outcomes;

      expect(outcomes.cancel).toBeGreaterThan(outcomes.delay);
    });

    it('gives a delay a length inside the cause’s range', () => {
      for (let i = 0; i < 200; i += 1) {
        const roll = rollDisruption(deriveRng('w', 'f', String(i)), risk({ atcFlow: 1 }));
        if (roll?.outcome === 'delay') {
          const [low, high] = DEFAULT_DISRUPTION.causes.atc_flow.delayRange;
          expect(roll.delayMinutes).toBeGreaterThanOrEqual(low);
          expect(roll.delayMinutes).toBeLessThanOrEqual(high);
        } else if (roll) {
          // Anything that ends the flight rather than moving it carries no delay.
          expect(roll.delayMinutes).toBe(0);
        }
      }
    });

    it('maps every outcome onto a flight disruption the schema knows', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 400; i += 1) {
        const roll = rollDisruption(
          deriveRng('w', 'f', String(i)),
          risk({ technical: 1, airportClosure: 0.3 }),
        );
        if (roll) seen.add(roll.disruption);
      }

      for (const disruption of seen) {
        expect(['delayed', 'cancelled', 'diverted', 'air_return']).toContain(disruption);
      }
    });
  });

  describe('§10.4 boosts', () => {
    it('makes a boosted airline measurably luckier', () => {
      const exposed = risk({ atcFlow: 0.9, weatherOrigin: 0.6 });
      const boosted = risk({
        ...exposed,
        boosts: [{ id: 'ops-doctrine', fraction: 0.3 }],
      });

      const plain = sample('w', 800, exposed).disrupted;
      const lucky = sample('w', 800, boosted).disrupted;

      expect(lucky).toBeLessThan(plain);
    });

    it('never exceeds §10.4’s −30% ceiling, however many are stacked', () => {
      // "A year-one player must never face an unbeatable wall of stacked
      // veteran bonuses." Ten 20% boosts still buy exactly 30%.
      const many = Array.from({ length: 10 }, (_, i) => ({
        id: `b-${String(i)}`,
        fraction: 0.2,
      }));

      const capped = disruptionProbability(risk({ atcFlow: 1, boosts: many }));
      const exactly = disruptionProbability(
        risk({ atcFlow: 1, boosts: [{ id: 'one', fraction: 0.3 }] }),
      );
      const none = disruptionProbability(risk({ atcFlow: 1 }));

      expect(capped).toBeCloseTo(exactly, 10);
      expect(capped).toBeCloseTo(none * 0.7, 10);
    });
  });
});

describe('outcomes have to be possible from where the flight is', () => {
  it('cannot cancel an aeroplane that is already flying', () => {
    expect(outcomeIsPossible('cancel', true)).toBe(false);
    expect(outcomeIsPossible('cancel', false)).toBe(true);
  });

  it('cannot divert or air-return one still on the stand', () => {
    expect(outcomeIsPossible('divert', false)).toBe(false);
    expect(outcomeIsPossible('air_return', false)).toBe(false);
  });

  it('can always delay', () => {
    expect(outcomeIsPossible('delay', true)).toBe(true);
    expect(outcomeIsPossible('delay', false)).toBe(true);
  });

  describe('applicableOutcome', () => {
    const roll = {
      cause: 'technical' as const,
      outcome: 'cancel' as const,
      delayMinutes: 0,
      disruption: 'cancelled' as const,
      probability: 0.5,
    };

    it('turns a cancellation rolled in the cruise into an air return', () => {
      const airborne = applicableOutcome(roll, true);

      expect(airborne.outcome).toBe('air_return');
      expect(airborne.disruption).toBe('air_return');
    });

    it('turns a diversion rolled on the stand into a delay', () => {
      const onStand = applicableOutcome(
        { ...roll, outcome: 'divert', disruption: 'diverted' },
        false,
      );

      expect(onStand.outcome).toBe('delay');
    });

    it('never rewrites the cause — what went wrong is a fact', () => {
      // Only what the aeroplane does about it depends on the phase.
      expect(applicableOutcome(roll, true).cause).toBe('technical');
    });

    it('leaves an already-possible outcome alone', () => {
      expect(applicableOutcome(roll, false)).toBe(roll);
    });
  });

  it('agrees with machine.ts about which phases are airborne', () => {
    // The two must not drift. `machine.ts` refuses an illegal command; this
    // picks a legal outcome, and if they disagreed the disruption would be
    // rolled and then silently dropped.
    const state = planFlight(
      {
        originIcao: 'EHAM',
        destinationIcao: 'EGLL',
        distanceNm: 200,
        cruiseSpeedKt: 275,
        cruiseAltitudeFt: 24_000,
        createdAt: new Date('2026-08-17T00:00:00.000Z'),
        scheduledDeparture: new Date('2026-08-17T06:00:00.000Z'),
        turnaroundMinutes: 40,
      },
      DEFAULT_FLIGHT_PROFILE,
    );

    // A freshly planned flight is on the stand, so cancellation is what is open
    // to it and a diversion is not.
    expect(state.phase).toBe('scheduled');
    expect(outcomeIsPossible('cancel', false)).toBe(true);
    expect(outcomeIsPossible('divert', false)).toBe(false);
  });
});
