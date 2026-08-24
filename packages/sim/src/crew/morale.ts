import type { CrewMoraleBalance, HotelTier, PayBand } from '@tailfin/shared';

import { DEFAULT_CREW } from './complement';

/**
 * Crew morale, and what it costs to ignore (§9.2, M5-03).
 *
 * ## The sentence this module exists to make true
 *
 * §9.2: *"Cost-cutting on crew is a viable strategy with a delayed, visible
 * bill."* Three words, three requirements, and they pull against each other:
 *
 *   - **viable** — paying badly must genuinely save money. Not a trap with a
 *     warning label; a real option a competent player might take on purpose.
 *   - **delayed** — the saving has to arrive before the cost. Morale that
 *     collapsed the week pay was cut would make the strategy obviously bad, and
 *     an obviously bad option is not a decision.
 *   - **visible** — when the bill lands, the player must be able to see what it
 *     was for. Which is why {@link moraleTarget} returns an itemised breakdown
 *     rather than a score: a number that cannot explain itself is a number the
 *     player will conclude is arbitrary.
 *
 * ## Morale is a state, not a formula
 *
 * The four inputs give a **target**; the base's actual morale eases toward it
 * over game weeks. That gap is the whole mechanic. Without it there is no delay,
 * and without the delay there is no trap worth avoiding.
 *
 * It also means morale cannot be read from the inputs — it has to be stored and
 * moved, which is why `crew_base` carries a column and the worker moves it.
 *
 * ## What it does not do
 *
 * It does not compute a product score. §9.2 makes morale *an input to* service
 * execution, and App. D.1 is explicit that **the weakest input dominates** among
 * four of them — a rule about all four, which cannot be settled by the one that
 * happens to be built first. {@link serviceExecution} exposes the number and
 * M8-04 owns the assembly. The same seam M2-08 left for `crewTimeout`, honoured
 * the same way.
 *
 * Industrial action is explicitly out of scope, and there is nothing here that
 * would grow into it by accident.
 */

/** What morale is computed from. Each already resolved to the 0–1 the model uses. */
export interface MoraleInputs {
  payBand: PayBand;
  hotelTier: HotelTier;
  /**
   * How predictable the roster has been, 0–1.
   *
   * There is no roster object in the game, so this is not read from one. It is
   * how consistent the crew's **report times** have been across recent duty
   * periods — a base whose crew sign on at 06:00 every day scores high, one
   * whose sign-on wanders from dawn to midnight scores low. That is what roster
   * instability feels like from the crew's side, and it is computable from the
   * duty periods M5-02 already writes.
   */
  rosterStability: number;
  /**
   * Rest actually served against rest required, 0–1, capped at 1.
   *
   * The one input that is measured rather than chosen. An airline rostering to
   * the legal minimum scores 1 here and no more: exceeding the minimum is not
   * rewarded, because the minimum is already the regulation's answer to what is
   * enough. Falling short of it is what this notices.
   */
  restRatio: number;
}

export interface MoraleContribution {
  factor: 'pay' | 'rosterStability' | 'hotel' | 'rest';
  /** A sentence naming what the player chose or what happened. */
  detail: string;
  /** This input's own score, 0–1, before weighting. */
  value: number;
  /** Its share of the total, 0–1. */
  weight: number;
  /** `value × weight`. Summing these gives the target. */
  weighted: number;
}

export interface MoraleTarget {
  /** Where morale is heading, 0–1. Not where it is. */
  score: number;
  /** Every input, itemised. §9.2's *visible* bill starts here. */
  contributions: readonly MoraleContribution[];
}

/**
 * Where morale is heading, and why.
 *
 * Itemised because M5-03's second acceptance criterion asks for exactly that —
 * *"morale is shown per base with its contributing factors itemised"* — and
 * because a single figure invites the player to conclude the game is being
 * unfair to them. `weighted` sums to `score` by construction, so the breakdown
 * cannot drift from the number it explains.
 */
export function moraleTarget(
  inputs: MoraleInputs,
  balance: CrewMoraleBalance = DEFAULT_CREW.morale,
): MoraleTarget {
  const pay = balance.payBands[inputs.payBand];
  const hotel = balance.hotelTiers[inputs.hotelTier];

  const raw = [
    {
      factor: 'pay' as const,
      detail: `${PAY_LABEL[inputs.payBand]} pay band`,
      value: pay.moraleFactor,
      weight: balance.weights.pay,
    },
    {
      factor: 'rosterStability' as const,
      detail: describeStability(inputs.rosterStability),
      value: clamp01(inputs.rosterStability),
      weight: balance.weights.rosterStability,
    },
    {
      factor: 'hotel' as const,
      detail: `${HOTEL_LABEL[inputs.hotelTier]} hotels away from base`,
      value: hotel.moraleFactor,
      weight: balance.weights.hotel,
    },
    {
      factor: 'rest' as const,
      detail: describeRest(inputs.restRatio),
      value: clamp01(inputs.restRatio),
      weight: balance.weights.rest,
    },
  ];

  /*
   * Normalised, so a retune that changes one weight without rebalancing the
   * others cannot silently move every base's morale. The weights ship summing to
   * 1 and this makes that a convenience rather than a requirement.
   */
  const total = raw.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return { score: 0, contributions: [] };

  const contributions = raw.map((entry) => {
    const weight = entry.weight / total;
    return { ...entry, weight, weighted: entry.value * weight };
  });

  return {
    score: clamp01(contributions.reduce((sum, entry) => sum + entry.weighted, 0)),
    contributions,
  };
}

/**
 * Move morale toward its target, one review at a time.
 *
 * Exponential easing: a fixed fraction of the **remaining gap** each week, so
 * morale approaches its target without ever quite arriving and without a cliff
 * at either end. A linear ramp would hit the target exactly and then sit there,
 * which makes the mechanic feel like a countdown rather than a mood.
 *
 * `weeks` is fractional and in **game** time, because everything about crew is:
 * a world at 4× sours twice as fast in real time as one at 2×, exactly as its
 * conversions finish twice as fast.
 */
export function driftMorale(
  current: number,
  target: number,
  weeks: number,
  balance: CrewMoraleBalance = DEFAULT_CREW.morale,
): number {
  if (weeks <= 0) return clamp01(current);
  if (balance.driftPerWeek <= 0) return clamp01(current);

  // `(1 - rate)^weeks` is the fraction of the gap still unclosed. Compounding
  // rather than multiplying keeps two half-weeks equal to one week, which a
  // linear `rate × weeks` does not.
  const remaining = Math.pow(1 - Math.min(1, balance.driftPerWeek), weeks);
  return clamp01(target + (clamp01(current) - target) * remaining);
}

/** Fraction of a pool off sick in a given week. Linear between the two ends. */
export function sicknessRate(
  morale: number,
  balance: CrewMoraleBalance = DEFAULT_CREW.morale,
): number {
  return between(balance.sicknessAtZero, balance.sicknessAtFull, morale);
}

/**
 * Fraction of a pool who resign in a given week.
 *
 * The expensive half of the bill: a sick crew member is back in three days, a
 * resignation costs the hiring fee, the weeks of hiring capacity, and — for a
 * Captain — the years the game will not let money shortcut.
 */
export function attritionRate(
  morale: number,
  balance: CrewMoraleBalance = DEFAULT_CREW.morale,
): number {
  return between(balance.attritionAtZero, balance.attritionAtFull, morale);
}

/**
 * What this base's morale does to service execution (App. D.1, §6.4).
 *
 * **Exposed, not consumed.** M8-04 assembles the product score, and D.1's rule
 * that *"the weakest input dominates"* is a decision about four inputs together.
 * Nothing in `packages/sim` multiplies this into anything today, and a caller
 * that starts doing so before M8-04 lands has made M8-04's decision for it.
 */
export function serviceExecution(
  morale: number,
  balance: CrewMoraleBalance = DEFAULT_CREW.morale,
): number {
  return between(balance.serviceExecutionAtZero, balance.serviceExecutionAtFull, morale);
}

/**
 * How steady a base's sign-on times have been, 0–1.
 *
 * The spread of report times around their own mean, in hours, mapped so that a
 * base reporting within about an hour of the same time each day scores near 1
 * and one whose sign-on wanders across six hours scores near 0.
 *
 * **Local minutes past midnight, and the caller does the conversion.** Report
 * times are stored as instants; what the crew experience is the local clock, and
 * a base that reports at 06:00 every day is steady whether or not the world is
 * on summer time.
 *
 * Fewer than two periods is not instability, it is no evidence — and the honest
 * answer to no evidence is the neutral one, not zero.
 */
export function rosterStability(
  reportLocalMinutes: readonly number[],
  spreadHoursForZero = 6,
): number {
  if (reportLocalMinutes.length < 2) return NEUTRAL_STABILITY;

  /*
   * Circular mean, because report times live on a clock. Treating them as plain
   * numbers puts the average of 23:00 and 01:00 at noon, and would score the
   * steadiest possible night operation as the least stable thing in the game.
   */
  const angles = reportLocalMinutes.map((minute) => (minute / 1440) * 2 * Math.PI);
  const meanX = angles.reduce((sum, a) => sum + Math.cos(a), 0) / angles.length;
  const meanY = angles.reduce((sum, a) => sum + Math.sin(a), 0) / angles.length;
  const mean = Math.atan2(meanY, meanX);

  const deviations = angles.map((angle) => {
    const raw = Math.abs(angle - mean);
    const wrapped = Math.min(raw, 2 * Math.PI - raw);
    return (wrapped / (2 * Math.PI)) * 24;
  });
  const spreadHours =
    deviations.reduce((sum, hours) => sum + hours, 0) / Math.max(1, deviations.length);

  return clamp01(1 - spreadHours / spreadHoursForZero);
}

/** No duty periods yet is not a badly-run base. */
export const NEUTRAL_STABILITY = 0.7;

const PAY_LABEL: Record<PayBand, string> = {
  lean: 'Lean',
  market: 'Market',
  generous: 'Generous',
};

const HOTEL_LABEL: Record<HotelTier, string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
};

function describeStability(value: number): string {
  if (value >= 0.8) return 'Steady sign-on times';
  if (value >= 0.5) return 'Somewhat irregular rosters';
  return 'Unpredictable rosters';
}

function describeRest(value: number): string {
  if (value >= 0.99) return 'Full legal rest served';
  if (value >= 0.9) return 'Rest occasionally cut short';
  return 'Rest regularly cut short';
}

/** Linear between the zero-morale and full-morale ends. */
function between(atZero: number, atFull: number, morale: number): number {
  const t = clamp01(morale);
  return atZero + (atFull - atZero) * t;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
