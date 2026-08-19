/**
 * `@tailfin/sim` — the pure simulation core: demand, flights, economy, crew.
 *
 * Architectural rule, enforced by lint (M0-02) and by this package's
 * dependency list: **sim depends on `@tailfin/shared` and nothing else.**
 * It must never import from `@tailfin/server` or `@tailfin/web`. Keeping it
 * pure is what makes the deterministic replay harness (M13-01) and the
 * economy regression suite (M13-02) possible at all.
 */

import { FLAGSHIP_EPOCH_ISO, FLAGSHIP_SPEED_MULTIPLIER } from '@tailfin/shared';

/**
 * Convert elapsed real time into in-game time for a world.
 *
 * `InGameDate = Epoch + speed × (real time elapsed since world launch)`
 * — design doc §3.1b. The real clock work lands in M1-05; this is here to
 * prove the package graph resolves.
 */
export function inGameDate(
  realElapsedMs: number,
  epochIso: string = FLAGSHIP_EPOCH_ISO,
  speed: number = FLAGSHIP_SPEED_MULTIPLIER,
): Date {
  return new Date(Date.parse(epochIso) + speed * realElapsedMs);
}
export * from './clock';

export * from './distance';

export * from './flight';

export * from './route';

export * from './aircraft';

export * from './schedule';
