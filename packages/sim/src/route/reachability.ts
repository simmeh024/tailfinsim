/**
 * Can this aircraft actually fly this route? (M2-01, design doc App. B.4)
 *
 * Seven checks, in order, and the answer names **which one failed**. App. B.4 is
 * explicit about that: *"The UI shows exactly which one failed, never a generic
 * 'unavailable'."* A player told a route is unavailable learns nothing and can do
 * nothing; a player told the runway at the far end is 400 m short knows whether
 * to change aircraft, change airport, or give up.
 *
 * ## Pure, and supplied with its inputs
 *
 * Four of the seven checks depend on data that does not exist yet — the aircraft
 * catalogue is M4, slots are M7-05, traffic rights are §8.1's regulatory layer,
 * and temperature is M2-09's weather. Rather than stub those systems, this takes
 * what it needs as arguments. The checks are correct and ordered now; the
 * milestones that own the data fill it in later without touching this file.
 *
 * That also keeps CONTRIBUTING invariant 2: nothing here reads a clock, a
 * database or a config file, so the same inputs give the same answer for ever.
 */

/** ICAO aerodrome reference code letter — the wingspan half of the code (App. B.4 check 3). */
export type WingspanCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

const WINGSPAN_ORDER: readonly WingspanCode[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Metres of wingspan each code admits, for the message rather than the comparison. */
const WINGSPAN_LIMIT_M: Record<WingspanCode, number> = {
  A: 15,
  B: 24,
  C: 36,
  D: 52,
  E: 65,
  F: 80,
};

/**
 * Why a route cannot be flown. One per check in App. B.4, in the order they run.
 *
 * A closed set rather than a message, because the interface has to be able to
 * offer the *fix* — "buy a longer-range variant" for `range`, "pick another
 * airport" for `runway` — and that cannot be driven off prose.
 */
export type ReachabilityReason =
  'range' | 'runway' | 'wingspan' | 'overwater' | 'curfew' | 'rights' | 'slot';

export type Reachability = { ok: true } | { ok: false; reason: ReachabilityReason; detail: string };

/**
 * The margins the checks apply.
 *
 * Balance numbers, so they are configuration rather than literals in the
 * arithmetic (CONTRIBUTING invariant 3). Both come from App. B.4 or from
 * standard performance practice, and both are the kind of number that will be
 * retuned.
 */
export interface ReachabilityConfig {
  /**
   * How much further than the great circle a flight actually covers — departure
   * and arrival routings, airways, avoidance. App. B.4 fixes this at 1.06.
   */
  routeFactor: number;
  /**
   * Extra takeoff distance per 1,000 ft of field elevation, as a fraction.
   *
   * Thinner air means less thrust and more groundspeed for the same indicated
   * airspeed. 7% per 1,000 ft is the standard rule of thumb and stands in for a
   * real performance model; App. B.4 also names temperature, which needs M2-09's
   * weather before it can be anything but a guess.
   */
  takeoffPerThousandFeet: number;
}

export const DEFAULT_REACHABILITY: ReachabilityConfig = {
  routeFactor: 1.06,
  takeoffPerThousandFeet: 0.07,
};

/**
 * What the aircraft can do **at the planned payload**, not on the brochure.
 *
 * App. B.4: *"Payload/range is a live trade, not a fixed number."* Filling every
 * seat on a marginal sector can put the aircraft over max takeoff weight, so the
 * caller resolves the trade first (M2-02) and passes the result here.
 */
export interface AircraftCapability {
  /** Still-air range in nautical miles at the planned payload. */
  rangeNm: number;
  /** Takeoff distance required at sea level, ISA, at the planned payload, in metres. */
  takeoffRunM: number;
  wingspanCode: WingspanCode;
  /**
   * Certified single-engine diversion time in minutes, or null for a type with
   * no ETOPS approval. A type with no approval can still fly routes that never
   * exceed the default 60-minute diversion rule.
   */
  etopsMinutes: number | null;
}

/** An operating window in local minutes from midnight, or null for a 24-hour airport. */
export interface OperatingHours {
  /** Inclusive. 360 is 06:00. */
  opensMinute: number;
  /** Exclusive. 1380 is 23:00. A window that wraps midnight has `closes < opens`. */
  closesMinute: number;
}

export interface AirportCapability {
  /** For the message. A failure that does not name the airport is half a failure. */
  icao: string;
  longestRunwayM: number;
  elevationFt: number;
  maxWingspanCode: WingspanCode;
  /** Null means no curfew. */
  hours: OperatingHours | null;
  /** ISO 3166-1 alpha-2, for the traffic-rights check. */
  countryCode: string;
}

export interface RoutePlan {
  distanceNm: number;
  /** Local minutes from midnight at the origin. */
  departureMinute: number;
  /** Local minutes from midnight at the destination. */
  arrivalMinute: number;
  /**
   * The longest single-engine diversion time the routing demands, in minutes.
   *
   * Zero for a sector that is never far from an adequate airport. Computing it
   * from the great-circle path and the diversion airports along it is M2-07's
   * job; until then the caller supplies it.
   */
  diversionMinutes: number;
  /**
   * Whether a traffic right exists for the country pair (§8.1).
   *
   * A boolean because the regulatory layer does not exist — §24 lists it as
   * named-but-undefined. The check is in the right place and in the right order;
   * what feeds it is the part still to be built.
   */
  hasTrafficRights: boolean;
  /** Whether a slot is held in the chosen band (M7-05). Same reasoning as above. */
  hasSlot: boolean;
}

/** Whether `minute` falls inside a window that may wrap past midnight. */
function isOpen(hours: OperatingHours, minute: number): boolean {
  const { opensMinute, closesMinute } = hours;
  // A window like 06:00–23:00 is a simple range; one like 22:00–05:00 wraps, and
  // treating it as a range would call the airport shut all night and open all
  // day — exactly backwards.
  return opensMinute <= closesMinute
    ? minute >= opensMinute && minute < closesMinute
    : minute >= opensMinute || minute < closesMinute;
}

function formatMinute(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function round(value: number): string {
  return Math.round(value).toLocaleString('en-GB');
}

/**
 * The seven checks, in App. B.4's order, stopping at the first failure.
 *
 * The order is not arbitrary and is worth keeping: it runs from the physical and
 * permanent to the administrative and temporary. Being 300 nm short of the
 * destination is a different kind of problem from not holding a slot in the
 * 08:00 band, and a player should hear about the first before the second — there
 * is no point offering to buy a slot for a route the aircraft cannot fly.
 */
export function checkReachability(
  aircraft: AircraftCapability,
  origin: AirportCapability,
  destination: AirportCapability,
  plan: RoutePlan,
  config: ReachabilityConfig = DEFAULT_REACHABILITY,
): Reachability {
  // 1. Range — great circle plus the routing factor, against range at payload.
  const required = plan.distanceNm * config.routeFactor;
  if (required > aircraft.rangeNm) {
    return {
      ok: false,
      reason: 'range',
      detail:
        `${origin.icao}–${destination.icao} needs ${round(required)} nm of range ` +
        `(${round(plan.distanceNm)} nm great circle × ${String(config.routeFactor)}), ` +
        `and this aircraft has ${round(aircraft.rangeNm)} nm at the planned payload.`,
    };
  }

  // 2. Runway — at the departure field, where the aircraft is heaviest, and
  //    corrected for elevation. Landing distance is a separate and usually
  //    smaller problem; App. B.4 names takeoff.
  const elevationPenalty = 1 + (origin.elevationFt / 1000) * config.takeoffPerThousandFeet;
  const runwayNeeded = aircraft.takeoffRunM * elevationPenalty;
  if (runwayNeeded > origin.longestRunwayM) {
    return {
      ok: false,
      reason: 'runway',
      detail:
        `${origin.icao} has ${round(origin.longestRunwayM)} m of runway and this ` +
        `aircraft needs ${round(runwayNeeded)} m at the planned payload` +
        (origin.elevationFt > 0
          ? `, including ${round((elevationPenalty - 1) * 100)}% for ${round(origin.elevationFt)} ft of elevation.`
          : '.'),
    };
  }

  // 3. Wingspan — both ends. An aircraft that cannot be parked at the far end
  //    cannot fly there, however much runway it has.
  const aircraftCode = WINGSPAN_ORDER.indexOf(aircraft.wingspanCode);
  for (const airport of [origin, destination]) {
    if (aircraftCode > WINGSPAN_ORDER.indexOf(airport.maxWingspanCode)) {
      return {
        ok: false,
        reason: 'wingspan',
        detail:
          `${airport.icao} takes code ${airport.maxWingspanCode} aircraft ` +
          `(up to ${String(WINGSPAN_LIMIT_M[airport.maxWingspanCode])} m of wingspan) ` +
          `and this one is code ${aircraft.wingspanCode}.`,
      };
    }
  }

  // 4. Overwater — the routing's diversion requirement against the type's rating.
  if (plan.diversionMinutes > 0) {
    const rating = aircraft.etopsMinutes ?? 0;
    if (rating < plan.diversionMinutes) {
      return {
        ok: false,
        reason: 'overwater',
        detail:
          `This routing is up to ${String(plan.diversionMinutes)} minutes from an adequate airport, ` +
          (aircraft.etopsMinutes === null
            ? 'and this type holds no ETOPS approval.'
            : `and this type is approved to ${String(aircraft.etopsMinutes)} minutes.`),
      };
    }
  }

  // 5. Curfew — both ends, each against its own local clock.
  const windows: [AirportCapability, number, string][] = [
    [origin, plan.departureMinute, 'departs'],
    [destination, plan.arrivalMinute, 'arrives'],
  ];
  for (const [airport, minute, verb] of windows) {
    if (airport.hours !== null && !isOpen(airport.hours, minute)) {
      return {
        ok: false,
        reason: 'curfew',
        detail:
          `The flight ${verb} ${airport.icao} at ${formatMinute(minute)} local, ` +
          `and it is open ${formatMinute(airport.hours.opensMinute)}–${formatMinute(airport.hours.closesMinute)}.`,
      };
    }
  }

  // 6. Rights — the country pair. Domestic pairs need none.
  if (origin.countryCode !== destination.countryCode && !plan.hasTrafficRights) {
    return {
      ok: false,
      reason: 'rights',
      detail: `No traffic right is held for ${origin.countryCode}–${destination.countryCode}.`,
    };
  }

  // 7. Slot — last, because it is the cheapest to fix and the most temporary.
  if (!plan.hasSlot) {
    return {
      ok: false,
      reason: 'slot',
      detail: `No slot is held at ${origin.icao} in the ${formatMinute(plan.departureMinute)} band.`,
    };
  }

  return { ok: true };
}

/**
 * Every reason, in the order the checks run.
 *
 * Exported so a test can prove each one is reachable, and so an interface can
 * order a list of problems the same way the rules do.
 */
export const REACHABILITY_REASONS: readonly ReachabilityReason[] = [
  'range',
  'runway',
  'wingspan',
  'overwater',
  'curfew',
  'rights',
  'slot',
];
