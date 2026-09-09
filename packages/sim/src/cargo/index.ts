/**
 * §12's cargo model, belly channel only (M8-15).
 *
 * Two halves, and they are versioned by different pins on purpose:
 *
 * - **`belly.ts`** — how much freight fits. Aircraft performance, §22.5,
 *   `world.aircraft_catalogue_version`.
 * - **`lane.ts`** — what it earns and how much a lane offers. Economy, §22.3,
 *   `world.economy_config_version`.
 *
 * Freighters, contracts, ULDs, commodity types and a persisted directional
 * demand pool are the CARGO milestone's, scoped by the 2026-09-07 decision
 * (https://github.com/simmeh024/tailfinsim/issues/1087). `lane.ts` names exactly
 * what CARGO-03 replaces.
 */

export * from './belly';
export * from './lane';
