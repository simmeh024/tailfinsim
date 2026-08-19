/**
 * How long the aircraft is on stand, and **why** (M2-04, §3.3, §9.3, §10.4, App. B.6).
 *
 * §3.3: *"Turnaround time is a real cost driver and is affected by cabin config,
 * ground staff level, and airport congestion."* It is also the join between four
 * systems that otherwise never meet — the cabin builder, the ground vendor
 * contract, the gate holding and the research ladder — which is what makes a
 * single opaque number the wrong answer.
 *
 * ## The breakdown is the feature
 *
 * The issue asks for turn time *"shown broken down by contributor, not as a
 * single opaque number"*, and §9.4 explains why in general terms: **"any weak
 * link in that chain shows up as a specific, diagnosable number — not a vague
 * penalty."** A player told their turn is 54 minutes learns nothing. A player
 * told it is 40 base, +5 for the extra seats they fitted, +11 for a remote
 * stand, and −2 from research can fix the one they care about.
 *
 * So {@link computeTurnaround} returns every contribution, signed, in minutes,
 * and they sum **exactly** to the total. A breakdown that does not reconcile is
 * worse than none, because it invites the player to trust it.
 *
 * ## What this is not
 *
 * `turnaroundMinutes` here is **ground servicing only** — doors closed on the
 * arriving flight to ready-for-boarding on the next. It is not the industry's
 * "turn time", which also contains boarding; `FlightProfile` models that as a
 * separate phase, and its comment already records the distinction: §14's
 * research target of a *"sub-25-minute narrowbody turn"* is against the combined
 * figure, not against this one.
 *
 * ## Pure, and supplied with its inputs
 *
 * Same discipline as M2-01, M2-02 and M2-03. The aircraft catalogue is M4-01,
 * ground vendors are M5/§9.3, gate holdings are M7 and the research ladder is
 * M9 — none of them exist, so each arrives as a field rather than as a stub.
 */

/**
 * Where the aircraft parks.
 *
 * Only the two that are passenger turnarounds. App. B.6 also lists overnight
 * parking, cargo stands and maintenance stands, and none of them is a turn:
 * overnight and maintenance have nobody aboard, and a cargo turn is a different
 * process that arrives with §12's freighters.
 */
export type StandType = 'contact' | 'remote';

/** One line of the answer. Every contribution is signed minutes. */
export interface TurnaroundContribution {
  source:
    'base' | 'seats' | 'stand' | 'cabin' | 'service' | 'vendor' | 'congestion' | 'boosts' | 'floor';
  /** Signed. Negative is time saved. */
  minutes: number;
  /** One phrase a player can act on. */
  detail: string;
}

export interface TurnaroundResult {
  /** Ground minutes, exact. Equals the base plus every contribution. */
  minutes: number;
  /**
   * What a schedule should book, rounded **up**.
   *
   * `schedule_leg.turnaround_minutes` is an integer column (M2-03), and rounding
   * down would book a turn shorter than the model says is achievable — which
   * would then show up as a delay caused by the scheduler rather than by the
   * operation.
   */
  scheduleMinutes: number;
  /** Every contributor, in the order applied. Sums with the base to `minutes`. */
  contributions: TurnaroundContribution[];
  /** The reduction actually applied after diminishing returns and the cap, 0–1. */
  boostFraction: number;
  /** Whether §10.4's ceiling clipped the boosts. A further boost buys nothing. */
  boostCapReached: boolean;
}

/** The aircraft, as M4-01's catalogue will eventually describe it. */
export interface TurnaroundAircraft {
  /**
   * The type's baseline ground time at its reference cabin, in minutes.
   *
   * §7.1 lists a *"turnaround baseline"* per type. {@link DEFAULT_TURNAROUND_MINUTES}
   * is the unimproved narrowbody figure and is the right stand-in until the
   * catalogue exists.
   */
  baseTurnaroundMinutes: number;
  /** Seats actually fitted, from the cabin builder (§6.1). */
  seats: number;
  /** The seat count `baseTurnaroundMinutes` is quoted at. */
  referenceSeats: number;
}

/** The ground handler at this station (§9.3). */
export interface GroundVendor {
  /**
   * Multiplier on ground work. 1 is the contracted norm; 1.2 is a handler taking
   * a fifth longer than it should.
   *
   * §9.3 is explicit about the trade this represents: *"cheap ramp handlers =
   * slower turns and more mishandled bags."* The price is elsewhere; this is the
   * time.
   */
  speedFactor: number;
}

/**
 * One efficiency boost from §10.4 — a research node, an academy doctrine, a
 * Head of Ground Ops, a Training Captain.
 *
 * Each is a fraction of time removed, before stacking.
 */
export interface TurnaroundBoost {
  id: string;
  /** 0.05 is five percent off. */
  fraction: number;
}

export interface TurnaroundPlan {
  stand: StandType;
  vendor: GroundVendor;
  /**
   * Minutes from cabin options whose cost is **not** a function of seat count.
   *
   * A trap worth naming: App. C.3 prices high-density exits at *"+5 min
   * turnaround"*, and that cost is already produced here by the extra seats
   * those exits allow — see {@link DEFAULT_TURNAROUND}. Passing it again as a
   * cabin option charges the player twice for one decision.
   */
  cabinOptionMinutes: number;
  /**
   * Minutes from the service package (App. D.6's `turnaround_delta`).
   *
   * A hot meal service on a narrowbody takes longer to load than a bag of
   * pretzels, and D.6 makes that a property of each service item.
   */
  serviceMinutes: number;
  /**
   * Multiplier for how busy the airport is (§3.3). 1 is a clear stand.
   *
   * Separate from the vendor because they fail independently: a good handler at
   * a congested airport is still waiting for a tug.
   */
  congestionFactor: number;
  boosts: readonly TurnaroundBoost[];
}

/**
 * Balance numbers (CONTRIBUTING invariant 3), so §22.3's admin can retune them
 * against a snapshot rather than waiting for a deploy.
 */
export interface TurnaroundConfig {
  /**
   * Minutes added per seat above the type's reference count.
   *
   * **Calibrated to App. C.3.** That table prices high-density exits at
   * *"+5 min turnaround"*, and C.4's A321neo high-density build carries 244
   * seats against the standard 200 — so 5 minutes buys 44 seats, and one seat
   * costs 0.1136 of a minute. Rounding to 0.11 reproduces the documented figure
   * to within seven seconds.
   *
   * Modelling it per seat rather than as a flat option delta is deliberate: it
   * makes every cabin decision cost turnaround in proportion, including the ones
   * App. C.3 does not enumerate.
   */
  minutesPerSeat: number;
  /**
   * App. B.6 puts a remote stand at **+10–12 minutes** against a contact gate,
   * for bussing passengers to and from the aircraft. The midpoint.
   */
  remoteStandMinutes: number;
  /**
   * §10.4's ceiling on turnaround reduction from every source stacked: **−20%**.
   *
   * The section is unusually firm about why: *"a year-one player must never face
   * an unbeatable wall of stacked veteran bonuses… moats kill persistent
   * multiplayer games."*
   */
  maxBoostFraction: number;
  /**
   * The floor no amount of money or research goes below.
   *
   * Fuel goes in, bags come off and the cabin gets cleaned, and none of that is
   * instant. Without a floor, enough stacked multipliers produce a turn of
   * seconds, which is not a balance problem so much as an obviously wrong number
   * appearing in the interface.
   */
  minimumMinutes: number;
}

export const DEFAULT_TURNAROUND: TurnaroundConfig = {
  minutesPerSeat: 0.11,
  remoteStandMinutes: 11,
  maxBoostFraction: 0.2,
  minimumMinutes: 10,
};

/**
 * Version tag, mirroring `FLIGHT_PROFILE_VERSION` and `world.economy_config_version`.
 *
 * A world records which numbers it ran under, so a 54-minute turn from October
 * can still be explained after they change (invariant 4).
 */
export const TURNAROUND_CONFIG_VERSION = 'v1' as const;

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${what} must be a finite number, got ${String(value)}`);
  }
}

function assertPositive(value: number, what: string): void {
  assertFinite(value, what);
  if (value <= 0) throw new Error(`${what} must be positive, got ${String(value)}`);
}

function assertNonNegative(value: number, what: string): void {
  assertFinite(value, what);
  if (value < 0) throw new Error(`${what} must be zero or more, got ${String(value)}`);
}

function round(value: number, places = 1): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/**
 * How much time the stacked boosts actually remove.
 *
 * Combined **multiplicatively**, which is diminishing returns by construction:
 * two 10% boosts give 19%, not 20%. §10.4 asks for exactly that —
 * *"diminishing returns before the cap"* — and then for a hard ceiling, which is
 * the clamp.
 *
 * An asymptotic curve that approaches the cap without reaching it was the
 * obvious alternative and is worse: it charges the *first* boost most heavily,
 * so a player's first research node in the branch feels broken. Multiplicative
 * stacking keeps a lone boost worth its face value and only bites once several
 * are held, which is the behaviour the section describes.
 */
export function stackBoosts(
  boosts: readonly TurnaroundBoost[],
  config: TurnaroundConfig = DEFAULT_TURNAROUND,
): { fraction: number; capped: boolean } {
  assertNonNegative(config.maxBoostFraction, 'Maximum boost fraction');

  let remaining = 1;
  for (const boost of boosts) {
    assertFinite(boost.fraction, `Boost ${boost.id}`);
    if (boost.fraction < 0 || boost.fraction >= 1) {
      throw new Error(
        `Boost ${boost.id} must remove between 0% and 100% of the time, got ${String(boost.fraction)}`,
      );
    }
    remaining *= 1 - boost.fraction;
  }

  const combined = 1 - remaining;
  const capped = combined > config.maxBoostFraction;
  return { fraction: capped ? config.maxBoostFraction : combined, capped };
}

/**
 * Ground minutes for one turn, and the reason for every one of them.
 *
 * The order is additive first, then multiplicative, then boosts, then the floor.
 * That is not arbitrary: a vendor 20% slower than contracted should be 20%
 * slower at *everything* it is responsible for, including the extra bussing time
 * a remote stand costs — so the stand delta has to be in the total before the
 * vendor multiplier is applied to it.
 */
export function computeTurnaround(
  aircraft: TurnaroundAircraft,
  plan: TurnaroundPlan,
  config: TurnaroundConfig = DEFAULT_TURNAROUND,
): TurnaroundResult {
  assertPositive(aircraft.baseTurnaroundMinutes, 'Base turnaround');
  assertNonNegative(aircraft.seats, 'Seat count');
  assertPositive(aircraft.referenceSeats, 'Reference seat count');
  assertPositive(plan.vendor.speedFactor, 'Vendor speed factor');
  assertPositive(plan.congestionFactor, 'Congestion factor');
  assertFinite(plan.cabinOptionMinutes, 'Cabin option minutes');
  assertFinite(plan.serviceMinutes, 'Service minutes');
  assertNonNegative(config.minimumMinutes, 'Minimum turnaround');

  const contributions: TurnaroundContribution[] = [];
  let minutes = aircraft.baseTurnaroundMinutes;

  contributions.push({
    source: 'base',
    minutes: aircraft.baseTurnaroundMinutes,
    detail: `${round(aircraft.baseTurnaroundMinutes)} min baseline for the type at ${String(aircraft.referenceSeats)} seats.`,
  });

  // 1. Seats. More people to disembark, more rows to clean, more bags.
  const extraSeats = aircraft.seats - aircraft.referenceSeats;
  if (extraSeats !== 0) {
    const delta = extraSeats * config.minutesPerSeat;
    minutes += delta;
    contributions.push({
      source: 'seats',
      minutes: delta,
      detail:
        `${String(Math.abs(extraSeats))} ${extraSeats > 0 ? 'more' : 'fewer'} seats than the ` +
        `baseline cabin, at ${round(config.minutesPerSeat, 2)} min each.`,
    });
  }

  // 2. Stand. App. B.6: bussing costs time a jet bridge does not.
  if (plan.stand === 'remote') {
    minutes += config.remoteStandMinutes;
    contributions.push({
      source: 'stand',
      minutes: config.remoteStandMinutes,
      detail: `Remote stand — passengers bussed rather than walking off a jet bridge.`,
    });
  }

  // 3. Cabin options whose cost is not seat-driven.
  if (plan.cabinOptionMinutes !== 0) {
    minutes += plan.cabinOptionMinutes;
    contributions.push({
      source: 'cabin',
      minutes: plan.cabinOptionMinutes,
      detail: 'Cabin fit beyond the seat count.',
    });
  }

  // 4. Service package (App. D.6).
  if (plan.serviceMinutes !== 0) {
    minutes += plan.serviceMinutes;
    contributions.push({
      source: 'service',
      minutes: plan.serviceMinutes,
      detail: 'Catering and cabin service loading.',
    });
  }

  // 5. The handler, applied to everything above.
  if (plan.vendor.speedFactor !== 1) {
    const delta = minutes * (plan.vendor.speedFactor - 1);
    minutes += delta;
    contributions.push({
      source: 'vendor',
      minutes: delta,
      detail:
        plan.vendor.speedFactor > 1
          ? `Ground handler is ${round((plan.vendor.speedFactor - 1) * 100, 0)}% slower than contracted.`
          : `Ground handler is ${round((1 - plan.vendor.speedFactor) * 100, 0)}% faster than contracted.`,
    });
  }

  // 6. The airport.
  if (plan.congestionFactor !== 1) {
    const delta = minutes * (plan.congestionFactor - 1);
    minutes += delta;
    contributions.push({
      source: 'congestion',
      minutes: delta,
      detail:
        plan.congestionFactor > 1
          ? `Airport congestion adds ${round((plan.congestionFactor - 1) * 100, 0)}%.`
          : `Quiet airport saves ${round((1 - plan.congestionFactor) * 100, 0)}%.`,
    });
  }

  // 7. Research, academy and crew (§10.4), capped.
  const { fraction: boostFraction, capped: boostCapReached } = stackBoosts(plan.boosts, config);
  if (boostFraction > 0) {
    const delta = -minutes * boostFraction;
    minutes += delta;
    contributions.push({
      source: 'boosts',
      minutes: delta,
      detail:
        `Efficiency boosts remove ${round(boostFraction * 100, 1)}%` +
        (boostCapReached
          ? ` — at the ${round(config.maxBoostFraction * 100, 0)}% ceiling, so a further boost buys nothing.`
          : '.'),
    });
  }

  // 8. The floor. Recorded as a contribution rather than clamped silently, so
  //    the breakdown still reconciles and the player can see it bit.
  if (minutes < config.minimumMinutes) {
    const delta = config.minimumMinutes - minutes;
    minutes = config.minimumMinutes;
    contributions.push({
      source: 'floor',
      minutes: delta,
      detail: `No turn goes below ${round(config.minimumMinutes, 0)} min — fuel, bags and cleaning take time.`,
    });
  }

  return {
    minutes,
    scheduleMinutes: Math.ceil(minutes),
    contributions,
    boostFraction,
    boostCapReached,
  };
}

/** Every contribution source, so a test can prove each one is reachable. */
export const TURNAROUND_SOURCES: readonly TurnaroundContribution['source'][] = [
  'base',
  'seats',
  'stand',
  'cabin',
  'service',
  'vendor',
  'congestion',
  'boosts',
  'floor',
];

/**
 * A plan with nothing going on: contact gate, contracted handler, quiet airport,
 * no options, no service load, no boosts.
 *
 * The reference point a readout compares against, so *"your turn is 14 minutes
 * longer than it needs to be"* is answerable.
 */
export const NOMINAL_PLAN: TurnaroundPlan = {
  stand: 'contact',
  vendor: { speedFactor: 1 },
  cabinOptionMinutes: 0,
  serviceMinutes: 0,
  congestionFactor: 1,
  boosts: [],
};
