import type { LngLat } from './terminator';

/**
 * Great-circle flight simulation for the world map's plane icons (M7).
 *
 * Not tied to real schedules yet — this is the FlightRadar-style *look*: a plane
 * moving along each route's great circle, nose pointed the way it is going. The
 * maths is spherical (via 3D unit vectors) so a plane follows the same curve the
 * route line draws rather than cutting a straight line across a Mercator map.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

type Vec3 = [number, number, number];

function toVec([lon, lat]: LngLat): Vec3 {
  const lo = lon * RAD;
  const la = lat * RAD;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function toLngLat([x, y, z]: Vec3): LngLat {
  return [Math.atan2(y, x) * DEG, Math.atan2(z, Math.hypot(x, y)) * DEG];
}

/** The point a fraction `t` (0→1) of the way along the great circle from a to b. */
export function interpolateGreatCircle(a: LngLat, b: LngLat, t: number): LngLat {
  const A = toVec(a);
  const B = toVec(b);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return [a[0], a[1]];
  const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const s1 = Math.sin(t * omega) / Math.sin(omega);
  return toLngLat([A[0] * s0 + B[0] * s1, A[1] * s0 + B[1] * s1, A[2] * s0 + B[2] * s1]);
}

/**
 * The great circle from a to b as a flat polyline on the map surface.
 *
 * This is the FlightRadar-style route *line*: it lies on the ground (unlike an
 * `ArcLayer`, which lifts a rainbow off the surface into 3D), so on a flat map it
 * reads as a line that bends north or south the way a real long-haul track does.
 * The plane rides this exact same curve, because both come from
 * {@link interpolateGreatCircle}.
 *
 * Longitudes are **unwrapped** — each point is pulled to within 180° of the one
 * before it, so a leg crossing the antimeridian keeps climbing past ±180 rather
 * than snapping back and drawing a stray line straight across the whole map.
 * deck.gl accepts out-of-range longitudes on both the flat map and the globe.
 */
export function greatCirclePath(a: LngLat, b: LngLat, segments = 64): LngLat[] {
  const path: LngLat[] = [];
  let previousLon: number | undefined;
  for (let i = 0; i <= segments; i += 1) {
    const [lon, lat] = interpolateGreatCircle(a, b, i / segments);
    let unwrapped = lon;
    if (previousLon !== undefined) {
      while (unwrapped - previousLon > 180) unwrapped -= 360;
      while (unwrapped - previousLon < -180) unwrapped += 360;
    }
    previousLon = unwrapped;
    path.push([unwrapped, lat]);
  }
  return path;
}

/**
 * A simulated altitude at fraction `t` along a leg (0 on the ground → 1 at cruise).
 *
 * FlightRadar colours a trail by height: near the ground on climb-out and on
 * approach, high in the long middle. This is that profile — a quick climb over the
 * first stretch, a flat cruise, a descent into the far end — used only to colour
 * the route line, not to move the plane. Symmetric, so it reads the same whichever
 * way the leg is drawn.
 */
export function altitudeProfile(t: number): number {
  const ramp = 0.12;
  if (t <= ramp) return t / ramp;
  if (t >= 1 - ramp) return (1 - t) / ramp;
  return 1;
}

/** Initial bearing from a to b, degrees clockwise from north (0–360). */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** The heading of the great-circle path at fraction `t`, from a short step ahead. */
export function headingAt(a: LngLat, b: LngLat, t: number): number {
  const here = interpolateGreatCircle(a, b, t);
  const ahead = interpolateGreatCircle(a, b, Math.min(1, t + 0.005));
  return bearing(here, ahead);
}

/**
 * Per-route track variation, so a route is not a mathematically perfect great
 * circle.
 *
 * A real leg wanders: a departure turn onto an airway, a dogleg around a sector, a
 * few degrees of drift, an approach from one side or the other. This adds that as a
 * smooth **lateral** offset from the great circle — a sum of a handful of sine
 * waves whose amplitudes, frequencies and phases are seeded from the route id, so
 * every route has its own shape and it is the *same* shape every render (the line
 * and the plane share it). The offset is enveloped to zero at both ends, so the
 * track still begins and ends exactly at the two airports.
 */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** A stable 32-bit hash of a route id, the seed for its track's variation. */
export function routeSeed(id: string): number {
  let hash = FNV_OFFSET >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** mulberry32 — a tiny seeded PRNG, so a route's waypoints are deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harmonic {
  frequency: number;
  phase: number;
  weight: number;
}

/** The mix of waves this route meanders by, drawn from its seed. */
function routeHarmonics(seed: number): Harmonic[] {
  const rng = mulberry32(seed);
  const harmonics: Harmonic[] = [];
  for (let k = 0; k < 3; k += 1) {
    harmonics.push({
      frequency: 1 + Math.floor(rng() * 4),
      phase: rng() * Math.PI * 2,
      weight: 0.5 + rng() * 0.5,
    });
  }
  return harmonics;
}

/** The lateral wander at fraction `t`, in roughly [-1, 1], zero at both ends. */
function meander(t: number, harmonics: Harmonic[]): number {
  let sum = 0;
  let weightSum = 0;
  for (const { frequency, phase, weight } of harmonics) {
    sum += weight * Math.sin(Math.PI * frequency * t + phase);
    weightSum += weight;
  }
  const envelope = Math.sin(Math.PI * t);
  return weightSum > 0 ? (envelope * sum) / weightSum : 0;
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize3(a: Vec3): Vec3 {
  const magnitude = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude];
}

function slerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  const omega = Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
  if (omega < 1e-6) return a;
  const s0 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const s1 = Math.sin(t * omega) / Math.sin(omega);
  return [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1];
}

interface FlightArc {
  a: Vec3;
  b: Vec3;
  harmonics: Harmonic[];
  /** The largest lateral swing, in radians — scaled to the leg, capped so a long
   * haul does not wander wildly. */
  maxAngle: number;
}

function makeFlightArc(source: LngLat, target: LngLat, seed: number): FlightArc {
  const a = toVec(source);
  const b = toVec(target);
  const omega = Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
  return { a, b, harmonics: routeHarmonics(seed), maxAngle: Math.min(omega * 0.12, 2.5 * RAD) };
}

/** The unit vector on the varied track at fraction `t`. */
function arcVec(arc: FlightArc, t: number): Vec3 {
  const point = slerpVec(arc.a, arc.b, t);
  if (t <= 0 || t >= 1 || arc.maxAngle <= 0) return point;
  // Rotate the great-circle point sideways by the meander: `left` is the tangent
  // perpendicular to travel, and rotating `point` towards it by `offset` radians
  // shifts the track laterally while keeping it on the sphere.
  const ahead = slerpVec(arc.a, arc.b, Math.min(1, t + 1e-3));
  const travel = normalize3([ahead[0] - point[0], ahead[1] - point[1], ahead[2] - point[2]]);
  const left = normalize3(cross3(point, travel));
  const offset = arc.maxAngle * meander(t, arc.harmonics);
  const cos = Math.cos(offset);
  const sin = Math.sin(offset);
  return normalize3([
    point[0] * cos + left[0] * sin,
    point[1] * cos + left[1] * sin,
    point[2] * cos + left[2] * sin,
  ]);
}

function arcHeading(arc: FlightArc, t: number): number {
  const here = toLngLat(arcVec(arc, t));
  const ahead = toLngLat(arcVec(arc, Math.min(1, t + 0.01)));
  return bearing(here, ahead);
}

/**
 * The varied flight track as a flat polyline on the surface — the great circle with
 * this route's own seeded wander applied. Longitudes are unwrapped exactly as
 * {@link greatCirclePath} does, so an antimeridian crossing does not snap back.
 */
export function flightPath(source: LngLat, target: LngLat, seed: number, segments = 64): LngLat[] {
  const arc = makeFlightArc(source, target, seed);
  const path: LngLat[] = [];
  let previousLon: number | undefined;
  for (let i = 0; i <= segments; i += 1) {
    const [lon, lat] = toLngLat(arcVec(arc, i / segments));
    let unwrapped = lon;
    if (previousLon !== undefined) {
      while (unwrapped - previousLon > 180) unwrapped -= 360;
      while (unwrapped - previousLon < -180) unwrapped += 360;
    }
    previousLon = unwrapped;
    path.push([unwrapped, lat]);
  }
  return path;
}

export interface RouteLike {
  id: string;
  source: LngLat;
  target: LngLat;
}

/** One simulated aircraft: where it is and which way its nose points. */
export interface WorldPlane {
  routeId: string;
  position: LngLat;
  /** deck.gl icon angle — counter-clockwise degrees, so a north-up icon faces travel. */
  angle: number;
}

/**
 * A plane for every route at the given animation phase (0→1, looping). More than
 * one plane per route staggers them along the line so a busy route looks busy.
 */
export function planesForRoutes(
  routes: readonly RouteLike[],
  phase: number,
  planesPerRoute = 1,
): WorldPlane[] {
  const planes: WorldPlane[] = [];
  for (const routeItem of routes) {
    // The plane rides the same seeded track the line draws, so it follows the bends
    // rather than cutting a clean great circle through them.
    const arc = makeFlightArc(routeItem.source, routeItem.target, routeSeed(routeItem.id));
    for (let k = 0; k < planesPerRoute; k += 1) {
      const t = (phase + k / planesPerRoute) % 1;
      planes.push({
        routeId: `${routeItem.id}:${String(k)}`,
        position: toLngLat(arcVec(arc, t)),
        // deck.gl rotates the icon counter-clockwise; a north-up plane faces a
        // clockwise bearing when rotated by its negative.
        angle: -arcHeading(arc, t),
      });
    }
  }
  return planes;
}
