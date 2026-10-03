import {
  TURNAROUND_PHASE_WINDOWS,
  type AirportStand,
  type ApronMovement,
  type GateContract,
  type StandHolder,
  type StandKind,
  type StandUtilisationView,
  type TurnaroundPhase,
} from '@tailfin/shared';

import type { Point, RunwayShape } from './layout';

/**
 * The airport map's words and the arithmetic its pictures need (M7-07).
 *
 * Pure folds over what the server sent. Nothing here decides who may lease a
 * stand, what one costs or how long a turn takes — those are M7-06's and
 * `computeTurnaround`'s, and the map only draws them.
 */

export const STAND_KIND_LABEL: Record<StandKind, string> = {
  contact_gate: 'Contact gate',
  remote_stand: 'Remote stand',
  overnight_parking: 'Overnight parking',
  cargo_stand: 'Cargo stand',
  maintenance_stand: 'Maintenance stand',
};

export const CONTRACT_LABEL: Record<GateContract, string> = {
  common_use: 'Common use',
  preferential: 'Preferential',
  exclusive: 'Exclusive',
};

/**
 * App. B.7's three ways a stand can look.
 *
 * *"Your gates highlighted in your brand colours … rival gates in muted
 * neutrals; unleased gates in outline."* A stand you share with a rival is
 * yours: the map's job is to show the airport becoming yours, and the rival is
 * still named on it.
 */
export type StandState = 'yours' | 'rival' | 'open';

export function standState(stand: Pick<AirportStand, 'yourContract' | 'holders'>): StandState {
  if (stand.yourContract !== null) return 'yours';
  return stand.holders.length > 0 ? 'rival' : 'open';
}

/** Who holds a stand, in words: `KLM Royal Dutch Airlines (exclusive), you (preferential)`. */
export function holdersInWords(holders: readonly StandHolder[]): string {
  if (holders.length === 0) return 'Nobody holds it';
  return holders
    .map(
      (holder) =>
        `${holder.isYou ? 'You' : holder.name} (${CONTRACT_LABEL[holder.contract].toLowerCase()})`,
    )
    .join(', ');
}

/**
 * The accessible name of a stand: everything the picture says about it.
 *
 * Read aloud when it takes focus, so a keyboard or screen-reader user learns
 * the same three facts the fill shows — whose it is, on what contract, and
 * whether an exclusive lease has closed it.
 */
export function standAccessibleName(
  stand: Pick<AirportStand, 'position' | 'kind' | 'holders' | 'yourContract' | 'exclusivelyHeld'>,
): string {
  const parts = [`${stand.position}, ${STAND_KIND_LABEL[stand.kind].toLowerCase()}`];
  parts.push(stand.holders.length === 0 ? 'unleased' : `held by ${holdersInWords(stand.holders)}`);
  if (stand.exclusivelyHeld) parts.push('exclusively held');
  return parts.join(' — ');
}

/* -- The utilisation heat overlay --------------------------------------------- */

/**
 * Above this share of the operating day a stand is *jammed*: turns are queuing
 * for it, and another gate or a reshuffled rotation would pay. Presentation —
 * the threshold of a picture, not a price — which is why it is here and not in
 * the economy config. App. B.6's floor is the other end and comes from the
 * server as `belowFloor`.
 */
export const JAMMED_FRACTION = 0.85;

/** *"Which of your gates are idle and which are jammed."* */
export type HeatBand = 'idle' | 'working' | 'jammed';

export function heatBand(utilisation: StandUtilisationView): HeatBand {
  if (utilisation.belowFloor) return 'idle';
  return utilisation.fraction >= JAMMED_FRACTION ? 'jammed' : 'working';
}

export const HEAT_LABEL: Record<HeatBand, string> = {
  idle: 'Idle — below the utilisation floor',
  working: 'Working',
  jammed: `Jammed — over ${String(Math.round(JAMMED_FRACTION * 100))}% occupied`,
};

/** The glyph beside a heat band, so it reads without hue (H.7). */
export const HEAT_GLYPH: Record<HeatBand, string> = {
  idle: '▽',
  working: '●',
  jammed: '▲',
};

export function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/* -- Turnaround rings ----------------------------------------------------------- */

/** `Bags 100%, cleaning 80%, …` — the rings, said. */
export function ringsInWords(progress: Record<TurnaroundPhase, number>): string {
  return TURNAROUND_PHASE_WINDOWS.map(
    (window, i) =>
      `${i === 0 ? window.label : window.label.toLowerCase()} ${percent(progress[window.phase])}`,
  ).join(', ');
}

/* -- Game clock ----------------------------------------------------------------- */

/** `09:05` — the world's clock, UTC, as every other world time on the map. */
export function gameClock(iso: string): string {
  return iso.slice(11, 16);
}

/* -- Runway movements ----------------------------------------------------------- */

/** *"Runways with live movements"*: a movement is drawn from this long before it to this long after. */
export const MOVEMENT_WINDOW_MS = 2 * 60_000;

/** Movements close enough to now to be on the runway, in time order. */
export function liveMovements(movements: readonly ApronMovement[], now: Date): ApronMovement[] {
  const t = now.getTime();
  return movements
    .filter((movement) => Math.abs(Date.parse(movement.at) - t) <= MOVEMENT_WINDOW_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * How far along the runway a movement is, as a share of its length from the
 * lower-numbered threshold: below 0 is still on approach, above 1 has left the
 * runway behind.
 *
 * An arrival comes in over the threshold and touches down just past it at `at`,
 * then rolls out; a departure lines up, rolls, lifts off three-quarters of the
 * way down at `at` and climbs away. Piecewise linear, because the marker only
 * has to be legible as *landing* or *taking off*, not to be a performance model.
 */
export function movementProgress(kind: ApronMovement['kind'], at: Date, now: Date): number {
  const f = (now.getTime() - (at.getTime() - MOVEMENT_WINDOW_MS)) / (2 * MOVEMENT_WINDOW_MS);
  const clamped = Math.min(1, Math.max(0, f));
  const [start, middle, end] = kind === 'arrival' ? [-0.5, 0.15, 0.85] : [0.05, 0.75, 1.6];
  return clamped <= 0.5
    ? start + (middle - start) * (clamped / 0.5)
    : middle + (end - middle) * ((clamped - 0.5) / 0.5);
}

/**
 * Which runway a movement is drawn on. Arrivals use the first, departures the
 * last — on a two-runway airport that is the common split, and on a one-runway
 * airport both use the only one there is.
 */
export function runwayFor(
  kind: ApronMovement['kind'],
  runways: readonly RunwayShape[],
): RunwayShape | undefined {
  return kind === 'arrival' ? runways[0] : runways[runways.length - 1];
}

/** Where a movement's marker is, and which way it points. */
export function movementPoint(
  runway: RunwayShape,
  movement: Pick<ApronMovement, 'kind' | 'at'>,
  now: Date,
): Point & { heading: number } {
  const s = movementProgress(movement.kind, new Date(movement.at), now);
  const [from, to] = runway.ends;
  return {
    x: from.x + (to.x - from.x) * s,
    y: from.y + (to.y - from.y) * s,
    heading: runway.heading,
  };
}
