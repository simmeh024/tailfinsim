import { describe, expect, it } from 'vitest';

import { TURNAROUND_PHASE_WINDOWS, TURNAROUND_PHASES, turnaroundProgress } from './apron';

/**
 * App. B.7's turnaround rings (M7-07).
 *
 * The rings share out the real, modelled turn; they are not a second turnaround
 * model. So the property worth holding is that every ring is empty at on-blocks
 * and full by off-blocks, whatever length the real turn is.
 */

const MINUTE = 60_000;
const onBlocks = new Date(Date.UTC(2030, 4, 1, 9, 0));
const at = (minutes: number) => new Date(onBlocks.getTime() + minutes * MINUTE);

describe('TURNAROUND_PHASE_WINDOWS', () => {
  it('names each of App. B.7’s five processes once, inside the turn', () => {
    expect(TURNAROUND_PHASE_WINDOWS.map((window) => window.phase)).toEqual([...TURNAROUND_PHASES]);
    for (const window of TURNAROUND_PHASE_WINDOWS) {
      expect(window.from).toBeGreaterThanOrEqual(0);
      expect(window.to).toBeLessThanOrEqual(1);
      expect(window.to).toBeGreaterThan(window.from);
    }
  });
});

describe('turnaroundProgress', () => {
  it('starts every ring empty at on-blocks and finishes them all by off-blocks', () => {
    for (const turnMinutes of [25, 45, 90, 180]) {
      const departs = at(turnMinutes);
      const start = turnaroundProgress(onBlocks, departs, onBlocks);
      const end = turnaroundProgress(onBlocks, departs, departs);
      for (const phase of TURNAROUND_PHASES) {
        expect(start[phase], `${phase} at ${String(turnMinutes)}`).toBe(0);
        expect(end[phase], `${phase} at ${String(turnMinutes)}`).toBe(1);
      }
    }
  });

  it('never runs backwards and never leaves [0, 1]', () => {
    const departs = at(60);
    let previous = turnaroundProgress(onBlocks, departs, at(-10));
    for (let minute = -9; minute <= 70; minute += 1) {
      const next = turnaroundProgress(onBlocks, departs, at(minute));
      for (const phase of TURNAROUND_PHASES) {
        expect(next[phase]).toBeGreaterThanOrEqual(previous[phase]);
        expect(next[phase]).toBeGreaterThanOrEqual(0);
        expect(next[phase]).toBeLessThanOrEqual(1);
      }
      previous = next;
    }
  });

  it('boards last: boarding has not begun while the bags are still coming off', () => {
    const midway = turnaroundProgress(onBlocks, at(60), at(15));
    expect(midway.bags).toBeGreaterThan(0);
    expect(midway.boarding).toBe(0);
  });

  it('reads a parked aeroplane — no departure scheduled — as a finished turn', () => {
    const parked = turnaroundProgress(onBlocks, null, at(5));
    for (const phase of TURNAROUND_PHASES) expect(parked[phase]).toBe(1);
  });
});
