/**
 * The executive floor's rendered art, keyed by how many offices are open.
 *
 * One render for every state from the empty floor (0) to all ten offices open
 * (10). Kept in its own module because two surfaces draw it now: the Headquarters
 * context panel's floor pager ({@link HqLayoutPanel}) and the C-Suite page's own
 * embedded floor ({@link ExecutiveFloorPlan}).
 *
 * ## These are `.webp`, and that was measured rather than assumed (PERF-01)
 *
 * They shipped as PNG: eleven files, **25.17 MB**, in a directory whose other
 * floorplans were already webp at 71–123 kB. One of them becomes the pager's
 * `background-image`, so opening the executive floor downloaded ~2.4 MB for a
 * single image. Re-encoded to webp they are **1.85 MB in total** — 92.6% less,
 * and no image over 241 kB.
 *
 * Encoded at **quality 80, effort 6, `smartSubsample`, native 887×1774**. Every
 * part of that was chosen against a measurement:
 *
 * - **Quality 80** because at 4× nearest-neighbour magnification it is
 *   indistinguishable from the PNG in both the busiest detail and the flat
 *   marble, where blocking and banding respectively would show first. Its
 *   per-pixel RMSE against the original is 4.2 on a 0–255 scale, and the bytes
 *   per pixel it lands on are *more* generous than the webp siblings already in
 *   this directory — so it sits on the quality side of the house convention
 *   rather than pushing it.
 * - **`smartSubsample`** because the art's saturated small features are the wall
 *   lamps, and chroma subsampling is exactly what smears those. It costs 16 kB
 *   on the largest file and lowers the error.
 * - **Native dimensions**, deliberately not downscaled. The only consumer is the
 *   22rem context panel, so 887px is already ~2.8× oversampled and resizing
 *   would be a second judgement about high-DPI fidelity on top of a format
 *   change. Whether the art wants to be smaller is a separate question from
 *   whether it wants to be a PNG.
 *
 * The PNGs are deleted rather than kept beside these: webp is already the master
 * format for the floorplans in this directory, and git retains the originals at
 * the commit before this one for anyone who needs to re-export.
 */

import execFloor0 from './assets/floorplan/exec-floor-0.webp';
import execFloor1 from './assets/floorplan/exec-floor-1.webp';
import execFloor10 from './assets/floorplan/exec-floor-10.webp';
import execFloor2 from './assets/floorplan/exec-floor-2.webp';
import execFloor3 from './assets/floorplan/exec-floor-3.webp';
import execFloor4 from './assets/floorplan/exec-floor-4.webp';
import execFloor5 from './assets/floorplan/exec-floor-5.webp';
import execFloor6 from './assets/floorplan/exec-floor-6.webp';
import execFloor7 from './assets/floorplan/exec-floor-7.webp';
import execFloor8 from './assets/floorplan/exec-floor-8.webp';
import execFloor9 from './assets/floorplan/exec-floor-9.webp';

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
