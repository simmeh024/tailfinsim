/**
 * Great-circle distance, and the packed matrix that makes it a lookup (M1-04).
 *
 * App. B.4's reachability check runs on every candidate route, every time the
 * route picker is opened, for every aircraft in the fleet. The issue's framing is
 * the right one: it must be a lookup rather than a calculation.
 *
 * Everything here is pure, per CONTRIBUTING invariant 2 — no file reads, no
 * clock, no database. The matrix arrives as a buffer the caller has already
 * loaded, so `packages/sim` stays a function of its inputs and the same inputs
 * always give the same answer.
 */

/**
 * Mean Earth radius in nautical miles.
 *
 * 6,371 km over exactly 1,852 m to the nautical mile. Nautical miles rather than
 * kilometres because every aircraft range figure in the design doc is in nm
 * (App. B.4's ATR 72 at ~700 nm, LHR–NRT at 5,179 nm), and converting at each
 * comparison is how a units bug gets in.
 */
export const EARTH_RADIUS_NM = 6371 / 1.852;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in nautical miles.
 *
 * Haversine rather than the spherical law of cosines: the latter loses precision
 * badly at short distances, and short sectors are exactly where the ATR-72 game
 * of App. B.4 is played.
 */
export function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLon = (bLon - aLon) * DEG_TO_RAD;
  const lat1 = aLat * DEG_TO_RAD;
  const lat2 = bLat * DEG_TO_RAD;

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // Clamped before the root: floating point can push h a hair above 1 for
  // near-antipodal pairs, and Math.asin of that is NaN.
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How many entries a packed upper triangle needs for `n` points. */
export function packedLength(n: number): number {
  return (n * (n - 1)) / 2;
}

/**
 * Index into the packed upper triangle, excluding the diagonal.
 *
 * Only half the matrix is stored because distance is symmetric, and the diagonal
 * is skipped because it is always zero. For 4,359 airports that is 9.5 million
 * entries rather than 19 million — 38 MB instead of 76 MB, which is the
 * difference between fitting the issue's 40 MB budget and not.
 *
 * Callers pass either order; the pair is normalised here so nobody has to
 * remember which way round it goes.
 */
export function packedIndex(i: number, j: number, n: number): number {
  if (i === j) throw new Error('packedIndex: the diagonal is not stored — it is always zero');
  const [low, high] = i < j ? [i, j] : [j, i];
  if (low < 0 || high >= n) {
    throw new Error(`packedIndex: ${String(i)},${String(j)} is outside a matrix of ${String(n)}`);
  }
  return low * n - (low * (low + 1)) / 2 + (high - low - 1);
}

export interface DistanceMatrixData {
  /** Airport identifiers in matrix order — the index map. */
  idents: readonly string[];
  /** Packed upper triangle, Float32, in `packedIndex` order. */
  distances: Float32Array;
}

/**
 * A loaded distance matrix.
 *
 * Float32 holds about 7 significant digits, so a 5,179 nm sector is exact to
 * well under a nautical mile — far tighter than the ±1% the acceptance criterion
 * asks for, and half the memory of Float64. Aircraft range is not known to
 * better than that anyway.
 */
export class DistanceMatrix {
  private readonly index: Map<string, number>;

  constructor(private readonly data: DistanceMatrixData) {
    const expected = packedLength(data.idents.length);
    if (data.distances.length !== expected) {
      throw new Error(
        `Distance matrix has ${String(data.distances.length)} entries, ` +
          `expected ${String(expected)} for ${String(data.idents.length)} airports`,
      );
    }
    this.index = new Map(data.idents.map((ident, position) => [ident, position]));
  }

  get size(): number {
    return this.data.idents.length;
  }

  has(ident: string): boolean {
    return this.index.has(ident);
  }

  /**
   * Distance between two airports by identifier, or `null` if either is not in
   * the matrix.
   *
   * Null rather than a throw: the matrix covers the scheduled-service subset, and
   * asking about an airstrip outside it is a normal question with the honest
   * answer "not something this matrix knows". A throw would make every caller
   * guard first.
   */
  distanceNm(a: string, b: string): number | null {
    const i = this.index.get(a);
    const j = this.index.get(b);
    if (i === undefined || j === undefined) return null;
    if (i === j) return 0;
    return this.data.distances[packedIndex(i, j, this.data.idents.length)] ?? null;
  }

  /** Distance by matrix position, for callers that have already resolved idents. */
  distanceAt(i: number, j: number): number {
    if (i === j) return 0;
    return this.data.distances[packedIndex(i, j, this.data.idents.length)] ?? 0;
  }
}

export interface MatrixPoint {
  ident: string;
  latitude: number;
  longitude: number;
}

/**
 * Builds the packed matrix.
 *
 * O(n²/2) haversines — 9.5 million for the real dataset. Deliberately a plain
 * loop over a preallocated Float32Array: allocating per pair, or building an
 * array of objects, is what turns a two-second job into a two-minute one.
 *
 * Latitudes and longitudes are converted to radians once up front rather than
 * inside the inner loop, which is 9.5 million multiplications saved and the
 * reason this comes in well under the 60-second budget.
 */
export function buildDistanceMatrix(points: readonly MatrixPoint[]): DistanceMatrixData {
  const n = points.length;
  const distances = new Float32Array(packedLength(n));

  const latRad = new Float64Array(n);
  const lonRad = new Float64Array(n);
  const cosLat = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const point = points[i]!;
    latRad[i] = point.latitude * DEG_TO_RAD;
    lonRad[i] = point.longitude * DEG_TO_RAD;
    cosLat[i] = Math.cos(latRad[i]!);
  }

  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const lat1 = latRad[i]!;
    const lon1 = lonRad[i]!;
    const cos1 = cosLat[i]!;
    for (let j = i + 1; j < n; j += 1) {
      const dLat = latRad[j]! - lat1;
      const dLon = lonRad[j]! - lon1;
      const sinLat = Math.sin(dLat / 2);
      const sinLon = Math.sin(dLon / 2);
      const h = sinLat * sinLat + cos1 * cosLat[j]! * sinLon * sinLon;
      distances[cursor] = 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
      cursor += 1;
    }
  }

  return { idents: points.map((point) => point.ident), distances };
}
