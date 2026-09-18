/**
 * Gates and stands (M7-06, App. B.6).
 *
 * **Slots and gates are different scarce resources and both matter.** A slot is
 * permission to *move* at a time; a gate is somewhere to *park*. App. B.8 puts it
 * plainly, and the failure it warns about — holding one without the other — is
 * only a real mistake once both exist. `route/slots.ts` owns the first. This owns
 * the arithmetic of the second.
 *
 * ## What is pure, and what is not
 *
 * The same split `slots.ts` makes. Everything about *how many stands an operation
 * needs* is arithmetic over a day's on-stand intervals and lives here, beside the
 * band maths. Everything about *holding* one — inventory, leases, who has denied
 * what to whom — is database state and lives in the server.
 *
 * ## The one formula the design doc states outright
 *
 * ```
 * ContactGates = ceil( P95(concurrent aircraft in turnaround) × 1.2 )
 * ```
 *
 * Two things in it are worth saying out loud, because both are easy to get wrong
 * and neither is arbitrary:
 *
 *   - **P95 rather than the peak.** A hub sized to its single busiest minute buys
 *     a gate for a once-a-week overlap. P95 sizes for the day the airline
 *     actually operates and tolerates the tail, which is what real gate planning
 *     does — the tail goes to a remote stand.
 *   - **×1.2 rather than exactly P95.** Gates are not interchangeable at the
 *     moment you need one: an aircraft cannot use a stand a jet bridge is still
 *     retracting from, and a schedule slips. The 20% is the doc's, and it is the
 *     difference between a plan that works and a plan that works on paper.
 *
 * And one thing the formula as written does not say, which
 * {@link gateRequirement} adds: **the buffer never buys a stand no aircraft could
 * ever be on.** The headroom is bought out of the gap between P95 and the peak,
 * and is capped there. Without that, App. B.6's own worked example contradicts
 * App. B.6's own formula — one aircraft with one aircraft ever on the ground has
 * a P95 of 1, `ceil(1 × 1.2)` is 2, and the doc's table says 1. A second gate at
 * a station that never has two aeroplanes on it at once is not headroom; it is a
 * bill. `gates.test.ts` records where else the doc's table and the doc's formula
 * disagree, and this module ships the formula.
 *
 * ## Why utilisation is computed from an assignment
 *
 * App. B.6's worked example does not report a percentage for the airline; it
 * reports one *per gate* — "3 turns/day · 2.0 h occupied of 17 h → 12%" — and
 * B.7 lets the player click a single gate to see its day. A total spread evenly
 * across the holdings would hide the thing the player needs: the first gate is
 * jammed and the fifth is idle, and it is the fifth they should give back.
 *
 * So {@link assignStands} colours the day's intervals greedily onto the
 * lowest-numbered free stand. That is deliberately **not** a gate allocator —
 * App. B.7 lists *"gate assignment as an optimisation puzzle"* as post-MVP, and
 * this invents no policy: greedy interval colouring uses exactly as many stands
 * as the peak concurrency and no more, which is the same answer any allocator
 * would have to reach. What it adds over a bare count is *which* stand each turn
 * lands on, and that is what makes a per-gate figure possible at all.
 */

import type { GateContract, StandKind } from '@tailfin/shared';

/**
 * Who wins a contested stand. Higher is stronger.
 *
 * Common use is bumpable by anything, a preferential holder outranks a walk-up,
 * and an exclusive holding is never contested at all because nobody else can
 * hold the stand in the first place — its rank exists so the ladder is total
 * rather than because a comparison against it is ever reached.
 *
 * The vocabularies themselves are `@tailfin/shared`'s (`gates.ts`), for the
 * reason `HandlerGrade` is: the economy config keys off them, the database enum
 * mirrors them and the client renders them, so one declaration is what stops a
 * sixth stand kind arriving in four places with three spellings.
 */
export function contractPriority(contract: GateContract): number {
  switch (contract) {
    case 'common_use':
      return 0;
    case 'preferential':
      return 1;
    case 'exclusive':
      return 2;
  }
}

/** Whether a contract takes the stand away from every other airline. */
export function deniesRivals(contract: GateContract): boolean {
  return contract === 'exclusive';
}

/**
 * Which of the two passenger stand types this kind turns as, or null.
 *
 * The seam between a holding and `computeTurnaround`. A contact gate turns at the
 * baseline; a remote stand costs App. B.6's +10–12 minutes of bussing, which
 * `flight/turnaround.ts` already prices and until M7-06 nothing could trigger.
 * The other three return null: they are not turns.
 */
export function turnaroundStandOf(kind: StandKind): 'contact' | 'remote' | null {
  if (kind === 'contact_gate') return 'contact';
  if (kind === 'remote_stand') return 'remote';
  return null;
}

/* -- The operating day ------------------------------------------------------- */

/**
 * The window a gate's utilisation is measured against: 06:00 to 23:00.
 *
 * Seventeen hours, and the figure is App. B.6's own — its worked example divides
 * 2.0 occupied hours by 17 and reports 12%. Measuring against 24 would report the
 * same gate at 8% and would be measuring the airline against hours the airport is
 * shut and nobody could have used it. The night is where
 * {@link overnightPositions} looks instead, and that is a different question with
 * a different answer.
 */
export const OPERATING_DAY_START_MINUTE = 6 * 60;
export const OPERATING_DAY_END_MINUTE = 23 * 60;
export const OPERATING_DAY_MINUTES = OPERATING_DAY_END_MINUTE - OPERATING_DAY_START_MINUTE;

const MINUTES_PER_DAY = 1_440;

/**
 * One aircraft on one stand, once.
 *
 * Local minutes of the day at the airport, because a stand is a physical place
 * and its day is the local one — the same reason a slot band is read at local
 * time (M3-04a). `off` may exceed 1,440 for a turn that runs past midnight; the
 * interval is not folded, so an overnight is one interval rather than two.
 */
export interface StandOccupancy {
  /** On-blocks: the minute the aircraft arrived on the stand. */
  on: number;
  /** Off-blocks: the minute it left. Must be at or after `on`. */
  off: number;
}

function assertOccupancies(occupancies: readonly StandOccupancy[]): void {
  for (const it of occupancies) {
    if (!Number.isFinite(it.on) || !Number.isFinite(it.off)) {
      throw new Error(
        `A stand occupancy must be finite minutes, got ${String(it.on)}–${String(it.off)}`,
      );
    }
    if (it.off < it.on) {
      throw new Error(
        `A stand occupancy cannot end before it starts, got ${String(it.on)}–${String(it.off)}`,
      );
    }
  }
}

/**
 * How many aircraft are on stand at each minute something changes.
 *
 * Returned as the event points rather than 1,440 samples: concurrency only ever
 * changes at an on-blocks or an off-blocks, so every other minute is a repeat of
 * the one before it. The percentile below weights each level by how long it
 * lasted, which is what makes that equivalent to sampling every minute and
 * markedly cheaper for an airline with a day's worth of turns.
 *
 * Half-open intervals: an aircraft occupying 10:00–10:40 and one occupying
 * 10:40–11:20 are never counted together. A stand freed at 10:40 is available at
 * 10:40, and counting the handover as two aircraft would buy a gate for an
 * instant that does not exist.
 */
export interface ConcurrencyLevel {
  /** Aircraft on stand through this stretch. */
  count: number;
  /** How many minutes it lasted. */
  minutes: number;
}

export function concurrencyProfile(occupancies: readonly StandOccupancy[]): ConcurrencyLevel[] {
  assertOccupancies(occupancies);
  if (occupancies.length === 0) return [];

  const edges: { at: number; delta: number }[] = [];
  for (const it of occupancies) {
    if (it.off === it.on) continue; // a zero-length stay occupies nothing
    edges.push({ at: it.on, delta: 1 });
    edges.push({ at: it.off, delta: -1 });
  }
  if (edges.length === 0) return [];
  // Off-blocks before on-blocks at the same minute, so a handover is never two.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const levels: ConcurrencyLevel[] = [];
  let count = 0;
  let cursor = edges[0]?.at ?? 0;
  for (const edge of edges) {
    if (edge.at > cursor) {
      levels.push({ count, minutes: edge.at - cursor });
      cursor = edge.at;
    }
    count += edge.delta;
  }
  return levels;
}

/** The busiest instant of the day — the peak, which is not what sizes a hub. */
export function peakConcurrency(occupancies: readonly StandOccupancy[]): number {
  let peak = 0;
  for (const level of concurrencyProfile(occupancies)) {
    if (level.count > peak) peak = level.count;
  }
  return peak;
}

/**
 * The concurrency the airline is at or below for `percentile` of the occupied day.
 *
 * Weighted by duration, so a two-minute overlap of six aircraft does not size the
 * hub the way a two-hour one does. Measured over the **occupied** stretches only:
 * including the hours nothing was on the ground would drag every percentile to
 * zero and make P95 report the peak of a quiet morning rather than of the day.
 *
 * `percentile` is a fraction, 0–1. Returns 0 for an airline with no turns.
 */
export function percentileConcurrency(
  occupancies: readonly StandOccupancy[],
  percentile: number,
): number {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new Error(`A percentile is a fraction 0–1, got ${String(percentile)}`);
  }
  const occupied = concurrencyProfile(occupancies).filter((level) => level.count > 0);
  if (occupied.length === 0) return 0;

  const totalMinutes = occupied.reduce((sum, level) => sum + level.minutes, 0);
  const target = totalMinutes * percentile;
  const byCount = [...occupied].sort((a, b) => a.count - b.count);

  let cumulative = 0;
  for (const level of byCount) {
    cumulative += level.minutes;
    if (cumulative >= target) return level.count;
  }
  return byCount[byCount.length - 1]?.count ?? 0;
}

/**
 * How the contact-gate requirement is calculated, as numbers a world may retune.
 *
 * Deliberately **not** an `EconomyConfig` section: this prices nothing. It is the
 * same call `slots.ts` makes about its release waves and its per-tier capacity —
 * a rule about how much room an operation needs, not about what room costs. What
 * a stand *costs* is `economy/gate-cost.ts`, and that is in the balance payload
 * where every price belongs.
 */
export interface GateRequirementConfig {
  /** The percentile of concurrent turnarounds the fleet is sized against. */
  percentile: number;
  /** App. B.6's headroom over that percentile. */
  buffer: number;
}

export const DEFAULT_GATE_REQUIREMENT: GateRequirementConfig = {
  percentile: 0.95,
  buffer: 1.2,
};

/** What a day of turns says about how many stands are needed to work it. */
export interface GateRequirement {
  /** `ceil(P95 × buffer)` — the doc's formula, and the number to lease against. */
  contactGates: number;
  /** The percentile itself, before the buffer. Unrounded, so the arithmetic shows. */
  percentileConcurrency: number;
  /** The busiest instant. Above the requirement when the tail is a brief one. */
  peakConcurrency: number;
  /** Aircraft still on the ground when the operating day ends. */
  overnightPositions: number;
  /** Turns counted. Zero means the requirement is a statement about nothing. */
  turns: number;
}

/**
 * App. B.6's stand requirement for one airport, from one day of on-stand intervals.
 *
 * ```
 * ContactGates = ceil( P95(concurrent aircraft in turnaround) × 1.2 )
 * ```
 *
 * transcribed — and then capped at the peak, for the reason at the top of this
 * module. The headline finding the doc draws from it — *"a banked hub needs
 * roughly five times the gates of a rolling point-to-point operation for the same
 * fleet"* — is a property of the intervals fed in, not of anything decided here:
 * a bank puts every aircraft on the ground together, and this counts them. It
 * reproduces at 5.3× for sixteen aircraft and 5.5× for a hundred and twenty.
 *
 * An airline with a single turn a day requires **one** gate, which is the worked
 * example's answer and the reason the floor is not zero: you cannot work a turn
 * from nowhere.
 */
export function gateRequirement(
  occupancies: readonly StandOccupancy[],
  config: GateRequirementConfig = DEFAULT_GATE_REQUIREMENT,
): GateRequirement {
  assertOccupancies(occupancies);
  const turns = occupancies.filter((it) => it.off > it.on).length;
  const p = percentileConcurrency(occupancies, config.percentile);
  const peak = peakConcurrency(occupancies);
  return {
    contactGates: Math.min(Math.ceil(p * config.buffer), peak),
    percentileConcurrency: p,
    peakConcurrency: peak,
    overnightPositions: overnightPositions(occupancies),
    turns,
  };
}

/**
 * Aircraft on the ground when the operating day closes.
 *
 * App. B.6 reports these in their own column and never folds them into the gate
 * count, because they are a different purchase: an overnight position is cheap
 * parking, and paying contact-gate rates to leave an aeroplane somewhere until
 * morning is the mistake the separate column exists to prevent.
 *
 * An occupancy counts when it spans the end of the operating day — which is what
 * an unfolded overnight interval looks like, and why `off` is allowed past 1,440.
 */
export function overnightPositions(occupancies: readonly StandOccupancy[]): number {
  assertOccupancies(occupancies);
  return occupancies.filter(
    (it) => it.on < OPERATING_DAY_END_MINUTE && it.off > OPERATING_DAY_END_MINUTE,
  ).length;
}

/* -- Use it or lose it ------------------------------------------------------- */

/**
 * The utilisation a leased turn stand must reach to be kept.
 *
 * App. B.6: *"Holding gates you barely use is a legitimate blocking strategy —
 * countered by a use-it-or-lose-it utilisation floor, same principle as slots."*
 * This is that floor.
 *
 * **Five percent, and the number matters.** The same appendix's worked example
 * reports a first hub's only gate at **12%** and calls that *"the lesson the
 * first hub teaches, and it is the correct one"*. A floor anywhere near 12 would
 * therefore withdraw the gate of exactly the player the example is teaching, at
 * exactly the moment they are being taught. Five leaves that airline alone and
 * still catches a stand worked twice a month, which is what blocking looks like.
 *
 * Deliberately **not** an `EconomyConfig` coefficient, for the reason
 * {@link SLOT_RELEASE_WAVES} is not: it prices nothing. It is an
 * allocation-fairness rule, and the balance payload is the wrong home for a rule
 * about queueing.
 */
export const GATE_UTILISATION_FLOOR = 0.05;

/**
 * How long a new lease is left alone before the floor applies, in **game** days.
 *
 * A stand is leased *in order to* build a schedule onto it, and a schedule takes
 * time to build — so a floor that bit on day one would make the first thing a
 * player does the thing that loses them the stand. Ninety game days is a game
 * quarter, the same horizon the last slot release wave lands on.
 *
 * Game days rather than real ones for ADR-0026's reason: a lease is an in-world
 * span, so a world at 4× reaches the end of its grace period in half the real
 * days of one at 2×.
 */
export const GATE_UTILISATION_GRACE_GAME_DAYS = 90;

/**
 * Whether a leased stand has fallen below the floor and may be withdrawn.
 *
 * Only the two **turn** stands are measured, and the exclusion is not an
 * oversight: an overnight position is occupied at night, a cargo stand works
 * §12's process and a maintenance stand holds an aeroplane that is not flying by
 * definition. All three report zero against a 06:00–23:00 operating day, so a
 * floor that counted them would withdraw every one of them on the first sweep —
 * punishing an airline for using a stand exactly as it is meant to be used.
 */
export function belowUtilisationFloor(
  kind: StandKind,
  fraction: number,
  floor: number = GATE_UTILISATION_FLOOR,
): boolean {
  if (turnaroundStandOf(kind) === null) return false;
  return fraction < floor;
}

/* -- Which stand each turn lands on, and how busy that leaves it ------------- */

/** One occupancy, placed. */
export interface StandAssignment extends StandOccupancy {
  /** 0-based. Stand 0 is the one the operation cannot do without. */
  standIndex: number;
}

/**
 * Place a day's turns onto as few stands as they can be worked from.
 *
 * Greedy interval colouring, earliest on-blocks first, each turn taking the
 * lowest-numbered stand free at that minute. The number of stands used is exactly
 * the peak concurrency, which is the least any assignment could use — so this is
 * not a policy about *which* gate an aircraft should get (App. B.7 files that
 * under post-MVP), only the arrangement that makes a per-gate figure meaningful.
 *
 * The bias towards low indices is the point: it concentrates work on the first
 * stands and leaves the last ones visibly idle, which is exactly the reading the
 * player needs before giving one back.
 */
export function assignStands(occupancies: readonly StandOccupancy[]): StandAssignment[] {
  assertOccupancies(occupancies);
  const ordered = [...occupancies]
    .map((it, index) => ({ ...it, index }))
    .sort((a, b) => a.on - b.on || a.off - b.off || a.index - b.index);

  /** When each stand next becomes free. */
  const freeAt: number[] = [];
  const placed: StandAssignment[] = [];

  for (const it of ordered) {
    let standIndex = freeAt.findIndex((at) => at <= it.on);
    if (standIndex === -1) {
      standIndex = freeAt.length;
      freeAt.push(it.off);
    } else {
      freeAt[standIndex] = it.off;
    }
    placed.push({ on: it.on, off: it.off, standIndex });
  }

  return placed;
}

/** One stand's day. */
export interface StandUtilisation {
  standIndex: number;
  /** Turns worked from this stand. */
  turns: number;
  /** Minutes it was occupied, clipped to the operating day. */
  occupiedMinutes: number;
  /** `occupiedMinutes / windowMinutes`, 0–1. */
  fraction: number;
}

/**
 * How busy each stand was, as App. B.6's worked example reports it.
 *
 * > *"Gate utilisation: 3 turns/day · 2.0 h occupied of 17 h → 12%"*
 *
 * Clipped to the operating window rather than measured raw, so an overnight
 * parked on a contact gate does not report that gate at 90% — the hours the
 * airport is shut are not hours the gate was working, and a figure that said
 * otherwise would tell the player their idle gate was their busiest one.
 *
 * `standCount` pads the answer out to the stands actually held: a fifth gate
 * nothing was assigned to belongs in the list at 0%, because *that is the row the
 * player is looking for*. Below the number used, it is ignored — a utilisation
 * report is not the place to discover you are short of gates, and
 * {@link gateRequirement} is.
 */
export function standUtilisation(
  occupancies: readonly StandOccupancy[],
  standCount?: number,
  windowMinutes: number = OPERATING_DAY_MINUTES,
): StandUtilisation[] {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error(`A utilisation window must be positive minutes, got ${String(windowMinutes)}`);
  }
  const placed = assignStands(occupancies);
  const used = placed.reduce((max, it) => Math.max(max, it.standIndex + 1), 0);
  const stands = Math.max(used, standCount ?? 0);

  const rows: StandUtilisation[] = [];
  for (let standIndex = 0; standIndex < stands; standIndex += 1) {
    const mine = placed.filter((it) => it.standIndex === standIndex);
    const occupiedMinutes = mine.reduce((sum, it) => sum + withinOperatingDay(it), 0);
    rows.push({
      standIndex,
      turns: mine.length,
      occupiedMinutes,
      fraction: Math.min(occupiedMinutes / windowMinutes, 1),
    });
  }
  return rows;
}

/** The part of one occupancy that falls inside the operating day. */
function withinOperatingDay(it: StandOccupancy): number {
  const on = Math.max(it.on, OPERATING_DAY_START_MINUTE);
  const off = Math.min(it.off, OPERATING_DAY_END_MINUTE);
  return Math.max(off - on, 0);
}

/**
 * Build the day's on-stand intervals for one airport from a rotation's arrivals
 * and departures.
 *
 * The join between a schedule and a stand: an aircraft is on a stand from the
 * minute it arrives until the minute it next leaves, and the last arrival of the
 * day holds its stand until the first departure of the next — which is the
 * overnight, and is why it is emitted with an `off` past midnight rather than
 * dropped.
 *
 * `arrivals` and `departures` are local minutes at this airport, in any order. An
 * aircraft that departs before it has ever arrived (the first sector of the day)
 * was parked there overnight and is not counted twice — the interval that covers
 * it is the previous day's, and this returns one day.
 */
export function standOccupancies(
  arrivals: readonly number[],
  departures: readonly number[],
): StandOccupancy[] {
  const outbound = [...departures].sort((a, b) => a - b);
  const occupancies: StandOccupancy[] = [];

  for (const on of [...arrivals].sort((a, b) => a - b)) {
    const next = outbound.find((at) => at >= on);
    // Nothing left today: the aircraft stays until tomorrow's first departure,
    // or until the end of the day if the rotation never resumes.
    const off = next ?? (outbound[0] ?? on) + MINUTES_PER_DAY;
    occupancies.push({ on, off });
    if (next !== undefined) outbound.splice(outbound.indexOf(next), 1);
  }

  return occupancies;
}
