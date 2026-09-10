import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1, SHIPPED_CREW_XP_BALANCE } from '@tailfin/shared';

import { weatherFor, type Weather } from '../weather';

import { flightXp, isNightHour, xpBase, xpTypeFactor, type FlightXpInput } from './xp';

const XP = ECONOMY_CONFIG_V1.crew.xp;

/** A clear, calm day. The baseline every "hard" case is measured against. */
const FAIR: Weather = {
  icaoCode: 'EHAM',
  date: '2026-06-15',
  temperatureC: 18,
  windKt: 5,
  visibilityM: 10_000,
  precipitation: 'none',
};

/** A winter northern day: crosswind, snow, poor visibility. */
const FOUL: Weather = {
  icaoCode: 'ENSB',
  date: '2026-01-15',
  temperatureC: -8,
  windKt: 32,
  visibilityM: 900,
  precipitation: 'snow',
};

function sector(over: Partial<FlightXpInput> = {}): FlightXpInput {
  return {
    distanceNm: 250,
    maxTakeoffWeightT: 80,
    arrivalDifficulty: 0,
    originDifficulty: 0,
    arrivalWeather: FAIR,
    arrivalLocalHour: 14,
    disruption: 'none',
    crossesContinents: false,
    ...over,
  };
}

/**
 * §10.2's XP (M9-02).
 *
 * The three acceptance criteria are what this file is for, and the first is the
 * one the whole section exists to deliver: *"a hard winter northern network
 * levels crew measurably faster than easy domestic hops"*.
 */
describe('the formula', () => {
  it('is base × typeFactor × difficultyMultiplier, and says so in the output', () => {
    const result = flightXp(sector({ arrivalDifficulty: 0.5 }), XP);
    expect(result.xpPerHead).toBe(
      Math.round(result.base * result.typeFactor * result.difficultyMultiplier),
    );
  });

  it('pays a floor for a sector of no length, and more for a longer one', () => {
    expect(xpBase(0, XP)).toBe(XP.baseSectorXp);
    expect(xpBase(1_000, XP)).toBeGreaterThan(xpBase(250, XP));
    // Negative distance cannot subtract XP, however it arrived.
    expect(xpBase(-500, XP)).toBe(XP.baseSectorXp);
  });

  it('scales the type factor with weight, between its bounds', () => {
    expect(xpTypeFactor(XP.typeFactor.referenceTonnes, XP)).toBe(1);
    expect(xpTypeFactor(350, XP)).toBeGreaterThan(1);
    expect(xpTypeFactor(23, XP)).toBeLessThan(1);
    // A hypothetical 900-tonne aeroplane does not earn nine times the XP.
    expect(xpTypeFactor(900, XP)).toBe(XP.typeFactor.max);
    expect(xpTypeFactor(1, XP)).toBe(XP.typeFactor.min);
  });
});

/** AC3: *"XP is deterministic given the flight and its conditions."* */
describe('determinism', () => {
  it('gives the same answer for the same inputs, every time', () => {
    const input = sector({ arrivalDifficulty: 0.62, arrivalWeather: FOUL, arrivalLocalHour: 23 });
    const first = flightXp(input, XP);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(flightXp(input, XP)).toEqual(first);
    }
  });

  it('is deterministic through the weather model as well', () => {
    // The weather is itself a pure function of (seed, station, date), so the
    // whole chain re-derives — which is what lets an old arrival be explained.
    const station = { icaoCode: 'ENSB', latitude: 78.25, longitude: 15.47 };
    const day = new Date('2026-01-15T12:00:00.000Z');
    const a = flightXp(sector({ arrivalWeather: weatherFor('seed-1', station, day) }), XP);
    const b = flightXp(sector({ arrivalWeather: weatherFor('seed-1', station, day) }), XP);
    expect(a).toEqual(b);
  });
});

/**
 * AC1: *"A hard winter northern network levels crew measurably faster than easy
 * domestic hops."*
 */
describe('the network shapes the crew', () => {
  const easyHop = flightXp(sector(), XP);

  it('pays measurably more for the same sector flown hard', () => {
    const hard = flightXp(
      sector({
        // A northern field, in winter weather, landing in the dark.
        arrivalDifficulty: 0.6,
        originDifficulty: 0.35,
        arrivalWeather: FOUL,
        arrivalLocalHour: 23,
      }),
      XP,
    );
    // Same distance, same aeroplane — every extra point is difficulty.
    expect(hard.base).toBe(easyHop.base);
    expect(hard.typeFactor).toBe(easyHop.typeFactor);
    expect(hard.xpPerHead).toBeGreaterThan(easyHop.xpPerHead * 1.5);
  });

  it('leaves an easy domestic hop on a bare multiplier', () => {
    expect(easyHop.difficultyMultiplier).toBe(1);
    expect(easyHop.factors).toEqual([]);
  });

  it('compounds over a season into a large gap', () => {
    /*
     * The claim §10.2 actually makes is about a *network*, not a sector. Two
     * crews fly the same number of sectors of the same length for a season; one
     * flies the easy network and one the hard one.
     */
    const sectors = 120;
    const easyTotal = easyHop.xpPerHead * sectors;
    const hardTotal =
      flightXp(
        sector({
          arrivalDifficulty: 0.6,
          originDifficulty: 0.35,
          arrivalWeather: FOUL,
          arrivalLocalHour: 23,
        }),
        XP,
      ).xpPerHead * sectors;

    expect(hardTotal).toBeGreaterThan(easyTotal);
    // "Measurably" made into a number: at least half as much again.
    expect(hardTotal / easyTotal).toBeGreaterThan(1.5);
  });
});

describe('each difficulty term', () => {
  const bare = flightXp(sector(), XP);

  it('counts the arrival field above the departure field', () => {
    const arriving = flightXp(sector({ arrivalDifficulty: 1 }), XP);
    const departing = flightXp(sector({ originDifficulty: 1 }), XP);
    expect(arriving.xpPerHead).toBeGreaterThan(departing.xpPerHead);
    expect(departing.xpPerHead).toBeGreaterThan(bare.xpPerHead);
  });

  it('treats an unrated field as contributing nothing, not as easy or hard', () => {
    // Null and 0 agree on the number; the difference is what the interface can
    // say about it, and that lives on the airport row rather than here.
    expect(flightXp(sector({ arrivalDifficulty: null }), XP).xpPerHead).toBe(bare.xpPerHead);
  });

  it('pays for the weather the crew landed in', () => {
    const foul = flightXp(sector({ arrivalWeather: FOUL }), XP);
    expect(foul.xpPerHead).toBeGreaterThan(bare.xpPerHead);
    expect(foul.factors.find((f) => f.factor === 'weather')?.detail).toContain('snow');
  });

  it('pays for a night landing, at the arrival field’s local clock', () => {
    expect(flightXp(sector({ arrivalLocalHour: 23 }), XP).xpPerHead).toBeGreaterThan(
      bare.xpPerHead,
    );
    expect(flightXp(sector({ arrivalLocalHour: 3 }), XP).xpPerHead).toBeGreaterThan(bare.xpPerHead);
    expect(flightXp(sector({ arrivalLocalHour: 14 }), XP).xpPerHead).toBe(bare.xpPerHead);
    // No timezone means no claim about darkness.
    expect(flightXp(sector({ arrivalLocalHour: null }), XP).xpPerHead).toBe(bare.xpPerHead);
  });

  it('wraps the night window across midnight', () => {
    expect(isNightHour(22, XP)).toBe(true);
    expect(isNightHour(2, XP)).toBe(true);
    expect(isNightHour(12, XP)).toBe(false);
    // The boundaries themselves: `[from, to)`.
    expect(isNightHour(XP.nightFromHour, XP)).toBe(true);
    expect(isNightHour(XP.nightToHour, XP)).toBe(false);
  });

  it('pays most for a diversion and least for a delay', () => {
    const delay = flightXp(sector({ disruption: 'delay' }), XP).xpPerHead;
    const airReturn = flightXp(sector({ disruption: 'air_return' }), XP).xpPerHead;
    const divert = flightXp(sector({ disruption: 'divert' }), XP).xpPerHead;
    expect(delay).toBeGreaterThan(bare.xpPerHead);
    expect(airReturn).toBeGreaterThan(delay);
    expect(divert).toBeGreaterThan(airReturn);
  });

  it('ramps the long-haul term rather than stepping it', () => {
    const short = flightXp(sector({ distanceNm: XP.difficulty.longHaulFromNm }), XP);
    const middling = flightXp(sector({ distanceNm: 3_500 }), XP);
    const full = flightXp(sector({ distanceNm: XP.difficulty.longHaulFullAtNm }), XP);
    const beyond = flightXp(sector({ distanceNm: 8_000 }), XP);

    expect(short.difficultyMultiplier).toBe(1);
    expect(middling.difficultyMultiplier).toBeGreaterThan(1);
    expect(full.difficultyMultiplier).toBeGreaterThan(middling.difficultyMultiplier);
    // Saturated: an 8,000 nm sector's *multiplier* matches a 5,000 nm one. It
    // still earns far more, because the base is longer.
    expect(beyond.difficultyMultiplier).toBe(full.difficultyMultiplier);
    expect(beyond.xpPerHead).toBeGreaterThan(full.xpPerHead);
  });

  it('pays for an intercontinental crossing', () => {
    expect(flightXp(sector({ crossesContinents: true }), XP).xpPerHead).toBeGreaterThan(
      bare.xpPerHead,
    );
  });
});

describe('the ceiling', () => {
  const everything = sector({
    distanceNm: 7_000,
    maxTakeoffWeightT: 350,
    arrivalDifficulty: 1,
    originDifficulty: 1,
    arrivalWeather: FOUL,
    arrivalLocalHour: 2,
    disruption: 'divert',
    crossesContinents: true,
  });

  it('caps the multiplier and says that it did', () => {
    const result = flightXp(everything, XP);
    expect(result.difficultyMultiplier).toBe(XP.difficulty.maxMultiplier);
    expect(result.capped).toBe(true);
  });

  it('does not report an ordinary sector as capped', () => {
    expect(flightXp(sector(), XP).capped).toBe(false);
  });

  it('keeps the hardest sector within reach of an ordinary one', () => {
    /*
     * Same distance and aeroplane, so only the difficulty differs. The whole
     * point of a cap: hard flying is worth more, never worth everything.
     *
     * A *short* sector cannot reach the cap even with every other term maxed —
     * long-haul is a difficulty term (§10.2 puts it there), so 250 nm forgoes
     * it. That is the intended shape rather than a shortfall: the ceiling is
     * reserved for a sector that is genuinely extreme in every dimension, and a
     * hard domestic hop lands below it.
     */
    const hardest = flightXp({ ...everything, distanceNm: 250, maxTakeoffWeightT: 80 }, XP);
    const easiest = flightXp(sector(), XP);
    const ratio = hardest.xpPerHead / easiest.xpPerHead;
    expect(hardest.capped).toBe(false);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThanOrEqual(XP.difficulty.maxMultiplier);
  });
});

/** §14.1: a figure has to be able to explain itself. */
describe('the itemised readout', () => {
  it('lists only the terms that actually contributed', () => {
    const result = flightXp(sector({ arrivalDifficulty: 0.5, arrivalLocalHour: 23 }), XP);
    expect(result.factors.map((f) => f.factor).sort()).toEqual(['arrivalAirport', 'night']);
  });

  it('sums to the multiplier when the cap has not bitten', () => {
    const result = flightXp(
      sector({ arrivalDifficulty: 0.5, originDifficulty: 0.2, arrivalLocalHour: 23 }),
      XP,
    );
    const summed = 1 + result.factors.reduce((total, f) => total + f.contribution, 0);
    expect(result.capped).toBe(false);
    expect(result.difficultyMultiplier).toBeCloseTo(summed, 6);
  });

  it('gives every factor a sentence a player could read', () => {
    const result = flightXp(
      sector({
        distanceNm: 4_000,
        arrivalDifficulty: 0.7,
        originDifficulty: 0.3,
        arrivalWeather: FOUL,
        arrivalLocalHour: 1,
        disruption: 'divert',
        crossesContinents: true,
      }),
      XP,
    );
    expect(result.factors).toHaveLength(7);
    for (const factor of result.factors) {
      expect(factor.detail.length).toBeGreaterThan(3);
      expect(factor.contribution).toBeGreaterThan(0);
    }
  });
});

describe('the shipped balance', () => {
  it('is the payload the economy config seeds', () => {
    expect(ECONOMY_CONFIG_V1.crew.xp).toEqual(SHIPPED_CREW_XP_BALANCE);
  });

  it('never lets a hard sector be worth less than an easy one', () => {
    expect(XP.difficulty.maxMultiplier).toBeGreaterThan(1);
    for (const value of Object.values(XP.difficulty.disruption)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('reaches the long-haul term before it saturates', () => {
    expect(XP.difficulty.longHaulFullAtNm).toBeGreaterThan(XP.difficulty.longHaulFromNm);
  });
});
