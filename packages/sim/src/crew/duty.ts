import type { CrewDutyBalance } from '@tailfin/shared';

import { DEFAULT_CREW } from './complement';

/**
 * Duty, rest and fatigue (§9.2, M5-02) — the flagship crew mechanic.
 *
 * ## Why this is a rule engine and not a penalty
 *
 * §9.2 is explicit that *"exceeding limits is not allowed"*. So nothing here
 * returns a multiplier, a cost or a probability of trouble: it returns whether a
 * flight may legally happen. The money and the disruption are downstream of the
 * verdict, and both are somebody else's module. A duty limit expressed as a
 * penalty would be a duty limit a rich player can buy past, which is precisely
 * the mechanic §9.2 is trying to build.
 *
 * ## Three verdicts, because the mechanic needs three
 *
 * `legal`, `tight`, `illegal`. The middle one is the whole point: §9.2 says
 * *"running close to them causes crew timeout"*, and M5-02's fourth acceptance
 * criterion asks for a **warning** when a schedule is saved and a **hard rule**
 * at departure. A two-state model can express neither — a schedule that is legal
 * today and one weather delay from cancelling would save silently, and the
 * player would meet the mechanic for the first time as a cancellation with no
 * explanation attached.
 *
 * So: `illegal` is refused wherever it is found. `tight` is saved, flown, and
 * shown — and it is the state that turns into a timeout when the day slips.
 *
 * ## Counts, not people — still
 *
 * M5-01's invariant survives intact. Nothing here identifies a crew member. The
 * thing that has a duty period is **a crew set operating an airframe**, which is
 * what the regulation constrains anyway: ORO.FTL limits a duty, and a duty is a
 * span of time with a report and an off-duty, not a name. Individual hours and
 * proficiency remain M9's, and nothing in this file should grow a person.
 *
 * ## What decides a duty period boundary
 *
 * Legs separated by less than a full rest are one duty period; a gap long enough
 * for the required rest ends it and starts another. That is derived rather than
 * declared, because a rotation is a list of legs and the player never says "this
 * is where the day ends" — they say when the aeroplane flies, and the duty
 * periods fall out. It is also what makes a tightened turnaround able to *merge*
 * two days into one illegal one, which is a failure mode worth being able to
 * produce.
 */

/** One leg, as the duty rules see it: two instants and two airports. */
export interface DutyLeg {
  departure: Date;
  arrival: Date;
  originIcao: string;
  destinationIcao: string;
  /**
   * The crew travel on this leg as passengers rather than operating it.
   *
   * Deadheading is duty but not flight duty (ORO.FTL.205(e)) and does not count
   * as a sector, which is the rule that makes it worth paying for: it moves crew
   * without spending the part of their day that flying spends.
   */
  deadhead?: boolean;
}

/** A span of duty: report, work, off duty. Derived, never declared. */
export interface DutyPeriod {
  reportAt: Date;
  offDutyAt: Date;
  /** Operating sectors. Deadheads are excluded — see {@link DutyLeg.deadhead}. */
  sectors: number;
  /** Report to off duty, in minutes. What the cumulative limits count. */
  dutyMinutes: number;
  /** Flight duty period: report to the end of the last sector. What the FDP limits. */
  flightDutyMinutes: number;
  /** Block time actually operated, for the 28-day flight-time limit. */
  blockMinutes: number;
  startsAtIcao: string;
  endsAtIcao: string;
  /** Indices into the rotation's leg list, in order. */
  legIndices: readonly number[];
}

export type DutyVerdict =
  | { status: 'legal'; marginMinutes: number }
  | { status: 'tight'; marginMinutes: number; reason: string }
  | { status: 'illegal'; overMinutes: number; reason: string };

/** True for anything a dispatcher must refuse. The hard rule, in one place. */
export function isIllegal(verdict: DutyVerdict): boolean {
  return verdict.status === 'illegal';
}

/**
 * The maximum flight duty period for a report at this local time, this many
 * sectors.
 *
 * `reportLocalMinuteOfDay` is minutes past local midnight **at the reporting
 * airport** — the WOCL is a body-clock window, so a 03:00 report in Singapore
 * and one in Lisbon cost the same however far apart they are in UTC. Callers
 * with a UTC instant and an airport's `utc_offset_minutes` have everything they
 * need; this deliberately does not take a timezone, because a pure function that
 * resolves zones is a pure function with a database in it.
 *
 * Sectors are the **planned** count for the whole duty period, not the count so
 * far. That is the regulation — the limit is set when the day is rostered and
 * does not move as it is flown — and it is also what makes a delay bite: the
 * ceiling stays where it was while the day gets longer underneath it.
 */
export function maxFlightDutyMinutes(
  reportLocalMinuteOfDay: number,
  sectors: number,
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): number {
  const extra = Math.max(0, sectors - duty.sectorsBeforeReduction);
  const forSectors = duty.maxFlightDutyMinutes - extra * duty.sectorReductionMinutes;
  const wocl = startsInWocl(reportLocalMinuteOfDay, duty) ? duty.woclReductionMinutes : 0;
  return Math.max(duty.minimumFlightDutyMinutes, forSectors - wocl);
}

/** Whether a report at this local minute falls inside the window of circadian low. */
export function startsInWocl(
  reportLocalMinuteOfDay: number,
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): boolean {
  const minute = ((reportLocalMinuteOfDay % 1440) + 1440) % 1440;
  const start = duty.woclStartHour * 60;
  const end = duty.woclEndHour * 60;
  // The window can wrap midnight if a world ever tunes it that way.
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Rest owed after a duty period.
 *
 * ORO.FTL.235: at least as long as the preceding duty, and never less than the
 * floor — twelve hours at a base, ten away. The *"at least as long as the duty"*
 * half is the one players discover late: a thirteen-hour day does not buy back a
 * twelve-hour night, it buys a thirteen-hour one, so the second heavy day of a
 * pairing starts later than the first whether the schedule says so or not.
 */
export function restRequiredMinutes(
  precedingDutyMinutes: number,
  atBase: boolean,
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): number {
  const floor = atBase ? duty.minimumRestAtBaseMinutes : duty.minimumRestAwayMinutes;
  return Math.max(floor, precedingDutyMinutes);
}

export interface RotationDutyOptions {
  /**
   * The crew base the crew report from and return to.
   *
   * Decides which rest floor applies and where hotels are owed. A rotation whose
   * crew have no base cannot be checked against the away/at-base split, so this
   * is required rather than defaulted to the first origin — guessing it would
   * silently apply the shorter floor to a crew sleeping at home.
   */
  baseIcao: string;
  /**
   * Local minutes to add to a UTC instant at each airport, by ICAO.
   *
   * Missing entries are treated as UTC, which is wrong by up to twelve hours and
   * says so: {@link RotationDutyResult.unknownOffsets} lists them, so a caller
   * can tell a real answer from one computed against a gap in the airport data.
   */
  utcOffsetMinutes?: Readonly<Record<string, number>>;
  duty?: CrewDutyBalance;
}

export interface LegDutyVerdict {
  /** Index into the legs passed in. */
  leg: number;
  verdict: DutyVerdict;
  /** Which duty period this leg belongs to. */
  period: number;
  /** Flight duty elapsed when this leg arrives. */
  flightDutyMinutes: number;
  /** The ceiling that applies to it. */
  maxFlightDutyMinutes: number;
}

export interface RotationDutyResult {
  periods: readonly DutyPeriod[];
  legs: readonly LegDutyVerdict[];
  /** The first leg no legal crew can operate, or `null`. */
  firstIllegalLeg: number | null;
  /** The worst verdict across every leg — what a schedule editor shows. */
  worst: DutyVerdict;
  /** Airports whose local time had to be assumed to be UTC. */
  unknownOffsets: readonly string[];
}

/**
 * Whether a rotation can legally be flown, leg by leg.
 *
 * The function M5-02's first acceptance criterion is about: give it four tight
 * sectors and it says `tight`; push leg two ninety minutes late and it says leg
 * four is `illegal`, with the numbers in the sentence. Nothing random, nothing
 * fitted — the delay simply makes the flight duty period longer than the
 * ceiling that was already there.
 */
export function checkRotationDuty(
  legs: readonly DutyLeg[],
  options: RotationDutyOptions,
): RotationDutyResult {
  const duty = options.duty ?? DEFAULT_CREW.duty;
  const offsets = options.utcOffsetMinutes ?? {};
  const unknown = new Set<string>();

  const offsetFor = (icao: string): number => {
    const value = offsets[icao];
    if (value === undefined) {
      unknown.add(icao);
      return 0;
    }
    return value;
  };

  const periods = splitIntoPeriods(legs, options.baseIcao, duty);

  const verdicts: LegDutyVerdict[] = [];
  for (const [periodIndex, period] of periods.entries()) {
    const reportLocal =
      period.reportAt.getUTCHours() * 60 +
      period.reportAt.getUTCMinutes() +
      offsetFor(period.startsAtIcao);
    const ceiling = maxFlightDutyMinutes(reportLocal, period.sectors, duty);

    for (const legIndex of period.legIndices) {
      const leg = legs[legIndex];
      if (!leg) continue;
      const elapsed = minutesBetween(period.reportAt, leg.arrival);
      const margin = ceiling - elapsed;
      verdicts.push({
        leg: legIndex,
        period: periodIndex,
        flightDutyMinutes: elapsed,
        maxFlightDutyMinutes: ceiling,
        verdict: verdictFor(margin, duty, { elapsed, ceiling, sectors: period.sectors }),
      });
    }
  }

  verdicts.sort((a, b) => a.leg - b.leg);
  const firstIllegal = verdicts.find((entry) => isIllegal(entry.verdict));

  return {
    periods,
    legs: verdicts,
    firstIllegalLeg: firstIllegal?.leg ?? null,
    worst: worstOf(verdicts.map((entry) => entry.verdict)),
    unknownOffsets: [...unknown].sort(),
  };
}

/** The verdict for a flight duty period with this much room left in it. */
function verdictFor(
  marginMinutes: number,
  duty: CrewDutyBalance,
  context: { elapsed: number; ceiling: number; sectors: number },
): DutyVerdict {
  const { elapsed, ceiling, sectors } = context;
  if (marginMinutes < 0) {
    return {
      status: 'illegal',
      overMinutes: -marginMinutes,
      reason:
        `The crew would be on flight duty for ${hhmm(elapsed)} across ` +
        `${String(sectors)} sector${sectors === 1 ? '' : 's'}, ` +
        `${hhmm(-marginMinutes)} beyond the ${hhmm(ceiling)} limit.`,
    };
  }
  if (marginMinutes <= duty.timeoutWarningMarginMinutes) {
    return {
      status: 'tight',
      marginMinutes,
      reason:
        `Only ${hhmm(marginMinutes)} of flight duty left at the end of this leg ` +
        `(${hhmm(elapsed)} of ${hhmm(ceiling)}). A delay here times the crew out.`,
    };
  }
  return { status: 'legal', marginMinutes };
}

/** `illegal` beats `tight` beats `legal`; ties keep the tightest margin. */
function worstOf(verdicts: readonly DutyVerdict[]): DutyVerdict {
  let worst: DutyVerdict | null = null;
  for (const verdict of verdicts) {
    if (worst === null || rank(verdict) > rank(worst)) {
      worst = verdict;
      continue;
    }
    if (rank(verdict) !== rank(worst)) continue;
    if (verdict.status === 'illegal' && worst.status === 'illegal') {
      if (verdict.overMinutes > worst.overMinutes) worst = verdict;
    } else if (verdict.status !== 'illegal' && worst.status !== 'illegal') {
      if (verdict.marginMinutes < worst.marginMinutes) worst = verdict;
    }
  }
  return worst ?? { status: 'legal', marginMinutes: 0 };
}

function rank(verdict: DutyVerdict): number {
  return verdict.status === 'illegal' ? 2 : verdict.status === 'tight' ? 1 : 0;
}

/**
 * Group legs into duty periods.
 *
 * A gap counts as a rest — and so ends the period — only if it is long enough
 * for the off-duty tail, the rest the preceding duty earned, and the next
 * report. Anything shorter is a turnaround, and the crew are still on duty
 * through it, which is why tightening a turnaround can fuse two comfortable days
 * into one that breaks.
 */
function splitIntoPeriods(
  legs: readonly DutyLeg[],
  baseIcao: string,
  duty: CrewDutyBalance,
): DutyPeriod[] {
  if (legs.length === 0) return [];

  const periods: DutyPeriod[] = [];
  let current: number[] = [];

  for (const [index, leg] of legs.entries()) {
    if (current.length === 0) {
      current.push(index);
      continue;
    }

    const previousIndex = current[current.length - 1];
    const previous = previousIndex === undefined ? undefined : legs[previousIndex];
    if (!previous) continue;

    const provisional = buildPeriod(current, legs, duty);
    const atBase = previous.destinationIcao === baseIcao;
    const needed =
      duty.offDutyAfterArrivalMinutes +
      restRequiredMinutes(provisional.dutyMinutes, atBase, duty) +
      duty.reportBeforeDepartureMinutes;

    if (minutesBetween(previous.arrival, leg.departure) >= needed) {
      periods.push(provisional);
      current = [index];
    } else {
      current.push(index);
    }
  }

  if (current.length > 0) periods.push(buildPeriod(current, legs, duty));
  return periods;
}

function buildPeriod(
  indices: readonly number[],
  legs: readonly DutyLeg[],
  duty: CrewDutyBalance,
): DutyPeriod {
  const first = legs[indices[0] ?? 0];
  const last = legs[indices[indices.length - 1] ?? 0];
  if (!first || !last) throw new Error('buildPeriod called with no legs');

  const reportAt = new Date(first.departure.getTime() - duty.reportBeforeDepartureMinutes * 60_000);
  const offDutyAt = new Date(last.arrival.getTime() + duty.offDutyAfterArrivalMinutes * 60_000);

  let sectors = 0;
  let blockMinutes = 0;
  for (const index of indices) {
    const leg = legs[index];
    if (!leg || leg.deadhead === true) continue;
    sectors += 1;
    blockMinutes += minutesBetween(leg.departure, leg.arrival);
  }

  return {
    reportAt,
    offDutyAt,
    sectors,
    dutyMinutes: minutesBetween(reportAt, offDutyAt),
    flightDutyMinutes: minutesBetween(reportAt, last.arrival),
    blockMinutes,
    startsAtIcao: first.originIcao,
    endsAtIcao: last.destinationIcao,
    legIndices: [...indices],
  };
}

/**
 * How close the crew are to timing out, as the 0–1 `DisruptionRisk.crewTimeout`
 * M2-08 left for M5 to fill in.
 *
 * Zero while there is more slack than the warning margin, rising linearly to one
 * as the margin closes. It is deliberately **not** the case that 1.0 means
 * "certainly cancelled" — a flight with no slack left is refused by the hard
 * rule at departure and never reaches the disruption roll at all. This number
 * describes the days that are merely at risk, which is the only kind a
 * probability is the right tool for.
 */
export function crewTimeoutRisk(
  marginMinutes: number,
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): number {
  if (duty.timeoutWarningMarginMinutes <= 0) return marginMinutes <= 0 ? 1 : 0;
  if (marginMinutes >= duty.timeoutWarningMarginMinutes) return 0;
  if (marginMinutes <= 0) return 1;
  return 1 - marginMinutes / duty.timeoutWarningMarginMinutes;
}

/* ---------------------------------------------------------------------- *
 * Cumulative limits over rolling windows
 * ---------------------------------------------------------------------- */

/** One completed duty period, as the rolling windows remember it. */
export interface DutyHistoryEntry {
  offDutyAt: Date;
  dutyMinutes: number;
  blockMinutes: number;
}

export interface RollingUsage {
  dutyMinutes7Days: number;
  dutyMinutes14Days: number;
  dutyMinutes28Days: number;
  blockMinutes28Days: number;
}

/**
 * Duty and block time already used, looking back from `at`.
 *
 * Rolling windows, not calendar weeks: the question ORO.FTL.210 asks is *"in any
 * seven consecutive days"*, and a week-boundary reset would let a player stack a
 * heavy Sunday against a heavy Monday and stay inside a limit that exists to
 * stop exactly that.
 */
export function rollingUsage(history: readonly DutyHistoryEntry[], at: Date): RollingUsage {
  const usage: RollingUsage = {
    dutyMinutes7Days: 0,
    dutyMinutes14Days: 0,
    dutyMinutes28Days: 0,
    blockMinutes28Days: 0,
  };
  for (const entry of history) {
    const daysAgo = (at.getTime() - entry.offDutyAt.getTime()) / 86_400_000;
    if (daysAgo < 0 || daysAgo > 28) continue;
    usage.dutyMinutes28Days += entry.dutyMinutes;
    usage.blockMinutes28Days += entry.blockMinutes;
    if (daysAgo <= 14) usage.dutyMinutes14Days += entry.dutyMinutes;
    if (daysAgo <= 7) usage.dutyMinutes7Days += entry.dutyMinutes;
  }
  return usage;
}

/**
 * Whether adding one more duty period would break a rolling ceiling.
 *
 * Reports the **tightest** window rather than the first, so the sentence a
 * player reads names the limit that actually binds. Four windows all reported
 * would be four ways of saying the same "you have flown these crew too much".
 */
export function cumulativeVerdict(
  history: readonly DutyHistoryEntry[],
  adding: { at: Date; dutyMinutes: number; blockMinutes: number },
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): DutyVerdict {
  const usage = rollingUsage(history, adding.at);
  const windows = [
    {
      label: '7 days',
      used: usage.dutyMinutes7Days + adding.dutyMinutes,
      limit: duty.maxDutyMinutesPer7Days,
      what: 'duty',
    },
    {
      label: '14 days',
      used: usage.dutyMinutes14Days + adding.dutyMinutes,
      limit: duty.maxDutyMinutesPer14Days,
      what: 'duty',
    },
    {
      label: '28 days',
      used: usage.dutyMinutes28Days + adding.dutyMinutes,
      limit: duty.maxDutyMinutesPer28Days,
      what: 'duty',
    },
    {
      label: '28 days',
      used: usage.blockMinutes28Days + adding.blockMinutes,
      limit: duty.maxBlockMinutesPer28Days,
      what: 'block time',
    },
  ];

  let tightest = windows[0];
  if (!tightest) return { status: 'legal', marginMinutes: 0 };
  for (const window of windows) {
    if (window.limit - window.used < tightest.limit - tightest.used) tightest = window;
  }

  const margin = tightest.limit - tightest.used;
  if (margin < 0) {
    return {
      status: 'illegal',
      overMinutes: -margin,
      reason:
        `The crew would exceed ${hhmm(tightest.limit)} of ${tightest.what} in ` +
        `${tightest.label} by ${hhmm(-margin)}.`,
    };
  }
  if (margin <= duty.timeoutWarningMarginMinutes) {
    return {
      status: 'tight',
      marginMinutes: margin,
      reason:
        `Only ${hhmm(margin)} of the ${hhmm(tightest.limit)} ${tightest.what} ` +
        `allowance for ${tightest.label} is left.`,
    };
  }
  return { status: 'legal', marginMinutes: margin };
}

/* ---------------------------------------------------------------------- *
 * Positioning: where the crew are, versus where the aeroplane is
 * ---------------------------------------------------------------------- */

export interface PositioningNeed {
  kind: 'hotel' | 'deadhead';
  icao: string;
  /** Hotel nights owed. Always 1 for a deadhead, which pays per head per sector. */
  nights: number;
  /** Which duty period this attaches to. */
  period: number;
}

/**
 * What a rotation costs in crew that are not where they need to be (§9.2).
 *
 * Two situations, and they are different bills. A duty period that **ends** away
 * from base leaves the crew somewhere with a hotel in it, for as many nights as
 * the rest before their next duty covers. A duty period that **starts** somewhere
 * the crew are not needs them flown there as passengers first.
 *
 * The first is the one §9.2 names — *"an aircraft night-stopping away from base
 * needs crew hotelling"* — and the one a player creates by accident, because a
 * rotation that ends where it started looks symmetric on the map and is not.
 */
export function positioningFor(
  periods: readonly DutyPeriod[],
  baseIcao: string,
): PositioningNeed[] {
  const needs: PositioningNeed[] = [];
  let crewAt = baseIcao;

  for (const [index, period] of periods.entries()) {
    if (period.startsAtIcao !== crewAt) {
      needs.push({ kind: 'deadhead', icao: period.startsAtIcao, nights: 1, period: index });
    }
    crewAt = period.endsAtIcao;

    if (crewAt === baseIcao) continue;

    // At least one night the moment the crew stop away from base; more if the
    // rest before their next duty spans them.
    const next = periods[index + 1];
    const restEnds = next?.reportAt ?? period.offDutyAt;
    const restHours = Math.max(0, minutesBetween(period.offDutyAt, restEnds)) / 60;
    needs.push({
      kind: 'hotel',
      icao: crewAt,
      nights: Math.max(1, Math.ceil(restHours / 24)),
      period: index,
    });
  }
  return needs;
}

/** What {@link positioningFor}'s needs cost for a complement of this size. */
export function positioningCostMinor(
  needs: readonly PositioningNeed[],
  heads: number,
  duty: CrewDutyBalance = DEFAULT_CREW.duty,
): number {
  let total = 0;
  for (const need of needs) {
    total +=
      need.kind === 'hotel'
        ? duty.hotelCostPerHeadPerNightMinor * need.nights * heads
        : duty.deadheadCostPerHeadMinor * heads;
  }
  return Math.round(total);
}

/* ---------------------------------------------------------------------- *
 * Small shared helpers
 * ---------------------------------------------------------------------- */

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

/** `13h`, `45m`, `11h15` — a duty limit read as `780 minutes` is one nobody checks. */
function hhmm(minutes: number): string {
  const whole = Math.round(Math.abs(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${String(rest)}m`;
  return `${String(hours)}h${rest === 0 ? '' : String(rest).padStart(2, '0')}`;
}
