import { type FlightPhase } from '@tailfin/shared';

import { type FlightProfile } from './profile';
import { type FlightShape, type LegProgress, legProgressAt } from './progress';
import { type RouteLeg } from './timeline';

/**
 * Where an aircraft is, at any game time (M1-08, design doc §4.1 and §21).
 *
 * ## Slerp, not lerp
 *
 * Positions are interpolated as **unit vectors on a sphere**, not as pairs of
 * numbers. Interpolating latitude and longitude arithmetically gets both things
 * wrong: the path is not a great circle, and it breaks completely at the
 * antimeridian — NRT at 139.8°E to LAX at 118.4°W would sweep 258° *west* across
 * Asia and the Atlantic instead of 102° east across the Pacific.
 *
 * Spherical linear interpolation has no such case to handle. A great circle
 * through two points is the shortest arc between their vectors, and the short
 * way round is simply what the formula produces. The antimeridian stops being a
 * special case and becomes a place where the longitude *number* changes sign
 * while the aircraft carries on in a straight line.
 *
 * That sign change is real and correct, and a renderer that draws line segments
 * between raw longitudes will still streak a line across the whole map when it
 * happens. `unwrapLongitudes` exists for exactly that: it makes a sampled path
 * continuous for drawing, without pretending the coordinates themselves are.
 *
 * ## Purity and cost
 *
 * A pure function of the flight and the instant (CONTRIBUTING invariant 2), with
 * airport coordinates passed in as a lookup because this package does no I/O.
 * §21 requires this to be cheap at world scale — the whole point of computing
 * position instead of storing it — so there are no allocations per sample beyond
 * the returned object, and no trigonometry that can be hoisted is repeated.
 */

export interface Coordinates {
  latitudeDeg: number;
  longitudeDeg: number;
}

/** An airport's position, and how high its ground is. */
export interface AirportPoint extends Coordinates {
  /** Field elevation in feet. Denver sits at 5,431 ft, and an aircraft on its stand is not at zero. */
  elevationFt?: number;
}

/** Resolves an ICAO code to a point. Returns undefined for an airport the caller does not have. */
export type AirportLookup = (icao: string) => AirportPoint | undefined;

export interface Position extends Coordinates {
  /** Feet above sea level. */
  altitudeFt: number;
  groundSpeedKt: number;
  /** Degrees true, 0 ≤ heading < 360. */
  headingDeg: number;
  /** How far along the leg currently being flown, 0–1. */
  progress: number;
  phase: FlightPhase;
  /** Which leg of the flight this is. 0 unless the flight was diverted. */
  legIndex: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

interface Vector {
  x: number;
  y: number;
  z: number;
}

function toVector(point: Coordinates): Vector {
  const lat = point.latitudeDeg * DEG;
  const lon = point.longitudeDeg * DEG;
  const cosLat = Math.cos(lat);
  return { x: cosLat * Math.cos(lon), y: cosLat * Math.sin(lon), z: Math.sin(lat) };
}

function toCoordinates(v: Vector): Coordinates {
  return {
    latitudeDeg: Math.atan2(v.z, Math.hypot(v.x, v.y)) * RAD,
    longitudeDeg: Math.atan2(v.y, v.x) * RAD,
  };
}

/**
 * A point `t` of the way along the great circle from `from` to `to`.
 *
 * `t` outside 0–1 extrapolates along the same circle rather than clamping, which
 * is what a caller sampling a path slightly beyond an endpoint means.
 */
export function slerp(from: Coordinates, to: Coordinates, t: number): Coordinates {
  const a = toVector(from);
  const b = toVector(to);

  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  // Coincident points: the arc has no direction, and every t is the same place.
  if (sinOmega < 1e-12) {
    if (dot > 0) return { latitudeDeg: from.latitudeDeg, longitudeDeg: from.longitudeDeg };
    // Antipodal. There is no *shortest* great circle between opposite points —
    // every one of them is the same length — so there is no honest answer, and
    // guessing would draw a confident line along a route nothing chose. Cannot
    // arise from real airports: the two farthest apart are about 10,600 nm, and
    // antipodal is 10,800.
    throw new Error(
      `No unique great circle between antipodal points ` +
        `(${String(from.latitudeDeg)},${String(from.longitudeDeg)}) and ` +
        `(${String(to.latitudeDeg)},${String(to.longitudeDeg)})`,
    );
  }

  const k1 = Math.sin((1 - t) * omega) / sinOmega;
  const k2 = Math.sin(t * omega) / sinOmega;

  return toCoordinates({
    x: k1 * a.x + k2 * b.x,
    y: k1 * a.y + k2 * b.y,
    z: k1 * a.z + k2 * b.z,
  });
}

/**
 * Initial bearing along the great circle from one point to another, degrees true.
 *
 * "Initial" is the whole point: a great-circle track's bearing changes
 * continuously along it, which is why a flight from London to Tokyo leaves
 * pointing north-east and arrives pointing south-east. Taking the bearing at the
 * aircraft's *current* position is what makes the map icon point where the
 * aircraft is actually going.
 */
export function initialBearingDeg(from: Coordinates, to: Coordinates): number {
  const lat1 = from.latitudeDeg * DEG;
  const lat2 = to.latitudeDeg * DEG;
  const dLon = (to.longitudeDeg - from.longitudeDeg) * DEG;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** `steps + 1` points along the great circle, endpoints included. For drawing route lines (§4.1). */
export function greatCirclePath(from: Coordinates, to: Coordinates, steps: number): Coordinates[] {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`A path needs at least one step, got ${String(steps)}`);
  }
  const points: Coordinates[] = [];
  for (let i = 0; i <= steps; i += 1) points.push(slerp(from, to, i / steps));
  return points;
}

/**
 * Longitudes made continuous, for drawing.
 *
 * A path over the Pacific runs ...179.4, 179.9, −179.6..., and a renderer joining
 * those with straight segments draws a line back across the entire map. This
 * unrolls the sequence to ...179.4, 179.9, 180.4..., so consecutive points are
 * always adjacent.
 *
 * The result is **for geometry only**. Values may fall outside ±180 and are no
 * longer valid coordinates, which is why this returns bare numbers rather than
 * something that could be mistaken for a position.
 */
export function unwrapLongitudes(path: readonly Coordinates[]): number[] {
  const out: number[] = [];
  let offset = 0;
  let previous: number | undefined;

  for (const point of path) {
    if (previous !== undefined) {
      const step = point.longitudeDeg - previous;
      if (step > 180) offset -= 360;
      else if (step < -180) offset += 360;
    }
    previous = point.longitudeDeg;
    out.push(point.longitudeDeg + offset);
  }

  return out;
}

/** The two ends of a leg's track. A replanned leg starts where the previous one was cut. */
function endpointsOf(
  legs: readonly RouteLeg[],
  legIndex: number,
  lookup: AirportLookup,
): { from: Coordinates; to: Coordinates } | null {
  const leg = legs[legIndex];
  if (!leg) return null;

  const to = lookup(leg.toIcao);
  if (!to) return null;

  if (leg.fromIcao !== null) {
    const from = lookup(leg.fromIcao);
    return from ? { from, to } : null;
  }

  // Open water. The previous leg says how far along its own track the aircraft
  // got before it turned, which is exactly the point this leg starts from.
  const previous = legs[legIndex - 1];
  if (!previous) return null;
  const previousEnds = endpointsOf(legs, legIndex - 1, lookup);
  if (!previousEnds) return null;

  return { from: slerp(previousEnds.from, previousEnds.to, previous.flownFraction), to };
}

/**
 * Altitude from the phase and how far through it the flight is.
 *
 * Ramps between the levels each phase joins, so the profile is continuous: the
 * altitude at the end of the climb is the altitude at the start of the cruise,
 * and an aircraft never teleports between flight levels as it changes phase.
 */
function altitudeFt(
  progress: LegProgress,
  profile: FlightProfile,
  originFt: number,
  destinationFt: number,
): number {
  const between = (low: number, high: number) => low + (high - low) * progress.phaseFraction;

  switch (progress.phase) {
    case 'departure':
      return between(originFt, profile.departureAltitudeFt);
    case 'climb':
      return between(profile.departureAltitudeFt, progress.ceilingFt);
    case 'cruise':
      return progress.ceilingFt;
    case 'descent':
      return between(progress.ceilingFt, profile.approachAltitudeFt);
    case 'approach':
      return between(profile.approachAltitudeFt, destinationFt);
    case 'landing':
      return destinationFt;
    default:
      return destinationFt;
  }
}

const ON_THE_GROUND_AT_ORIGIN = new Set<FlightPhase>([
  'scheduled',
  'boarding',
  'pushback',
  'taxi_out',
]);

/**
 * Where the aircraft is at `at`, or null if the airports are not in the lookup.
 *
 * A flight that is not airborne answers with the airport it is sitting at, at
 * field elevation and zero ground speed, rather than with nothing — the flight
 * detail view (§4.2) wants a position for a boarding aircraft too, and "no
 * answer" would be indistinguishable from "no such flight".
 */
export function interpolatePosition(
  flight: FlightShape & { phase: FlightPhase; arrivalIcao: string },
  at: Date,
  profile: FlightProfile,
  lookup: AirportLookup,
): Position | null {
  const progress = legProgressAt(flight, at, profile);

  if (!progress) {
    const icao = ON_THE_GROUND_AT_ORIGIN.has(flight.phase)
      ? flight.plan.originIcao
      : flight.arrivalIcao;
    const stand = lookup(icao);
    if (!stand) return null;
    return {
      latitudeDeg: stand.latitudeDeg,
      longitudeDeg: stand.longitudeDeg,
      altitudeFt: stand.elevationFt ?? 0,
      groundSpeedKt: 0,
      headingDeg: 0,
      progress: ON_THE_GROUND_AT_ORIGIN.has(flight.phase) ? 0 : 1,
      phase: flight.phase,
      legIndex: -1,
    };
  }

  const ends = endpointsOf(flight.legs, progress.legIndex, lookup);
  if (!ends) return null;

  const here = slerp(ends.from, ends.to, progress.fraction);

  // The bearing from *here* to the destination, not the bearing the flight left
  // on: on a great circle those differ by tens of degrees over a long sector.
  // Within a hair of the destination the bearing is numerically meaningless, so
  // the last known good direction is used instead of a random one.
  const headingDeg =
    progress.fraction >= 0.999_9
      ? initialBearingDeg(slerp(ends.from, ends.to, 0.999), ends.to)
      : initialBearingDeg(here, ends.to);

  const originPoint = lookup(flight.plan.originIcao);
  const destinationPoint = lookup(flight.arrivalIcao);

  return {
    latitudeDeg: here.latitudeDeg,
    longitudeDeg: here.longitudeDeg,
    altitudeFt: altitudeFt(
      progress,
      profile,
      originPoint?.elevationFt ?? 0,
      destinationPoint?.elevationFt ?? 0,
    ),
    groundSpeedKt: progress.groundSpeedKt,
    headingDeg,
    progress: progress.fraction,
    phase: progress.phase,
    legIndex: progress.legIndex,
  };
}
