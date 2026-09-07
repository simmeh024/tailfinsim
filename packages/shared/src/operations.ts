import { z } from 'zod';

import { CrewRank } from './economy-config';
import { MinorUnits, Timestamp } from './primitives';

/**
 * §14.3's operational dashboards (M8-12).
 *
 * §14.3 lists seven dashboards. M8-10 built the two financial ones; this is the
 * five that describe how the airline *runs* — traffic, fleet, crew, ground and
 * punctuality — assembled in one response because they share one window and one
 * read of `flight_result`, and because five endpoints would let five panels
 * disagree about which flights were in the period.
 *
 * ## What is here is what the game records
 *
 * §14.3's lists are longer than this, and the difference is deliberate rather
 * than partial. A booking curve needs bookings modelled over time and they are
 * not; a vendor scorecard needs turnaround measured against contract and nothing
 * measures it; satisfaction by class needs a per-cabin survey that does not
 * exist. Each absence is named in `docs/statistics.md` with what it would need.
 *
 * Inventing any of them would be the *"number players will not trust"* §14.1 is
 * about — and worse here than elsewhere, because an operational dashboard is
 * read as a description of what happened.
 */

/* ---- Traffic and commercial ------------------------------------------------- */

/**
 * §14.3's traffic figures.
 *
 * `spilledPassengers` is the count, not the rate, because M8-12's second
 * acceptance criterion asks for spill as *"passengers turned away"* — an
 * actionable number. A rate tells a player they are losing 8% of something; a
 * count tells them they turned away 1,240 people, which is a decision.
 */
export const TrafficSummary = z
  .object({
    passengers: z.number().int().nonnegative(),
    cargoTonnes: z.number().nonnegative(),
    askKm: z.number().nonnegative(),
    rpkKm: z.number().nonnegative(),
    rtkKm: z.number().nonnegative(),
    loadFactor: z.number().min(0).max(1).nullable(),
    /** Passengers who wanted a seat and did not get one. The actionable number. */
    spilledPassengers: z.number().int().nonnegative(),
    /** The same thing as a share of the demand that came, for context. */
    spillRate: z.number().min(0).max(1).nullable(),
    /** Revenue per RPK, minor units — yield, for the commercial half. */
    yieldMinor: z.number().nullable(),
  })
  .strict();
export type TrafficSummary = z.infer<typeof TrafficSummary>;

/* ---- Punctuality ------------------------------------------------------------ */

/**
 * M2-08's delay causes, as the wire sees them.
 *
 * The taxonomy lived only in a database enum until M8-12; attributing delay
 * minutes by cause (the first acceptance criterion) needs it named on the wire,
 * so a client can label a bar without a lookup table of its own.
 */
export const DelayCause = z.enum([
  'weather_origin',
  'weather_destination',
  'atc_flow',
  'technical',
  'crew_timeout',
  'ground_vendor',
  'airport_closure',
  /**
   * Delay with no recorded cause.
   *
   * **Not** one of M2-08's causes, and present precisely so the attributed
   * total is honest: a dashboard that dropped unattributed minutes would show a
   * player less delay than they actually suffered, which is the one thing an
   * attribution must never do.
   */
  'unattributed',
]);
export type DelayCause = z.infer<typeof DelayCause>;

export const DelayByCause = z
  .object({
    cause: DelayCause,
    /** Arrival delay minutes attributed to this cause across the window. */
    minutes: z.number().int().nonnegative(),
    /** Flights carrying that delay, so a big number can be read as few or many. */
    flights: z.number().int().nonnegative(),
  })
  .strict();
export type DelayByCause = z.infer<typeof DelayByCause>;

/** §14.3's OTP pair, plus what never flew at all. */
export const PunctualitySummary = z
  .object({
    /** Arrivals exactly on time or early — D0. Null when nothing flew. */
    onTimeD0: z.number().min(0).max(1).nullable(),
    /** Arrivals within fifteen minutes — D15, the industry's headline. */
    onTimeD15: z.number().min(0).max(1).nullable(),
    /** Share of scheduled flights that were cancelled rather than flown. */
    cancellationRate: z.number().min(0).max(1).nullable(),
    cancelledFlights: z.number().int().nonnegative(),
    /** Total arrival delay across the window, before attribution. */
    totalDelayMinutes: z.number().int().nonnegative(),
    /** Every cause with minutes against it, worst first. */
    byCause: z.array(DelayByCause),
  })
  .strict();
export type PunctualitySummary = z.infer<typeof PunctualitySummary>;

/* ---- Fleet ------------------------------------------------------------------ */

/** One age bucket of the fleet, for §14.3's age profile. */
export const FleetAgeBand = z
  .object({
    label: z.string().min(1),
    airframes: z.number().int().nonnegative(),
  })
  .strict();
export type FleetAgeBand = z.infer<typeof FleetAgeBand>;

export const FleetSummary = z
  .object({
    airframes: z.number().int().nonnegative(),
    /** Grounded or in a check — §14.3's AOG count. */
    aogCount: z.number().int().nonnegative(),
    inCheck: z.number().int().nonnegative(),
    /** Block hours per airframe per game day over the window. Null with no fleet. */
    blockHoursPerDay: z.number().nonnegative().nullable(),
    /** Flight cost over block hours flown, minor units. Null when nothing flew. */
    costPerBlockHourMinor: z.number().nullable(),
    ageProfile: z.array(FleetAgeBand),
  })
  .strict();
export type FleetSummary = z.infer<typeof FleetSummary>;

/* ---- Crew ------------------------------------------------------------------- */

export const CrewRankHeadcount = z
  .object({
    rank: CrewRank,
    headcount: z.number().int().nonnegative(),
    onDuty: z.number().int().nonnegative(),
    reserve: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    sick: z.number().int().nonnegative(),
  })
  .strict();
export type CrewRankHeadcount = z.infer<typeof CrewRankHeadcount>;

/**
 * One base's morale as the operations dashboard shows it: a number and a
 * headcount.
 *
 * Deliberately **not** `crew.ts`'s `CrewBaseMorale`, which is M5-03's itemised
 * score with its contributing factors — that belongs on the Crew page, where a
 * player is deciding what to change. Here five bases are being compared at a
 * glance, and five factor breakdowns would bury the comparison.
 */
export const BaseMoraleRow = z
  .object({
    airportIcao: z.string().min(1),
    /**
     * 0–1, or **null meaning never reviewed** — not zero, which would say the
     * crew hate a base on its opening day. The same reading `crew_base.morale`
     * has carried since M5-03.
     */
    morale: z.number().min(0).max(1).nullable(),
    headcount: z.number().int().nonnegative(),
  })
  .strict();
export type BaseMoraleRow = z.infer<typeof BaseMoraleRow>;

export const CrewSummary = z
  .object({
    headcount: z.number().int().nonnegative(),
    byRank: z.array(CrewRankHeadcount),
    moraleByBase: z.array(BaseMoraleRow),
    /** Reserves over total heads — §14.3's reserve coverage. Null with no crew. */
    reserveCoverage: z.number().min(0).max(1).nullable(),
    /** Heads in type conversion right now — the training pipeline's size. */
    converting: z.number().int().nonnegative(),
  })
  .strict();
export type CrewSummary = z.infer<typeof CrewSummary>;

/* ---- Ground ----------------------------------------------------------------- */

/** A handling contract and when it lapses — §14.3's contract expiries. */
export const ContractExpiry = z
  .object({
    airportIcao: z.string().min(1),
    serviceLine: z.string().min(1),
    grade: z.string().min(1),
    /** Game time the term ends. Null for a legacy contract signed before terms. */
    termEnd: Timestamp.nullable(),
    /** Game days until it lapses. Null when it never does. */
    daysRemaining: z.number().int().nullable(),
  })
  .strict();
export type ContractExpiry = z.infer<typeof ContractExpiry>;

export const GroundSummary = z
  .object({
    activeContracts: z.number().int().nonnegative(),
    selfHandledStations: z.number().int().nonnegative(),
    /** Soonest first, capped. The ones a player can still act on. */
    expiries: z.array(ContractExpiry),
  })
  .strict();
export type GroundSummary = z.infer<typeof GroundSummary>;

/* ---- The wire --------------------------------------------------------------- */

/** `GET /api/statistics/operations` — §14.3's five operational dashboards. */
export const OperationsDashboardResponse = z
  .object({
    gameNow: Timestamp,
    windowDays: z.number().int().positive(),
    /** Settled flights everything in the window was folded from. */
    flights: z.number().int().nonnegative(),
    traffic: TrafficSummary,
    punctuality: PunctualitySummary,
    fleet: FleetSummary,
    crew: CrewSummary,
    ground: GroundSummary,
    /** What the airline is owed for its service, from M8-04's assembled score. */
    productScore: z.number().min(0).max(1).nullable(),
    reputation: z.number().min(0).max(1),
    /** Money in the window, so a cost-per-block-hour has something to sit beside. */
    revenueMinor: MinorUnits.nonnegative(),
    costMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type OperationsDashboardResponse = z.infer<typeof OperationsDashboardResponse>;
