/**
 * The executive floor's rendered art, keyed by how many offices are open.
 *
 * One render for every state from the empty floor (0) to all ten offices open
 * (10). Kept in its own module because two surfaces draw it now: the Headquarters
 * context panel's floor pager ({@link HqLayoutPanel}) and the C-Suite page's own
 * embedded floor ({@link ExecutiveFloorPlan}).
 */

import execFloor0 from './assets/floorplan/exec-floor-0.png';
import execFloor1 from './assets/floorplan/exec-floor-1.png';
import execFloor10 from './assets/floorplan/exec-floor-10.png';
import execFloor2 from './assets/floorplan/exec-floor-2.png';
import execFloor3 from './assets/floorplan/exec-floor-3.png';
import execFloor4 from './assets/floorplan/exec-floor-4.png';
import execFloor5 from './assets/floorplan/exec-floor-5.png';
import execFloor6 from './assets/floorplan/exec-floor-6.png';
import execFloor7 from './assets/floorplan/exec-floor-7.png';
import execFloor8 from './assets/floorplan/exec-floor-8.png';
import execFloor9 from './assets/floorplan/exec-floor-9.png';

const EXEC_FLOORPLAN: Record<number, string> = {
  0: execFloor0,
  1: execFloor1,
  2: execFloor2,
  3: execFloor3,
  4: execFloor4,
  5: execFloor5,
  6: execFloor6,
  7: execFloor7,
  8: execFloor8,
  9: execFloor9,
  10: execFloor10,
};

/** The exec floor plan aspect ratio — every render shares it. */
export const EXEC_FLOOR_ASPECT = '887 / 1774';

/** The exec floor render for a given progress — the exact art if we have it, else the nearest below. */
export function execFloorImage(officesUnlocked: number): string {
  for (let n = officesUnlocked; n >= 0; n -= 1) {
    const src = EXEC_FLOORPLAN[n];
    if (src !== undefined) return src;
  }
  return execFloor0;
}
