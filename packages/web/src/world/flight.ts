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
 * Per-route track variation — a re-route, not a wander.
 *
 * An aeroplane flies the direct track. Cleared as filed it runs from one end to the
 * other along the great circle, and the one thing it never does is meander: a
 * sinusoidal flight path is the tell of a graphic rather than a flight.
 *
 * What does happen is air traffic control giving you something else — a lateral offset
 * onto a parallel airway, a dogleg around a busy sector or a line of weather, a
 * re-route that puts a kink in an otherwise straight line. So a track here is
 * **straight great-circle legs joined at one or two waypoints**, with the corner
 * rounded because an aeroplane rolls into a turn rather than hinging at a point.
 *
 * Which legs are re-routed, where their waypoints sit and how far off-track they run
 * are all drawn from the route id, so a route has one track and it is the same track
 * every render — the line and the plane share it. **Most routes get no waypoints at
 * all**, which is what makes the exceptions read as exceptions.
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

/** A deviation from the direct track: how far off, where, and how sharply flown. */
interface Waypoint {
  /** Fraction along the leg, 0 to 1. */
  at: number;
  /** Lateral offset as a share of the maximum for this leg; negative is the far side. */
  offset: number;
  /**
   * How much of the leg the turn is rolled through.
   *
   * This is what separates the two things a bend can be. A **wide** turn spreads the
   * heading change across most of the leg, which is the continuous drift of a track
   * being flown — no corner anywhere, just a line that is never quite a ruler. A
   * **narrow** one puts the whole change in one place, which is a dogleg: the corner
   * you see when a controller turns an aircraft around something.
   */
  turn: number;
}

/**
 * The deviations this route is flown with.
 *
 * Three regimes, and the proportions are the whole look of the map:
 *
 * - a few legs are flown exactly as filed, dead straight;
 * - **most drift gently** — one waypoint, a modest offset, and a turn so wide the
 *   track never has a corner in it, only a slow bow;
 * - some get a real dogleg, and a few of those get two, which is the shape of being
 *   offset onto a parallel track and later rejoining.
 *
 * A ruler-straight line looks unflown and a wave looks drawn; the gentle bow is what
 * an aircraft track actually looks like, so it is the common case.
 */
function routeWaypoints(seed: number): Waypoint[] {
  const rng = mulberry32(seed);
  const roll = rng();

  // Cleared as filed, and flown that way.
  if (roll < 0.14) return [];

  // Which side of the direct track the deviation runs.
  const side = rng() < 0.5 ? -1 : 1;

  if (roll < 0.79) {
    // The common case: a slow bow across the middle of the leg. The turn is half the
    // leg wide, so the heading changes continuously and no part of it reads as a kink.
    return [{ at: 0.4 + rng() * 0.2, offset: side * (0.45 + rng() * 0.45), turn: 0.5 }];
  }

  if (roll < 0.94) {
    // A dogleg: the same lateral idea, flown as one distinct turn instead of a drift.
    return [{ at: 0.28 + rng() * 0.44, offset: side * (0.6 + rng() * 0.4), turn: 0.11 }];
  }

  // Offset onto a parallel track and later rejoined — usually the same side, so it
  // reads as a detour rather than a slalom.
  const secondSide = rng() < 0.8 ? side : -side;
  return [
    { at: 0.22 + rng() * 0.16, offset: side * (0.55 + rng() * 0.45), turn: 0.1 },
    { at: 0.62 + rng() * 0.16, offset: secondSide * (0.55 + rng() * 0.45), turn: 0.1 },
  ];
}

/** Cubic ease, for rolling into and out of a turn. */
function smoothstep(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
}

/**
 * The lateral offset at fraction `t`, in roughly [-1, 1] and zero at both ends.
 *
 * Piecewise linear between the waypoints, with each corner rolled through over that
 * waypoint's own `turn`. The width of the turn is what decides the character: wide
 * enough and the linear stretches vanish into one continuous bow, narrow and they stay
 * straight either side of a corner. A leg with no waypoints is offset zero the whole
 * way, which is exactly the great circle.
 */
function lateralAt(t: number, waypoints: readonly Waypoint[]): number {
  if (waypoints.length === 0) return 0;
  // The two airports bracket the waypoints. Neither is ever a corner — the loop below
  // only rolls a turn at an interior point — so their `turn` is unused.
  const points: Waypoint[] = [
    { at: 0, offset: 0, turn: 0 },
    ...waypoints,
    { at: 1, offset: 0, turn: 0 },
  ];

  /** The straight leg arriving at `points[i]`, extended to any fraction. */
  const leg = (i: number, at: number): number => {
    const from = points[i - 1]!;
    const to = points[i]!;
    const span = to.at - from.at;
    if (span <= 0) return to.offset;
    return from.offset + ((at - from.at) / span) * (to.offset - from.offset);
  };

  for (let i = 1; i < points.length; i += 1) {
    const corner = points[i]!;
    if (i < points.length - 1) {
      // Half-width of the turn, clamped so it can never reach past the waypoint on
      // either side of it — which is also what keeps a wide turn from swallowing an
      // endpoint and lifting the track off its airport.
      const half = Math.min(
        corner.turn,
        (corner.at - points[i - 1]!.at) / 2,
        (points[i + 1]!.at - corner.at) / 2,
      );
      if (half > 0 && t > corner.at - half && t < corner.at + half) {
        // Inside the turn: roll the incoming leg into the outgoing one.
        const u = smoothstep((t - (corner.at - half)) / (2 * half));
        return leg(i, t) * (1 - u) + leg(i + 1, t) * u;
      }
    }
    if (t <= corner.at) return leg(i, t);
  }
  return 0;
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
  /** The deviations this leg was given. Empty — the common case — is flown direct. */
  waypoints: Waypoint[];
  /** How far off-track a full deviation runs, in radians — scaled to the leg and
   * capped, so a long haul kinks rather than detours. */
  maxAngle: number;
}

function makeFlightArc(source: LngLat, target: LngLat, seed: number): FlightArc {
  const a = toVec(source);
  const b = toVec(target);
  const omega = Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
  return { a, b, waypoints: routeWaypoints(seed), maxAngle: Math.min(omega * 0.16, 3 * RAD) };
}

/** The unit vector on this route's track at fraction `t`. */
function arcVec(arc: FlightArc, t: number): Vec3 {
  const point = slerpVec(arc.a, arc.b, t);
  // A leg flown as filed *is* the great circle, and most are: no rotation, and no trig
  // beyond the slerp — which is also what keeps the per-frame plane animation cheap.
  if (arc.waypoints.length === 0 || t <= 0 || t >= 1 || arc.maxAngle <= 0) return point;
  const offset = arc.maxAngle * lateralAt(t, arc.waypoints);
  if (offset === 0) return point;
  // Rotate the great-circle point sideways onto the cleared track: `left` is the
  // tangent perpendicular to travel, and rotating `point` towards it by `offset`
  // radians shifts the track laterally while keeping it on the sphere.
  const ahead = slerpVec(arc.a, arc.b, Math.min(1, t + 1e-3));
  const travel = normalize3([ahead[0] - point[0], ahead[1] - point[1], ahead[2] - point[2]]);
  const left = normalize3(cross3(point, travel));
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
  /** Unique per plane (route id plus its index), so deck.gl keys them apart. */
  routeId: string;
  /** The route this plane flies, for looking up its carrier on a click. */
  sourceId: string;
  position: LngLat;
  /** deck.gl icon angle — counter-clockwise degrees, so a north-up icon faces travel. */
  angle: number;
}

/**
 * A route's flight arc and phase offset, built once and reused every frame.
 *
 * `makeFlightArc` runs trig and a seeded harmonic mix, and the animation calls
 * `planesForRoutes` sixty times a second — rebuilding every arc each frame is what
 * pushed the globe below its frame budget. A route id maps to fixed endpoints, so
 * the arc is cached by id; the stored endpoints guard against the rare id whose
 * coordinates change, rebuilding it then.
 */
interface CachedArc {
  source: LngLat;
  target: LngLat;
  arc: FlightArc;
  offset: number;
}
const arcCache = new Map<string, CachedArc>();

function routeArc(id: string, source: LngLat, target: LngLat): CachedArc {
  const cached = arcCache.get(id);
  if (cached !== undefined) {
    const same =
      cached.source[0] === source[0] &&
      cached.source[1] === source[1] &&
      cached.target[0] === target[0] &&
      cached.target[1] === target[1];
    if (same) return cached;
  }
  const seed = routeSeed(id);
  // A stable 0–1 offset from the route's own seed, so two routes are almost never
  // at the same fraction of their legs at the same moment.
  const entry: CachedArc = {
    source,
    target,
    arc: makeFlightArc(source, target, seed),
    offset: (seed % 9973) / 9973,
  };
  arcCache.set(id, entry);
  return entry;
}

/**
 * A plane for every route at the given animation phase (0→1, looping). More than
 * one plane per route staggers them along the line so a busy route looks busy.
 *
 * Each route also carries a **per-route phase offset** seeded from its id, so the
 * whole fleet is not frozen at the same fraction of every leg. Without it every
 * plane sits at exactly `phase` along its own route — and on a hub-and-spoke
 * network, where dozens of legs radiate from a few hubs, that piles every aircraft
 * into one throbbing clump near the hubs rather than scattering them along their
 * routes the way real traffic reads. The offset is deterministic, so a plane's
 * position is still stable frame to frame.
 */
export function planesForRoutes(
  routes: readonly RouteLike[],
  phase: number,
  planesPerRoute = 1,
): WorldPlane[] {
  const planes: WorldPlane[] = [];
  for (const routeItem of routes) {
    // The plane rides the same seeded track the line draws, so it follows the bends
    // rather than cutting a clean great circle through them. The arc is cached by
    // route id so the per-frame animation does not rebuild it.
    const { arc, offset } = routeArc(routeItem.id, routeItem.source, routeItem.target);
    for (let k = 0; k < planesPerRoute; k += 1) {
      const t = (phase + offset + k / planesPerRoute) % 1;
      planes.push({
        routeId: `${routeItem.id}:${String(k)}`,
        sourceId: routeItem.id,
        position: toLngLat(arcVec(arc, t)),
        // deck.gl rotates the icon counter-clockwise; a north-up plane faces a
        // clockwise bearing when rotated by its negative.
        angle: -arcHeading(arc, t),
      });
    }
  }
  return planes;
}
