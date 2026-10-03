import { describe, expect, it } from 'vitest';

import {
  ECONOMY_CONFIG_V1,
  SHIPPED_TRAINING_CAPTAIN_BALANCE,
  TrainingCaptainBalance,
  type CrewRank,
} from '@tailfin/shared';

import { EFFICIENCY_CEILINGS, resolveEfficiencyBoosts } from '../economy/boosts';
import { createRng, type Rng } from '../random';

import { levelForXp, xpForLevel } from './skills';
import {
  crewBoostSources,
  isFlightDeckRank,
  trainedXpPerHead,
  trainingCaptainRefusal,
  trainingXpMultiplier,
  type RosterCrew,
  type TrainingCaptainCandidate,
} from './training-captain';

/**
 * §10.2's Training Captains (M9-04).
 *
 * Two acceptance criteria live here:
 *
 *   - *"Conversion is reversible at a cost"* is the server's (the fee is a cash
 *     movement); what is proved here is who may convert, and in which order the
 *     reasons they may not are given.
 *   - *"The XP multiplier is capped so the loop converges rather than runs
 *     away"* is proved twice: as a **property** over seeded random balances,
 *     and as a **simulation** of the loop itself, in which every pilot who
 *     reaches the top converts and the bench's XP is shown to grow linearly.
 */

const SKILLS = ECONOMY_CONFIG_V1.crew.skills;
const TC = ECONOMY_CONFIG_V1.crew.trainingCaptain;

function candidate(over: Partial<TrainingCaptainCandidate> = {}): TrainingCaptainCandidate {
  return { rank: 'captain', level: SKILLS.maxLevel, trainingCaptain: false, ...over };
}

describe('who may become a Training Captain', () => {
  it('converts a max-level captain at a Centre of Excellence', () => {
    expect(trainingCaptainRefusal(candidate(), 5, { skills: SKILLS })).toBeNull();
  });

  it('accepts a pilot already hired at Training Captain rank, who is not yet designated', () => {
    expect(
      trainingCaptainRefusal(candidate({ rank: 'training_captain' }), 5, { skills: SKILLS }),
    ).toBeNull();
  });

  it('never converts cabin crew', () => {
    for (const rank of ['cabin_crew', 'senior_cabin_crew', 'purser', 'cabin_service_manager']) {
      expect(
        trainingCaptainRefusal(candidate({ rank: rank as CrewRank }), 5, { skills: SKILLS }),
      ).toBe('not_flight_deck');
    }
  });

  it('never converts a pilot below command rank', () => {
    for (const rank of ['cadet', 'first_officer', 'senior_first_officer']) {
      expect(
        trainingCaptainRefusal(candidate({ rank: rank as CrewRank }), 5, { skills: SKILLS }),
      ).toBe('not_command_rank');
    }
  });

  it('needs §10.2’s "max-level"', () => {
    expect(
      trainingCaptainRefusal(candidate({ level: SKILLS.maxLevel - 1 }), 5, { skills: SKILLS }),
    ).toBe('below_max_level');
  });

  it('refuses one who already holds it', () => {
    expect(
      trainingCaptainRefusal(candidate({ trainingCaptain: true }), 5, { skills: SKILLS }),
    ).toBe('already_training_captain');
  });

  it('needs an academy at the member’s base, and a building site is not one', () => {
    expect(trainingCaptainRefusal(candidate(), null, { skills: SKILLS })).toBe('no_academy');
    expect(trainingCaptainRefusal(candidate(), 0, { skills: SKILLS })).toBe('no_academy');
  });

  it('needs the academy to permit the rank — level 5, read from §10.1’s ladder', () => {
    for (const level of [1, 2, 3, 4]) {
      expect(trainingCaptainRefusal(candidate(), level, { skills: SKILLS })).toBe('academy_level');
    }
  });

  describe('gives the most permanent answer first', () => {
    it('tells a purser they never will, rather than to build an academy', () => {
      expect(
        trainingCaptainRefusal(candidate({ rank: 'purser', level: 1 }), null, { skills: SKILLS }),
      ).toBe('not_flight_deck');
    });

    it('tells a first officer about rank before level or academy', () => {
      expect(
        trainingCaptainRefusal(candidate({ rank: 'first_officer', level: 3 }), null, {
          skills: SKILLS,
        }),
      ).toBe('not_command_rank');
    });

    it('says a Training Captain is one, even after a retune raised the top level', () => {
      // A retune of `maxLevel` must not tell an existing Training Captain to
      // "reach level 25 first" — the answer that matters is that they hold it.
      expect(
        trainingCaptainRefusal(candidate({ trainingCaptain: true, level: 3 }), null, {
          skills: SKILLS,
        }),
      ).toBe('already_training_captain');
    });

    it('tells a captain to keep flying before sending them after a building', () => {
      expect(trainingCaptainRefusal(candidate({ level: 9 }), null, { skills: SKILLS })).toBe(
        'below_max_level',
      );
      expect(trainingCaptainRefusal(candidate({ level: 9 }), 3, { skills: SKILLS })).toBe(
        'below_max_level',
      );
    });
  });

  it('reads the top level from the balance, not from a constant', () => {
    expect(trainingCaptainRefusal(candidate({ level: 7 }), 5, { skills: { maxLevel: 7 } })).toBe(
      null,
    );
  });
});

describe('the XP multiplier', () => {
  it('is exactly 1 with no Training Captains and no doctrine', () => {
    const m = trainingXpMultiplier({ trainingCaptains: 0, flightDeckHeads: 120 }, TC);
    expect(m).toEqual({
      multiplier: 1,
      bonus: 0,
      coverage: 0,
      fromTrainingCaptains: 0,
      fromDoctrine: 0,
      capped: false,
    });
  });

  it('pays a Training Captain their share of the heads they cover', () => {
    // One covers `crewsPerTrainingCaptain`, so at twice that many heads they
    // cover half of them and are worth half the full-coverage bonus.
    const heads = TC.crewsPerTrainingCaptain * 2;
    const m = trainingXpMultiplier({ trainingCaptains: 1, flightDeckHeads: heads }, TC);
    expect(m.coverage).toBeCloseTo(0.5, 12);
    expect(m.bonus).toBeCloseTo(TC.xpBonusAtFullCoverage / 2, 12);
    expect(m.multiplier).toBeCloseTo(1 + TC.xpBonusAtFullCoverage / 2, 12);
  });

  it('stops at full coverage: more Training Captains add nothing', () => {
    const heads = 40;
    const full = Math.ceil(heads / TC.crewsPerTrainingCaptain);
    const atFull = trainingXpMultiplier({ trainingCaptains: full, flightDeckHeads: heads }, TC);
    const beyond = trainingXpMultiplier(
      { trainingCaptains: full + 10, flightDeckHeads: heads },
      TC,
    );
    expect(atFull.coverage).toBe(1);
    expect(beyond).toEqual(atFull);
    expect(atFull.multiplier).toBeCloseTo(1 + TC.xpBonusAtFullCoverage, 12);
  });

  it('gives a base with no pilots no bonus, not a division by zero', () => {
    const m = trainingXpMultiplier({ trainingCaptains: 3, flightDeckHeads: 0 }, TC);
    expect(m.coverage).toBe(0);
    expect(m.multiplier).toBe(1);
  });

  it('caps the combined bonus, shared with doctrine', () => {
    const m = trainingXpMultiplier(
      { trainingCaptains: 100, flightDeckHeads: 12, doctrineXpFraction: 0.5 },
      TC,
    );
    expect(m.capped).toBe(true);
    expect(m.bonus).toBe(TC.maxXpBonus);
    expect(m.multiplier).toBe(1 + TC.maxXpBonus);
    // The parts are still reported uncapped, so the page can say which source
    // ran into the ceiling.
    expect(m.fromTrainingCaptains).toBe(TC.xpBonusAtFullCoverage);
    expect(m.fromDoctrine).toBe(0.5);
  });

  it('leaves room under the cap for doctrine at full coverage', () => {
    // The shipped balance's whole point: Training Captains alone do not fill the
    // cap, so M9-05's Crew Development branch still has something to give.
    const full = trainingXpMultiplier({ trainingCaptains: 99, flightDeckHeads: 12 }, TC);
    expect(full.capped).toBe(false);
    expect(full.bonus).toBeLessThan(TC.maxXpBonus);
  });

  it('refuses a negative or non-finite input rather than inventing a bonus', () => {
    expect(() => trainingXpMultiplier({ trainingCaptains: -1, flightDeckHeads: 10 }, TC)).toThrow(
      /Training Captains/,
    );
    expect(() =>
      trainingXpMultiplier({ trainingCaptains: 1, flightDeckHeads: Number.NaN }, TC),
    ).toThrow(/Flight-deck heads/);
    expect(() =>
      trainingXpMultiplier(
        { trainingCaptains: 1, flightDeckHeads: 10, doctrineXpFraction: -0.1 },
        TC,
      ),
    ).toThrow(/Doctrine/);
  });

  it('rounds a trained sector to whole XP and never below the untrained figure', () => {
    const m = trainingXpMultiplier({ trainingCaptains: 1, flightDeckHeads: 24 }, TC);
    expect(trainedXpPerHead(209, m)).toBe(Math.round(209 * m.multiplier));
    expect(
      trainedXpPerHead(209, trainingXpMultiplier({ trainingCaptains: 0, flightDeckHeads: 24 }, TC)),
    ).toBe(209);
  });
});

// ---------------------------------------------------------------------------
// Convergence, as a property
// ---------------------------------------------------------------------------

/** A valid, random balance — including corners no shipped world would choose. */
function randomBalance(rng: Rng): TrainingCaptainBalance {
  const maxXpBonus = 0.01 + rng() * 0.99;
  return TrainingCaptainBalance.parse({
    conversionCostMinor: 1 + Math.floor(rng() * 10_000_000),
    reversionCostMinor: 1 + Math.floor(rng() * 10_000_000),
    lineContributionFactor: rng(),
    crewsPerTrainingCaptain: 1 + Math.floor(rng() * 40),
    // Strictly below the cap, as the schema requires.
    xpBonusAtFullCoverage: maxXpBonus * (0.01 + rng() * 0.98),
    maxXpBonus,
  });
}

describe('the loop converges: the multiplier as a property (AC2)', () => {
  const rng = createRng(0x9_1004);
  const RUNS = 2_000;

  it('always lies in [1, 1 + maxXpBonus], whatever the inputs', () => {
    for (let run = 0; run < RUNS; run += 1) {
      const balance = randomBalance(rng);
      const heads = Math.floor(rng() * 600);
      const tcs = Math.floor(rng() * 80);
      // Doctrine anywhere from nothing to far past the cap on its own.
      const doctrine = rng() < 0.3 ? 0 : rng() * 2;
      const m = trainingXpMultiplier(
        { trainingCaptains: tcs, flightDeckHeads: heads, doctrineXpFraction: doctrine },
        balance,
      );

      expect(m.multiplier, `run ${String(run)}`).toBeGreaterThanOrEqual(1);
      expect(m.multiplier, `run ${String(run)}`).toBeLessThanOrEqual(1 + balance.maxXpBonus);
      expect(m.bonus).toBeLessThanOrEqual(balance.maxXpBonus);
      expect(m.coverage).toBeGreaterThanOrEqual(0);
      expect(m.coverage).toBeLessThanOrEqual(1);
      expect(m.capped).toBe(m.fromTrainingCaptains + m.fromDoctrine > balance.maxXpBonus);
    }
  });

  it('never falls when a Training Captain is added', () => {
    for (let run = 0; run < 300; run += 1) {
      const balance = randomBalance(rng);
      const heads = 1 + Math.floor(rng() * 300);
      const doctrine = rng() < 0.5 ? 0 : rng() * balance.maxXpBonus;
      let previous = 1;
      for (let tcs = 0; tcs <= heads + 5; tcs += 1) {
        const { multiplier } = trainingXpMultiplier(
          { trainingCaptains: tcs, flightDeckHeads: heads, doctrineXpFraction: doctrine },
          balance,
        );
        expect(multiplier, `run ${String(run)}, ${String(tcs)} TCs`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = multiplier;
      }
    }
  });

  it('saturates: past full coverage, another Training Captain adds exactly nothing', () => {
    for (let run = 0; run < 300; run += 1) {
      const balance = randomBalance(rng);
      const heads = 1 + Math.floor(rng() * 300);
      const full = Math.ceil(heads / balance.crewsPerTrainingCaptain);
      const atFull = trainingXpMultiplier(
        { trainingCaptains: full, flightDeckHeads: heads },
        balance,
      );
      expect(atFull.coverage).toBe(1);
      for (const extra of [1, 2, 10, 1_000]) {
        expect(
          trainingXpMultiplier({ trainingCaptains: full + extra, flightDeckHeads: heads }, balance)
            .multiplier,
        ).toBe(atFull.multiplier);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Convergence, as a simulation of the loop itself
// ---------------------------------------------------------------------------

describe('the loop converges: §10.2’s loop, run (AC2)', () => {
  /**
   * One base, one family, a large flight deck, and §10.2's loop with nothing
   * held back: every captain who reaches the top level converts the week they
   * reach it, at a Centre of Excellence that permits it.
   *
   * The XP a head earns from flying is held constant per week — the loop's
   * whole claim is about the *multiplier*, so a varying route network would
   * only obscure it. What has to hold is that the bench's XP gain per week is
   * bounded by a constant (`heads × base × (1 + maxXpBonus)`), which makes the
   * cumulative XP a straight line at worst rather than a curve bending upward.
   */
  function runLoop(options: { weeks: number; heads: number; base: number; doctrine?: number }) {
    const rng = createRng(0x10_02);
    const maxXp = xpForLevel(SKILLS.maxLevel, SKILLS);
    // Pilots start anywhere from fresh to just short of the top, so they reach
    // it in different weeks and the loop has to keep feeding itself.
    const xp = Array.from({ length: options.heads }, () => Math.floor(rng() * maxXp));
    const designated = Array.from({ length: options.heads }, () => false);

    const multipliers: number[] = [];
    const weeklyGain: number[] = [];
    const startingTotal = xp.reduce((a, b) => a + b, 0);

    for (let week = 0; week < options.weeks; week += 1) {
      const m = trainingXpMultiplier(
        {
          trainingCaptains: designated.filter(Boolean).length,
          flightDeckHeads: options.heads,
          doctrineXpFraction: options.doctrine ?? 0,
        },
        TC,
      );
      multipliers.push(m.multiplier);

      const perHead = trainedXpPerHead(options.base, m);
      weeklyGain.push(perHead * options.heads);
      for (let n = 0; n < options.heads; n += 1) {
        xp[n] = (xp[n] ?? 0) + perHead;
        const refusal = trainingCaptainRefusal(
          {
            rank: 'captain',
            level: levelForXp(xp[n] ?? 0, SKILLS),
            trainingCaptain: designated[n] ?? false,
          },
          5,
          { skills: SKILLS },
        );
        if (refusal === null) designated[n] = true;
      }
    }

    return {
      multipliers,
      weeklyGain,
      startingTotal,
      total: xp.reduce((a, b) => a + b, 0),
      trainingCaptains: designated.filter(Boolean).length,
    };
  }

  // ~600 XP a day for a week: M9-02's easy-network figure.
  const BASE = 4_200;
  const HEADS = 120;
  const WEEKS = 520;

  it('bounds every week’s gain by a constant, so cumulative XP grows linearly', () => {
    const run = runLoop({ weeks: WEEKS, heads: HEADS, base: BASE });
    const ceilingPerWeek = HEADS * Math.round(BASE * (1 + TC.maxXpBonus));

    for (const [week, gain] of run.weeklyGain.entries()) {
      expect(gain, `week ${String(week)}`).toBeLessThanOrEqual(ceilingPerWeek);
    }
    // Linear at worst: ten years of the loop is at most ten years of the
    // ceiling rate, from wherever the bench started.
    expect(run.total - run.startingTotal).toBeLessThanOrEqual(WEEKS * ceilingPerWeek);
    // And it did run: veterans reached the top and converted.
    expect(run.trainingCaptains).toBeGreaterThan(0);
  });

  it('speeds up while coverage grows, then holds still — it converges', () => {
    const run = runLoop({ weeks: WEEKS, heads: HEADS, base: BASE });

    // Monotone: Training Captains are never lost in this loop, so the
    // multiplier only ever rises…
    for (let week = 1; week < run.multipliers.length; week += 1) {
      expect(run.multipliers[week]).toBeGreaterThanOrEqual(run.multipliers[week - 1] ?? 0);
    }
    // …and it settles on the full-coverage figure, which is below the cap, and
    // then stays there for every remaining week however many more convert.
    const settled = 1 + TC.xpBonusAtFullCoverage;
    const firstSettled = run.multipliers.findIndex((m) => Math.abs(m - settled) < 1e-12);
    expect(firstSettled).toBeGreaterThan(0);
    for (const m of run.multipliers.slice(firstSettled)) {
      expect(m).toBeCloseTo(settled, 12);
    }
    // Full coverage needed only a handful of the veterans the loop produced.
    expect(run.trainingCaptains).toBeGreaterThan(Math.ceil(HEADS / TC.crewsPerTrainingCaptain));
  });

  it('holds the cap even when doctrine alone would pass it', () => {
    const run = runLoop({ weeks: 200, heads: HEADS, base: BASE, doctrine: 5 });
    for (const m of run.multipliers) {
      expect(m).toBe(1 + TC.maxXpBonus);
    }
  });

  it('never compounds: the last week earns no more than the ceiling rate the first could have', () => {
    const run = runLoop({ weeks: WEEKS, heads: HEADS, base: BASE });
    const first = run.weeklyGain[0] ?? 0;
    const last = run.weeklyGain.at(-1) ?? 0;
    // Exponential growth would make this ratio unbounded in the number of weeks;
    // the cap makes it at most 1 + maxXpBonus, whatever the horizon.
    expect(last / first).toBeLessThanOrEqual(1 + TC.maxXpBonus + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// The line value a Training Captain gives up
// ---------------------------------------------------------------------------

function crew(over: Partial<RosterCrew> = {}): RosterCrew {
  return {
    rank: 'captain',
    family: 'A320neo',
    level: SKILLS.maxLevel,
    spent: { performance_fuel: 5, command_leadership: 3 },
    trainingCaptain: false,
    ...over,
  };
}

describe('a Training Captain’s own points reach the line at a fraction', () => {
  it('puts a line pilot in the skills source at full strength', () => {
    const sources = crewBoostSources([crew()], ['A320neo'], SKILLS, TC);
    expect(sources.skills.fuelBurn?.[0]?.fraction).toBeCloseTo(
      5 * SKILLS.fractionPerPoint.performance_fuel,
      12,
    );
    expect(sources.trainingCaptains.fuelBurn).toEqual([]);
    expect(sources.contributors.skills.fuelBurn).toBe(1);
    expect(sources.contributors.trainingCaptains.fuelBurn).toBe(0);
  });

  it('puts a Training Captain in their own source, scaled by the line contribution', () => {
    const sources = crewBoostSources([crew({ trainingCaptain: true })], ['A320neo'], SKILLS, TC);
    expect(sources.skills.fuelBurn).toEqual([]);
    expect(sources.trainingCaptains.fuelBurn?.[0]?.fraction).toBeCloseTo(
      5 * SKILLS.fractionPerPoint.performance_fuel * TC.lineContributionFactor,
      12,
    );
    expect(sources.trainingCaptains.turnaroundTime?.[0]?.fraction).toBeCloseTo(
      3 * SKILLS.fractionPerPoint.command_leadership * TC.lineContributionFactor,
      12,
    );
    expect(sources.contributors.trainingCaptains.fuelBurn).toBe(1);
  });

  it('is worth less converted than on the line — §10.2’s "stop generating full revenue value"', () => {
    const line = resolveEfficiencyBoosts(
      crewBoostSources([crew()], ['A320neo'], SKILLS, TC),
      EFFICIENCY_CEILINGS,
    );
    const converted = resolveEfficiencyBoosts(
      crewBoostSources([crew({ trainingCaptain: true })], ['A320neo'], SKILLS, TC),
      EFFICIENCY_CEILINGS,
    );
    expect(converted.fuelBurn.fraction).toBeLessThan(line.fuelBurn.fraction);
    expect(converted.fuelBurn.bySource.trainingCaptains).toBeGreaterThan(0);
    expect(converted.fuelBurn.bySource.skills).toBe(0);
  });

  it('contributes nothing at a line contribution of zero, and counts nobody', () => {
    const balance = TrainingCaptainBalance.parse({ ...TC, lineContributionFactor: 0 });
    const sources = crewBoostSources(
      [crew({ trainingCaptain: true })],
      ['A320neo'],
      SKILLS,
      balance,
    );
    expect(sources.trainingCaptains.fuelBurn).toEqual([]);
    expect(sources.contributors.trainingCaptains.fuelBurn).toBe(0);
  });

  it('still silences Type Mastery when the fleet has gone', () => {
    const sources = crewBoostSources(
      [crew({ trainingCaptain: true, spent: { type_mastery: 5 } })],
      [],
      SKILLS,
      TC,
    );
    expect(sources.trainingCaptains.maintenanceCost).toEqual([]);
  });

  it('never lets a roster of veterans and Training Captains pass a ceiling', () => {
    const rng = createRng(0x7c_04);
    for (let run = 0; run < 200; run += 1) {
      const roster = Array.from({ length: 1 + Math.floor(rng() * 60) }, () =>
        crew({
          trainingCaptain: rng() < 0.4,
          spent: {
            performance_fuel: Math.floor(rng() * 6),
            handling_safety: Math.floor(rng() * 6),
            command_leadership: Math.floor(rng() * 6),
            type_mastery: Math.floor(rng() * 6),
          },
        }),
      );
      const resolved = resolveEfficiencyBoosts(
        crewBoostSources(roster, ['A320neo'], SKILLS, TC),
        EFFICIENCY_CEILINGS,
      );
      for (const quantity of Object.values(resolved)) {
        expect(quantity.fraction).toBeLessThanOrEqual(quantity.ceiling);
      }
    }
  });
});

describe('the flight deck', () => {
  it('is the five pilot ranks and nothing else', () => {
    expect(
      (
        ['cadet', 'first_officer', 'senior_first_officer', 'captain', 'training_captain'] as const
      ).every(isFlightDeckRank),
    ).toBe(true);
    expect(isFlightDeckRank('purser')).toBe(false);
  });
});

describe('the shipped balance', () => {
  it('is the payload the economy config seeds', () => {
    expect(ECONOMY_CONFIG_V1.crew.trainingCaptain).toEqual(SHIPPED_TRAINING_CAPTAIN_BALANCE);
  });

  it('prices the way back above the way in, so the round trip is not a dial', () => {
    expect(TC.reversionCostMinor).toBeGreaterThan(TC.conversionCostMinor);
  });

  it('leaves Training Captains below the shared cap, and the cap at most doubling XP', () => {
    expect(TC.xpBonusAtFullCoverage).toBeLessThan(TC.maxXpBonus);
    expect(TC.maxXpBonus).toBeLessThanOrEqual(1);
  });

  it('refuses a world that would let Training Captains fill the cap alone', () => {
    const result = TrainingCaptainBalance.safeParse({
      ...SHIPPED_TRAINING_CAPTAIN_BALANCE,
      xpBonusAtFullCoverage: SHIPPED_TRAINING_CAPTAIN_BALANCE.maxXpBonus,
    });
    expect(result.success).toBe(false);
  });

  it('gives a Training Captain less line value than a line pilot, and more than none', () => {
    expect(TC.lineContributionFactor).toBeGreaterThan(0);
    expect(TC.lineContributionFactor).toBeLessThan(1);
  });
});
