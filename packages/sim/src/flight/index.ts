/**
 * The flight lifecycle (M1-07) and where the aircraft actually is (M1-08).
 *
 *   `profile`  — how long each phase takes, as config rather than constants
 *   `timeline` — those durations laid out on the game-time line
 *   `machine`  — the pure reducer that moves a flight along it, and off it
 *   `progress` — how far along its track a flight has actually got, and how fast
 *   `position` — that turned into a point on a great circle, for the map
 */
export * from './profile';
export * from './timeline';
export * from './progress';
export * from './machine';
export * from './position';

export * from './turnaround';
