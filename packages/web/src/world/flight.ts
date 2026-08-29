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
    for (let k = 0; k < planesPerRoute; k += 1) {
      const t = (phase + k / planesPerRoute) % 1;
      planes.push({
        routeId: `${routeItem.id}:${String(k)}`,
        position: interpolateGreatCircle(routeItem.source, routeItem.target, t),
        // deck.gl rotates the icon counter-clockwise; a north-up plane faces a
        // clockwise bearing when rotated by its negative.
        angle: -headingAt(routeItem.source, routeItem.target, t),
      });
    }
  }
  return planes;
}
