/**
 * The flight lifecycle (M1-07, design doc §3.3).
 *
 *   `profile`  — how long each phase takes, as config rather than constants
 *   `timeline` — those durations laid out on the game-time line
 *   `machine`  — the pure reducer that moves a flight along it, and off it
 */
export * from './profile';
export * from './timeline';
export * from './machine';
