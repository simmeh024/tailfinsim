import { type CrewXpBalance } from '@tailfin/shared';

import { landingChallenge, type Weather, type WeatherConfig } from '../weather';

import { DEFAULT_CREW } from './complement';

/**
 * What a flight teaches the crew who flew it (M9-02, §10.2).
 *
 * ```
 * XP = base(sector length) × typeFactor × difficultyMultiplier
 * ```
 *
 * §10.2's formula, and the section's own claim about what it is for:
 *
 * > *"Grinding easy domestic hops levels crew slowly. A pilot who flies your
 * > hard winter northern network becomes measurably better than one who
 * > doesn't. **Your route network shapes your crew, not just your balance
 * > sheet.**"*
 *
 * ## Deterministic, and that is an acceptance criterion
 *
 * *"XP is deterministic given the flight and its conditions."* Nothing here
 * draws a random number or reads a clock. Every input is either a stored fact
 * about the flight (distance, aeroplane, disruption, arrival instant) or a
 * derived one that is itself deterministic — the airport rating comes from a
 * reproducible data job, and the weather from M2-09's seeded per-station-day
 * model, which was built to be re-derivable months later for exactly this kind
 * of question.
 *
 * So a replay of an old arrival awards the same XP, and *"why did that flight
 * earn that much?"* has an answer — {@link FlightXp.factors} itemises it, the
 * same contract §14.1 asks of every figure in the game.
 *
 * ## The multiplier adds, and it has a ceiling
 *
 * `1 + Σ(terms)`, capped at `difficulty.maxMultiplier`. Multiplying the terms
 * would make a hard night landing at a hard field in weather worth an unbounded
 * amount; §10.4's whole philosophy is that a ladder has a ceiling, and a cap is
 * what makes *"the hardest sector in the game is worth three ordinary ones"* a
 * sentence with an answer.
 *
 * ## What this does not do
 *
 * It does not decide **who** gets the XP. §10.2's *"every crew member aboard"*
 * meets M5-01's rule that there are no crew member rows, and the server resolves
 * that against `crew_duty_period` — every head aboard earns this figure, and the
 * sum lands on the pool. Nor does it spend XP: skill trees and levels are M9-03.
 */

/** Which disruption the crew flew through and still arrived. */
export type XpDisruption = 'none' | 'delay' | 'divert' | 'air_return';

export interface FlightXpInput {
  /** Great-circle distance actually flown, nautical miles. */
  distanceNm: number;
  /** The aeroplane's maximum takeoff weight, tonnes — the type factor's input. */
  maxTakeoffWeightT: number;
  /**
   * The arrival field's 0-1 difficulty rating.
   *
   * **Null means never rated**, which contributes nothing — the same reading
   * `airport.difficulty` documents. A world whose `data:difficulty` job has not
   * run pays flat XP rather than guessing, and the Crew page can say so.
   */
  arrivalDifficulty: number | null;
  originDifficulty: number | null;
  /** The weather the crew landed in, or null where the world has no reading. */
  arrivalWeather: Weather | null;
  /**
   * Local hour at the arrival field, 0-23, or null where the airport has no
   * timezone offset. Null contributes nothing rather than guessing at darkness.
   */
  arrivalLocalHour: number | null;
  disruption: XpDisruption;
  /**
   * True when origin and arrival are on different continents.
   *
   * §10.2 asks for *"oceanic crossings"*, and this is a **proxy** rather than
   * the thing itself: deciding whether a great-circle track actually crosses
   * open water needs coastline geometry the game does not carry. Two continents
   * and a long sector is right for the North Atlantic, the Pacific and the Kangaroo
   * route, and wrong for Istanbul–Cairo, which is short enough that the
   * long-haul term leaves it near nothing anyway. Named as a proxy rather than
   * left to be discovered.
   */
  crossesContinents: boolean;
}

/** One named contribution to the multiplier, for the itemised readout. */
export interface XpFactor {
  factor:
    | 'arrivalAirport'
    | 'originAirport'
    | 'weather'
    | 'night'
    | 'disruption'
    | 'longHaul'
    | 'oceanic';
  /** A sentence naming what made it hard, for the interface to show. */
  detail: string;
  /** What it added to the multiplier, before the cap. */
  contribution: number;
}

export interface FlightXp {
  /** What each head aboard earns. Rounded, because XP is a whole number. */
  xpPerHead: number;
  /** `base(sector length)` — the unmultiplied figure. */
  base: number;
  typeFactor: number;
  /** `1 + Σ(factors)`, after the cap. */
  difficultyMultiplier: number;
  /** True when the cap bit — so the interface can say the sector maxed out. */
  capped: boolean;
  /**
   * Every term that contributed, and by how much. Zero-contribution terms are
   * omitted: a list of seven items of which five are 0 is not an explanation.
   */
  factors: XpFactor[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Whether a local hour falls in the night window, which may wrap midnight. */
export function isNightHour(hour: number, xp: CrewXpBalance): boolean {
  const h = ((hour % 24) + 24) % 24;
  return xp.nightFromHour <= xp.nightToHour
    ? h >= xp.nightFromHour && h < xp.nightToHour
    : h >= xp.nightFromHour || h < xp.nightToHour;
}

/**
 * The type factor: heavier aeroplane, bigger licence.
 *
 * §10.2 says *"type factor"* and no more. The one fact about a type that is
 * already versioned (§22.5) and already in hand at settlement is its maximum
 * takeoff weight, so that is what this reads — rather than eighteen
 * hand-written factors in a catalogue that is meant to hold performance.
 */
export function xpTypeFactor(maxTakeoffWeightT: number, xp: CrewXpBalance): number {
  const { referenceTonnes, perTonneAbove, min, max } = xp.typeFactor;
  return clamp(1 + (maxTakeoffWeightT - referenceTonnes) * perTonneAbove, min, max);
}

/** `base(sector length)` — a floor every sector earns, plus distance. */
export function xpBase(distanceNm: number, xp: CrewXpBalance): number {
  return xp.baseSectorXp + Math.max(0, distanceNm) * xp.xpPerNm;
}

export function flightXp(
  input: FlightXpInput,
  xp: CrewXpBalance = DEFAULT_CREW.xp,
  weatherConfig?: WeatherConfig,
): FlightXp {
  const d = xp.difficulty;
  const factors: XpFactor[] = [];

  const arrival = clamp(input.arrivalDifficulty ?? 0, 0, 1);
  if (arrival > 0) {
    factors.push({
      factor: 'arrivalAirport',
      detail: `Arrival field rated ${arrival.toFixed(2)}`,
      contribution: arrival * d.arrivalAirport,
    });
  }

  const origin = clamp(input.originDifficulty ?? 0, 0, 1);
  if (origin > 0) {
    factors.push({
      factor: 'originAirport',
      detail: `Departure field rated ${origin.toFixed(2)}`,
      contribution: origin * d.originAirport,
    });
  }

  /*
   * `landingChallenge`, not `weatherSeverity`. The two disagree on purpose and
   * the weather module says why: severity asks whether the operation survives,
   * challenge asks what the crew learned. A gale that cancels the flight
   * teaches nobody anything — and never reaches here, because a cancellation
   * does not settle.
   */
  if (input.arrivalWeather !== null) {
    const challenge = landingChallenge(input.arrivalWeather, weatherConfig);
    if (challenge > 0) {
      const conditions = [
        input.arrivalWeather.windKt >= 20
          ? `${String(Math.round(input.arrivalWeather.windKt))} kt wind`
          : null,
        input.arrivalWeather.visibilityM < 3_000
          ? `${String(Math.round(input.arrivalWeather.visibilityM))} m visibility`
          : null,
        input.arrivalWeather.precipitation === 'snow' ? 'snow' : null,
      ].filter((part): part is string => part !== null);
      factors.push({
        factor: 'weather',
        detail:
          conditions.length > 0 ? `Landed in ${conditions.join(', ')}` : 'Marginal conditions',
        contribution: challenge * d.weather,
      });
    }
  }

  if (input.arrivalLocalHour !== null && isNightHour(input.arrivalLocalHour, xp)) {
    factors.push({
      factor: 'night',
      detail: `Night landing, ${String(input.arrivalLocalHour).padStart(2, '0')}:00 local`,
      contribution: d.night,
    });
  }

  if (input.disruption !== 'none') {
    const contribution =
      input.disruption === 'divert'
        ? d.disruption.divert
        : input.disruption === 'air_return'
          ? d.disruption.airReturn
          : d.disruption.delay;
    const detail =
      input.disruption === 'divert'
        ? 'Diversion flown and completed'
        : input.disruption === 'air_return'
          ? 'Air return handled'
          : 'Delay absorbed';
    factors.push({ factor: 'disruption', detail, contribution });
  }

  // Ramped rather than a step, so a 2,100 nm sector is not worth the same as a
  // 4,900 nm one. `longHaulFullAtNm` below `longHaulFromNm` would be a nonsense
  // config; the max guards the division rather than trusting it.
  const span = Math.max(1, d.longHaulFullAtNm - d.longHaulFromNm);
  const longHaul = clamp((input.distanceNm - d.longHaulFromNm) / span, 0, 1) * d.longHaul;
  if (longHaul > 0) {
    factors.push({
      factor: 'longHaul',
      detail: `${String(Math.round(input.distanceNm))} nm sector`,
      contribution: longHaul,
    });
  }

  if (input.crossesContinents) {
    factors.push({
      factor: 'oceanic',
      detail: 'Intercontinental crossing',
      contribution: d.oceanic,
    });
  }

  const raw = 1 + factors.reduce((total, factor) => total + factor.contribution, 0);
  const difficultyMultiplier = Math.min(raw, d.maxMultiplier);

  const base = xpBase(input.distanceNm, xp);
  const typeFactor = xpTypeFactor(input.maxTakeoffWeightT, xp);

  return {
    xpPerHead: Math.round(base * typeFactor * difficultyMultiplier),
    base: Math.round(base * 100) / 100,
    typeFactor: Math.round(typeFactor * 1000) / 1000,
    difficultyMultiplier: Math.round(difficultyMultiplier * 1000) / 1000,
    capped: raw > d.maxMultiplier,
    factors,
  };
}
