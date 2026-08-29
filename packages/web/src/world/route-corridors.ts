import type { LngLat } from './terminator';

/**
 * Corridor bundling for the live route lines (M7-03).
 *
 * "All traffic" on the whole-world view is a hairball: hundreds of near-parallel
 * legs between the same handful of big hubs, drawn on top of each other. Bundling
 * collapses the legs that share a **corridor** — the same pair of regions, however
 * their exact airports differ — into one representative line whose weight says how
 * many routes run it. Zoom in and the grid shrinks to nothing, so corridors split
 * back into their individual legs: the un-bundling the acceptance criteria ask for.
 *
 * The maths is deliberately trivial and pure, so it is cheap to run every time the
 * zoom crosses a step and easy to test: snap each endpoint to a grid, key a leg by
 * its two snapped ends (order-independent, so A→B and B→A share a corridor), and
 * average the real endpoints of the members back for the line to draw.
 */

export interface CorridorRoute {
  id: string;
  source: LngLat;
  target: LngLat;
}

export interface Corridor {
  /** Stable id for the bundled line — the two grid cells it spans. */
  key: string;
  /** Averaged endpoints of the members, so the line sits among the legs it stands for. */
  source: LngLat;
  target: LngLat;
  /** How many individual routes run this corridor — the line's weight. */
  count: number;
  /** The routes it bundles, for a click-through later. */
  routeIds: string[];
}

/** Snap a longitude/latitude to a grid of `gridDeg` degrees. */
function snap([lon, lat]: LngLat, gridDeg: number): [number, number] {
  return [Math.round(lon / gridDeg), Math.round(lat / gridDeg)];
}

/** An order-independent key for a cell pair, so A→B and B→A land together. */
function cellKey(a: [number, number], b: [number, number]): string {
  const first = `${a[0]},${a[1]}`;
  const second = `${b[0]},${b[1]}`;
  return first <= second ? `${first}|${second}` : `${second}|${first}`;
}

/**
 * Bundle legs that share a corridor at the given grid coarseness.
 *
 * A larger `gridDeg` bundles more aggressively (the far-out view); as it shrinks
 * towards a fraction of a degree, every leg keeps its own cell and nothing bundles.
 * The two ends of each corridor are held apart by the order the first member set,
 * and later members are aligned to those ends by proximity before averaging, so a
 * leg flown the other way round does not cancel the line out.
 */
export function bundleCorridors(routes: readonly CorridorRoute[], gridDeg: number): Corridor[] {
  interface Accumulator {
    key: string;
    endA: [number, number];
    sumA: [number, number];
    sumB: [number, number];
    count: number;
    routeIds: string[];
  }
  const byKey = new Map<string, Accumulator>();

  for (const route of routes) {
    const cellSource = snap(route.source, gridDeg);
    const cellTarget = snap(route.target, gridDeg);
    const key = cellKey(cellSource, cellTarget);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = {
        key,
        endA: cellSource,
        sumA: [0, 0],
        sumB: [0, 0],
        count: 0,
        routeIds: [],
      };
      byKey.set(key, entry);
    }
    // Align this leg's endpoints to the corridor's A/B ends: whichever snapped end
    // matches `endA` contributes to A, the other to B. A degenerate leg (both ends
    // in one cell) still counts, both endpoints falling to the same side harmlessly.
    const sourceIsA = cellSource[0] === entry.endA[0] && cellSource[1] === entry.endA[1];
    const [aPoint, bPoint] = sourceIsA
      ? [route.source, route.target]
      : [route.target, route.source];
    entry.sumA[0] += aPoint[0];
    entry.sumA[1] += aPoint[1];
    entry.sumB[0] += bPoint[0];
    entry.sumB[1] += bPoint[1];
    entry.count += 1;
    entry.routeIds.push(route.id);
  }

  return [...byKey.values()].map((entry) => ({
    key: entry.key,
    source: [entry.sumA[0] / entry.count, entry.sumA[1] / entry.count],
    target: [entry.sumB[0] / entry.count, entry.sumB[1] / entry.count],
    count: entry.count,
    routeIds: entry.routeIds,
  }));
}

/**
 * The bundling grid for a zoom, in degrees — coarse when the whole world is in
 * frame, vanishing as the camera comes in so corridors split back into legs.
 * Returns `0` above `unbundleZoom`, the signal to draw every leg individually.
 */
export function corridorGridForZoom(zoom: number, unbundleZoom = 3.5): number {
  if (zoom >= unbundleZoom) return 0;
  // ~12° cells on the whole-world view, tightening to ~3° as the camera approaches
  // the un-bundle zoom. Linear in zoom is smooth enough for a step that only fires
  // on a threshold crossing.
  const t = Math.max(0, Math.min(1, zoom / unbundleZoom));
  return 12 - 9 * t;
}
